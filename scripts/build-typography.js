/* eslint-disable */
/**
 * build-typography.js — generate the text-style ramp from a Figma library's TEXT STYLES.
 *
 * WHY THIS IS A SEPARATE SCRIPT FROM build-tokens.js
 * --------------------------------------------------
 * Figma text styles are **not variables**. They are a different primitive stored in a different
 * place, so they are completely absent from the variables export that `build-tokens.js` reads —
 * no amount of re-exporting will make them appear. The only way to get them is the REST API:
 * `/v1/files/:key/styles` lists the styles (name + node id, no metrics), and the node behind each
 * style carries the actual `style` block. Hence: two scripts, one token pipeline.
 *
 * WHAT IT EMITS (into `paths.tokensDir/typography.generated.ts`)
 *   - `textStyles` — per-CATEGORY metrics `{ fontSize, lineHeight?, letterSpacing }`. These are
 *     weight-independent in a well-formed ramp (Body/Regular and Body/Bold share a size and a
 *     line height), so one row per category.
 *   - one face map per configured prefix — the `{ fontFamily, fontWeight }` for each
 *     (category, weight SLOT). A library's face-per-slot is regularly IRREGULAR: a "bold" slot
 *     bound to a Medium face, a display slot that stops at 500 while body goes to 700. That
 *     cannot be derived from the slot name, so it is captured verbatim from Figma. The first
 *     configured prefix is the BASE (it drives metrics and the base faces); every later prefix
 *     emits FACE OVERRIDES ONLY — just the slots whose face differs from the base — which is how
 *     a second script/locale with diverging weights is expressed without duplicating the ramp.
 *
 * THINGS LEARNED THE HARD WAY
 *   - Prefer `lineHeightPx`. Figma resolves it even when the style was authored as a percentage,
 *     so it is the one unit that always means the same thing. (A style set to "Auto" has no
 *     resolved px value; nothing is emitted for it and the renderer falls back to the font's own
 *     metrics — which is the correct behaviour, not a bug to paper over.)
 *   - letterSpacing is emitted, never enforced. Whether tracking is APPLIED is a per-project
 *     RENDERING decision: some fonts (and some text engines) render tight tracking badly enough
 *     that a project deliberately drops it. That policy belongs in the app's text layer, not in
 *     a generated file — so this script reports the design intent and stops there.
 *   - A tight design line height only renders un-clipped if the font's declared vertical metrics
 *     describe a box that fits inside it. If the ramp looks right in Figma and clipped in the
 *     app, the fix is the font metrics, not the numbers here — see scripts/patch-font-metrics.py.
 *   - `typographySource.faceFixes` corrects known Figma authoring bugs on the way out, and every
 *     correction is logged loudly, because a silent fix here becomes an invisible divergence
 *     between the library and the app. Fix it in Figma too, then delete the entry.
 *
 * Usage: node scripts/build-typography.js [--file <fileKey>]
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, resolvePath, requireFileKey } = require('./figma-config');

// The kit ships figma-net.js (one token loader + a retrying fetch) — prefer it so there is a
// single credential path, but keep working when this script is used on its own.
let net = null;
try {
  net = require('./figma-net');
} catch {}

const cfg = loadConfig();
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

const OUT_DIR = resolvePath(cfg, cfg.paths.tokensDir);
const OUT = OUT_DIR ? path.join(OUT_DIR, 'typography.generated.ts') : null;
const PREFIXES = cfg.typographySource.prefixes || [];
const ORDER = cfg.typographySource.order || [];
const FACE_FIXES = cfg.typographySource.faceFixes || {};

function fail(msg) {
  console.error(`[build-typography] ${msg}`);
  process.exit(1);
}

if (!OUT) {
  fail(
    'paths.tokensDir is not set. Add it to figma-kit.config.json, e.g.\n' +
      '  "paths": { "tokensDir": "src/theme/tokens" }',
  );
}
if (!PREFIXES.length) {
  fail(
    'typographySource.prefixes is empty — the script needs to know which style names to read.\n' +
      '  A prefix is the leading part of a style name in Figma: for a style named\n' +
      '  "Mobile/Body/Regular" the prefix is "Mobile/". The first prefix is the base; later\n' +
      '  ones add face overrides only.',
  );
}

// ─── Credentials + transport ──────────────────────────────────────────────────
/** Env var wins; the env file is the fallback. Quotes are stripped — a quoted value sent verbatim
 *  is the classic "authenticates from one script, 403s from the next" bug. */
