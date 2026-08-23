/* eslint-disable */
/**
 * figma-extract — print the EXACT spec of a Figma node, so an agent can port it without guessing.
 *
 *   node scripts/figma-extract.js <nodeId> [--file <fileKey>] [--screens] [--depth <n>]
 *   e.g. node scripts/figma-extract.js 1234:5678
 *
 * WHY THIS EXISTS
 * Dumping a raw Figma node tree at a model is worse than useless: it is enormous, most of it is
 * noise, and the few numbers that matter (radius, gap, the third fill in a stack) are buried.
 * This prints a compact spec of ONLY the properties that decide whether the built UI matches the
 * design — and, crucially, annotates each one with whether the design *intended* that value.
 *
 * For every node it prints: size, auto-layout (gap/padding), cornerRadius, stroke, fill (EVERY
 * paint when a shape is multi-fill — they composite, and the bottom paint alone is not what
 * renders), and text style (size/weight/lineHeight/letterSpacing). For each styled value it shows
 * whether the property is BOUND TO A FIGMA VARIABLE and suggests the matching generated token to
 * reference in code. Unbound style values are flagged ⚠LITERAL — they are hardcoded in Figma and
 * must be verified with design before they are copied into code (a hand-typed radius that nobody
 * meant is a real and frequent authoring bug; so is a deliberate one-off. The flag says "ask",
 * not "wrong").
 *
 * THE BINDING CHECK NEEDS NO ENTERPRISE PLAN. `bound()` only key-tests `node.boundVariables`,
 * which the ordinary `/v1/files/:key/nodes` response carries for every node on every plan. It
 * never calls the Variables API (`/v1/files/:key/variables/local`), which is Organization/
 * Enterprise-only. So the single most valuable signal in this kit — "is this value a token or a
 * literal?" — works on a free or Professional Figma seat.
 *
 * NEITHER DOES NAMING THE VARIABLE. `boundVariables[prop]` does not just say "bound", it carries
 * the variable's ID (`{ type: 'VARIABLE_ALIAS', id: 'VariableID:1:23' }`) — and every leaf in the
 * variables export carries the SAME id under `$extensions["com.figma.variableId"]`. Verified live:
 * the Variables API 403s on lower plans, but those two do not. `build-tokens.js` joins them into
 * `<paths.tokensDir>/variable-map.generated.json` (id → the code reference the token became), and
 * this script reads it: a bound property then resolves to EXACTLY ONE token, printed `✓exact`.
 *
 * Without that map (no token build yet, or an export whose plugin dropped the ids) the script falls
 * back to what it always did — matching the RESOLVED VALUE against the project's generated token
 * modules and offering a shortlist. That fallback is a guess: `#FFFFFF` legitimately matches three
 * tokens and a human has to pick. Prefer the map; the fallback exists so nothing ever crashes.
 *
 * A bound id the map does not contain is not an error either — it means the design gained a
 * variable your export predates. Those are called out inline and tallied at the end, because they
 * say something no other signal does: the token pipeline is behind the design file.
 *
 * COMPONENT PROPERTIES ARE A CONTRACT. When the node is a component set, its
 * `componentPropertyDefinitions` are printed first as a state matrix: every VARIANT axis with all
 * its options, plus BOOLEAN/TEXT/INSTANCE_SWAP props and the number of variant combinations. That
 * list is the definition of done — implement (and Code-Connect-map) every state, not the subset
 * that happens to be on screen.
 *
 * SPACING IS A PER-PROJECT FACT, NOT A FIGMA FACT. Many design systems never bind variables to
 * gap/padding, so those values can never come back ✓bound and the ramp is code-owned; some systems
 * do bind them. `tokens.spacing.tokenizedInFigma` says which world you are in: when false, each
 * gap/padding value is checked against the configured spacing ramp (on-ramp ⇒ the code reference;
 * off-ramp ⇒ ⚠OFF-GRID with the nearest step, summarised at the end); when true, gap/padding also
 * get the ✓bound / ⚠LITERAL treatment like every other styled value.
 *
 * Off-ramp spacing found INSIDE a component instance is reported separately and informationally:
 * that geometry is owned by the component instance, not authored in the layout you are porting.
 *
 * Every project-specific value (file keys, token module paths, the text component's name) comes
 * from `figma-kit.config.json`. With no config the script still runs as a plain extractor — the
 * suggestion features simply switch off with a one-line warning.
 */
