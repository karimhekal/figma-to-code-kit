/* eslint-disable */
/**
 * figma-icon — export Figma icons as EXACT SVG into a name-keyed registry, so an `<Icon>`
 * component can look a glyph up by name, recolor it from a `color` prop and size it from a
 * `size` prop.
 *
 *   node scripts/figma-icon.js <nodeId>=<name> [<nodeId>=<name> ...] [--file <key>] [--out <path>]
 *   e.g. node scripts/figma-icon.js 1234:5678=search 1234:9012=arrow-right
 *
 * Upserts the registry at `paths.iconRegistry` (a flat JSON object, icon name -> SVG string):
 * existing entries survive, named entries are replaced, and the whole thing is written back
 * alphabetically sorted so the diff of adding one icon is one line, not a reshuffle.
 *
 * WHY THE EXPLICIT `<nodeId>=<name>` PAIRS
 * The operator names every icon. That looks like extra typing and it is the single reason this
 * script transfers to any design system: it assumes NOTHING about how the icon page is
 * organized. No "icons live in a page called Icons", no "the frame name is the icon name", no
 * vendor icon-pack naming convention, no required 24x24 grid. Whatever your library calls a
 * glyph internally, you decide what your code calls it — and renaming an icon in code never
 * requires renaming anything in Figma. Auto-discovery would buy a little convenience and cost
 * the portability, plus it would silently re-export half a library the day someone reorganizes
 * a page.
 *
 * WHAT THE SVG REWRITE DOES  (shared with figma-asset.js — see scripts/svg-normalize.js)
 *   (a) hex `stroke`/`fill`   -> currentColor
 *   (b) NAMED white/black     -> currentColor  (Figma emits `fill="white"`; without this rule a
 *                                               white glyph ships white and vanishes on a light
 *                                               background)
 *   (c) width/height stripped from the ROOT tag only, so the `size` prop controls dimensions
 *       while `viewBox` — and every inner width/height, which is geometry — survives.
 * `fill="none"` is never touched: it means "do not paint", and rewriting it fills outline icons in.
 *
 * LIMITS
 *   - A MULTI-COLOR icon cannot collapse to a single `currentColor`. Export it with
 *     `node scripts/figma-asset.js` instead, which keeps the original paints.
 *   - Paints written as `rgb()`, inline `style="fill:…"`, or another CSS keyword are left alone.
 *     Add the keyword to `icons.extraNamedColors` in figma.config.json to catch it.
 *
 * Config used: `files.default` (or `--file`), `paths.iconRegistry` (or `--out`),
 * `icons.extraNamedColors`, `auth.*`. Node 18+ (global fetch), zero dependencies.
 */
const fs = require('fs');
const path = require('path');
const { fetchRetry, requireFigmaToken } = require('./figma-net');
const { loadConfig, resolvePath, requireFileKey } = require('./figma-config');
const { normalizeIcon } = require('./svg-normalize');

const USAGE =
  'Usage: node scripts/figma-icon.js <nodeId>=<name> [<nodeId>=<name> ...] [--file <key>] [--out <registry.json>]';

/**
 * Figma's UI copies node ids out of the URL in `1234-5678` form while the API speaks `1234:5678`.
 * Swap the FIRST hyphen only — instance ids look like `I1234:5678;9012:3456` and the rest of the
 * string must survive untouched.
 */
function apiNodeId(id) {
  return id.replace('-', ':');
}

function parseArgs(argv) {
  const pairs = [];
  let fileKey = null;
  let out = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
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
    // Split on the FIRST '=' so a name may itself contain one.
    const eq = arg.indexOf('=');
    if (eq <= 0 || eq === arg.length - 1) {
      console.error(`Expected <nodeId>=<name>, got "${arg}".\n${USAGE}`);
      process.exit(1);
    }
    pairs.push({ id: arg.slice(0, eq), name: arg.slice(eq + 1) });
  }

  return { pairs, fileKey, out };
}

/**
 * Read the existing registry. A missing file is the normal first run (start empty); a file that
 * exists but does not parse is NOT — overwriting it would silently destroy every icon already
 * registered, so stop and let a human look at it.
 */
function readRegistry(regPath) {
  if (!fs.existsSync(regPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    console.error(`Registry ${regPath} is not a JSON object. Fix or delete it, then re-run.`);
  } catch (e) {
    console.error(
      `Could not parse registry ${regPath}: ${e.message}\nFix or delete it, then re-run.`,
    );
  }
  process.exit(1);
}

(async () => {
  const { pairs, fileKey: fileFlag, out } = parseArgs(process.argv.slice(2));
  if (!pairs.length) {
    console.error(USAGE);
    process.exit(1);
  }

  const cfg = loadConfig();
  const fileKey = requireFileKey(cfg, fileFlag, 'default');

  // A `--out` on the command line is relative to where you ran the script; a configured path is
  // relative to the project root. The registry location is the one path that genuinely has to be
  // pinned — the component reads it by import, so guessing a default here would just write to a
  // file nothing imports.
  const regPath = out
    ? path.resolve(process.cwd(), out)
    : resolvePath(cfg, cfg.paths && cfg.paths.iconRegistry);
  if (!regPath) {
    console.error(
      'No icon registry path. Set paths.iconRegistry in figma.config.json, or pass --out <registry.json>.',
    );
    process.exit(1);
  }

  const token = requireFigmaToken(cfg);

  // One images call for every requested id — Figma rate-limits per token, so batching matters
  // when you are registering a dozen glyphs at once.
  const idParam = pairs.map((p) => apiNodeId(p.id)).join(',');
  const res = await fetchRetry(
    `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(idParam)}&format=svg`,
    { headers: { 'X-Figma-Token': token } },
  );
  const meta = await res.json();
  // A 200 can still carry `{ err }` (render timeout, bad id) — fetchRetry cannot see that, since
  // it is not an HTTP error.
  if (meta.err) {
    console.error('Figma images API error:', meta.err);
    process.exit(1);
  }
  if (!meta.images) {
    console.error('Figma images API returned no images:', JSON.stringify(meta).slice(0, 300));
    process.exit(1);
  }

  const registry = readRegistry(regPath);
  let written = 0;

  for (const { id, name } of pairs) {
    const url = meta.images[apiNodeId(id)];
    if (!url) {
      console.warn(`no SVG for ${id} (${name}) — check the node id and that it is in this file`);
      continue;
    }
    const raw = await (await fetchRetry(url)).text();
    registry[name] = normalizeIcon(raw, cfg);
    written++;
    console.log(`+ ${name}  (${id})`);
  }

  if (!written) {
    console.error('\nNothing exported — registry left untouched.');
    process.exit(1);
  }

  // Alphabetical on every write: adding one icon should be a one-line diff.
  const sorted = Object.fromEntries(
    Object.keys(registry)
      .sort()
      .map((k) => [k, registry[k]]),
  );
  fs.mkdirSync(path.dirname(regPath), { recursive: true });
  fs.writeFileSync(regPath, JSON.stringify(sorted, null, 2) + '\n');

  const shown = path.relative(process.cwd(), regPath) || regPath;
  console.log(`\nRegistry: ${Object.keys(sorted).length} icons (${written} updated) → ${shown}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
