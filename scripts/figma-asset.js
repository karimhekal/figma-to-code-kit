/* eslint-disable */
/**
 * figma-asset — export big / multi-color Figma graphics (illustrations, logos, spot art) as
 * EXACT `.svg` files, one file per name, ready for whatever turns SVG into a component in your
 * build.
 *
 *   node scripts/figma-asset.js <nodeId>=<name> [<nodeId>=<name> ...] [--file <key>] [--out <dir>] [--mono]
 *   e.g. node scripts/figma-asset.js 1234:5678=empty-state-inbox
 *
 * The original Figma colors are KEPT by default — that is the whole point for an illustration or
 * a logo, where the palette is the artwork. Pass `--mono` for large single-color art you want to
 * recolor from a `color` prop; it rewrites `stroke`/`fill` to `currentColor`.
 *
 * Same `<nodeId>=<name>` pair interface as figma-icon.js, for the same reason: the operator names
 * the asset, so nothing here assumes how your Figma file organizes its graphics.
 *
 * PORTING FIX: `--mono` used to rewrite only HEX paints. Figma emits `fill="white"` for pure-white
 * art, so a white `--mono` asset kept a hard white fill and shipped invisible on a light
 * background — a bug the icon script had already fixed and this one had not. Both scripts now
 * share ONE rewrite implementation in `scripts/svg-normalize.js`, so the two rule sets cannot
 * drift apart again.
 *
 * RENDERER CAVEAT — read before blaming the export:
 * SVG renderers are not all complete. React Native's `react-native-svg`, notably, cannot do
 * filters/blur, SMIL animation, `<foreignObject>` or full CSS, and quietly drops what it cannot
 * draw. So ALWAYS render-and-compare (`node scripts/figma-render.js <nodeId>`) after exporting.
 * If a graphic comes out broken, export it as a PNG/WebP instead — the design is not negotiable.
 * Never hand-draw a replacement and never substitute a similar-looking glyph: an approximation
 * that reaches review is worse than a raster, because nobody can tell it apart from the design
 * until a designer does.
 *
 * Config used: `files.default` (or `--file`), `paths.graphicsDir` (or `--out`),
 * `icons.extraNamedColors` (for `--mono`), `auth.*`. Node 18+ (global fetch), zero dependencies.
 */
const fs = require('fs');
const path = require('path');
const { fetchRetry, requireFigmaToken } = require('./figma-net');
const { loadConfig, resolvePath, requireFileKey } = require('./figma-config');
const { recolorToCurrentColor } = require('./svg-normalize');

const USAGE =
  'Usage: node scripts/figma-asset.js <nodeId>=<name> [<nodeId>=<name> ...] [--file <key>] [--out <dir>] [--mono]';

/** Figma's URLs use `1234-5678`, the API uses `1234:5678`. Swap the FIRST hyphen only. */
function apiNodeId(id) {
  return id.replace('-', ':');
}

function parseArgs(argv) {
  const pairs = [];
  let fileKey = null;
  let out = null;
  let mono = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mono') {
      mono = true;
      continue;
    }
    if (arg === '--file' || arg === '--out') {
      const value = argv[++i];
      if (!value) {
        console.error(`${arg} needs a value.\n${USAGE}`);
        process.exit(1);
      }
      if (arg === '--file') fileKey = value;
      else out = value;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg.startsWith('--')) {
      console.warn(`Ignoring unknown flag ${arg}`);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq <= 0 || eq === arg.length - 1) {
      console.error(`Expected <nodeId>=<name>, got "${arg}".\n${USAGE}`);
      process.exit(1);
    }
    pairs.push({ id: arg.slice(0, eq), name: arg.slice(eq + 1) });
  }

  return { pairs, fileKey, out, mono };
}

(async () => {
  const { pairs, fileKey: fileFlag, out, mono } = parseArgs(process.argv.slice(2));
  if (!pairs.length) {
    console.error(USAGE);
    process.exit(1);
  }

  const cfg = loadConfig();
  const fileKey = requireFileKey(cfg, fileFlag, 'default');

  // `--out` is relative to where you ran the script; a configured path is relative to the project
  // root.
  const dir = out
    ? path.resolve(process.cwd(), out)
    : resolvePath(cfg, cfg.paths && cfg.paths.graphicsDir);
  if (!dir) {
    console.error(
      'No graphics output directory. Set paths.graphicsDir in figma-kit.config.json, or pass --out <dir>.',
    );
    process.exit(1);
  }

  const token = requireFigmaToken(cfg);

  // One images call for every id — Figma rate-limits per token.
  const idParam = pairs.map((p) => apiNodeId(p.id)).join(',');
  const res = await fetchRetry(
    `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(idParam)}&format=svg`,
    { headers: { 'X-Figma-Token': token } },
  );
  const meta = await res.json();
  // A 200 can still carry `{ err }` (render timeout, bad id) — not an HTTP error, so fetchRetry
  // cannot have retried it.
  if (meta.err) {
    console.error('Figma images API error:', meta.err);
    process.exit(1);
  }
  if (!meta.images) {
    console.error('Figma images API returned no images:', JSON.stringify(meta).slice(0, 300));
    process.exit(1);
  }

  fs.mkdirSync(dir, { recursive: true });
  let written = 0;

  for (const { id, name } of pairs) {
    const url = meta.images[apiNodeId(id)];
    if (!url) {
      console.warn(`no SVG for ${id} (${name}) — check the node id and that it is in this file`);
      continue;
    }
    let svg = await (await fetchRetry(url)).text();
    if (mono) svg = recolorToCurrentColor(svg, cfg);

    // A name may carry a subdirectory (`illustrations/hero`) — create it rather than failing.
    const target = path.join(dir, `${name}.svg`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, svg);
    written++;
    console.log(`+ ${name}.svg  (${id})  ${mono ? '[mono → currentColor]' : '[colors kept]'}`);
  }

  if (!written) {
    console.error('\nNothing exported.');
    process.exit(1);
  }

  const shown = path.relative(process.cwd(), dir) || dir;
  console.log(`\nSaved ${written} file(s) to ${shown}/`);
  console.log(
    'Now render the same node and compare — SVG features do not all survive every renderer.',
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