const fs = require('fs');
const path = require('path');
const { fetchRetry, requireFigmaToken } = require('./figma-net');
const { loadConfig, resolvePath, requireFileKey, loadTokenModule } = require('./figma-config');

const cfg = loadConfig();
const rel = (p) => path.relative(cfg.__root, p) || p;
const TOKENS_BUILD_CMD =
  (cfg.commands && cfg.commands.tokensBuild) || 'node scripts/build-tokens.js';

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let nodeId = null;
let fileFlag = null;
let slot = 'default';
let depth = 99;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--file') fileFlag = argv[++i];
  else if (argv[i] === '--screens') slot = 'screens';
  else if (argv[i] === '--depth') depth = Number(argv[++i]);
  else nodeId = argv[i];
}
if (!nodeId) {
  console.error(
    'Usage: node scripts/figma-extract.js <nodeId> [--file <fileKey>] [--screens] [--depth <n>]',
  );
  process.exit(1);
}
const fileKey = requireFileKey(cfg, fileFlag, slot);

// ── color helpers ───────────────────────────────────────────────────────────────
// Format ONE paint. A non-solid paint (gradient/image) has no flat color — print its type.
function onePaint(p) {
  if (p.type !== 'SOLID') return p.type;
  const c = p.color;
  const a = p.opacity != null ? p.opacity : c.a != null ? c.a : 1;
  const [r, g, b] = ['r', 'g', 'b'].map((k) => Math.round(c[k] * 255));
  return a >= 0.999
    ? '#' +
        [r, g, b]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase()
    : `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}
// A paint toggled off in Figma is still in the array but paints nothing.
const hiddenMark = (p) => (p.visible === false ? ' (HIDDEN — does not render)' : '');
// First paint only — for strokes and the TEXT summary line, where one color is representative.
function paintColor(paints) {
  if (!paints || !paints.length) return null;
  return onePaint(paints[0]);
}

// ── variable map (variable id -> code reference) ─────────────────────────────────
/**
 * The exact half of token resolution. `build-tokens.js` writes this next to the generated tokens,
 * keyed by the very same `VariableID:…` that `node.boundVariables` hands us here — so a bound
 * property names one token instead of every token that happens to share its value.
 *
 * Every failure mode degrades to the value-matching fallback with ONE `[warn]`: no tokensDir, no
 * file yet, unreadable JSON, or a map with no entries. None of them are worth stopping an extract
 * for, and a silent switch-off would be worse than either.
 */
const VARIABLE_MAP_FILE = 'variable-map.generated.json';
let variableMap = null; // { "VariableID:1:23": { ref, figmaPath, values } }

(function loadVariableMap() {
  const dir = resolvePath(cfg, cfg.paths.tokensDir);
  if (!dir) {
    console.warn(
      '[warn] paths.tokensDir is not set — no variable map, so tokens are suggested by VALUE (can tie).',
    );
    return;
  }
  const file = path.join(dir, VARIABLE_MAP_FILE);
  if (!fs.existsSync(file)) {
    console.warn(
      `[warn] no variable map at ${rel(file)} — tokens are suggested by VALUE (can tie). ` +
        `Run \`${TOKENS_BUILD_CMD}\` to generate it and get exact resolution.`,
    );
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const vars = parsed && parsed.variables;
    if (!vars || typeof vars !== 'object' || !Object.keys(vars).length) {
      throw new Error('it contains no "variables" entries');
    }
    variableMap = vars;
  } catch (e) {
    console.warn(
      `[warn] could not read the variable map (${rel(file)}): ${e.message} — ` +
        'tokens are suggested by VALUE instead.',
    );
  }
})();

