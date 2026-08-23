/* eslint-disable */
/**
 * figma-render — render Figma node(s) to PNG so the build can be visually compared against the
 * source of truth (numbers lie; pixels don't). An extract tells you what the design *says*;
 * only a render tells you what it *looks like*, including layers the extract reports as hidden.
 *
 *   node scripts/figma-render.js <nodeId> [<nodeId> ...] [--file <key>] [--screens]
 *                                [--scale 4] [--format png|svg] [--out <dir>]
 *
 *   e.g. node scripts/figma-render.js 1234:5678 2468:1357
 *        node scripts/figma-render.js 1234-5678 --screens --scale 2
 *
 * Saves <out>/figma-<nodeId>.<format> and prints the paths so they can be opened and diffed
 * against a screenshot of the running build. `--out` defaults to paths.renderDir from
 * figma-kit.config.json; the file key defaults to files.default (`--screens` picks files.screens,
 * `--file` overrides both). Credentials come from figma-net (auth.* in the config).
 *
 * Node ids copied out of a Figma URL use `-` as the separator; both forms are accepted.
 * `--format svg` gives an exact vector export (icons); `--format png` is what you diff.
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, resolvePath, requireFileKey } = require('./figma-config');
const { fetchRetry, requireFigmaToken } = require('./figma-net');

const cfg = loadConfig();

const argv = process.argv.slice(2);
const ids = [];
let fileKeyFlag = null;
let slot = 'default';
let scale = 4;
let out = null;
let format = 'png'; // png for visual diff; svg for exact icon export
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--file') fileKeyFlag = argv[++i];
  else if (argv[i] === '--screens') slot = 'screens';
  else if (argv[i] === '--scale') scale = Number(argv[++i]);
  else if (argv[i] === '--out') out = argv[++i];
  else if (argv[i] === '--format') format = argv[++i];
  else ids.push(argv[i]);
}
if (!ids.length) {
  console.error(
    'Usage: node scripts/figma-render.js <nodeId> [...] [--file <key>] [--screens] ' +
      '[--scale 4] [--format png|svg] [--out <dir>]',
  );
  process.exit(1);
}
if (format !== 'png' && format !== 'svg') {
  console.error(`Unsupported --format "${format}" (use png or svg).`);
  process.exit(1);
}
if (!Number.isFinite(scale) || scale <= 0) {
  console.error('--scale must be a positive number.');
  process.exit(1);
}

const fileKey = requireFileKey(cfg, fileKeyFlag, slot);
const outDir = out || resolvePath(cfg, cfg.paths.renderDir) || '/tmp';

(async () => {
  const t = requireFigmaToken(cfg);
  fs.mkdirSync(outDir, { recursive: true });

  // One request for every id: the images API batches, and batching keeps the per-token rate
  // limit from tripping when you are rendering a whole state matrix.
  const idParam = ids.map((id) => id.replace('-', ':')).join(',');
  const url =
    `https://api.figma.com/v1/images/${fileKey}` +
    `?ids=${encodeURIComponent(idParam)}&format=${format}&scale=${scale}`;

  // The images API can 200 with `{ err: "...Render timeout..." }`; that's not an HTTP error,
  // so retry it here (transport errors + 5xx are already retried inside fetchRetry).
  let meta;
  for (let attempt = 0; attempt < 4; attempt++) {
    meta = await (await fetchRetry(url, { headers: { 'X-Figma-Token': t } })).json();
    if (!meta.err) break;
    if (attempt < 3 && /timeout/i.test(String(meta.err))) {
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      continue;
    }
    console.error('Figma images API error:', meta.err);
    process.exit(1);
  }

  let saved = 0;
  for (const [id, imgUrl] of Object.entries(meta.images || {})) {
    if (!imgUrl) {
      // A null URL means the node exists but rendered to nothing (empty/hidden frame), or the
      // id belongs to a different file than the one asked for.
      console.warn('no image for', id);
      continue;
    }
    const buf = Buffer.from(await (await fetchRetry(imgUrl)).arrayBuffer());
    const file = path.join(outDir, `figma-${id.replace(':', '-')}.${format}`);
    fs.writeFileSync(file, buf);
    console.log('saved', file);
    saved++;
  }

  // Fidelity is width-dependent: a layout that matches at the design width can wrap or clip at a
  // wider one. Remind the caller of the widths this project verifies against, when configured.
  const widths = Array.isArray(cfg.design.compareWidths) ? cfg.design.compareWidths : [];
  if (saved && widths.length) {
    const modes = Array.isArray(cfg.design.modes) ? cfg.design.modes : [];
    console.log(
      `\nCompare at ${widths.join(' and ')} px wide` +
        (modes.length ? ` in each mode (${modes.join(', ')})` : '') +
        ' — capture the build at the same width and diff it against these renders.',
    );
  }
})();
