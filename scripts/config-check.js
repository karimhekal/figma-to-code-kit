/* eslint-disable */
/**
 * config-check — validate `figma.config.json` against the repository it claims to describe.
 *
 * Every other script in this kit degrades gracefully on purpose: an unset optional field turns a
 * feature off with a one-line `[warn]` and the run continues. That is the right behaviour at 2am
 * mid-task, and the wrong behaviour over six months — because config rot is silent. Someone moves
 * the token modules, renames an export, re-runs the Figma variables export and the filenames come
 * back different, or deletes the showcase screen. Nothing crashes. The extractor simply stops
 * suggesting tokens, and every value it prints starts looking like a literal. You find out in QA.
 *
 * This is the one script that is LOUD. It checks the config against the filesystem, loads the
 * modules it names, and confirms the exports it claims actually exist — then prints ✓ / ⚠ / ✗ and
 * exits non-zero if anything is broken. Run it in CI, and after any refactor that moves files.
 *
 * The classification rule that makes the report useful:
 *   • a field left UNSET (or holding a built-in default) is a ⚠ — the feature is simply off
 *   • a field the config EXPLICITLY names that isn't there is a ✗ — you pointed at something that
 *     doesn't exist, which is exactly the rot this exists to catch
 * Telling those apart needs the raw config file, not the defaults-merged object, so it is re-read
 * here to see which keys the user actually wrote.
 *
 * Safety: this script never prints the access token or any part of it (it reports FOUND/MISSING),
 * and it never EXECUTES anything from `commands.*` — running a project's build command as a
 * side effect of a validation pass is not a trade anyone agreed to. Commands are resolved
 * statically instead: against `package.json` scripts, or as a file on disk.
 *
 * Zero dependencies — Node 18+ for global `fetch`.
 *
 * Usage: node scripts/config-check.js [--online]
 *
 *   --online   make ONE cheap Figma call (`GET /v1/files/<key>?depth=1`) to prove the token can
 *              actually read `files.default`, and print that file's lastModified. Offline by
 *              default so the check stays free and runnable in CI without a secret.
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, resolvePath, loadTokenModule } = require('./figma-config');
const { loadFigmaToken, fetchRetry } = require('./figma-net');
const { exportHashStatus, normalizeId, MAP_NAME, BASELINE_INDEX } = require('./figma-drift');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: node scripts/config-check.js [--online]');
  process.exit(0);
}
const ONLINE = argv.includes('--online');

const cfg = loadConfig();
const rel = (p) => (p ? path.relative(cfg.__root, p) || '.' : '(unset)');

// ─── report primitives ────────────────────────────────────────────────────────
let oks = 0;
let warns = 0;
let errs = 0;

const ok = (m) => (oks++, console.log(`  \x1b[32m✓\x1b[0m ${m}`));
const warn = (m) => (warns++, console.log(`  \x1b[33m⚠\x1b[0m ${m}`));
const bad = (m) => (errs++, console.log(`  \x1b[31m✗\x1b[0m ${m}`));
const note = (m) => console.log(`    ${m}`);
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// ─── which keys did the user actually write? ──────────────────────────────────
// `loadConfig()` returns DEFAULTS deep-merged with the file, so by the time we see it there is no
// way to tell `"variablesExport": "figma-variables"` (typed by a human, must exist) from the
// identical built-in default (nobody asked for it, absence is fine). Re-read the raw file — the
// same tolerant parse figma-config uses — and consult it before calling a missing path an error.
let rawUser = {};
if (cfg.__file) {
  try {
    rawUser = JSON.parse(fs.readFileSync(cfg.__file, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  } catch {
    rawUser = {}; // loadConfig() already exits on a parse failure; this is belt-and-braces.
  }
}

/** Did the config file itself set this dotted key? (`paths.fontSources` → true/false) */
function isExplicit(dotted) {
  let cur = rawUser;
  for (const part of dotted.split('.')) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return false;
    cur = cur[part];
  }
  return cur !== null && cur !== undefined;
}

