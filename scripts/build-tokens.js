/* eslint-disable */
/**
 * build-tokens.js — compile a Figma **variables export** into typed TypeScript token modules.
 *
 * WHY THE INPUT IS A FILE ON DISK AND NOT AN API CALL
 * ---------------------------------------------------
 * Figma's Variables REST API (`GET /v1/files/:key/variables/local`) is an **Enterprise-plan**
 * feature — on every other plan it answers 403, so a pipeline built on it only works for a
 * fraction of teams. What every plan does have is the editor's own variables export (and the
 * community export plugins that emit the same shape). So the contract here is: a designer drops
 * the export into `paths.variablesExport`, anyone re-runs this script. The cost is one manual
 * step per token change; the benefit is a pipeline that runs on any plan, in CI, with no
 * privileged token — and a reviewable diff of what design actually changed.
 *
 * THE INPUT SHAPE (W3C DTCG draft)
 * --------------------------------
 * The export is the DTCG draft shape, which is worth knowing because everything below keys off it:
 *   - Groups nest arbitrarily; a *leaf* is any object carrying `$value` (with `$type` beside it).
 *   - Every `$`-prefixed key is metadata, never a token — including `$extensions`, where Figma
 *     stashes `"com.figma.variableId"`. They are skipped wholesale.
 *   - Colors are `{ components: [r, g, b], alpha, hex }` with 0..1 components.
 *   - An alias is a *string* `"{group.sub.token}"` pointing at another token by path.
 *   - Figma writes **one file per mode** (a mode = a column in the variables table: light, dark,
 *     brand-x…). Cross-file aliases are normal — semantic tokens in the light file routinely
 *     point at primitives that only exist in the primitives file — so aliases are resolved
 *     against every loaded export, not just the file they appear in.
 *
 * WHAT IT EMITS (into `paths.tokensDir`)
 *   - `palette.generated.ts` — the mode-independent primitives: `palette`, any per-mode `ramps`,
 *     and the radius scale (exported under the camelCased name of the group it came from).
 *   - `themes.generated.ts`  — `themes`, keyed by YOUR mode names, each `{ semantic, components }`.
 *   - `variable-map.generated.json` — variable id → code reference (see the next section).
 *
 * Nothing about light/dark is baked in: modes come from `variables.sources`, and a project with
 * three modes (or one) gets three keys (or one).
 *
 * THE VARIABLE MAP — WHY THIS SCRIPT IS THE ONLY PLACE THAT CAN WRITE IT
 * ---------------------------------------------------------------------
 * Every leaf in the export carries `$extensions["com.figma.variableId"]` (e.g. `VariableID:1:23`),
 * and the ORDINARY nodes endpoint — `/v1/files/:key/nodes`, no privileged plan — carries the SAME
 * identifier back on each node as `boundVariables[prop] = { type: 'VARIABLE_ALIAS', id: … }`.
 * Verified live: the Variables API is Enterprise-only and 403s on lower plans, but BOTH of those
 * are available on every plan. Joining them on the id lets figma-extract name the exact token a
 * property is bound to, instead of guessing from the resolved value — where `#FFFFFF` ties across
 * three tokens and a human has to pick. That guess was the kit's biggest accuracy gap, and it was
 * never necessary.
 *
 * Only this script can build the join: it is the one place that knows BOTH the Figma path of a
 * token and the code destination it is routed to. So while transforming, it records each leaf's
 * variable id against the reference the token becomes in code, and writes:
 *
 *   { "$meta": { generator, exportHash, sources, variableCount },
 *     "variables": { "VariableID:1:23": { ref, figmaPath, values } } }
 *
 * `ref` is spelled exactly the way figma-extract writes references (`palette.brand[500]`,
 * `components.checkbox.color.on`) so it can be pasted into code. `values` is keyed by mode — `'*'`
 * for a single-mode source such as the primitives file — so a reviewer can see what the variable
 * resolves to per theme. `exportHash` fingerprints the export that produced the map, which is how
 * you tell a stale map from a current one. Exports that omit the variable ids simply produce no
 * map, and the extractor falls back to value matching with a warning.
 *
 * CONFIGURATION (figma.config.json → `variables`)
 *   sources: [{ match: "<regex source>", role: "primitives" | "mode:<name>" }]
 *            `match` is tested case-insensitively against the *basename* of each file found under
 *            `paths.variablesExport` (searched recursively — Figma exports into subfolders).
 *   groups:  { "<group path>": "palette" | "radius" | "ramp:<mode>" | "semantic" | "components"
 *                              | "ignore" }
 *            A key is a bare group name (for example a top-level "Corner radius" group) or a
 *            dotted path for a nested one (for example "Component.App Theme"). The most specific
 *            rule wins, so routing a parent to `components` and one of its children to `semantic`
 *            splits them correctly. A BARE name only matches at the top level or directly under a
 *            group that is itself routed — deeper than that, spell out the dotted path, because
 *            component groups reuse generic child names ("Color", "Corner radius") constantly and
 *            a bare rule matching at any depth would hoist all of them out of their component.
 *   ignoreKeys: stray keys anywhere in the export to skip entirely.
 *
 * Anything the config does not route is REPORTED, never guessed at — an unrouted group is either
 * a config gap or something new the library just added, and both are worth a human's attention.
 *
 * Run: node scripts/build-tokens.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig, resolvePath } = require('./figma-config');

const cfg = loadConfig();
const SRC_DIR = resolvePath(cfg, cfg.paths.variablesExport);
const OUT_DIR = resolvePath(cfg, cfg.paths.tokensDir);
const IGNORE_KEYS = new Set(cfg.variables.ignoreKeys || []);

const SIMPLE_DESTS = ['palette', 'radius', 'semantic', 'components', 'ignore'];

const rel = (p) => path.relative(cfg.__root, p) || '.';

function fail(msg) {
  console.error(`[build-tokens] ${msg}`);
  process.exit(1);
}

// ─── Source discovery ─────────────────────────────────────────────────────────
/** Every file under `dir`, recursively. Figma exports one folder per collection. */
function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  })(dir);
  return out.sort();
}

