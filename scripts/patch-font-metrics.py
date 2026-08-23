#!/usr/bin/env python3
"""
patch-font-metrics.py — rewrite a font's declared VERTICAL METRICS to its MEASURED ink box, so
tight design line heights render without the text engine clipping the glyphs.

THE PROBLEM (it is not your line heights, and it is not the design)
------------------------------------------------------------------
Every font file declares how tall a line of it is, in three places: `hhea.ascent/descent/lineGap`,
`OS/2.sTypoAscender/Descender/LineGap`, and `OS/2.usWinAscent/usWinDescent`. Plenty of families
ship those numbers describing a box far taller than any ink the font actually draws — they reserve
headroom for the tallest mark of every script the family supports, for stacked diacritics, or
simply because the vendor rounded up. A family whose Latin ink occupies ~1.2x the em can easily
declare a ~1.9x line box.

Design tools do not care: they lay each line out at the line height the design system specifies,
so the mock looks exactly right. A UI runtime does care — it sizes every line against the FONT's
declared metrics. When the declared box (1.9x em) is taller than the line height the design asks
for (1.2x em), the glyph box overflows the line box and the renderer CLIPS the top and bottom of
every line. The usual reaction is to inflate the line heights until nothing is cut, which quietly
abandons the type ramp and makes the app permanently disagree with the design file.

The honest fix is to stop the font from lying about its own size.

THE STRATEGY (measured per face from real glyph contours — never hand-typed)
---------------------------------------------------------------------------
  * LAYOUT metrics -> the ink box of the script that DEFINES the line box (default: Latin).
    Written to `hhea.ascent/descent` AND `OS/2.sTypoAscender/sTypoDescender`, with lineGap 0.
    These drive line-height layout. Tuning them to the ink of the script the ramp was drawn
    against is what makes the design line heights land 1:1.
  * CLIP metrics -> the FULL ink box across every glyph in the font.
    Written to `OS/2.usWinAscent/usWinDescent`. On Android the win box is the glyph CLIP rect, so
    keeping it at full ink means an unusually tall glyph or mark OVERLAPS the neighbouring line —
    exactly what the design tool does — instead of being hard-clipped at every line height.
  * USE_TYPO_METRICS (`OS/2.fsSelection` bit 7) is set, so Android honours the typo metrics for
    layout rather than falling back to the win box.

Why all three: iOS/CoreText lays out from `hhea`; Android uses the OS/2 typo metrics when
USE_TYPO_METRICS is set (and the win metrics when it is not) and clips at the win box. Writing
them consistently is what makes the two platforms agree with each other and with the design file.

WHICH SCRIPT DEFINES THE LAYOUT BOX IS A REAL DECISION
------------------------------------------------------
`--layout-range` picks the codepoints whose ink sets the layout box; it defaults to Latin
(0x20-0x24F). If your type ramp was drawn against Latin text, that is the right box, and taller
scripts in the same family will overlap slightly at tight line heights — which is precisely what
they do in the design tool, since the design uses the same line heights. If your primary script
is a taller one, set its range instead and accept the taller line box everywhere. Pick
deliberately; do not discover it from a bug report.

IDEMPOTENT BY CONSTRUCTION
--------------------------
It always reads the pristine sources and writes elsewhere, so re-running never compounds a
previous patch. Commit the sources and never mutate them; the patched fonts are a build product.

Run:  python3 scripts/patch-font-metrics.py
Deps: fonttools  (pip install fonttools)
"""

import argparse
import glob
import json
import os
import re
import sys

try:
    from fontTools.ttLib import TTFont
except ImportError:
    sys.exit("fonttools is required: pip install fonttools")

USE_TYPO_METRICS = 1 << 7  # OS/2 fsSelection bit 7
DEFAULT_LAYOUT_RANGE = "0x20-0x24F"  # Basic Latin + Latin-1 Supplement + Latin Extended-A/B


