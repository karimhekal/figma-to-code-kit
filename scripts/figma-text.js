/* eslint-disable */
/**
 * figma-text — pull every piece of translatable copy out of a Figma node (a section, a page, a
 * screen frame), grouped by screen and in reading order, so it can be turned into translation
 * keys without anyone retyping a string.
 *
 *   node scripts/figma-text.js <nodeId> [--file <key>] [--rtl] [--json]
 *   e.g. node scripts/figma-text.js 1234:5678 --json > copy.json
 *
 * It walks the node tree, takes each TEXT node's `characters` plus its absolute box, sorts into
 * reading order, collapses whitespace, drops noise and de-duplicates within a screen.
 *
 * WHY THE FILE KEY DEFAULTS TO THE `screens` SLOT
 * Copy lives in the product/screens file, not in the design-system library — the library holds
 * components whose text is placeholder ("Label", "Button"). Most orgs really do split the two
 * files, so this script asks for `files.screens` and falls back to `files.default` when there is
 * only one file. `--file` overrides both.
 *
 * READING ORDER, AND `--rtl`
 * Rows are ordered top→bottom; within a row, columns are ordered start→end. "Start" is not a
 * fixed side: for an LTR frame it is the left, for an RTL frame it is the right. Sorting x
 * ascending — the obvious implementation — is correct only for LTR, and silently reads an RTL
 * screen backwards while its own docstring claims "start→end". `--rtl`
 * (or `text.rtl: true` in the config) flips the secondary sort to x-descending. Mixed-direction
 * files: run it once per direction over the relevant sections.
 *
 * Rows are grouped with a small vertical tolerance before the column sort, because two labels
 * sitting side by side almost never share an exact `y` — different type sizes put their boxes a
 * few px apart. Comparing raw `y` first means the column sort essentially never runs, and the
 * direction question above never even gets asked.
 *
 * NOISE FILTERING IS ENTIRELY YOURS
 * Only one filter is built in — the status-bar clock (`9:41`), which is a screenshot artifact in
 * every mobile file on earth, in every language. Everything else is locale- and
 * library-specific and comes from the config: `text.noiseWords` for exact placeholder strings
 * ("Title", "Label", your locale's equivalents) and `text.noisePatterns` for regex sources
 * (pure numbers, currency formats, dates). An unparseable pattern is reported and skipped rather
 * than taking the run down.
 *
 * NOTE: the API returns hidden layers too, so copy from a hidden variant of a screen shows up
 * alongside the visible copy. If a string appears that you cannot find in the design, that is
 * usually why.
 *
 * Config used: `files.screens` (or `--file`), `text.noiseWords`, `text.noisePatterns`,
 * `text.rtl`, `auth.*`. Node 18+ (global fetch), zero dependencies.
 */
const { fetchRetry, requireFigmaToken } = require('./figma-net');
const { loadConfig, requireFileKey } = require('./figma-config');

const USAGE = 'Usage: node scripts/figma-text.js <nodeId> [--file <key>] [--rtl] [--json]';

/**
 * Two text boxes are on the same visual row when their tops are within this many pixels. Small
 * enough not to merge two genuine lines of a paragraph, large enough to catch a caption sitting
 * next to a title.
 */
const ROW_TOLERANCE_PX = 6;

/** Figma's URLs use `1234-5678`, the API uses `1234:5678`. Swap the FIRST hyphen only. */
function apiNodeId(id) {
  return id.replace('-', ':');
}

function parseArgs(argv) {
  let nodeId = null;
  let fileKey = null;
  let asJson = false;
  let rtl = null; // null = "not specified on the CLI", so the config decides

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') {
      fileKey = argv[++i];
      if (!fileKey) {
        console.error(`--file needs a value.\n${USAGE}`);
        process.exit(1);
      }
      continue;
    }
    if (arg === '--json') {
      asJson = true;
      continue;
    }
    if (arg === '--rtl') {
      rtl = true;
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
    nodeId = arg;
  }

  return { nodeId, fileKey, asJson, rtl };
}

/**
 * Build the noise test from config. Exact-match words are cheap; patterns are compiled once here
 * so a typo is reported with its source string instead of throwing per-line, mid-run.
 */