// ─── filesystem helpers ───────────────────────────────────────────────────────
/** Every file under `dir`, recursively, dotfiles excluded — what build-tokens.js sees. */
function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  })(dir);
  return out.sort();
}

/**
 * Check one configured path. `key` is the dotted config key, `offNote` says what turns off when it
 * is unset, `generatedBy` names the command that creates it (so a "not built yet" failure reads as
 * an instruction rather than a mystery). Returns the absolute path when it exists, else null.
 */
function checkPath(key, value, offNote, generatedBy) {
  if (!value) {
    warn(`${key} unset — ${offNote}`);
    return null;
  }
  const abs = resolvePath(cfg, value);
  if (fs.existsSync(abs)) {
    ok(`${key} → ${value}`);
    return abs;
  }
  const hint = generatedBy ? ` Not generated yet? Run \`${generatedBy}\`.` : '';
  if (isExplicit(key)) {
    bad(`${key} → ${value} does not exist.${hint || ' Fix the path, or remove the field.'}`);
  } else {
    // A built-in default nobody asked for. Absence just means the feature isn't in use here.
    warn(`${key} defaults to "${value}", which does not exist — ${offNote}`);
  }
  return null;
}

/** Count leaf values in a token tree — "how much did this module actually contribute". */
function countLeaves(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v !== 'object') return 1;
  return Object.values(v).reduce((n, x) => n + countLeaves(x), 0);
}

console.log('\x1b[1mfigma-to-code-kit · config check\x1b[0m');

// ─── 1. the config file itself ────────────────────────────────────────────────
section('Config file');
if (cfg.__file) {
  ok(`found ${cfg.__file}`);
} else {
  // Not fatal by itself — the scripts run on defaults — but nothing below can be configured, so
  // expect this to cascade into a files.default error.
  warn(
    `no figma.config.json found (searched upward from ${process.cwd()}) — running on built-in defaults.`,
  );
  note('Copy figma.config.example.json to figma.config.json at your project root.');
}
note(`project root: ${cfg.__root}`);

// ─── 2. Figma file keys ───────────────────────────────────────────────────────
// Keys are the 22-ish character token out of a Figma URL: figma.com/design/<FILE_KEY>/<name>.
// The shape check is a warning, never a hard failure: Figma has changed key length before and a
// working key that merely looks unusual must not fail anyone's CI.
const KEY_SHAPE = /^[A-Za-z0-9]{20,26}$/;

function checkFileKey(key, value, required) {
  if (!value) {
    if (required) {
      bad(`${key} is not set — every script needs it (or an explicit --file <key> on each call).`);
      note('Take it from the file URL: figma.com/design/<FILE_KEY>/<name>');
    } else {
      warn(`${key} unset — calls that ask for the "${key.split('.')[1]}" slot fall back to default.`);
    }
    return;
  }
  if (/PUT_YOUR|_HERE/.test(value)) {
    bad(`${key} is still the example placeholder — fill in your real file key.`);
    return;
  }
  if (/^https?:\/\//i.test(value)) {
    const m = value.match(/\/(?:file|design)\/([A-Za-z0-9]+)/);
    warn(`${key} looks like a full URL, not a key.${m ? ` Use just: ${m[1]}` : ''}`);
    return;
  }
  if (!KEY_SHAPE.test(value)) {
    warn(`${key} = "${value}" does not look like a Figma file key (expected ~22 alphanumerics).`);
    return;
  }
  ok(`${key} = ${value}`);
}

section('Figma files');
checkFileKey('files.default', cfg.files.default, true);
checkFileKey('files.screens', cfg.files.screens, false);

