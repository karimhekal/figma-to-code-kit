/* eslint-disable */
/**
 * figma-drift — catch the design moving while the code stands still.
 *
 * WHY THIS EXISTS
 * ---------------
 * This pipeline reads a COMMITTED SNAPSHOT of the design: a variables export a designer dropped
 * into the repo, plus node ids captured by hand. That snapshot is what makes the kit work on any
 * Figma plan (the Variables REST API is Enterprise-only) — and it is also its one structural
 * weakness. When a designer changes a color today, nothing in the repo changes. The build is
 * green, the tests pass, the tokens still compile, and the app ships last month's design. There
 * is no error to see, which is exactly why this failure survives for months and then surfaces as
 * "why does the app not match the file?" in a review nobody scheduled.
 *
 * We cannot become live. We can become LOUD, and that is most of the practical difference.
 *
 * TWO LAYERS, BECAUSE THEY CATCH DIFFERENT FAILURES
 * -------------------------------------------------
 * LAYER 1 — the cheap tripwire (one API call, or none at all).
 *   a) The design file's `lastModified` versus the timestamp recorded when the baselines were
 *      captured. Somebody edited the design after the last time anyone here looked at it.
 *   b) A hash of the variables export ON DISK versus the hash the token build stamped into
 *      `variable-map.generated.json`. Someone dropped in a fresh export and never re-ran the
 *      build, so the generated tokens describe an export that is no longer the one sitting next
 *      to them. This check is entirely offline, and it is the more common of the two: dropping
 *      files in is the step a human does, and re-running the build is the step a human forgets.
 *
 * LAYER 2 — visual baselines (the real detector).
 *   Layer 1 only knows that SOMETHING moved. A token check cannot see a 4px padding tweak, a new
 *   disabled state, or a swapped icon — none of those touch a variable, so none of them change a
 *   single generated token. Rendered pixels see all three. `--update` renders your canonical
 *   components and stores the PNGs; the default run re-renders and compares per pixel, reporting
 *   how much changed, WHERE it changed, and writing a diff image somebody can actually open.
 *
 * WHAT TO BASELINE
 *   A handful of canonical components — a button, an input, a card. Not everything. This is meant
 *   to run on a schedule (a weekly CI job), each node costs a render, and forty baselines that
 *   nobody reads are worth less than three that somebody does.
 *
 * USAGE
 *   node scripts/figma-drift.js [--update] [--fail-on-drift] [--tolerance N]
 *                               [--scale N] [--file <key>] [--screens] [--baselines <dir>]
 *
 *   (default)          check: re-render the configured nodes and compare against the baselines
 *   --update           capture/refresh the baselines and record the file's lastModified
 *   --fail-on-drift    exit non-zero when anything drifted (this is the CI switch)
 *   --tolerance N      per-channel tolerance, default `drift.tolerance` (2) — encoder noise
 *   --scale N          render scale for --update, default 2 (a check always reuses the baseline's)
 *   --baselines <dir>  override `drift.baselineDir`
 *
 * DEGRADING
 *   Every input here is optional and every missing one turns a feature off with one `[warn]`:
 *   no token or no file key → layer 1(a) and layer 2 are off, the offline hash check still runs;
 *   no `drift.nodes` → layer 2 is off; no baselines yet → the run tells you to `--update` and
 *   exits 0; no `pngjs` → the compare falls back to whole-image content hashes, which still says
 *   "this changed", just not where.
 *
 * This file is also require()-able: config-check.js imports the export-hash check rather than
 * carrying a second copy of it. Per-script copies of a hash are how two "identical" hashes start
 * disagreeing, and then nobody trusts either one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadConfig, resolvePath } = require('./figma-config');
const { loadFigmaToken, fetchRetry } = require('./figma-net');

const MAP_NAME = 'variable-map.generated.json';
const BASELINE_INDEX = 'baseline.json';
const RENDER_SCRIPT = path.join(__dirname, 'figma-render.js');

// ─── the export hash (shared with build-tokens.js via the variable-map contract) ──────────────
// THE RECIPE, stated once so it can be reproduced exactly: take the export files that
// `variables.sources` actually routes (the FIRST match per source, which is what build-tokens
// uses), express each as a path relative to the export directory with `/` separators, sort those
// paths, concatenate the raw file BYTES in that order, sha256, keep the first 12 hex characters.
// Sorting by relative path (not by basename) is deliberate: an export with two same-named files in
// different mode folders would otherwise hash differently depending on which one was read first.

/**
 * Every file under `dir`, recursively, dot-FILES excluded. This mirrors build-tokens.js exactly,
 * down to descending into dot-directories: the hash only means anything if both scripts consider
 * the same set of files, and "close enough" here reads as a permanently stale token build.
 */
function listExportFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  })(dir);
  return out.filter((f) => !path.basename(f).startsWith('.')).sort();
}

/** The export files the token build reads, in config order. `{ dir, files }` or `{ dir, reason }`. */
function resolveExportSources(cfg) {
  const dir = resolvePath(cfg, cfg.paths.variablesExport);
  if (!dir || !fs.existsSync(dir)) {
    return { dir, reason: dir ? `no variables export at ${dir}` : 'paths.variablesExport is unset' };
  }
  const sources = Array.isArray(cfg.variables && cfg.variables.sources) ? cfg.variables.sources : [];
  if (!sources.length) return { dir, reason: 'variables.sources is empty' };

  let available;
  try {
    available = listExportFiles(dir);
  } catch (e) {
    return { dir, reason: `could not read the export directory: ${e.message}` };
  }

  const picked = [];
  for (const src of sources) {
    if (!src || !src.match) continue;
    let re;
    try {
      re = new RegExp(src.match, 'i');
    } catch {
      continue; // config-check reports a bad regex; here it just contributes nothing
    }
    const hit = available.find((f) => re.test(path.basename(f)));
    if (hit && !picked.includes(hit)) picked.push(hit);
  }
  if (!picked.length) return { dir, reason: 'no exported file matches any variables.sources pattern' };
  return { dir, files: picked };
}

/** `{ hash, sources }` for a resolved source set. See THE RECIPE above. */
function hashExport(dir, files) {
  const sources = files
    .map((f) => path.relative(dir, f).split(path.sep).join('/'))
    .sort();
  const h = crypto.createHash('sha256');
  for (const relPath of sources) h.update(fs.readFileSync(path.join(dir, relPath)));
  return { hash: h.digest('hex').slice(0, 12), sources };
}

/**
 * Compare the export on disk against the hash the token build recorded.
 *
 * States: `fresh` (they agree), `stale` (the export moved and the build did not re-run),
 * `unreadable` (the map is corrupt), `off` (+ `reason` — a prerequisite is missing, so this
 * check simply is not running).
 */
function exportHashStatus(cfg) {
  const tokensDir = resolvePath(cfg, cfg.paths.tokensDir);
  if (!tokensDir) return { state: 'off', reason: 'paths.tokensDir is not set' };

  const file = path.join(tokensDir, MAP_NAME);
  if (!fs.existsSync(file)) {
    return { state: 'off', file, reason: `${MAP_NAME} has not been generated yet` };
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { state: 'unreadable', file, reason: e.message };
  }
  const meta = (json && json.$meta) || {};
  const recorded = typeof meta.exportHash === 'string' ? meta.exportHash : null;
  if (!recorded) return { state: 'off', file, reason: `${MAP_NAME} carries no $meta.exportHash` };

  const src = resolveExportSources(cfg);
  if (!src.files) return { state: 'off', file, recorded, reason: src.reason };

  let current;
  try {
    current = hashExport(src.dir, src.files);
  } catch (e) {
    return { state: 'off', file, recorded, reason: `could not hash the export: ${e.message}` };
  }
  return {
    state: current.hash === recorded ? 'fresh' : 'stale',
    file,
    recorded,
    current: current.hash,
    sources: current.sources,
    recordedSources: Array.isArray(meta.sources) ? meta.sources : null,
    variableCount: typeof meta.variableCount === 'number' ? meta.variableCount : null,
  };
}