function buildNoiseFilter(cfg) {
  const words = new Set((cfg.text && cfg.text.noiseWords) || []);

  const patterns = [];
  for (const source of (cfg.text && cfg.text.noisePatterns) || []) {
    try {
      patterns.push(new RegExp(source));
    } catch (e) {
      console.warn(
        `[figma-text] Skipping invalid text.noisePatterns entry ${JSON.stringify(source)}: ${e.message}`,
      );
    }
  }

  // The one built-in: a status-bar clock is a screenshot artifact, never copy — and it looks the
  // same in every locale.
  const CLOCK = /^\d{1,2}:\d{2}$/;

  return function isNoise(s) {
    if (!s) return true;
    if (CLOCK.test(s)) return true;
    if (words.has(s)) return true;
    return patterns.some((re) => re.test(s));
  };
}

/** Every TEXT node under `node`, with the absolute box we sort by. */
function collectText(node, acc = []) {
  if (node.type === 'TEXT' && node.characters) {
    const box = node.absoluteBoundingBox || {};
    acc.push({ text: node.characters, x: box.x || 0, y: box.y || 0 });
  }
  (node.children || []).forEach((c) => collectText(c, acc));
  return acc;
}

/**
 * Reading order: bucket into rows top→bottom, then order each row start→end.
 *
 * Bucketing (rather than a single comparator with a tolerance) keeps the sort a strict weak
 * ordering — a "within N px counts as equal" comparator is not transitive and gives different
 * results depending on the input order.
 */
function readingOrder(items, rtl) {
  const byY = [...items].sort((a, b) => a.y - b.y);
  const rows = [];
  for (const item of byY) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(item.y - row.top) <= ROW_TOLERANCE_PX) row.items.push(item);
    else rows.push({ top: item.y, items: [item] });
  }
  const columns = rtl ? (a, b) => b.x - a.x : (a, b) => a.x - b.x;
  return rows.flatMap((row) => row.items.sort(columns));
}

(async () => {
  const { nodeId, fileKey: fileFlag, asJson, rtl: rtlFlag } = parseArgs(process.argv.slice(2));
  if (!nodeId) {
    console.error(USAGE);
    process.exit(1);
  }

  const cfg = loadConfig();
  const fileKey = requireFileKey(cfg, fileFlag, 'screens');
  const rtl = rtlFlag === null ? Boolean(cfg.text && cfg.text.rtl) : rtlFlag;
  const isNoise = buildNoiseFilter(cfg);
  const token = requireFigmaToken(cfg);

  const id = apiNodeId(nodeId);
  const res = await fetchRetry(
    `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(id)}`,
    { headers: { 'X-Figma-Token': token } },
  );
  const data = await res.json();
  const wrap = data.nodes && (data.nodes[id] || Object.values(data.nodes)[0]);
  if (!wrap || !wrap.document) {
    console.error('Node not found:', nodeId, JSON.stringify(data).slice(0, 200));
    process.exit(1);
  }
  const root = wrap.document;

  // When the node is a section / page / group, its direct children ARE the screens — group by
  // them so the output maps onto screens instead of arriving as one undifferentiated list.
  // Children with no children of their own are decoration, not screens.
  const isContainer = ['SECTION', 'CANVAS', 'GROUP'].includes(root.type);
  const screens =
    isContainer && (root.children || []).length
      ? root.children.filter((n) => (n.children || []).length)
      : [root];

  const out = {};
  for (const screen of screens) {
    const seen = new Set();
    out[screen.name] = readingOrder(collectText(screen), rtl)
      .map((t) => t.text.replace(/\s+/g, ' ').trim())
      .filter((t) => !isNoise(t))
      // De-dupe WITHIN a screen only: the same word repeating across screens is normal, and
      // dropping the later ones would hide it from whoever is writing the keys.
      .filter((t) => (seen.has(t) ? false : seen.add(t)));
  }

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const total = Object.values(out).reduce((n, list) => n + list.length, 0);
  console.log(`# ${root.name} — ${total} strings${rtl ? ' (RTL reading order)' : ''}\n`);
  for (const [name, texts] of Object.entries(out)) {
    console.log(`## ${name}  (${texts.length})`);
    texts.forEach((t) => console.log('- ' + t));
    console.log('');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