if (!OUT_DIR) {
  fail(
    'paths.tokensDir is not set. Add it to figma.config.json, e.g.\n' +
      '  "paths": { "tokensDir": "src/theme/tokens" }',
  );
}
if (!SRC_DIR || !fs.existsSync(SRC_DIR)) {
  fail(
    `No variables export at ${SRC_DIR ? rel(SRC_DIR) : '(paths.variablesExport unset)'}.\n` +
      '  Export the variables from Figma and drop the files there, then re-run.',
  );
}

const available = listFiles(SRC_DIR).filter((f) => !path.basename(f).startsWith('.'));
const availableList = available.length
  ? available.map((f) => `    ${path.relative(SRC_DIR, f)}`).join('\n')
  : '    (the directory is empty)';

if (!(cfg.variables.sources || []).length) {
  fail(
    'variables.sources is empty — the script cannot tell which exported file is which mode.\n' +
      `  Files under ${rel(SRC_DIR)}:\n${availableList}\n` +
      '  Add one entry per file, e.g.\n' +
      '    { "match": "primitives.*\\\\.tokens\\\\.json$", "role": "primitives" }\n' +
      '    { "match": "light.*\\\\.tokens\\\\.json$",      "role": "mode:light" }',
  );
}

/** { file, role, mode, json } for every configured source, in config order. */
const sources = (cfg.variables.sources || []).map((src) => {
  if (!src || !src.match || !src.role) {
    fail(`Every variables.sources entry needs { match, role }. Got: ${JSON.stringify(src)}`);
  }
  let re;
  try {
    re = new RegExp(src.match, 'i');
  } catch (e) {
    fail(`variables.sources match /${src.match}/ is not a valid regex: ${e.message}`);
  }
  const hits = available.filter((f) => re.test(path.basename(f)));
  if (!hits.length) {
    fail(
      `No file under ${rel(SRC_DIR)} matches /${src.match}/i (role "${src.role}").\n` +
        `  Files found:\n${availableList}\n` +
        '  Fix the pattern in variables.sources, or re-export from Figma.',
    );
  }
  if (hits.length > 1) {
    console.warn(
      `[build-tokens] /${src.match}/i matched ${hits.length} files; using ` +
        `${path.relative(SRC_DIR, hits[0])}`,
    );
  }
  const mode = src.role.startsWith('mode:') ? src.role.slice(5).trim() : null;
  if (src.role !== 'primitives' && !mode) {
    fail(`Unknown role "${src.role}" — expected "primitives" or "mode:<name>".`);
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(hits[0], 'utf8'));
  } catch (e) {
    fail(`Could not parse ${path.relative(SRC_DIR, hits[0])}: ${e.message}`);
  }
  return { file: hits[0], role: src.role, mode, json };
});