const volatile = Array.isArray(cfg.files.volatile) ? cfg.files.volatile : [];
if (volatile.length) {
  // `volatile` names files that get republished wholesale, renumbering every node id. It may hold
  // either a slot name ("screens") or a raw key; anything else is a typo that silently disables
  // the staleness warning the skill relies on.
  const slots = Object.keys(cfg.files).filter((k) => k !== 'volatile');
  const unknown = volatile.filter((v) => !slots.includes(v) && !Object.values(cfg.files).includes(v));
  if (unknown.length) {
    warn(`files.volatile names ${unknown.map((u) => `"${u}"`).join(', ')} — not a slot or a key.`);
    note(`Known slots: ${slots.join(', ')}`);
  } else {
    ok(`files.volatile: ${volatile.join(', ')} (node ids there are treated as perishable)`);
  }
} else {
  warn('files.volatile is empty — no file is marked as renumbering its node ids on republish.');
}

// ─── 3. credentials ───────────────────────────────────────────────────────────
section('Access token');
const envVar = (cfg.auth && cfg.auth.envVar) || 'FIGMA_ACCESS_TOKEN';
const envFile = cfg.auth ? cfg.auth.envFile : null;
const token = loadFigmaToken(cfg);
if (token) {
  // Report only WHERE it came from. Never the value, never a prefix, never a length.
  const from = process.env[envVar] ? `environment ($${envVar})` : `${envFile}`;
  ok(`${envVar}: FOUND (from ${from})`);
} else {
  bad(`${envVar}: MISSING — no environment variable and nothing readable in ${envFile || '(auth.envFile unset)'}.`);
  note('Mint one at Figma → Settings → Security → Personal access tokens (file content: read).');
}
if (envFile) {
  const abs = resolvePath(cfg, envFile);
  const gitignore = path.join(cfg.__root, '.gitignore');
  const ignored =
    fs.existsSync(gitignore) &&
    fs
      .readFileSync(gitignore, 'utf8')
      .split('\n')
      .some((l) => l.trim() && !l.trim().startsWith('#') && envFile.includes(l.trim().replace(/^\/+|\/+$/g, '')));
  if (fs.existsSync(abs) && !ignored) {
    // The single worst outcome this kit can produce is a committed token, so it gets its own check.
    bad(`${envFile} exists but does not appear to be gitignored — a committed token must be revoked.`);
  }
}

// ─── 4. paths ─────────────────────────────────────────────────────────────────
section('Paths');
const tokensBuildCmd = (cfg.commands && cfg.commands.tokensBuild) || 'node scripts/build-tokens.js';
checkPath('paths.tokensDir', cfg.paths.tokensDir, 'generated token modules have nowhere to go', tokensBuildCmd);
const varsDir = checkPath(
  'paths.variablesExport',
  cfg.paths.variablesExport,
  'the token build has no export to read',
);
checkPath('paths.iconRegistry', cfg.paths.iconRegistry, 'figma-icon has no registry to upsert into', 'node scripts/figma-icon.js <nodeId>=<name>');
checkPath('paths.graphicsDir', cfg.paths.graphicsDir, 'figma-asset needs --out on every call');
checkPath('paths.fontSources', cfg.paths.fontSources, 'the font-metrics patch has no pristine input');
checkPath('paths.fontsOut', cfg.paths.fontsOut, 'patched fonts have nowhere to be written');

section('Design system (code side)');
checkPath('components.index', cfg.components.index, 'the agent cannot scan for existing components before building');
checkPath('components.showcase', cfg.components.showcase, 'new components have no living showcase to register in');
if (!cfg.components.themeAccessor) {
  warn('components.themeAccessor unset — the skill cannot tell the agent how to read the theme.');
} else {
  ok(`components.themeAccessor: ${cfg.components.themeAccessor}`);
}