// ── generated-token index (value -> code reference) ──────────────────────────────
// The FALLBACK for anything the variable map cannot resolve: index the project's own generated
// token modules by VALUE, and offer whatever code reference produces the value we found. Treat a
// result as a shortlist — several tokens can share one value, which is exactly what the map fixes.
const index = new Map(); // normalized value -> Set(reference)
function addIdx(value, ref) {
  const key = String(value).toUpperCase();
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(ref);
}
function walkTokens(obj, prefix) {
  for (const [k, v] of Object.entries(obj)) {
    const ref = /^\d+$/.test(k) ? `${prefix}[${k}]` : `${prefix}.${k}`;
    if (v && typeof v === 'object') walkTokens(v, ref);
    else addIdx(v, ref);
  }
}
/** Index one export of a loaded module under `prefix` (the way it is written in code). */
function indexExport(mod, name, prefix, label) {
  const value = mod[name];
  if (value == null) {
    console.warn(`[warn] ${label}: no export named "${name}" — skipped.`);
    return;
  }
  if (typeof value === 'object') walkTokens(value, prefix);
  else addIdx(value, prefix);
}
/**
 * `nested` handles a per-mode wrapper: a themes module keyed by mode, each mode holding the same
 * shape. Code references those slots mode-agnostically (the mode-aware accessor picks the mode at
 * runtime), so EVERY mode is indexed under the SAME reference prefix — light and dark both map
 * their `components.*` values onto `components.*`.
 */
function indexNested(mod, spec, label) {
  const root = mod[spec.export];
  if (root == null || typeof root !== 'object') {
    console.warn(`[warn] ${label}: no object export named "${spec.export}" — skipped.`);
    return;
  }
  const buckets = spec.perMode ? Object.values(root) : [root];
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== 'object') continue;
    const picks = spec.pick && spec.pick.length ? spec.pick : Object.keys(bucket);
    for (const p of picks) {
      const v = bucket[p];
      if (v && typeof v === 'object') walkTokens(v, p);
      else if (v != null) addIdx(v, p);
    }
  }
}
const tokenIndexSpec = Array.isArray(cfg.tokens.index) ? cfg.tokens.index : [];
if (!tokenIndexSpec.length) {
  console.warn(
    '[warn] no tokens.index configured — running as a plain extractor (no token suggestions).',
  );
}
for (const entry of tokenIndexSpec) {
  const abs = resolvePath(cfg, entry && entry.path);
  const label = (entry && entry.path) || '(entry with no path)';
  if (!abs) {
    console.warn(`[warn] tokens.index entry has no path — skipped.`);
    continue;
  }
  // One try/catch PER entry: a single unbuildable module must not cost you every other suggestion.
  try {
    const mod = loadTokenModule(abs);
    if (Array.isArray(entry.exports)) {
      for (const name of entry.exports) indexExport(mod, name, name, label);
    } else if (entry.exports && typeof entry.exports === 'object') {
      for (const [name, prefix] of Object.entries(entry.exports)) {
        indexExport(mod, name, prefix, label);
      }
    }
    for (const spec of entry.nested || []) indexNested(mod, spec, label);
  } catch (e) {
    console.warn(`[warn] could not index ${label} for suggestions: ${e.message}`);
  }
}
/** Up to three code references that produce `value`. Empty when nothing matches. */
function valueMatches(value) {
  const hit = index.get(String(value).toUpperCase());
  return hit ? [...hit].slice(0, 3) : [];
}
function suggest(value) {
  const hits = valueMatches(value);
  return hits.length ? '  ⇒ token: ' + hits.join(' | ') : '';
}

