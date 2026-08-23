/* eslint-disable */
/**
 * svg-normalize — the ONE implementation of "make a Figma-exported SVG recolorable and
 * size-controlled". `figma-icon.js` and `figma-asset.js` both go through this module.
 *
 * It lives here because the two scripts already drifted once: figma-icon rewrote hex paints AND
 * named `white`/`black` paints to `currentColor`, while figma-asset's `--mono` rewrote only the
 * hex ones. Figma emits `fill="white"` for pure-white art, so a `--mono` asset kept a hard white
 * fill and shipped invisible on a light background — the exact bug the icon script had already
 * fixed. One shared module, one rule set, no second chance to diverge.
 *
 * Zero dependencies.
 */
const { loadConfig } = require('./figma-config');

/** Escape a config-supplied color name before splicing it into a RegExp. */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Keywords that must NEVER be rewritten, whatever the config says.
 *
 * `fill="none"` does not mean "black" or "no color" — it means "do not paint this shape". Turning
 * it into `currentColor` floods every outline icon into a solid blob. `transparent` is the same
 * instruction spelled differently, and `currentColor` is already the answer.
 */
const PROTECTED_PAINTS = new Set(['none', 'transparent', 'currentcolor']);

/** The named colors to rewrite, from `icons.extraNamedColors` (default: white, black). */
function namedColors(cfg) {
  const raw = (cfg && cfg.icons && cfg.icons.extraNamedColors) || [];
  const out = [];
  for (const entry of raw) {
    const name = String(entry || '').trim();
    if (!name) continue;
    if (PROTECTED_PAINTS.has(name.toLowerCase())) {
      console.warn(
        `[svg-normalize] Ignoring icons.extraNamedColors entry "${name}" — it means "do not paint", not a color.`,
      );
      continue;
    }
    out.push(name);
  }
  return out;
}

/**
 * Step (a) + (b) of the rewrite: every explicit paint becomes `currentColor`, so the glyph takes
 * its color from the consuming component instead of from whatever the designer happened to have
 * selected in the library.
 *
 *   (a) hex paints        fill="#1A1A1A"  -> fill="currentColor"
 *   (b) named paints      fill="white"    -> fill="currentColor"
 *
 * (b) is not redundant. Figma exports pure white and pure black as CSS keywords rather than hex,
 * and a rule set that only knows hex leaves them alone — a white glyph then ships white and is
 * invisible against a light surface. The rule is case-insensitive because the keyword casing is
 * not stable across exports.
 *
 * LIMITS, honestly:
 *   - Only `stroke=` and `fill=` PRESENTATION ATTRIBUTES are matched (either quote style). Paints
 *     written as inline CSS (`style="fill:#fff"`), `rgb()`/`hsl()` functions, or any other CSS
 *     keyword (`gray`, `red`, …) are left as-is. Add the keyword to `icons.extraNamedColors` to
 *     catch it; `rgb()` would need a rule of its own.
 *   - A MULTI-COLOR icon cannot collapse into one `currentColor` — that is not a bug in the
 *     regex, it is arithmetic. Route multi-color art through `figma-asset.js` (which keeps the
 *     original paints) instead of forcing it through here.
 */
function recolorToCurrentColor(svg, cfg = loadConfig()) {
  let out = svg.replace(/(stroke|fill)=("|')#[0-9a-fA-F]{3,8}\2/g, '$1="currentColor"');

  const names = namedColors(cfg);
  if (names.length) {
    const alternation = names.map(escapeRe).join('|');
    out = out.replace(
      new RegExp(`(stroke|fill)=("|')(?:${alternation})\\2`, 'gi'),
      '$1="currentColor"',
    );
  }
  return out;
}

/**
 * Find the root `<svg …>` tag, quote-aware so a `>` inside an attribute value doesn't end it
 * early, and so a leading `<?xml …?>` prolog isn't mistaken for the root tag.
 */
function rootTagRange(svg) {
  const start = svg.indexOf('<svg');
  if (start === -1) return null;
  let quote = null;
  for (let i = start; i < svg.length; i++) {
    const ch = svg[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return { start, end: i };
  }
  return null;
}

/**
 * Step (c): drop `width`/`height` from the ROOT tag ONLY.
 *
 * Figma stamps the artboard's pixel size on the root element. Left in place it wins over the
 * `size` prop of the consuming component and every icon renders at whatever the designer's frame
 * happened to be. Removing it hands sizing to the component.
 *
 * "Root tag only" is the whole point: an inner `<rect width="16" …>` is GEOMETRY, and stripping
 * that deforms the drawing. `viewBox` is deliberately untouched — it is what preserves the
 * coordinate system and aspect ratio once the intrinsic size is gone.
 */
function stripRootSize(svg) {
  const range = rootTagRange(svg);
  if (!range) return svg;
  const open = svg
    .slice(range.start, range.end + 1)
    .replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/g, '');
  return svg.slice(0, range.start) + open + svg.slice(range.end + 1);
}

/** Collapse comments and inter-tag whitespace so the SVG stores as one tidy line. */
function collapseWhitespace(svg) {
  return svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n\s*/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

/**
 * The full icon rewrite: recolor -> strip the root's intrinsic size -> collapse to one line.
 * `figma-asset.js --mono` uses only `recolorToCurrentColor`, because a standalone `.svg` file
 * keeps its intrinsic size for the cases where nothing passes explicit dimensions.
 */
function normalizeIcon(svg, cfg = loadConfig()) {
  return collapseWhitespace(stripRootSize(recolorToCurrentColor(svg, cfg)));
}

module.exports = {
  normalizeIcon,
  recolorToCurrentColor,
  stripRootSize,
  collapseWhitespace,
};