function localToken() {
  const envVar = (cfg.auth && cfg.auth.envVar) || 'FIGMA_ACCESS_TOKEN';
  if (process.env[envVar]) return process.env[envVar];
  const file = resolvePath(cfg, cfg.auth && cfg.auth.envFile);
  if (file && fs.existsSync(file)) {
    const m = fs
      .readFileSync(file, 'utf8')
      .match(new RegExp(`^\\s*${envVar}\\s*=\\s*(.+?)\\s*$`, 'm'));
    if (m) return m[1].replace(/^['"]|['"]$/g, '');
  }
  return null;
}

/** Figma's API times out and 5xxs often enough that an un-retried call means manual re-runs; 429
 *  happens as soon as two scripts run at once. Retry those, never other 4xx. */
async function localFetchRetry(url, opts = {}, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) {
        await new Promise((r) => setTimeout(r, 600 * 2 ** i + Math.floor(Math.random() * 400)));
      }
    }
  }
  throw lastErr;
}

const fetchRetry = (net && net.fetchRetry) || localFetchRetry;

async function figmaGet(url, headers) {
  const res = await fetchRetry(url, { headers });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.err || body.message || '';
    } catch {}
    const hint =
      res.status === 403
        ? '\n  403 usually means the token cannot see this file (wrong account, or the file was never shared).'
        : res.status === 404
          ? '\n  404 usually means the file key is wrong — copy it from the file URL.'
          : '';
    fail(`Figma API ${res.status}${detail ? ` — ${detail}` : ''}${hint}\n  ${url}`);
  }
  return res.json();
}

// ─── Name handling ────────────────────────────────────────────────────────────
/** "Large Title" -> "largeTitle"; "Caption2" -> "caption2" */
const toKey = (category) =>
  category
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/[^a-z0-9]/gi, '');

/** "Bold" | "bold" | "Black" -> "bold" | "black" */
const toSlot = (name) => name.trim().toLowerCase();

const round = (n) => Math.round(n * 100) / 100;

const titleSegment = (s) =>
  s.length > 1 && s === s.toUpperCase()
    ? s[0] + s.slice(1).toLowerCase() // "AR" -> "Ar", so the export reads as an identifier
    : s[0].toUpperCase() + s.slice(1);

const pascal = (s) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(titleSegment)
    .join('');

/**
 * Name each face export after its prefix. The leading segments every prefix shares carry no
 * information (they are the platform/library folder), so they are dropped: with prefixes
 * "Mobile/Latin/" and "Mobile/Greek/" the exports come out as `textFaces` (the base) and
 * `textFacesGreek`.
 */
function faceExportNames(prefixes) {
  const segs = prefixes.map((p) => p.split('/').filter(Boolean));
  let common = 0;
  if (segs.length > 1) {
    const shortest = Math.min(...segs.map((s) => s.length));
    while (common < shortest - 1 && segs.every((s) => s[common] === segs[0][common])) common++;
  }
  const used = new Set(['textFaces']);
  return prefixes.map((p, i) => {
    if (i === 0) return 'textFaces';
    const tail = segs[i].slice(common).join(' ') || segs[i].join(' ') || String(i);
    let name = `textFaces${pascal(tail) || i}`;
    let n = 2;
    while (used.has(name)) name = `textFaces${pascal(tail) || i}${n++}`;
    used.add(name);
    return name;
  });
}

// ─── Fetch ────────────────────────────────────────────────────────────────────
/**
 * Rows for one prefix. The styles endpoint hands back names + node ids only, so the metrics come
 * from a second call: nodes are fetched 40 ids at a time (a long id list makes the query string
 * unwieldy and the response huge) with `depth=1`, because the style block lives on the node
 * itself and pulling its subtree would multiply the payload for nothing.
 */