# ─── Config ───────────────────────────────────────────────────────────────────
def _read_config(path):
    try:
        with open(path, encoding="utf-8") as fh:
            raw = fh.read()
        # The shipped template annotates itself with `//` lines; tolerate them like the JS loader.
        return json.loads(re.sub(r"^\s*//.*$", "", raw, flags=re.M))
    except Exception as exc:  # a malformed config should say so, not vanish into a default
        sys.exit(f"Could not parse {path}: {exc}")


def load_config():
    """Return (config, project_root): $FIGMA_CONFIG, else figma.config.json walking up from cwd."""
    explicit = os.environ.get("FIGMA_CONFIG")
    if explicit:
        path = os.path.abspath(explicit)
        return _read_config(path), os.path.dirname(path)
    directory = os.getcwd()
    while True:
        candidate = os.path.join(directory, "figma.config.json")
        if os.path.isfile(candidate):
            return _read_config(candidate), directory
        parent = os.path.dirname(directory)
        if parent == directory:
            return {}, os.getcwd()
        directory = parent


def resolve(root, value):
    if not value:
        return None
    return value if os.path.isabs(value) else os.path.join(root, value)


# ─── Measurement ──────────────────────────────────────────────────────────────
def parse_ranges(spec):
    """'0x20-0x24F,0x2000-0x206F' -> [(32, 591), (8192, 8303)]"""
    ranges = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        low, _, high = chunk.partition("-")
        high = high or low
        try:
            ranges.append((int(low, 0), int(high, 0)))
        except ValueError:
            sys.exit(f"--layout-range: '{chunk}' is not a codepoint range (e.g. 0x20-0x24F).")
    if not ranges:
        sys.exit("--layout-range is empty.")
    return ranges


def in_ranges(codepoint, ranges):
    return any(low <= codepoint <= high for low, high in ranges)


def ink_boxes(font, ranges):
    """Measure (layout_box, full_box) as (ymin, ymax) from real contours. layout_box may be None."""
    glyf = font["glyf"]
    try:
        cmap = font.getBestCmap()
    except Exception:
        cmap = {}
    layout_glyphs = {name for cp, name in cmap.items() if in_ranges(cp, ranges)}

    l_min = l_max = None
    f_min = f_max = None
    for name in glyf.keys():
        glyph = glyf[name]
        if glyph.numberOfContours == 0:  # space / non-marking: no ink to measure
            continue
        glyph.recalcBounds(glyf)
        f_min = glyph.yMin if f_min is None else min(f_min, glyph.yMin)
        f_max = glyph.yMax if f_max is None else max(f_max, glyph.yMax)
        if name in layout_glyphs:
            l_min = glyph.yMin if l_min is None else min(l_min, glyph.yMin)
            l_max = glyph.yMax if l_max is None else max(l_max, glyph.yMax)

    if f_min is None:
        return None, None
    layout = None if l_min is None else (l_min, l_max)
    return layout, (f_min, f_max)