// ── spacing ramp → code reference ────────────────────────────────────────────────
// The ramp keys drive the reference, so both shapes work: a ramp keyed by its own value renders
// `space[8]`, a named ramp renders `space.md` — whatever `refTemplate` says, with {n} = the key.
const SPACING = cfg.tokens.spacing || {};
const SPACING_TOKENIZED = SPACING.tokenizedInFigma === true;
const SPACE_REF_TEMPLATE = SPACING.refTemplate || 'space[{n}]';
let SPACE_RAMP = []; // sorted unique numeric steps
const SPACE_REF = new Map(); // numeric step -> code reference
if (SPACING.rampPath) {
  try {
    const mod = loadTokenModule(resolvePath(cfg, SPACING.rampPath));
    const ramp = mod[SPACING.rampExport || 'space'];
    if (!ramp || typeof ramp !== 'object') {
      throw new Error(`no object export named "${SPACING.rampExport || 'space'}"`);
    }
    for (const [k, v] of Object.entries(ramp)) {
      const n = Number(v);
      if (Number.isNaN(n)) continue;
      // First key wins: aliases pointing at the same step keep the canonical name in suggestions.
      if (!SPACE_REF.has(n)) SPACE_REF.set(n, SPACE_REF_TEMPLATE.replace('{n}', k));
    }
    SPACE_RAMP = [...SPACE_REF.keys()].sort((a, b) => a - b);
  } catch (e) {
    console.warn(`[warn] could not load the spacing ramp (${SPACING.rampPath}): ${e.message}`);
  }
} else {
  console.warn('[warn] no tokens.spacing.rampPath configured — off-grid spacing checks are off.');
}
function nearestSpace(px) {
  return SPACE_RAMP.reduce(
    (best, v) => (Math.abs(v - px) < Math.abs(best - px) ? v : best),
    SPACE_RAMP[0],
  );
}
const spaceRef = (px) => SPACE_REF.get(px) || String(px);
function suggestSpace(px) {
  if (px == null || px === 0 || !SPACE_RAMP.length) return '';
  if (SPACE_REF.has(px)) return ` ⇒ ${spaceRef(px)}`;
  return ` ⚠OFF-GRID (≈ ${spaceRef(nearestSpace(px))})`;
}

// ── typography ramp → text-style suggestion ──────────────────────────────────────
const TYPO = cfg.tokens.typography || {};
let textRamp = {};
if (TYPO.rampPath) {
  try {
    const mod = loadTokenModule(resolvePath(cfg, TYPO.rampPath));
    textRamp = mod[TYPO.rampExport || 'textStyles'] || {};
    if (!Object.keys(textRamp).length) {
      console.warn(`[warn] typography ramp ${TYPO.rampPath} exported nothing usable.`);
    }
  } catch (e) {
    console.warn(`[warn] could not load the typography ramp (${TYPO.rampPath}): ${e.message}`);
  }
} else {
  console.warn('[warn] no tokens.typography.rampPath configured — text-style suggestions are off.');
}
function weightName(w) {
  if (w >= 750) return 'black';
  if (w >= 650) return 'bold';
  if (w >= 450) return 'medium';
  return 'regular';
}
// Match a Figma text node's metrics to a project text style and render the code suggestion.
// Size alone is ambiguous (several styles share a size), so lineHeight disambiguates when present.
function suggestText(st) {
  if (!st || !Object.keys(textRamp).length) return '';
  const size = Math.round(st.fontSize);
  const lh = Math.round((st.lineHeightPx || 0) * 10) / 10;
  let names = Object.entries(textRamp).filter(([, v]) => Math.round(v.fontSize) === size);
  if (names.length > 1 && lh) {
    const byLh = names.filter(([, v]) => Math.abs(v.lineHeight - lh) < 0.6);
    if (byLh.length) names = byLh;
  }
  if (!names.length) {
    // No style at this size means the mock is off-system. Inventing a close-enough style here is
    // how a design system quietly grows a twelfth heading size — make a human decide instead.
    return `  ⚠ no DS text style at ${size}px — confirm with design (do NOT invent; use a DS variant)`;
  }
  const variant = names.map(([k]) => k).join('|');
  const weight = weightName(st.fontWeight || 400);
  const template = TYPO.component
    ? TYPO.suggestionTemplate || '<{component} variant={variant} weight={weight}>'
    : '{variant} (weight {weight})';
  const rendered = template
    .replace(/\{component\}/g, TYPO.component || '')
    .replace(/\{variant\}/g, variant)
    .replace(/\{weight\}/g, weight);
  return `  ⇒ ${rendered}`;
}