// ─── 5. token index ───────────────────────────────────────────────────────────
// The extractor cannot resolve variable NAMES (that API is Enterprise-only) — it matches resolved
// VALUES against these modules. So an entry that loads but exports nothing is not a cosmetic
// problem: it is the difference between "⇒ token: <ref>" and a bare number the agent hardcodes.
section('Token index (value → code reference)');
const indexSpec = Array.isArray(cfg.tokens.index) ? cfg.tokens.index : [];
if (!indexSpec.length) {
  warn('tokens.index is empty — figma-extract runs as a plain extractor with no token suggestions.');
}
let indexedTotal = 0;
indexSpec.forEach((entry, i) => {
  const label = (entry && entry.path) || `tokens.index[${i}]`;
  if (!entry || !entry.path) {
    bad(`tokens.index[${i}] has no "path".`);
    return;
  }
  const abs = resolvePath(cfg, entry.path);
  if (!fs.existsSync(abs)) {
    bad(`${label} does not exist. Not generated yet? Run \`${tokensBuildCmd}\`.`);
    return;
  }
  let mod;
  try {
    mod = loadTokenModule(abs);
  } catch (e) {
    // loadTokenModule strips type-only syntax and evaluates the rest; anything with real logic in
    // it (a function, an import it needs at runtime) will land here.
    bad(`${label} could not be evaluated: ${e.message}`);
    note('Token modules must be plain data — no runtime imports, no computed values.');
    return;
  }

  const parts = [];
  let entryTotal = 0;
  const claimed = Array.isArray(entry.exports)
    ? entry.exports.map((n) => [n, n])
    : Object.entries(entry.exports || {});
  for (const [name] of claimed) {
    const value = mod[name];
    if (value === null || value === undefined) {
      bad(`${label}: tokens.index claims export "${name}", but the module does not export it.`);
      continue;
    }
    const n = countLeaves(value);
    entryTotal += n;
    parts.push(`${name} (${n})`);
  }

  for (const spec of entry.nested || []) {
    const root = spec && mod[spec.export];
    if (!root || typeof root !== 'object') {
      bad(`${label}: nested export "${spec && spec.export}" is missing or is not an object.`);
      continue;
    }
    const buckets = spec.perMode ? Object.entries(root) : [['(root)', root]];
    const picks = spec.pick && spec.pick.length ? spec.pick : null;
    let nestedTotal = 0;
    const missingPicks = new Set(picks || []);
    for (const [, bucket] of buckets) {
      if (!bucket || typeof bucket !== 'object') continue;
      for (const p of picks || Object.keys(bucket)) {
        if (bucket[p] === undefined) continue;
        missingPicks.delete(p);
        nestedTotal += countLeaves(bucket[p]);
      }
    }
    if (missingPicks.size) {
      bad(`${label}: nested pick ${[...missingPicks].map((p) => `"${p}"`).join(', ')} not found in ${spec.export}.`);
    }
    entryTotal += nestedTotal;
    const modeNote = spec.perMode ? ` across modes ${buckets.map(([m]) => m).join('/')}` : '';
    parts.push(`${spec.export}${modeNote} (${nestedTotal})`);
  }

  if (!claimed.length && !(entry.nested || []).length) {
    warn(`${label} is indexed but claims no exports and no nested specs — it contributes nothing.`);
    return;
  }
  indexedTotal += entryTotal;
  if (entryTotal > 0) ok(`${label}: ${parts.join(', ')}`);
  else bad(`${label}: indexed 0 values — nothing here can ever be suggested.`);
});
if (indexSpec.length) note(`${indexedTotal} values indexed in total.`);