# ─── Patch ────────────────────────────────────────────────────────────────────
def patch(src_path, out_dir, ranges, range_label):
    name = os.path.basename(src_path)
    font = TTFont(src_path)

    # This measures TrueType outlines from the `glyf` table. A CFF-flavoured OpenType file
    # (.otf, and some .ttf-named files) stores outlines in `CFF `/`CFF2` instead, and would
    # otherwise fail with an opaque KeyError halfway through the run.
    if "glyf" not in font:
        flavour = "CFF2" if "CFF2" in font else ("CFF" if "CFF " in font else "unknown")
        sys.exit(
            f"{name}: {flavour}-flavoured OpenType (no 'glyf' table) — this script measures\n"
            "  TrueType outlines. Convert the face to TTF, or extend this script to measure via\n"
            "  fontTools' getGlyphSet() + BoundsPen, which works for both outline formats."
        )

    upm = font["head"].unitsPerEm
    hhea, os2 = font["hhea"], font["OS/2"]
    before = (hhea.ascent, hhea.descent, os2.usWinAscent, os2.usWinDescent)

    layout, full = ink_boxes(font, ranges)
    if full is None:
        print(f"  {name}: no glyph contours found — skipped")
        return None
    if layout is None:
        print(
            f"  {name}: no glyphs in {range_label} — falling back to the FULL ink box for layout.\n"
            f"  {'':{len(name)}}  Pass --layout-range covering this font's primary script."
        )
        layout = full

    asc, desc = max(layout[1], 0), min(layout[0], 0)  # layout box; descent is negative
    win_asc, win_desc = max(full[1], 0), max(-full[0], 0)  # clip box; win descent is positive

    hhea.ascent, hhea.descent, hhea.lineGap = asc, desc, 0
    os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap = asc, desc, 0
    os2.usWinAscent, os2.usWinDescent = win_asc, win_desc
    os2.fsSelection |= USE_TYPO_METRICS

    out_path = os.path.join(out_dir, name)
    font.save(out_path)

    was_ratio = (before[0] - before[1]) / upm
    now_ratio = (asc - desc) / upm
    full_ratio = (full[1] - full[0]) / upm
    pad = " " * len(name)
    print(
        f"  {name}  ({upm} upm)\n"
        f"  {pad}  was     hhea={before[0]}/{before[1]} ({was_ratio:.3f}x)  "
        f"win={before[2]}/{before[3]}\n"
        f"  {pad}  ink     layout({range_label})={layout[1]}/{layout[0]} ({now_ratio:.3f}x)  "
        f"full={full[1]}/{full[0]} ({full_ratio:.3f}x)\n"
        f"  {pad}  now     hhea+typo={asc}/{desc} ({now_ratio:.3f}x, lineGap 0)  "
        f"win={win_asc}/{win_desc}  USE_TYPO_METRICS=on"
    )
    return was_ratio, now_ratio


def main():
    cfg, root = load_config()
    paths = cfg.get("paths", {}) if isinstance(cfg, dict) else {}

    parser = argparse.ArgumentParser(
        description="Rewrite font vertical metrics to the measured ink box.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Run: python3 scripts/patch-font-metrics.py",
    )
    parser.add_argument("--src", help="pristine font sources (default: paths.fontSources)")
    parser.add_argument("--out", help="where patched fonts are written (default: paths.fontsOut)")
    parser.add_argument(
        "--glob", default="*.ttf", help="filename pattern inside --src (default: *.ttf)"
    )
    parser.add_argument(
        "--layout-range",
        default=DEFAULT_LAYOUT_RANGE,
        help=f"codepoints whose ink defines the LAYOUT box (default: {DEFAULT_LAYOUT_RANGE}, Latin)",
    )
    args = parser.parse_args()

    src_dir = args.src or resolve(root, paths.get("fontSources", "font-sources"))
    out_dir = args.out or resolve(root, paths.get("fontsOut"))

    if not out_dir:
        sys.exit(
            "No output directory. Pass --out, or set paths.fontsOut in figma.config.json, e.g.\n"
            '  "paths": { "fontSources": "font-sources", "fontsOut": "src/assets/fonts" }'
        )
    if not src_dir or not os.path.isdir(src_dir):
        sys.exit(
            f"No font sources at {src_dir or '(paths.fontSources unset)'}.\n"
            "  Copy the ORIGINAL font files there and commit them — they are the input to every\n"
            "  run, so patching stays idempotent."
        )
    if os.path.abspath(src_dir) == os.path.abspath(out_dir):
        sys.exit(
            f"--src and --out are the same directory ({src_dir}).\n"
            "  That would overwrite the pristine sources and make re-runs compound. Point --out\n"
            "  at the fonts your app loads instead."
        )

    sources = sorted(glob.glob(os.path.join(src_dir, args.glob)))
    if not sources:
        sys.exit(f"No files matching '{args.glob}' in {src_dir}.")

    ranges = parse_ranges(args.layout_range)
    os.makedirs(out_dir, exist_ok=True)

    print(
        f"Patching {len(sources)} face(s): layout box = ink of {args.layout_range}, "
        f"clip box = full ink.\n"
    )
    patched = 0
    for src in sources:
        if patch(src, out_dir, ranges, args.layout_range):
            patched += 1

    print(f"\nwrote {patched} patched face(s) to {out_dir}/")
    print("Re-run after replacing a source font; the app must load the PATCHED files.")


if __name__ == "__main__":
    main()