// ── fetch + walk ─────────────────────────────────────────────────────────────────
const literals = []; // unbound styled values to flag
const offGrid = []; // flow-authored auto-layout gap/padding not on the spacing ramp
const offGridDS = []; // off-ramp gap/padding INSIDE a component instance (component-owned — info)

// Round a px value for DISPLAY only — membership tests (SPACE_REF.has) use the raw value.
const disp = (v) => Math.round(v * 100) / 100;

/**
 * Is this property bound to a Figma variable? A key-test on `node.boundVariables` only — no
 * Variables API call, so this works on every Figma plan (see the header). Substring matching keeps
 * it robust to Figma's per-property key names (`itemSpacing`, `paddingTop`, `fills`, `strokes`,
 * `topLeftRadius`, …) without enumerating them.
 */
function bound(node, ...keys) {
  const bv = node.boundVariables || {};
  return keys.some((k) => Object.keys(bv).some((bk) => bk.toLowerCase().includes(k)));
}

const staleBindings = []; // bound to a variable id the export doesn't know about

/** `{ type: 'VARIABLE_ALIAS', id }` → the id. Anything else → null. */
function aliasId(entry) {
  return entry && typeof entry.id === 'string' && entry.id ? entry.id : null;
}

/**
 * The variable id bound to ONE property. Two shapes live in `boundVariables` and mixing them up
 * silently attributes the wrong token: the paint-ish keys (`fills`, `strokes`) hold an ARRAY
 * parallel to the paint stack, so paint 2's variable is `fills[2]` — every other key
 * (`cornerRadius`, `itemSpacing`, `paddingLeft`, `strokeWeight`) holds a single alias object.
 *
 * Matching is by KEY NAME, never by position in the object: a node can bind four different
 * variables and the order Figma serializes them in is not a contract. A shorter-than-expected
 * array (an unbound paint in the stack) just yields null and falls through to value matching.
 */
function boundVariableId(node, keys, paintIndex = 0) {
  const bv = node.boundVariables || {};
  for (const bk of Object.keys(bv)) {
    if (!keys.some((k) => bk.toLowerCase().includes(k))) continue;
    const v = bv[bk];
    const id = Array.isArray(v) ? aliasId(v[paintIndex]) : aliasId(v);
    if (id) return id;
  }
  return null;
}

/**
 * The token line for one styled property, in descending order of trust:
 *   exact — the bound id is in the map: that IS the token; no shortlist, no judgement call.
 *   stale — bound, but the map has never heard of the id: your export predates this variable. Say
 *           which id, tally it, and still offer the value match so the run stays useful.
 *   none  — no map, or the property isn't bound: exactly what this script did before the map.
 */
function tokenFor(node, prop, keys, value, paintIndex) {
  if (!variableMap) return suggest(value);
  const id = boundVariableId(node, keys, paintIndex);
  if (!id) return suggest(value);
  const entry = variableMap[id];
  if (entry && entry.ref) return `  ⇒ token: ${entry.ref} ✓exact`;
  staleBindings.push(`${node.name}: ${prop} → ${id}`);
  const hits = valueMatches(value);
  return (
    `  ⇒ ⚠ bound to a variable missing from your export (${id}) — re-export variables` +
    (hits.length ? `; value match: ${hits.join(' | ')}` : '')
  );
}

/**
 * Gap gets the same treatment, but keeps the code-ramp check: a variable-bound gap can still be a
 * step your own ramp does not have, and losing that warning would trade one signal for another.
 */