// ─── 6. spacing ramp ──────────────────────────────────────────────────────────
section('Spacing ramp');
const SPACING = cfg.tokens.spacing || {};
if (!SPACING.rampPath) {
  warn('tokens.spacing.rampPath unset — off-grid spacing checks are off.');
} else {
  const abs = resolvePath(cfg, SPACING.rampPath);
  const exportName = SPACING.rampExport || 'space';
  if (!fs.existsSync(abs)) {
    bad(`tokens.spacing.rampPath → ${SPACING.rampPath} does not exist.`);
  } else {
    try {
      const ramp = loadTokenModule(abs)[exportName];
      if (!ramp || typeof ramp !== 'object') {
        bad(`${SPACING.rampPath}: no object export named "${exportName}".`);
      } else {
        const steps = [...new Set(Object.values(ramp).map(Number).filter((n) => !Number.isNaN(n)))].sort(
          (a, b) => a - b,
        );
        if (!steps.length) bad(`${SPACING.rampPath}: "${exportName}" holds no numeric steps.`);
        else {
          ok(`${SPACING.rampPath} → ${exportName}: ${steps.length} steps [${steps.join(', ')}]`);
          const sample = Object.keys(ramp)[0];
          note(`code reference: ${(SPACING.refTemplate || 'space[{n}]').replace('{n}', sample)}`);
        }
      }
    } catch (e) {
      bad(`${SPACING.rampPath} could not be evaluated: ${e.message}`);
    }
  }
}
// Whether the design system binds Figma variables to gap/padding is a fact about the LIBRARY, not
// a preference — extract a component and see whether gap comes back ✓bound. Getting it wrong makes
// every spacing value look either falsely tokenized or falsely hardcoded.
note(
  `tokens.spacing.tokenizedInFigma = ${SPACING.tokenizedInFigma === true} ` +
    '(verify by extracting a component and reading the gap flag)',
);
if ((SPACING.banned || []).length) note(`banned spacing modules: ${SPACING.banned.join(', ')}`);

// ─── 7. typography ramp ───────────────────────────────────────────────────────
section('Typography ramp');
const TYPO = cfg.tokens.typography || {};
if (!TYPO.rampPath) {
  warn('tokens.typography.rampPath unset — text-style suggestions are off.');
} else {
  const abs = resolvePath(cfg, TYPO.rampPath);
  const exportName = TYPO.rampExport || 'textStyles';
  if (!fs.existsSync(abs)) {
    bad(`tokens.typography.rampPath → ${TYPO.rampPath} does not exist. Not generated yet? Run \`node scripts/build-typography.js\`.`);
  } else {
    try {
      const ramp = loadTokenModule(abs)[exportName];
      const variants = ramp && typeof ramp === 'object' ? Object.keys(ramp) : [];
      if (!variants.length) bad(`${TYPO.rampPath}: "${exportName}" exports no variants.`);
      else ok(`${TYPO.rampPath} → ${exportName}: ${variants.length} variants [${variants.join(', ')}]`);
    } catch (e) {
      bad(`${TYPO.rampPath} could not be evaluated: ${e.message}`);
    }
  }
}
if (TYPO.component) ok(`text component: ${TYPO.component}`);
else warn('tokens.typography.component unset — suggestions fall back to a plain text element.');
if ((TYPO.forbiddenProps || []).length && !TYPO.forbiddenReason) {
  // A rule with no reason gets argued with, then broken. The reason is the load-bearing half.
  warn('tokens.typography.forbiddenProps is set but forbiddenReason is empty — state WHY.');
}

// ─── 8. commands ──────────────────────────────────────────────────────────────
// Verified statically. Running them would mean a validation pass could rewrite generated files or
// launch a test suite, which is not what anyone types `config-check` for.
section('Commands (not executed)');
let pkg = null;
const pkgPath = path.join(cfg.__root, 'package.json');
if (fs.existsSync(pkgPath)) {
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    warn(`package.json could not be parsed: ${e.message}`);
  }
}

// Yarn's classic shorthand (`yarn <script>`) is indistinguishable from a builtin without this list.
const YARN_BUILTINS = new Set([
  'install', 'add', 'remove', 'up', 'why', 'init', 'link', 'unlink', 'pack', 'publish',
  'config', 'exec', 'dlx', 'node', 'set', 'workspace', 'workspaces', 'info', 'cache',
]);