const roots = sources.map((s) => s.json);

// ─── Value conversion ─────────────────────────────────────────────────────────
function rgbToHex(components) {
  return (
    '#' +
    components
      .map((c) =>
        Math.round(c * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
      .toUpperCase()
  );
}

function isColor(v) {
  return v && typeof v === 'object' && ('components' in v || 'hex' in v);
}

/**
 * Opaque colors become hex (what designers read in review); anything genuinely translucent
 * becomes `rgba()`. The 0.999 threshold exists because Figma stores alpha as a float and a
 * "100%" swatch comes back as 0.9999999 often enough to matter — rounding it to hex keeps the
 * generated file stable across exports instead of flip-flopping between forms.
 */
function convertColor(v) {
  const alpha = v.alpha == null ? 1 : v.alpha;
  if (alpha >= 0.999) return (v.hex || rgbToHex(v.components)).toUpperCase();
  const [r, g, b] = v.components.map((c) => Math.round(c * 255));
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`;
}

// ─── Alias resolution ─────────────────────────────────────────────────────────
/**
 * A broken alias is an AUTHORING BUG in the library, and it is the one class of design error
 * this pipeline can catch for free — so it never throws (a half-built token file helps nobody)
 * and never silently invents a value. It substitutes a visibly-wrong fallback and prints every
 * dangling reference at the end of the run, to be taken back to the design team.
 */
const UNRESOLVED_FALLBACK = 'transparent';
const MAX_ALIAS_DEPTH = 32; // alias chains are shallow; deeper means the export has a cycle

let aliasCount = 0;
const unresolved = [];
const circular = [];

function walkPath(root, segments) {
  let node = root;
  for (const seg of segments) {
    if (node == null) return null;
    node = node[seg];
  }
  return node && node.$value !== undefined ? node : null;
}

/** Find `{a.b.c}` in its own file first, then in every other loaded export (cross-mode aliases). */
function findRef(ref, root) {
  const segments = ref.slice(1, -1).split('.');
  const own = walkPath(root, segments);
  if (own) return { node: own, root };
  for (const other of roots) {
    if (other === root) continue;
    const node = walkPath(other, segments);
    if (node) return { node, root: other };
  }
  return null;
}

function resolveRef(ref, root, depth) {
  aliasCount++;
  if (depth > MAX_ALIAS_DEPTH) {
    if (!circular.includes(ref)) circular.push(ref);
    return UNRESOLVED_FALLBACK;
  }
  const found = findRef(ref, root);
  if (!found) {
    if (!unresolved.includes(ref)) unresolved.push(ref);
    return UNRESOLVED_FALLBACK; // broken alias in the export — reported at the end
  }
  return convertValue(found.node.$value, found.root, depth + 1);
}

function convertValue(raw, root, depth = 0) {
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    return resolveRef(raw.trim(), root, depth);
  }
  if (isColor(raw)) return convertColor(raw);
  return raw; // number or plain string
}

// ─── Key + tree transform ─────────────────────────────────────────────────────
/**
 * Figma group/variable names are human copy ("Secondary & tertiary", "Corner radius"), so they
 * are camelCased for code. Two rules earn their keep: '&' expands to ' and ' (otherwise the two
 * words weld into one unreadable identifier), and a purely numeric key — a ramp step like 500,
 * or a radius step like 8 — is preserved verbatim so `radius[8]` stays the obvious lookup.
 */
function camelKey(key) {
  if (/^\d+$/.test(key)) return key; // numeric step keys stay numeric
  const cleaned = key.replace(/&/g, ' and ');
  const parts = cleaned.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (!parts.length) return key;
  return parts
    .map((p, i) => (i === 0 ? p[0].toLowerCase() + p.slice(1) : p[0].toUpperCase() + p.slice(1)))
    .join('');
}

const isLeaf = (node) => node !== null && typeof node === 'object' && '$value' in node;
const isGroup = (node) => node !== null && typeof node === 'object' && !Array.isArray(node);

// ─── Variable map ─────────────────────────────────────────────────────────────
/** Where Figma stashes the variable id on a leaf. Some exports omit it; that is not an error. */
const VARIABLE_ID_EXT = 'com.figma.variableId';
const variableMap = new Map(); // variable id -> { ref, figmaPath, values }

/**
 * Spell a code reference the way figma-extract writes one: dot-separated, but a NUMERIC key in
 * brackets — `palette.brand[500]`, `cornerRadius[8]` — because that is how the generated modules
 * are actually indexed in code. The two must agree exactly or the map's whole point is lost.
 */
function formatRef(parts) {
  return parts.reduce((acc, part, i) => {
    const key = String(part);
    if (i === 0) return key;
    return /^\d+$/.test(key) ? `${acc}[${key}]` : `${acc}.${key}`;
  }, '');
}

/**
 * One entry per VARIABLE, not per file: the same variable appears once in every mode file it has a
 * value for, so later modes merge into the entry the first one created (that is what makes `values`
 * a per-mode object). A leaf with no id is skipped in silence — the map degrades to "fewer exact
 * hits", never to a wrong one.
 */
function recordVariable(leaf, refParts, figmaParts, value, ctx) {
  const ext = leaf.$extensions;
  const id = ext && typeof ext[VARIABLE_ID_EXT] === 'string' ? ext[VARIABLE_ID_EXT] : null;
  if (!id || !refParts.length) return;
  const mode = (ctx && ctx.mode) || '*';
  const existing = variableMap.get(id);
  if (existing) {
    existing.values[mode] = value;
    return;
  }
  variableMap.set(id, {
    ref: formatRef(refParts),
    figmaPath: figmaParts.join('.'),
    values: { [mode]: value },
  });
}

let leafCount = 0;
/**
 * `refParts` tracks the CODE path being built (bucket root + camelCased keys) and `figmaParts` the
 * original Figma path, so a leaf can be recorded under both without a second walk.
 */
function transform(node, root, refParts = [], figmaParts = [], ctx = null) {
  if (isLeaf(node)) {
    leafCount++;
    const value = convertValue(node.$value, root);
    recordVariable(node, refParts, figmaParts, value, ctx);
    return value;
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$') || IGNORE_KEYS.has(k)) continue;
    out[camelKey(k)] = transform(v, root, [...refParts, camelKey(k)], [...figmaParts, k], ctx);
  }
  return out;
}

// ─── Group routing ────────────────────────────────────────────────────────────
const rules = new Map(Object.entries(cfg.variables.groups || {}));
for (const [group, dest] of rules) {
  if (!SIMPLE_DESTS.includes(dest) && !/^ramp:.+/.test(dest)) {
    fail(
      `variables.groups["${group}"] = "${dest}" is not a destination.\n` +
        `  Valid: ${SIMPLE_DESTS.join(' | ')} | ramp:<mode>`,
    );
  }
}

/**
 * Resolve the destination for a group path. A full dotted path always wins. A BARE name only
 * matches at the top level or directly under a group that is itself explicitly routed — because
 * component libraries reuse generic subgroup names constantly (nearly every component group has
 * its own "Corner radius" / "Color" / "Border" child). Matching a bare rule at any depth would
 * silently hoist every one of those out of its component and pile them into a single export —
 * a corruption that looks plausible until you read the diff. Deeper than that, use a dotted path.
 */
function ruleFor(segments) {
  if (!segments.length) return null;
  const full = segments.join('.');
  if (rules.has(full)) return rules.get(full);
  const bare = segments[segments.length - 1];
  if (!rules.has(bare)) return null;
  if (segments.length === 1) return rules.get(bare);
  return ruleFor(segments.slice(0, -1)) ? rules.get(bare) : null;
}

const palette = {};
const radiusScale = {};
let radiusExportName = null;

// What each bucket is CALLED in the consuming codebase. These names go into BOTH the generated
// export/slot keys and the refs recorded in the variable map, so they must match the accessors the
// app really uses — a ref naming a bucket the code does not have sends every suggestion nowhere.
const EXPORT_NAMES = (cfg.variables && cfg.variables.exportNames) || {};
const NAME = {
  palette: EXPORT_NAMES.palette || 'palette',
  ramps: EXPORT_NAMES.ramps || 'ramps',
  semantic: EXPORT_NAMES.semantic || 'semantic',
  components: EXPORT_NAMES.components || 'components',
};
const ramps = {}; // mode -> ramp object
const themes = {}; // mode -> { semantic, components }
const unrouted = [];
const modeless = [];

for (const s of sources) if (s.mode) themes[s.mode] = { semantic: {}, components: {} };

/**
 * The destination bucket AND the root of the code reference that reads it back — `refRoot` is the
 * generated export name (`palette`, `ramps.<mode>`, the radius scale's own name) or, for the
 * per-mode themes, the slot as the theme accessor exposes it (`components.*` / `semantic.*`,
 * mode-agnostic, because code picks the mode at runtime). Returns null when there is nowhere to put
 * the group.
 */
function bucketFor(dest, ctx, groupPath) {
  if (dest === 'palette') return { bucket: palette, refRoot: [NAME.palette] };
  if (dest === 'radius') {
    // The radius export is named after the group it came from ("Corner radius" -> cornerRadius),
    // so the generated identifier matches what the library actually calls the scale.
    if (!radiusExportName) radiusExportName = camelKey(groupPath[groupPath.length - 1] || 'radius');
    return { bucket: radiusScale, refRoot: [radiusExportName] };
  }
  if (dest.startsWith('ramp:')) {
    const mode = dest.slice(5).trim();
    ramps[mode] = ramps[mode] || {};
    return { bucket: ramps[mode], refRoot: [NAME.ramps, mode] };
  }
  // semantic + components are per-mode, so they need a mode:<name> source to land in.
  if (!ctx.mode) {
    modeless.push(`${groupPath.join('.')} -> ${dest} (in ${path.basename(ctx.file)})`);
    return null;
  }
  const theme = (themes[ctx.mode] = themes[ctx.mode] || { semantic: {}, components: {} });
  return dest === 'semantic'
    ? { bucket: theme.semantic, refRoot: [NAME.semantic] }
    : { bucket: theme.components, refRoot: [NAME.components] };
}

/** Merge `value` into `bucket` at `relSegments` (the path relative to the routed group). */
function place(bucket, relSegments, value, label) {
  if (!relSegments.length) {
    if (!isGroup(value)) {
      console.warn(`[build-tokens] skipped ${label}: a single value cannot be a whole token group`);
      return;
    }
    Object.assign(bucket, value);
    return;
  }
  let node = bucket;
  for (const seg of relSegments.slice(0, -1)) {
    if (!isGroup(node[seg])) node[seg] = {};
    node = node[seg];
  }
  const last = relSegments[relSegments.length - 1];
  node[last] = isGroup(node[last]) && isGroup(value) ? { ...node[last], ...value } : value;
}

/**
 * Walk the export, handing each group to its destination. A group inherits its parent's routing
 * unless it has a rule of its own — that is what makes `{ "Component": "components",
 * "Component.App Theme": "semantic" }` split one Figma group across two generated shapes.
 * `anchor` is the path of the nearest explicitly-routed ancestor: everything is placed relative
 * to it, so the routed group's children become the bucket's top-level keys.
 */
function distribute(node, segments, dest, anchor, ctx) {
  const entries = isGroup(node)
    ? Object.entries(node).filter(([k]) => !k.startsWith('$') && !IGNORE_KEYS.has(k))
    : [];
  const splits = entries.filter(([k]) => {
    const child = ruleFor([...segments, k]);
    return child && child !== dest;
  });

  if (!splits.length) {
    if (!dest) {
      const label = segments.join('.') || '(root)';
      if (!unrouted.includes(label)) unrouted.push(label);
      return;
    }
    if (dest === 'ignore') return;
    const target = bucketFor(dest, ctx, anchor.length ? anchor : segments);
    if (!target) return;
    const relative = segments.slice(anchor.length).map(camelKey);
    const refBase = [...target.refRoot, ...relative];
    place(
      target.bucket,
      relative,
      transform(node, ctx.json, refBase, segments, ctx),
      segments.join('.') || '(root)',
    );
    return;
  }

  for (const [k, v] of entries) {
    const child = ruleFor([...segments, k]);
    if (child && child !== dest) distribute(v, [...segments, k], child, [...segments, k], ctx);
    else distribute(v, [...segments, k], dest, anchor, ctx);
  }
}

if (!rules.size) {
  const groupNames = new Set();
  for (const s of sources) {
    for (const k of Object.keys(s.json)) if (!k.startsWith('$')) groupNames.add(k);
  }
  fail(
    'variables.groups is empty — nothing tells the script where each group belongs.\n' +
      `  Top-level groups in your export: ${[...groupNames].join(', ') || '(none)'}\n` +
      '  Route each one, e.g. { "color": "palette", "Corner radius": "radius" }.',
  );
}

for (const s of sources) distribute(s.json, [], null, [], s);

// ─── TS serialization (prettier-compatible: single quotes, 2-space, trailing commas) ──
function isIdentifier(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

function serialize(value, indent) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const pad = '  '.repeat(indent);
  const padInner = '  '.repeat(indent + 1);
  const entries = Object.entries(value).map(([k, v]) => {
    const key = isIdentifier(k) || /^\d+$/.test(k) ? k : `'${k}'`;
    return `${padInner}${key}: ${serialize(v, indent + 1)},`;
  });
  if (!entries.length) return '{}';
  return `{\n${entries.join('\n')}\n${pad}}`;
}

const HEADER =
  '/* eslint-disable */\n' +
  '// AUTO-GENERATED by scripts/build-tokens.js — DO NOT EDIT.\n' +
  `// Re-run \`node scripts/build-tokens.js\` after dropping a new export into ${cfg.paths.variablesExport}/.\n\n`;

function emit(file, exportsMap) {
  const body = Object.entries(exportsMap)
    .map(([name, val]) => `export const ${name} = ${serialize(val, 0)} as const;`)
    .join('\n\n');
  fs.writeFileSync(path.join(OUT_DIR, file), HEADER + body + '\n');
}

// ─── Emit ─────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });

const written = [];

// Order the ramps by the mode order in variables.sources, so the generated file is stable and
// reads in the same order as the config rather than in Figma's export order.
const modeOrder = sources.filter((s) => s.mode).map((s) => s.mode);
const orderedRamps = {};
for (const m of modeOrder) if (ramps[m]) orderedRamps[m] = ramps[m];
for (const m of Object.keys(ramps)) if (!orderedRamps[m]) orderedRamps[m] = ramps[m];

const primitiveExports = {};
if (Object.keys(palette).length) primitiveExports[NAME.palette] = palette;
if (Object.keys(orderedRamps).length) primitiveExports[NAME.ramps] = orderedRamps;
if (radiusExportName && Object.keys(radiusScale).length) {
  primitiveExports[radiusExportName] = radiusScale;
}
if (Object.keys(primitiveExports).length) {
  emit('palette.generated.ts', primitiveExports);
  written.push(`palette.generated.ts (${Object.keys(primitiveExports).join(', ')})`);
}

for (const mode of Object.keys(themes)) {
  const t = themes[mode];
  if (!Object.keys(t.semantic).length && !Object.keys(t.components).length) {
    console.warn(`[build-tokens] mode "${mode}" produced no tokens — check variables.groups`);
    delete themes[mode];
  }
}
if (Object.keys(themes).length) {
  // Rename the per-mode slots to the project's vocabulary on the way out.
  const renamed = {};
  for (const [mode, t] of Object.entries(themes)) {
    renamed[mode] = { [NAME.semantic]: t.semantic, [NAME.components]: t.components };
  }
  emit('themes.generated.ts', { themes: renamed });
  written.push(`themes.generated.ts (modes: ${Object.keys(themes).join(', ')})`);
}

if (!written.length) {
  fail('Nothing was generated — every group was ignored or unrouted. Check variables.groups.');
}

// ─── Variable map ─────────────────────────────────────────────────────────────
const VARIABLE_MAP_FILE = 'variable-map.generated.json';

/**
 * Fingerprint the export that produced this map, so a consumer can tell "current" from "written
 * against last quarter's export". THE RECIPE, stated exactly because other tools re-compute it to
 * detect a stale token build: take the files `variables.sources` routes (first match per entry,
 * each file once), express each relative to the export directory with `/` separators, SORT those
 * paths, concatenate the raw bytes in that order, sha256, keep 12 hex characters.
 *
 * Sorting by relative path rather than basename matters when two mode folders hold same-named
 * files; deduplicating matters when two patterns match one file — either would otherwise make the
 * hash depend on read order, and a fingerprint that moves on its own is worse than none.
 */
function hashSources(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(fs.readFileSync(f));
  return h.digest('hex').slice(0, 12);
}

function writeVariableMap() {
  if (!variableMap.size) return null; // reported with the other warnings, at the end
  const seen = new Set();
  const named = [];
  for (const s of sources) {
    if (seen.has(s.file)) continue; // two patterns can match one file — hash it once
    seen.add(s.file);
    named.push({ name: path.relative(SRC_DIR, s.file).split(path.sep).join('/'), file: s.file });
  }
  named.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const payload = {
    $meta: {
      generator: 'build-tokens.js',
      exportHash: hashSources(named.map((n) => n.file)),
      sources: named.map((n) => n.name),
      variableCount: variableMap.size,
    },
    // Sorted by code reference so the file reads like the token tree and diffs stay small when a
    // variable moves in the export.
    variables: Object.fromEntries(
      [...variableMap.entries()].sort(([idA, a], [idB, b]) =>
        a.ref === b.ref ? (idA < idB ? -1 : 1) : a.ref < b.ref ? -1 : 1,
      ),
    ),
  };
  const out = path.join(OUT_DIR, VARIABLE_MAP_FILE);
  fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n');
  return out;
}

const variableMapFile = writeVariableMap();

// ─── Report ───────────────────────────────────────────────────────────────────
console.log('[build-tokens] Generated:');
for (const w of written) console.log(`  ${rel(OUT_DIR)}/${w}`);
if (Object.keys(palette).length) {
  console.log(`  palette groups : ${Object.keys(palette).join(', ')}`);
}
for (const [mode, ramp] of Object.entries(orderedRamps)) {
  console.log(`  ramp:${mode.padEnd(9)} : ${Object.keys(ramp).length} entries`);
}
if (radiusExportName) {
  console.log(`  ${radiusExportName.padEnd(15)}: ${Object.keys(radiusScale).length} steps`);
}
for (const [mode, t] of Object.entries(themes)) {
  console.log(
    `  theme ${mode.padEnd(9)} : ${Object.keys(t.semantic).length} semantic, ` +
      `${Object.keys(t.components).length} component groups`,
  );
}
console.log(`  total leaves   : ${leafCount}, aliases resolved : ${aliasCount}`);
if (variableMapFile) {
  console.log(
    `  variable map   : ${variableMap.size} variables → ${rel(OUT_DIR)}/${VARIABLE_MAP_FILE}`,
  );
} else {
  console.warn(
    `\n[build-tokens] no leaf in the export carries $extensions["${VARIABLE_ID_EXT}"], so no ` +
      `${VARIABLE_MAP_FILE} was written.`,
  );
  console.warn(
    '  EXACT variable resolution will be unavailable — figma-extract falls back to matching tokens',
  );
  console.warn(
    '  by VALUE, which ties whenever two tokens share one. Re-export the variables with a tool that',
  );
  console.warn('  preserves the variable ids to switch it back on.');
}
if (unrouted.length) {
  console.warn(`\n[build-tokens] ${unrouted.length} group(s) in the export have no destination:`);
  for (const g of unrouted.slice(0, 20)) console.warn(`    - ${g}`);
  if (unrouted.length > 20) console.warn(`    …and ${unrouted.length - 20} more`);
  console.warn('  Add each to variables.groups (or variables.ignoreKeys) in figma.config.json.');
}
if (modeless.length) {
  console.warn('\n[build-tokens] per-mode groups found in a source with no mode — skipped:');
  for (const g of modeless) console.warn(`    - ${g}`);
  console.warn('  "semantic"/"components" need a source whose role is mode:<name>.');
}
if (circular.length) {
  console.warn(`\n[build-tokens] ${circular.length} CIRCULAR alias chain(s) in the export:`);
  for (const ref of circular) console.warn(`    - ${ref}`);
}
if (unresolved.length) {
  console.warn(`\n[build-tokens] ${unresolved.length} BROKEN alias(es) in the Figma export`);
  console.warn(`  (substituted '${UNRESOLVED_FALLBACK}' — flag these to the design team):`);
  for (const ref of unresolved) console.warn(`    - ${ref}`);
}