function suggestGapToken(node, gap) {
  if (!variableMap) return suggestSpace(gap);
  const id = boundVariableId(node, ['itemspacing']);
  if (!id) return suggestSpace(gap);
  const entry = variableMap[id];
  if (entry && entry.ref) {
    const offRamp = gap && SPACE_RAMP.length && !SPACE_REF.has(gap);
    return ` ⇒ ${entry.ref} ✓exact${offRamp ? ' ⚠OFF-GRID' : ''}`;
  }
  staleBindings.push(`${node.name}: gap → ${id}`);
  return ` ⚠ variable missing from your export (${id})${suggestSpace(gap)}`;
}
function size(n) {
  const b = n.absoluteBoundingBox || {};
  return `${Math.round(b.width || 0)}×${Math.round(b.height || 0)}`;
}

function walk(n, ind, d, inInstance) {
  const pad = '  '.repeat(ind);
  const extra = [];
  // gap/padding inside a component instance belong to the component, not the flow you author —
  // once we enter an INSTANCE, its (and its descendants') spacing is informational, never
  // actionable.
  const dsCtx = inInstance || n.type === 'INSTANCE';
  if (n.layoutMode) {
    const gap = n.itemSpacing || 0;
    const pT = n.paddingTop || 0;
    const pR = n.paddingRight || 0;
    const pB = n.paddingBottom || 0;
    const pL = n.paddingLeft || 0;
    const offRamp = (v) => v && SPACE_RAMP.length && !SPACE_REF.has(v);
    const padMark = [pT, pR, pB, pL].some(offRamp) ? ' ⚠pad-off-grid' : '';
    // When the project binds spacing variables in Figma, gap/padding earn the same
    // ✓bound / ⚠LITERAL audit as any other styled value; when it doesn't, an unbound gap is
    // simply how that system works and flagging it would be pure noise.
    const gapBound = bound(n, 'itemspacing');
    const gapMark = SPACING_TOKENIZED ? (gapBound ? ' ✓bound' : ' ⚠LITERAL') : gapBound ? '✓' : '';
    const sides = [
      ['T', pT, 'paddingtop'],
      ['R', pR, 'paddingright'],
      ['B', pB, 'paddingbottom'],
      ['L', pL, 'paddingleft'],
    ];
    const padStr = sides
      .map(([label, v, key]) => {
        const mark = SPACING_TOKENIZED && v ? (bound(n, key) ? '✓' : '⚠') : '';
        return `${label}${disp(v)}${mark}`;
      })
      .join(' ');
    extra.push(
      `${n.layoutMode} gap=${disp(gap)}${gapMark}${suggestGapToken(n, gap)} pad[${padStr}]${padMark}`,
    );
    // Same rule as the off-grid split below: spacing inside an instance is the component's, so an
    // unbound gap in there is not a binding YOU are missing. Only tally spacing you authored.
    if (SPACING_TOKENIZED && !dsCtx) {
      if (gap && !gapBound) literals.push(`${n.name}: gap=${disp(gap)} (no spacing variable)`);
      for (const [label, v, key] of sides) {
        if (v && !bound(n, key)) {
          literals.push(`${n.name}: pad${label}=${disp(v)} (no spacing variable)`);
        }
      }
    }
    const sink = dsCtx ? offGridDS : offGrid;
    for (const [label, v] of [
      ['gap', gap],
      ['padT', pT],
      ['padR', pR],
      ['padB', pB],
      ['padL', pL],
    ]) {
      if (offRamp(v)) {
        sink.push(`${n.name}: ${label}=${disp(v)}px (nearest ${spaceRef(nearestSpace(v))})`);
      }
    }
  }
  if ('cornerRadius' in n) {
    const b = bound(n, 'radius', 'corner');
    const note = tokenFor(n, 'cornerRadius', ['radius', 'corner'], n.cornerRadius);
    extra.push(`radius=${n.cornerRadius}${b ? ' ✓bound' : ' ⚠LITERAL'}${note}`);
    if (!b) literals.push(`${n.name}: cornerRadius=${n.cornerRadius}`);
  }
  if (n.strokes && n.strokes.length && n.strokeWeight != null) {
    const col = paintColor(n.strokes);
    const b = bound(n, 'stroke');
    // The COLOR is what the suggestion names, so resolve `strokes[0]` — a strokeWeight-only
    // binding must not lend its (numeric) token to the paint on this line.
    const note = tokenFor(n, 'stroke', ['strokes'], col, 0);
    extra.push(`stroke=${n.strokeWeight}px ${col}${b ? ' ✓bound' : ' ⚠LITERAL'}${note}`);
    if (!b) literals.push(`${n.name}: stroke ${col}`);
  }
  if (n.fills && n.fills.length) {
    const b = bound(n, 'fill');
    const bindMark = b ? ' ✓bound' : ' ⚠LITERAL';
    if (n.fills.length === 1) {
      const col = onePaint(n.fills[0]);
      const note = tokenFor(n, 'fill', ['fills'], col, 0);
      extra.push(`fill=${col}${hiddenMark(n.fills[0])}${bindMark}${note}`);
      if (!b && col.startsWith('#')) literals.push(`${n.name}: fill ${col}`);
    } else {
      // A shape can carry MULTIPLE fills, and they COMPOSITE — paints[0] is the BOTTOM layer.
      // Printing only paints[0] ships the wrong color whenever a translucent ink wash sits on top
      // of a background: the rendered result is neither paint on its own.
      extra.push(
        `fills[${n.fills.length}] — MULTI-FILL, these composite bottom→top; no single flat color${bindMark}`,
      );
      n.fills.forEach((p, i) => {
        const col = onePaint(p);
        const pos = i === 0 ? 'bottom' : i === n.fills.length - 1 ? 'top' : `${i + 1}`;
        // Each paint carries its OWN binding, so resolve per index rather than reusing paint 0's.
        const note = tokenFor(n, `fill[${i}]`, ['fills'], col, i);
        extra.push(`  [${i}/${pos}] ${col}${hiddenMark(p)}${note}`);
        if (!b && col.startsWith('#')) literals.push(`${n.name}: fill[${i}] ${col}`);
      });
    }
  }
  if (n.type === 'TEXT') {
    const s = n.style || {};
    // `color` is the first paint only; when the node is multi-fill the full stack is listed above.
    const more =
      n.fills && n.fills.length > 1 ? ` (+${n.fills.length - 1} more — see fills above)` : '';
    extra.push(
      `"${n.characters}" fontSize=${s.fontSize} weight=${s.fontWeight} lineHeight=${Math.round((s.lineHeightPx || 0) * 10) / 10} letterSpacing=${Math.round((s.letterSpacing || 0) * 100) / 100} color=${paintColor(n.fills)}${more}${suggestText(s)}`,
    );
  }
  console.log(
    `${pad}• ${n.name} [${n.type}] ${size(n)}` +
      (extra.length ? `\n${pad}    ${extra.join('\n' + pad + '    ')}` : ''),
  );
  if (d > 0) for (const c of n.children || []) walk(c, ind + 1, d - 1, dsCtx);
}