/** Statically resolve what a command actually invokes, without running it. */
function resolveCommand(cmd) {
  const [bin, ...rest] = cmd.trim().split(/\s+/);
  if (bin === 'npm' || bin === 'pnpm' || bin === 'bun') {
    if (rest[0] === 'run' || rest[0] === 'run-script') return { kind: 'script', name: rest[1] };
    if (bin === 'pnpm' && rest[0] && !rest[0].startsWith('-')) return { kind: 'script', name: rest[0] };
    return { kind: 'opaque' };
  }
  if (bin === 'yarn') {
    if (rest[0] === 'run') return { kind: 'script', name: rest[1] };
    if (rest[0] && !rest[0].startsWith('-') && !YARN_BUILTINS.has(rest[0])) {
      return { kind: 'script', name: rest[0] };
    }
    return { kind: 'opaque' };
  }
  if (bin === 'node' && rest[0]) return { kind: 'file', name: rest[0] };
  return { kind: 'opaque' };
}

for (const [key, offNote] of [
  ['tokensBuild', 'the skill has no token-regeneration step to hand the agent'],
  ['validate', 'nothing gates the work before it is called done'],
]) {
  const cmd = cfg.commands ? cfg.commands[key] : null;
  if (typeof cmd !== 'string' || !cmd.trim()) {
    warn(`commands.${key} unset — ${offNote}.`);
    continue;
  }
  const resolved = resolveCommand(cmd);
  if (resolved.kind === 'script' && resolved.name) {
    if (!pkg) warn(`commands.${key}: "${cmd}" — no package.json here to verify it against.`);
    else if (pkg.scripts && pkg.scripts[resolved.name]) ok(`commands.${key}: "${cmd}"`);
    else bad(`commands.${key}: "${cmd}" — package.json has no "${resolved.name}" script.`);
  } else if (resolved.kind === 'file') {
    const abs = path.isAbsolute(resolved.name) ? resolved.name : path.join(cfg.__root, resolved.name);
    if (fs.existsSync(abs)) ok(`commands.${key}: "${cmd}"`);
    else bad(`commands.${key}: "${cmd}" — ${resolved.name} does not exist.`);
  } else {
    warn(`commands.${key}: "${cmd}" — cannot be verified automatically; eyeball it.`);
  }
}

// ─── 9. variables export ↔ sources ────────────────────────────────────────────
// build-tokens.js hard-fails on a pattern that matches nothing, so a stale pattern here means the
// whole token pipeline is down — usually because a re-export renamed the collection files.
section('Variables export');
const sources = Array.isArray(cfg.variables.sources) ? cfg.variables.sources : [];
if (!varsDir) {
  warn('no variables export directory — skipping the variables.sources match check.');
} else if (!sources.length) {
  warn('variables.sources is empty — the token build cannot tell which exported file is which mode.');
} else {
  const files = listFiles(varsDir);
  if (!files.length) {
    bad(`${rel(varsDir)} is empty — export the variables from Figma and drop the files there.`);
  } else {
    ok(`${files.length} file(s) under ${rel(varsDir)}`);
    const matchedFiles = new Set();
    let hasPrimitives = false;
    let modeCount = 0;
    sources.forEach((src, i) => {
      if (!src || !src.match || !src.role) {
        bad(`variables.sources[${i}] needs both "match" and "role".`);
        return;
      }
      let re;
      try {
        re = new RegExp(src.match, 'i');
      } catch (e) {
        bad(`variables.sources[${i}] /${src.match}/ is not a valid regex: ${e.message}`);
        return;
      }
      const mode = src.role.startsWith('mode:') ? src.role.slice(5).trim() : null;
      if (src.role !== 'primitives' && !mode) {
        bad(`variables.sources[${i}] role "${src.role}" — expected "primitives" or "mode:<name>".`);
        return;
      }
      if (src.role === 'primitives') hasPrimitives = true;
      else modeCount++;

      const hits = files.filter((f) => re.test(path.basename(f)));
      if (!hits.length) {
        bad(`/${src.match}/i (${src.role}) matches nothing — the token build will fail here.`);
        note(`Files present: ${files.map((f) => path.relative(varsDir, f)).join(', ')}`);
        return;
      }
      hits.forEach((h) => matchedFiles.add(h));
      if (hits.length > 1) {
        // build-tokens takes the first hit and warns; a pattern this loose usually means a
        // re-export added a file nobody meant to route here.
        warn(
          `/${src.match}/i (${src.role}) matches ${hits.length} files; the build uses ` +
            `${path.relative(varsDir, hits[0])}`,
        );
      } else {
        ok(`/${src.match}/i → ${path.relative(varsDir, hits[0])} (${src.role})`);
      }
    });
    const unrouted = files.filter((f) => !matchedFiles.has(f));
    if (unrouted.length) {
      warn(
        `${unrouted.length} exported file(s) match no source and are ignored: ` +
          unrouted.map((f) => path.relative(varsDir, f)).join(', '),
      );
    }
    if (!hasPrimitives) warn('no source has role "primitives" — the base palette has no home.');
    if (!modeCount) warn('no source has a "mode:<name>" role — no theme modes will be generated.');
  }
}
if (!Object.keys(cfg.variables.groups || {}).length) {
  warn('variables.groups is empty — every top-level group in the export lands in the default bucket.');
}