// ─── small shared helpers ─────────────────────────────────────────────────────
/** Node ids are written `1234:5678` (API) or `1234-5678` (URL); only the FIRST `-` is a separator. */
function normalizeId(id) {
  return String(id).replace('-', ':');
}

/** A filesystem-safe stem for a node's baseline images. */
function slugify(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'node';
}

function baseName(node) {
  return `${slugify(node.name)}-${normalizeId(node.id).replace(':', '-')}`;
}

function sha12(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

function daysBetween(a, b) {
  return Math.round(Math.abs(b - a) / 86400000);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
function main() {
  const cfg = loadConfig();
  const rel = (p) => (p ? path.relative(cfg.__root, p) || '.' : '(unset)');

  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      'Usage: node scripts/figma-drift.js [--update] [--fail-on-drift] [--tolerance N]\n' +
        '                                  [--scale N] [--file <key>] [--screens] [--baselines <dir>]',
    );
    process.exit(0);
  }

  const DRIFT = cfg.drift || {};
  let update = false;
  let failOnDrift = false;
  let tolerance = Number.isFinite(Number(DRIFT.tolerance)) ? Number(DRIFT.tolerance) : 2;
  let scaleFlag = null;
  let fileKeyFlag = null;
  let slot = 'default';
  let baselineDirFlag = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--update') update = true;
    else if (a === '--fail-on-drift') failOnDrift = true;
    else if (a === '--tolerance') tolerance = Number(argv[++i]);
    else if (a === '--scale') scaleFlag = Number(argv[++i]);
    else if (a === '--file') fileKeyFlag = argv[++i];
    else if (a === '--screens') slot = 'screens';
    else if (a === '--baselines') baselineDirFlag = argv[++i];
    else {
      console.error(`Unknown argument "${a}". Run with --help for the flag list.`);
      process.exit(1);
    }
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    console.error('--tolerance must be a number >= 0 (per 0-255 channel).');
    process.exit(1);
  }
  if (scaleFlag !== null && (!Number.isFinite(scaleFlag) || scaleFlag <= 0)) {
    console.error('--scale must be a positive number.');
    process.exit(1);
  }

  const green = (m) => `\x1b[32m${m}\x1b[0m`;
  const yellow = (m) => `\x1b[33m${m}\x1b[0m`;
  const red = (m) => `\x1b[31m${m}\x1b[0m`;
  const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
  const warn = (m) => console.log(`  ${yellow('[warn]')} ${m}`);

  const drifts = []; // one line per detected drift, replayed in the summary

  console.log(`\x1b[1mfigma-drift · has the design moved without us?\x1b[0m`);

  // ─── baselines on disk ──────────────────────────────────────────────────────
  const baselineDir = baselineDirFlag
    ? path.resolve(cfg.__root, baselineDirFlag)
    : resolvePath(cfg, DRIFT.baselineDir || 'figma-baselines');
  const indexPath = path.join(baselineDir, BASELINE_INDEX);

  let baseline = null;
  if (fs.existsSync(indexPath)) {
    try {
      baseline = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (e) {
      warn(`${rel(indexPath)} could not be parsed (${e.message}) — treating it as absent.`);
      baseline = null;
    }
  }
  const baseMeta = (baseline && baseline.$meta) || {};
  const baseNodes = (baseline && baseline.nodes) || {};

  // Scale is not a preference, it is part of the reference: re-baselining at a different scale
  // changes every recorded dimension, and the next check then reports "dimensions changed" on
  // components nobody touched. So an existing baseline's scale wins unless --scale says otherwise.
  const scale = scaleFlag !== null ? scaleFlag : Number(baseMeta.scale) > 0 ? Number(baseMeta.scale) : 2;

  // ─── configured nodes ───────────────────────────────────────────────────────
  const configured = (Array.isArray(DRIFT.nodes) ? DRIFT.nodes : [])
    .filter((n) => n && n.id)
    .map((n) => ({ id: normalizeId(n.id), name: n.name || n.id }));

  // ─── credentials + file key (both optional; both only gate the online halves) ─
  const token = loadFigmaToken(cfg);
  const fileKey = fileKeyFlag || (cfg.files && (cfg.files[slot] || cfg.files.default)) || null;

  // ─── LAYER 1a — the file's lastModified ─────────────────────────────────────
  section('Layer 1 · tripwire');

  let currentLastModified = null;
  const runLayer1a = async () => {
    if (!token) {
      warn(
        'no Figma access token — the lastModified tripwire is off. ' +
          'Set it (see auth.* in figma.config.json) to switch it on.',
      );
      return;
    }
    if (!fileKey) {
      warn('no Figma file key — the lastModified tripwire is off. Set files.default or pass --file.');
      return;
    }
    let json;
    try {
      // depth=1 returns the document and its pages only: the cheapest call that carries the
      // timestamp. Nothing here needs the node tree.
      const res = await fetchRetry(
        `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}?depth=1`,
        { headers: { 'X-Figma-Token': token } },
      );
      if (!res.ok) {
        warn(`HTTP ${res.status} asking Figma for the file — the lastModified tripwire is off.`);
        return;
      }
      json = await res.json();
    } catch (e) {
      warn(`could not reach Figma (${e.message}) — the lastModified tripwire is off.`);
      return;
    }

    currentLastModified = json.lastModified || null;
    console.log(`  design file    "${json.name}"`);
    console.log(`  lastModified   ${currentLastModified || '(not reported)'}`);

    const recorded = baseMeta.figmaLastModified || null;
    if (!recorded) {
      console.log(`  ${yellow('·')} no recorded timestamp yet — run --update to set the reference point.`);
      return;
    }
    console.log(`  baselined at   ${recorded}`);
    const then = Date.parse(recorded);
    const now = Date.parse(currentLastModified || '');
    if (!Number.isFinite(then) || !Number.isFinite(now)) {
      warn('one of the timestamps is unparseable — skipping the comparison.');
      return;
    }
    if (now > then) {
      const d = daysBetween(then, now);
      drifts.push('the design file was edited after the baselines were captured');
      console.log(
        `  ${red('✗')} the design file has been edited since the baselines were captured ` +
          `(${d} day${d === 1 ? '' : 's'} later).`,
      );
      console.log('      → ask design what changed, then, in order:');
      console.log('        1. re-export the variables into ' + (cfg.paths.variablesExport || 'the export directory') + '/');
      console.log(
        '        2. re-run the token build' +
          (cfg.commands && cfg.commands.tokensBuild ? ` (\`${cfg.commands.tokensBuild}\`)` : ''),
      );
      console.log('        3. re-check the visual baselines here, and --update once you accept the change');
    } else {
      console.log(`  ${green('✓')} the design file has not been touched since the baselines were captured.`);
    }
  };

  // ─── LAYER 1b — export on disk vs the hash the token build recorded ──────────
  const runLayer1b = () => {
    const status = exportHashStatus(cfg);
    if (status.state === 'off') {
      warn(`token-build freshness check is off — ${status.reason}.`);
      return;
    }
    if (status.state === 'unreadable') {
      warn(`${rel(status.file)} could not be parsed (${status.reason}) — freshness check is off.`);
      return;
    }
    console.log(`  export on disk ${status.sources.length} file(s), hash ${status.current}`);
    console.log(`  token build    ${MAP_NAME} recorded ${status.recorded}`);
    if (status.state === 'fresh') {
      console.log(`  ${green('✓')} the generated tokens were built from the export that is on disk.`);
      return;
    }
    drifts.push('the variables export changed without the token build re-running');
    console.log(
      `  ${red('✗')} the export on disk is NOT the one the tokens were generated from — ` +
        'the token build never re-ran.',
    );
    if (status.recordedSources) {
      const added = status.sources.filter((s) => !status.recordedSources.includes(s));
      const removed = status.recordedSources.filter((s) => !status.sources.includes(s));
      if (added.length) console.log(`      new file(s):     ${added.join(', ')}`);
      if (removed.length) console.log(`      missing file(s): ${removed.join(', ')}`);
      if (!added.length && !removed.length) {
        console.log('      same files, different contents — a value inside the export changed.');
      }
    }
    console.log(
      `      → run \`${(cfg.commands && cfg.commands.tokensBuild) || 'node scripts/build-tokens.js'}\`` +
        ' and review the diff in the generated token modules.',
    );
  };

  // ─── LAYER 2 — visual baselines ─────────────────────────────────────────────
  /** Render every id into `dir` by delegating to figma-render.js. Returns a map id -> png path. */
  const renderNodes = (ids, dir, atScale) => {
    fs.mkdirSync(dir, { recursive: true });
    const args = [RENDER_SCRIPT, ...ids, '--out', dir, '--scale', String(atScale)];
    if (fileKeyFlag) args.push('--file', fileKeyFlag);
    else if (slot === 'screens') args.push('--screens');
    // Delegating rather than re-implementing: figma-render already retries the images API's
    // 200-with-{err:"Render timeout"} quirk, which a plain fetch loop misses.
    const res = spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env });
    if (res.error) return { error: res.error.message };
    if (res.status !== 0) {
      return { error: (res.stderr || res.stdout || `figma-render exited ${res.status}`).trim() };
    }
    const out = {};
    for (const id of ids) {
      const p = path.join(dir, `figma-${normalizeId(id).replace(':', '-')}.png`);
      if (fs.existsSync(p)) out[id] = p;
    }
    return { images: out };
  };

  let PNG = null;
  try {
    ({ PNG } = require('pngjs'));
  } catch {
    PNG = null;
  }

  /** Per-pixel comparison. Returns `{ kind, ... }` — never throws on a bad PNG. */
  const comparePngs = (basePath, newPath) => {
    if (!PNG) {
      // Degraded mode: a content hash still answers "did this change?", just not "where".
      const same = sha12(fs.readFileSync(basePath)) === sha12(fs.readFileSync(newPath));
      return { kind: same ? 'identical' : 'changed-hash-only' };
    }
    let a;
    let b;
    try {
      a = PNG.sync.read(fs.readFileSync(basePath));
      b = PNG.sync.read(fs.readFileSync(newPath));
    } catch (e) {
      return { kind: 'unreadable', reason: e.message };
    }
    if (a.width !== b.width || a.height !== b.height) {
      return { kind: 'resized', from: [a.width, a.height], to: [b.width, b.height] };
    }
    const total = a.width * a.height;
    const changed = new Uint8Array(total);
    let count = 0;
    let minX = a.width;
    let minY = a.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < a.height; y++) {
      for (let x = 0; x < a.width; x++) {
        const i = (y * a.width + x) * 4;
        const aa = a.data[i + 3];
        const ba = b.data[i + 3];
        // Both effectively transparent: the RGB under a zero alpha is whatever the encoder felt
        // like writing, so comparing it invents differences that nobody can see.
        if (aa <= tolerance && ba <= tolerance) continue;
        const diff =
          Math.abs(a.data[i] - b.data[i]) > tolerance ||
          Math.abs(a.data[i + 1] - b.data[i + 1]) > tolerance ||
          Math.abs(a.data[i + 2] - b.data[i + 2]) > tolerance ||
          Math.abs(aa - ba) > tolerance;
        if (!diff) continue;
        changed[y * a.width + x] = 1;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (!count) return { kind: 'identical' };
    return {
      kind: 'differs',
      count,
      total,
      percent: (count / total) * 100,
      bbox: [minX, minY, maxX, maxY],
      changed,
      width: a.width,
      height: a.height,
      newPng: b,
    };
  };

  /**
   * The diff image: the new render, composited over white and washed out, with every changed
   * pixel painted magenta and a cyan box around the changed region. The wash matters — a diff
   * that keeps full contrast makes a 0.3% change impossible to spot, and the box finds it even
   * when the change is a handful of pixels.
   */
  const writeDiffPng = (cmp, outPath) => {
    if (!PNG) return null;
    const { width, height, changed, newPng, bbox } = cmp;
    const out = new PNG({ width, height });
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      if (changed[i]) {
        out.data[o] = 255;
        out.data[o + 1] = 0;
        out.data[o + 2] = 128;
        out.data[o + 3] = 255;
        continue;
      }
      const alpha = newPng.data[o + 3] / 255;
      const r = newPng.data[o] * alpha + 255 * (1 - alpha);
      const g = newPng.data[o + 1] * alpha + 255 * (1 - alpha);
      const b = newPng.data[o + 2] * alpha + 255 * (1 - alpha);
      const grey = 0.299 * r + 0.587 * g + 0.114 * b;
      const washed = Math.round(grey + (255 - grey) * 0.55);
      out.data[o] = washed;
      out.data[o + 1] = washed;
      out.data[o + 2] = washed;
      out.data[o + 3] = 255;
    }
    const [x0, y0, x1, y1] = bbox;
    const dot = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const o = (y * width + x) * 4;
      out.data[o] = 0;
      out.data[o + 1] = 160;
      out.data[o + 2] = 255;
      out.data[o + 3] = 255;
    };
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      dot(x, y0 - 1);
      dot(x, y1 + 1);
    }
    for (let y = y0 - 1; y <= y1 + 1; y++) {
      dot(x0 - 1, y);
      dot(x1 + 1, y);
    }
    try {
      fs.writeFileSync(outPath, PNG.sync.write(out));
      return outPath;
    } catch (e) {
      warn(`could not write ${rel(outPath)}: ${e.message}`);
      return null;
    }
  };

  const runUpdate = () => {
    section(`Layer 2 · capturing baselines → ${rel(baselineDir)}`);
    fs.mkdirSync(baselineDir, { recursive: true });

    // A failed capture must never blank the index: a --update that cannot reach Figma would
    // otherwise delete every reference this whole script depends on, and the next check would
    // report a clean bill of health because there is nothing left to compare against.
    let nodes = {};
    let preserveExisting = false;
    if (!configured.length) {
      warn('drift.nodes is empty — there is nothing to render, so only the timestamp is recorded.');
      console.log('      → add your canonical components, e.g.');
      console.log('        "drift": { "nodes": [{ "id": "1234:5678", "name": "button" }] }');
    } else if (!token || !fileKey) {
      preserveExisting = true;
      warn(
        `cannot render without ${!token ? 'an access token' : 'a file key'} — ` +
          'baselines were not captured, the existing ones are kept.',
      );
    } else {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-drift-'));
      const rendered = renderNodes(configured.map((n) => n.id), tmp, scale);
      if (rendered.error) {
        preserveExisting = true;
        warn(`render failed — the existing baselines are kept:\n      ${rendered.error}`);
      } else {
        for (const node of configured) {
          const src = rendered.images[node.id];
          const stem = baseName(node);
          if (!src) {
            console.log(`  ${red('✗')} ${node.name.padEnd(18)} ${node.id}  no image returned`);
            console.log('      → the node id may be dead (a republished file renumbers every id).');
            continue;
          }
          const dest = path.join(baselineDir, `${stem}.png`);
          const buf = fs.readFileSync(src);
          fs.writeFileSync(dest, buf);
          const entry = { name: node.name, file: `${stem}.png`, hash: sha12(buf) };
          if (PNG) {
            try {
              const png = PNG.sync.read(buf);
              entry.width = png.width;
              entry.height = png.height;
            } catch {
              /* dimensions are a convenience; a render we cannot parse still baselines by hash */
            }
          }
          nodes[node.id] = entry;
          const dims = entry.width ? `${entry.width}x${entry.height}` : 'dimensions unknown';
          console.log(`  ${green('✓')} ${node.name.padEnd(18)} ${node.id}  ${dims}  → ${entry.file}`);
          // Renaming a node in the config changes its image filename, orphaning the old PNG.
          // Say so, rather than leaving a plausible-looking stale baseline in the directory.
          const previous = baseNodes[node.id];
          if (previous && previous.file && previous.file !== entry.file) {
            console.log(`      renamed from ${previous.file} — that file is now unused`);
          }
        }
      }
    }

    if (preserveExisting) {
      nodes = { ...baseNodes, ...nodes };
    } else {
      for (const id of Object.keys(baseNodes)) {
        if (nodes[id]) continue;
        const was = baseNodes[id];
        console.log(`  ${yellow('·')} dropped ${(was && was.name) || id} (${id}) — no longer in drift.nodes`);
        if (was && was.file) console.log(`      ${rel(path.join(baselineDir, was.file))} is now unused`);
      }
    }

    const meta = {
      generator: 'figma-drift.js',
      capturedAt: new Date().toISOString(),
      fileKey: fileKey || baseMeta.fileKey || null,
      figmaLastModified: currentLastModified || baseMeta.figmaLastModified || null,
      // A check always re-renders at the baseline's scale, so this field is load-bearing: change
      // it and every dimension changes with it.
      scale: preserveExisting && Number(baseMeta.scale) > 0 ? Number(baseMeta.scale) : scale,
      tolerance,
    };
    fs.writeFileSync(indexPath, `${JSON.stringify({ $meta: meta, nodes }, null, 2)}\n`);
    console.log(`\n  wrote ${rel(indexPath)} — commit it with the PNGs so the next run has a reference.`);
    if (!meta.figmaLastModified) {
      warn('no lastModified could be recorded (Figma was not reached) — the tripwire stays off.');
    }
  };

  const runCheck = () => {
    section('Layer 2 · visual baselines');
    if (!configured.length) {
      warn('drift.nodes is empty — layer 2 is off, so a spacing or icon change cannot be seen.');
      console.log('      → name a few canonical components in figma.config.json, then run --update:');
      console.log('        "drift": { "nodes": [{ "id": "1234:5678", "name": "button" }] }');
      return;
    }
    if (!baseline || !Object.keys(baseNodes).length) {
      console.log(`  no baselines in ${rel(baselineDir)} yet.`);
      console.log('      → run `node scripts/figma-drift.js --update` once, review the PNGs, commit them.');
      return;
    }
    if (baseMeta.fileKey && fileKey && baseMeta.fileKey !== fileKey) {
      warn('these baselines were captured against a different file key — comparisons are meaningless.');
      console.log('      → re-run --update against the current file.');
      return;
    }
    if (!token || !fileKey) {
      warn(
        `cannot re-render without ${!token ? 'an access token' : 'a file key'} — layer 2 is off.`,
      );
      return;
    }
    if (!PNG) {
      warn("pngjs is not installed — comparing whole-image hashes only, so no percentages or bounding boxes.");
    }

    const pending = configured.filter((n) => !baseNodes[n.id]);
    const known = configured.filter((n) => baseNodes[n.id]);
    for (const n of pending) {
      console.log(`  ${yellow('·')} ${n.name.padEnd(18)} ${n.id}  not baselined yet — run --update`);
    }
    const orphans = Object.keys(baseNodes).filter((id) => !configured.some((n) => n.id === id));
    for (const id of orphans) {
      const was = baseNodes[id];
      console.log(`  ${yellow('·')} ${((was && was.name) || id).padEnd(18)} ${id}  baselined but no longer configured`);
    }
    if (!known.length) {
      console.log('      → nothing to compare. Run --update.');
      return;
    }

    // Always re-render at the scale the baselines were taken at: a different scale changes every
    // dimension, and the whole run then reports "definite change" on components nobody touched.
    const atScale = Number(baseMeta.scale) > 0 ? Number(baseMeta.scale) : scale;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-drift-'));
    const rendered = renderNodes(known.map((n) => n.id), tmp, atScale);
    if (rendered.error) {
      warn(`render failed — layer 2 could not run:\n      ${rendered.error}`);
      return;
    }

    let differing = 0;
    for (const node of known) {
      const entry = baseNodes[node.id];
      const label = String(entry.name || node.name).padEnd(18);
      const basePath = path.join(baselineDir, entry.file || '');
      const newPath = rendered.images[node.id];

      if (!newPath) {
        differing++;
        drifts.push(`${node.name} no longer renders`);
        console.log(`  ${red('✗')} ${label} ${node.id}  no image returned by Figma`);
        console.log('      → the node id may be dead: a republished file renumbers every id.');
        continue;
      }
      if (!entry.file || !fs.existsSync(basePath)) {
        console.log(`  ${yellow('·')} ${label} ${node.id}  baseline image is missing — run --update`);
        continue;
      }

      const cmp = comparePngs(basePath, newPath);
      if (cmp.kind === 'identical') {
        console.log(`  ${green('✓')} ${label} ${node.id}  identical`);
        continue;
      }
      differing++;
      drifts.push(`${node.name} changed`);

      if (cmp.kind === 'unreadable') {
        console.log(`  ${red('✗')} ${label} ${node.id}  could not be compared: ${cmp.reason}`);
        continue;
      }
      if (cmp.kind === 'changed-hash-only') {
        console.log(`  ${red('✗')} ${label} ${node.id}  changed (hash comparison — install pngjs for detail)`);
        console.log(`      new render: ${newPath}`);
        continue;
      }
      if (cmp.kind === 'resized') {
        // Not an approximation and not a tolerance question: the component is a different size.
        const copy = path.join(baselineDir, `${baseName(node)}.current.png`);
        try {
          fs.copyFileSync(newPath, copy);
        } catch {
          /* the temp path below is still printed */
        }
        console.log(
          `  ${red('✗')} ${label} ${node.id}  dimensions changed ` +
            `${cmp.from[0]}x${cmp.from[1]} → ${cmp.to[0]}x${cmp.to[1]}`,
        );
        console.log(`      new render: ${fs.existsSync(copy) ? rel(copy) : newPath}`);
        continue;
      }

      const [x0, y0, x1, y1] = cmp.bbox;
      const pct = cmp.percent < 0.01 ? '<0.01' : cmp.percent.toFixed(2);
      const d = (v) => Math.round(v / atScale);
      console.log(
        `  ${red('✗')} ${label} ${node.id}  ${pct}% of pixels differ ` +
          `(${cmp.count.toLocaleString('en-US')} of ${cmp.total.toLocaleString('en-US')})`,
      );
      console.log(
        `      changed region  x ${x0}-${x1}, y ${y0}-${y1} px` +
          `  ·  x ${d(x0)}-${d(x1)}, y ${d(y0)}-${d(y1)} at 1×`,
      );
      const diffPath = writeDiffPng(cmp, path.join(baselineDir, `${baseName(node)}.diff.png`));
      if (diffPath) console.log(`      diff: ${rel(diffPath)}  (magenta = changed, cyan box = region)`);
      console.log(`      new render: ${newPath}`);
    }

    if (differing) {
      console.log(
        `\n  ${differing} of ${known.length} baselined node(s) changed. ` +
          'Review the diffs, then --update to accept them as the new reference.',
      );
    } else {
      // Nothing changed, so nothing needs looking at — clear the scratch renders away.
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not worth a failure */
      }
    }
  };

  // ─── run ────────────────────────────────────────────────────────────────────
  (async () => {
    await runLayer1a();
    runLayer1b();
    if (update) runUpdate();
    else runCheck();

    console.log(`\n${'─'.repeat(72)}`);
    if (update) {
      console.log('baselines updated. Commit them — an uncommitted baseline detects nothing.');
      process.exit(0);
    }
    if (!drifts.length) {
      console.log(green('no drift detected.'));
      process.exit(0);
    }
    console.log(red(`drift detected (${drifts.length}):`));
    for (const d of drifts) console.log(`  · ${d}`);
    console.log(
      '\nDrift is not automatically a defect — it is a design change nobody has looked at yet.\n' +
        'Decide whether the code should follow it, then re-baseline with --update.',
    );
    process.exit(failOnDrift ? 1 : 0);
  })();
}

if (require.main === module) main();

module.exports = {
  exportHashStatus,
  hashExport,
  resolveExportSources,
  listExportFiles,
  normalizeId,
  MAP_NAME,
  BASELINE_INDEX,
};