(async () => {
  const url = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&geometry=paths`;
  const res = await fetchRetry(url, { headers: { 'X-Figma-Token': requireFigmaToken(cfg) } });
  const json = await res.json();
  // A node id copied out of a Figma URL uses `-` where the API uses `:` — accept both.
  const entry = json.nodes && json.nodes[nodeId.replace('-', ':')];
  if (!entry) {
    console.error('Node not found / not exportable. Response:', JSON.stringify(json).slice(0, 200));
    process.exit(1);
  }
  console.log(`\n=== ${entry.document.name} (${nodeId}) in ${fileKey} ===`);
  const spacingLegend = SPACING_TOKENIZED
    ? '        gap/pad ✓bound = bound to a spacing variable | ⚠LITERAL = hardcoded | ⚠OFF-GRID = not on the ramp\n'
    : `        gap/pad ⇒ ${SPACE_REF_TEMPLATE.replace('{n}', 'N')} = on the code-owned spacing ramp | ⚠OFF-GRID = not on the ramp (snap, or extend the ramp)\n`;
  // The ✓exact lines only make sense when the map is loaded; without it every suggestion is a
  // value match and saying so twice is noise.
  const exactLegend = variableMap
    ? '        ⇒ token: X ✓exact = resolved by variable id from your export — X IS the token, not a guess\n' +
      '        a suggestion WITHOUT ✓exact is a value match: several tokens can share one value\n'
    : '';
  console.log(
    'Legend: ✓bound = bound to a Figma variable (reference the token) | ⚠LITERAL = hardcoded (VERIFY!)\n' +
      exactLegend +
      spacingLegend +
      '        fills[N] = MULTI-FILL, listed bottom→top: they composite, so no single paint is the color\n',
  );
  const defs = entry.document.componentPropertyDefinitions;
  if (defs && Object.keys(defs).length) {
    console.log(
      '## COMPONENT PROPERTIES (states & props) — implement AND Code-Connect-map EVERY one:',
    );
    for (const [raw, m] of Object.entries(defs)) {
      const nm = raw.split('#')[0];
      if (m.type === 'VARIANT')
        console.log(`   ${nm}  [VARIANT / state]  →  ${m.variantOptions.join(' | ')}`);
      else console.log(`   ${nm}  [${m.type}]  default=${JSON.stringify(m.defaultValue)}`);
    }
    const kids = entry.document.children || [];
    if (kids.length) {
      console.log(
        `   (${kids.length} variant combination${kids.length === 1 ? '' : 's'} in the set)`,
      );
    }
    console.log('');
  }
  walk(entry.document, 0, depth, false);
  const uniqLiterals = [...new Set(literals)];
  if (uniqLiterals.length) {
    console.log(
      `\n⚠ ${uniqLiterals.length} UNBOUND styled value(s) — verify these are intentional (not a missing variable binding):`,
    );
    for (const l of uniqLiterals) console.log('   - ' + l);
  }
  const uniqOffGrid = [...new Set(offGrid)];
  if (uniqOffGrid.length) {
    const rampNote = SPACING.rampPath ? ` (${SPACING.rampPath})` : '';
    console.log(
      `\n⚠ ${uniqOffGrid.length} OFF-GRID spacing value(s) in YOUR layout — not on the spacing ramp. Snap to the nearest step, or add a new step to the ramp${rampNote} if design truly intends it (a large fixed gap is usually a space-between layout, not a token):`,
    );
    for (const l of uniqOffGrid) console.log('   - ' + l);
  }
  const uniqOffGridDS = [...new Set(offGridDS)];
  if (uniqOffGridDS.length) {
    console.log(
      `\nℹ ${uniqOffGridDS.length} off-ramp value(s) INSIDE component instances — owned by the component instance, not authored here. Do NOT snap these; listed for reference only:`,
    );
    for (const l of uniqOffGridDS) console.log('   - ' + l);
  }
  const uniqStale = [...new Set(staleBindings)];
  if (uniqStale.length) {
    // Not a design defect and not a code defect — a PIPELINE one. The design file has variables the
    // generated tokens have never seen, so every one of these fell back to a value guess.
    console.log(
      `\n⚠ ${uniqStale.length} value(s) bound to variables MISSING from your variables export — your token pipeline is behind the design file. Re-export the variables from Figma and re-run \`${TOKENS_BUILD_CMD}\`; until then these were matched by value, which can tie:`,
    );
    for (const l of uniqStale) console.log('   - ' + l);
  }
  const gotchas = Array.isArray(cfg.gotchas) ? cfg.gotchas : [];
  if (gotchas.length) {
    // The per-project ledger: incidents this library has already cost someone, delivered at the
    // exact moment an agent is about to read a spec out of it.
    console.log('\n## Known gotchas for this library:');
    for (const g of gotchas) {
      console.log('   - ' + (typeof g === 'string' ? g : JSON.stringify(g)));
    }
  }
  console.log('\nNext: render it to compare visually →  node scripts/figma-render.js ' + nodeId);
})();