// ─── 10. drift detection ──────────────────────────────────────────────────────
// Two silent failures live here, and neither one breaks a build:
//   • the design file moved and nobody re-baselined (needs the network — figma-drift does that)
//   • the variables export moved and the token build never re-ran (detectable right here, offline,
//     by comparing the export on disk against the hash build-tokens stamped into the variable map)
// The second is the common one, because dropping an export in is the step a human does and
// re-running the build is the step a human forgets.
section('Drift detection');
const DRIFT = cfg.drift || {};
const driftNodes = (Array.isArray(DRIFT.nodes) ? DRIFT.nodes : []).filter((n) => n && n.id);
const baselineDir = resolvePath(cfg, DRIFT.baselineDir || 'figma-baselines');
const baselineIndex = path.join(baselineDir, BASELINE_INDEX);

if (!driftNodes.length) {
  warn('drift.nodes is empty — the VISUAL layer is off (a spacing or icon change cannot be seen).');
  note('Name a few canonical components, then run `node scripts/figma-drift.js --update`.');
} else {
  ok(`drift.nodes: ${driftNodes.length} node(s) [${driftNodes.map((n) => n.name || n.id).join(', ')}]`);
}

let baselineJson = null;
if (fs.existsSync(baselineIndex)) {
  try {
    baselineJson = JSON.parse(fs.readFileSync(baselineIndex, 'utf8'));
  } catch (e) {
    bad(`${rel(baselineIndex)} could not be parsed: ${e.message}`);
  }
} else if (driftNodes.length) {
  warn(`no baselines captured yet in ${rel(baselineDir)} — run \`node scripts/figma-drift.js --update\`.`);
}

if (baselineJson) {
  const meta = baselineJson.$meta || {};
  const nodes = baselineJson.nodes || {};
  const count = Object.keys(nodes).length;
  ok(`${count} baselined node(s) in ${rel(baselineDir)}`);
  note(`captured ${meta.capturedAt || '(unknown)'} · design lastModified ${meta.figmaLastModified || '(not recorded)'}`);
  // A baseline.json naming an image that is not there is explicit rot, not an unused feature —
  // the check would silently skip that node and report a clean run forever.
  const missingImages = Object.entries(nodes)
    .filter(([, e]) => !e || !e.file || !fs.existsSync(path.join(baselineDir, e.file)))
    .map(([id, e]) => (e && e.name) || id);
  if (missingImages.length) {
    bad(`baseline image missing for: ${missingImages.join(', ')} — re-run \`node scripts/figma-drift.js --update\`.`);
  }
  const notCaptured = driftNodes.filter((n) => !nodes[normalizeId(n.id)]);
  if (notCaptured.length) {
    warn(`configured but not baselined: ${notCaptured.map((n) => n.name || n.id).join(', ')} — run --update.`);
  }
  const orphans = Object.keys(nodes).filter((id) => !driftNodes.some((n) => normalizeId(n.id) === id));
  if (orphans.length) {
    warn(`baselined but no longer in drift.nodes: ${orphans.join(', ')} — --update prunes them.`);
  }
}