async function fetchPrefix(fileKey, prefix, headers, allStyles) {
  const styles = allStyles.filter((s) => s.name.startsWith(prefix));
  if (!styles.length) {
    const sample = [...new Set(allStyles.map((s) => s.name.split('/').slice(0, 2).join('/')))];
    fail(
      `No TEXT style in the file starts with "${prefix}".\n` +
        `  Style-name prefixes present: ${sample.slice(0, 10).join(', ') || '(none — the file has no published text styles)'}\n` +
        '  Fix typographySource.prefixes in figma-kit.config.json.',
    );
  }

  const nameById = {};
  styles.forEach((s) => (nameById[s.node_id] = s.name));
  const ids = styles.map((s) => s.node_id);

  const rows = []; // { category, key, slot, fontSize, lineHeight, letterSpacing, face }
  for (let i = 0; i < ids.length; i += 40) {
    const group = ids.slice(i, i + 40);
    const url = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${group.join(',')}&depth=1`;
    const { nodes } = await figmaGet(url, headers);
    for (const id of group) {
      const st = nodes && nodes[id] && nodes[id].document && nodes[id].document.style;
      if (!st) continue;
      const rest = nameById[id].slice(prefix.length).split('/');
      const category = rest[0];
      const slot = toSlot(rest[1] || 'regular');
      const fix = FACE_FIXES[`${prefix}${toKey(category)}/${slot}`];
      if (fix) {
        console.warn(
          `[build-typography] authoring bug corrected: ${nameById[id]} ` +
            `(${st.fontPostScriptName}/${st.fontWeight}) -> ${fix.fontFamily}/${fix.fontWeight}`,
        );
      }
      rows.push({
        category,
        key: toKey(category),
        slot,
        fontSize: round(st.fontSize),
        lineHeight: st.lineHeightPx ? round(st.lineHeightPx) : undefined,
        letterSpacing: st.letterSpacing ? round(st.letterSpacing) : 0,
        fontFamily: fix ? fix.fontFamily : st.fontPostScriptName,
        fontWeight: fix ? fix.fontWeight : String(st.fontWeight),
      });
    }
  }
  return rows;
}

// ─── Shaping ──────────────────────────────────────────────────────────────────
/** Configured order first, then anything the config does not know about (sorted, for stability). */
const sortKeys = (cats) =>
  ORDER.filter((k) => cats[k]).concat(
    Object.keys(cats)
      .filter((k) => !ORDER.includes(k))
      .sort(),
  );

const facesOf = (rows) => {
  const faces = {};
  for (const r of rows) {
    (faces[r.key] = faces[r.key] || {})[r.slot] = {
      fontFamily: r.fontFamily,
      fontWeight: r.fontWeight,
    };
  }
  return faces;
};

/** Emit a per-(key, slot) face literal; `only` restricts it to a subset of keys/slots. */
const facesLiteral = (faces, only) => {
  const keys = sortKeys(faces).filter((k) => !only || only[k]);
  return keys
    .map((k) => {
      const slots = Object.keys(faces[k])
        .filter((s) => !only || only[k][s])
        .map(
          (s) =>
            `${s}: { fontFamily: '${faces[k][s].fontFamily}', fontWeight: '${faces[k][s].fontWeight}' }`,
        );
      return `  ${k}: { ${slots.join(', ')} },`;
    })
    .join('\n');
};

async function format(source, file) {
  try {
    const prettier = require('prettier');
    const options = (await prettier.resolveConfig(file)) || {};
    return await prettier.format(source, { ...options, parser: 'typescript' });
  } catch (e) {
    console.warn(
      '[build-typography] prettier not installed — writing unformatted output ' +
        '(harmless; run your formatter over the file if it is format-checked in CI)',
    );
    return source;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const fileKey = requireFileKey(cfg, flag('--file'), 'default');
  const token = (net && net.loadFigmaToken && net.loadFigmaToken(cfg)) || localToken();
  if (!token) {
    fail(
      `No Figma token. Set ${(cfg.auth && cfg.auth.envVar) || 'FIGMA_ACCESS_TOKEN'} in the ` +
        `environment or in ${(cfg.auth && cfg.auth.envFile) || '.env.local'} (and gitignore it).`,
    );
  }
  const headers = { 'X-Figma-Token': token };

  const meta = await figmaGet(`https://api.figma.com/v1/files/${fileKey}/styles`, headers);
  const allStyles = ((meta.meta && meta.meta.styles) || []).filter((s) => s.style_type === 'TEXT');
  if (!allStyles.length) {
    fail(
      'The file reports no TEXT styles.\n' +
        '  This endpoint lists a file\'s LIBRARY styles — styles that exist locally but were\n' +
        '  never published from that file do not appear. Publish them, or point files.default\n' +
        '  at the library file that owns the type ramp.',
    );
  }

  const perPrefix = [];
  for (const prefix of PREFIXES) {
    perPrefix.push(await fetchPrefix(fileKey, prefix, headers, allStyles));
  }

  // Metrics come from the base prefix only — they are weight-independent per category, so the
  // first row for a category wins. A later row that disagrees means the library itself is
  // inconsistent, which is worth saying out loud rather than silently taking whichever came first.
  const metrics = {};
  for (const r of perPrefix[0]) {
    if (!metrics[r.key]) {
      metrics[r.key] = {
        fontSize: r.fontSize,
        lineHeight: r.lineHeight,
        letterSpacing: r.letterSpacing,
      };
      continue;
    }
    const m = metrics[r.key];
    if (m.fontSize !== r.fontSize || m.lineHeight !== r.lineHeight) {
      console.warn(
        `[build-typography] ${r.category}/${r.slot} disagrees with the rest of its category ` +
          `(${r.fontSize}/${r.lineHeight} vs ${m.fontSize}/${m.lineHeight}) — kept ${m.fontSize}/${m.lineHeight}`,
      );
    }
  }

  const baseFaces = facesOf(perPrefix[0]);
  const exportNames = faceExportNames(PREFIXES);

  // Later prefixes contribute only the slots whose face actually differs from the base.
  const overrides = perPrefix.slice(1).map((rows, i) => {
    const faces = facesOf(rows);
    const mask = {};
    for (const k of Object.keys(faces)) {
      for (const s of Object.keys(faces[k])) {
        const base = baseFaces[k] && baseFaces[k][s];
        const own = faces[k][s];
        if (!base || base.fontFamily !== own.fontFamily || base.fontWeight !== own.fontWeight) {
          (mask[k] = mask[k] || {})[s] = true;
        }
      }
    }
    return { prefix: PREFIXES[i + 1], name: exportNames[i + 1], faces, mask };
  });

  const metricKeys = sortKeys(metrics);
  const metricLines = metricKeys.map((k) => {
    const lh = metrics[k].lineHeight != null ? `, lineHeight: ${metrics[k].lineHeight}` : '';
    return `  ${k}: { fontSize: ${metrics[k].fontSize}${lh}, letterSpacing: ${metrics[k].letterSpacing} },`;
  });

  const overrideBlocks = overrides
    .map(
      (o) => `
/**
 * Face overrides for "${o.prefix}" — only the slots whose face differs from the base ramp.
 * Merge over \`textFaces\` when this variant is active.
 */
export const ${o.name} = {
${facesLiteral(o.faces, o.mask)}
} as const satisfies Partial<Record<TextStyleName, Partial<Record<string, Face>>>>;
`,
    )
    .join('');

  const out = `/**
 * AUTO-GENERATED from the Figma library's text styles — DO NOT EDIT BY HAND.
 * Regenerate: node scripts/build-typography.js
 *
 * Metrics are per category and weight-independent. The face for each (category, weight slot) is
 * captured verbatim because a library's face-per-slot is often irregular and cannot be derived
 * from the slot name. letterSpacing is the design intent; whether to APPLY it is the app's call.
 */

export const textStyles = {
${metricLines.join('\n')}
} as const;

export type TextStyleName = keyof typeof textStyles;

type Face = { fontFamily: string; fontWeight: string };

/** Faces for "${PREFIXES[0]}" — the base ramp. */
export const textFaces = {
${facesLiteral(baseFaces)}
} as const satisfies Partial<Record<TextStyleName, Partial<Record<string, Face>>>>;
${overrideBlocks}`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, await format(out, OUT));

  console.log(`[build-typography] wrote ${path.relative(cfg.__root, OUT)}`);
  console.log(`  categories : ${metricKeys.length} (${metricKeys.join(', ')})`);
  console.log(`  base faces : ${PREFIXES[0]} -> textFaces`);
  for (const o of overrides) {
    const slots = Object.values(o.mask).reduce((n, s) => n + Object.keys(s).length, 0);
    console.log(
      `  overrides  : ${o.prefix} -> ${o.name} ` +
        `(${slots} slot(s) across ${Object.keys(o.mask).length} categories differ from the base)`,
    );
  }
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