const hashStatus = exportHashStatus(cfg);
if (hashStatus.state === 'fresh') {
  ok(`${MAP_NAME}: generated tokens match the export on disk (${hashStatus.current})`);
} else if (hashStatus.state === 'stale') {
  bad(`${MAP_NAME} records export hash ${hashStatus.recorded}, but the export on disk hashes ${hashStatus.current}.`);
  note(`The export was updated and the token build never re-ran. Run \`${tokensBuildCmd}\`.`);
  if (Array.isArray(hashStatus.recordedSources)) {
    const added = hashStatus.sources.filter((s) => !hashStatus.recordedSources.includes(s));
    const removed = hashStatus.recordedSources.filter((s) => !hashStatus.sources.includes(s));
    if (added.length) note(`new file(s): ${added.join(', ')}`);
    if (removed.length) note(`missing file(s): ${removed.join(', ')}`);
  }
} else if (hashStatus.state === 'unreadable') {
  bad(`${rel(hashStatus.file)} could not be parsed: ${hashStatus.reason}`);
} else {
  warn(`token-build freshness check is off — ${hashStatus.reason}.`);
}

// ─── 11. optional: prove the token can read the file ──────────────────────────
async function checkOnline() {
  section('Figma API (--online)');
  if (!cfg.files.default) {
    bad('files.default is not set — nothing to check against.');
    return;
  }
  if (!token) {
    bad('no access token — cannot check.');
    return;
  }
  try {
    // depth=1 returns the document and its pages only: the cheapest call that still proves both
    // "this key exists" and "this token may read it".
    const res = await fetchRetry(
      `https://api.figma.com/v1/files/${encodeURIComponent(cfg.files.default)}?depth=1`,
      { headers: { 'X-Figma-Token': token } },
    );
    if (res.ok) {
      const json = await res.json();
      ok(`token reads files.default — "${json.name}"`);
      note(`lastModified: ${json.lastModified}   version: ${json.version}`);
      // Node ids are only as fresh as the file. When this timestamp moves, every id written down
      // anywhere (docs, tickets, comments) is a suspect until re-extracted.
      note('Node ids captured before that timestamp are suspect — re-extract before trusting them.');
    } else if (res.status === 403) {
      // Figma answers 403 for an invalid token AND for a valid token without access — name both.
      bad('403 — the token was rejected for this file: expired/invalid, missing the file content read scope, or no access to that file.');
    } else if (res.status === 404) {
      bad('404 — no file with that key, or this account cannot see it.');
    } else {
      bad(`HTTP ${res.status} from the files endpoint.`);
    }
  } catch (e) {
    bad(`request failed: ${e.message}`);
  }
  if (cfg.files.screens && cfg.files.screens !== cfg.files.default) {
    note('files.screens was not checked — --online makes exactly one call.');
  }
}

// ─── summary ──────────────────────────────────────────────────────────────────
(async () => {
  if (ONLINE) await checkOnline();

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`${oks} ok · ${warns} warning(s) · ${errs} error(s)`);
  if (errs) {
    // Say only what is true: each ✗ already carries its own reason (a missing path, an export
    // that is not there, an unignored env file). Restating one specific cause here sent people
    // hunting through paths when the real error was about their token.
    console.log(
      `\x1b[31mconfig-check FAILED\x1b[0m — ${errs} error(s). Each ✗ above says what is wrong and how to fix it.`,
    );
    process.exit(1);
  }
  if (warns) {
    console.log('\x1b[33mconfig-check passed with warnings\x1b[0m — every ⚠ is a feature switched off.');
  } else {
    console.log('\x1b[32mconfig-check passed.\x1b[0m');
  }
  if (!ONLINE) console.log('Re-run with --online to prove the token can read files.default.');
})();
