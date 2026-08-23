/* eslint-disable */
/**
 * figma-config — THE single source of per-project settings for every figma-* script.
 *
 * Everything that differs between projects (file keys, token paths, component names, output
 * locations) lives in `figma.config.json` at the project root. The scripts themselves are
 * identical in every project and must never hard-code a project value.
 *
 * Resolution order for the config file:
 *   1. $FIGMA_CONFIG (explicit path)
 *   2. figma.config.json, walking up from cwd to the filesystem root
 *   3. built-in DEFAULTS (so a fresh repo still runs; `files.default` is then required per-call)
 *
 * A missing config is NOT an error — every field has a default and scripts degrade gracefully
 * (e.g. figma-extract runs as a plain extractor when no token index is configured). Run
 * `node scripts/config-check.js` to validate what you have.
 */
const fs = require('fs');
const path = require('path');

/** Every field the kit understands, with the value used when the config omits it. */
const DEFAULTS = {
  // Figma files this project reads. `default` is the design-system library; `screens` is the
  // product/screens file when the org splits them (many do). `volatile` names the keys that get
  // republished wholesale — their node ids renumber, so never trust a written-down id for them.
  files: { default: null, screens: null, volatile: [] },

  // Where the Figma personal access token comes from. env var wins; envFile is the fallback.
  auth: { envVar: 'FIGMA_ACCESS_TOKEN', envFile: '.env.local' },

  // The design frame the mocks are drawn on, and how you verify against it.
  design: { frameWidth: null, frameHeight: null, compareWidths: [], modes: ['light', 'dark'] },

  // Where generated artifacts are written (all relative to the project root).
  paths: {
    tokensDir: null, // generated token modules, e.g. 'src/theme/tokens'
    variablesExport: 'figma-variables', // where the Figma variables export is dropped
    iconRegistry: null, // e.g. 'src/components/icons/registry.generated.json'
    graphicsDir: null, // e.g. 'src/assets/graphics'
    renderDir: '/tmp/figma-renders', // PNGs for visual compare
    fontSources: 'font-sources', // pristine fonts (input to patch-font-metrics.py)
    fontsOut: null, // patched fonts the app loads
  },

  // How the extractor suggests code references for values it finds in Figma.
  tokens: {
    // Modules to index for value -> code-reference suggestions. Each entry is
    // { path, exports: [...] } or { path, exports: { exportName: 'refPrefix' } }.
    // `nested` lets you index inside a per-mode wrapper, e.g. themes.light.components -> 'components'.
    index: [],
    // Spacing: many design systems do NOT bind Figma variables to gap/padding, so the ramp is
    // code-owned. Set tokenizedInFigma:true if yours does bind them (then gap shows as ✓bound).
    spacing: {
      tokenizedInFigma: false,
      rampPath: null, // module exporting the ramp, e.g. 'src/theme/tokens/space.ts'
      rampExport: 'space',
      refTemplate: 'space[{n}]', // how a ramp step is written in code
      banned: [], // legacy spacing modules that must NOT be used for fidelity work
    },
    // Typography: the generated text ramp and how text is written in code.
    typography: {
      rampPath: null, // e.g. 'src/theme/tokens/typography.generated.ts'
      rampExport: 'textStyles',
      component: null, // the DS text component, e.g. 'AppText' — null = plain text element
      suggestionTemplate: '<{component} variant={variant} weight={weight}>',
      // Props the project forbids hand-setting on DS text, with the reason shown to the agent.
      forbiddenProps: [],
      forbiddenReason: '',
    },
  },

  // The code side of the design system.
  components: {
    index: null, // barrel/index the agent scans before building, e.g. 'src/components/ui/index.ts'
    prefix: '', // naming convention, e.g. 'App'
    themeAccessor: null, // mode-aware accessor, e.g. 'useTheme()'
    instanceMap: {}, // Figma instance name -> code component name
    showcase: null, // living showcase screen new components get registered in
    codeConnect: { enabled: false, glob: null, parseCommand: null },
  },

  // Icon pipeline.
  icons: {
    // Named colors Figma emits that must become currentColor. Hex is always handled.
    extraNamedColors: ['white', 'black'],
    rtlMirrored: [], // icon names that flip under RTL
  },

  // Copy extraction (figma-text) — noise filtering is locale-specific.
  text: {
    noiseWords: ['Title', 'Subtitle', 'Label', 'text'],
    // Extra regex sources (strings) for lines to drop, e.g. currency formats.
    noisePatterns: [],
    rtl: false, // sort rows right-to-left within a line
  },

  // How the token pipeline maps the Figma variables export onto generated files.
  variables: {
    // Each source: { match: <regex source, case-insensitive>, role: 'primitives' | 'mode:<name>' }
    sources: [],
    // Where top-level groups in the export end up:
    //   'palette' | 'radius' | 'ramp:<mode>' | 'semantic' | 'components' | 'ignore'
    groups: {},
    ignoreKeys: [], // stray keys in the export to skip entirely
  },

  // Text styles are NOT variables in Figma, so they are fetched separately.
  typographySource: {
    // Style-name prefixes. The FIRST is the base (drives metrics + faces); the rest contribute
    // face overrides only (e.g. a second locale whose faces diverge).
    prefixes: [],
    order: [], // display order of categories in the generated file
    // Known Figma authoring bugs to correct on export, keyed '<prefix><category>/<slot>'.
    faceFixes: {},
  },

  // Project commands the skill tells the agent to run. Keep them accurate — config-check runs them.
  commands: { tokensBuild: null, validate: null },

  // Per-library incidents worth remembering. Free-form; grows one line per surprise.
  gotchas: [],
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merge `override` onto `base` without mutating either. Arrays replace wholesale. */
function merge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

/** Walk up from `start` looking for `name`. Returns the containing directory, or null. */
function findUp(name, start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, name))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

let cached = null;

/**
 * Load the merged config. `config.__root` is the project root (the directory holding
 * figma.config.json, or cwd when there is none) — resolve every configured path against it.
 */
function loadConfig() {
  if (cached) return cached;

  let file = process.env.FIGMA_CONFIG || null;
  let root;
  if (file) {
    file = path.resolve(file);
    root = path.dirname(file);
  } else {
    const dir = findUp('figma.config.json', process.cwd());
    if (dir) {
      root = dir;
      file = path.join(dir, 'figma.config.json');
    } else {
      root = process.cwd();
      file = null;
    }
  }

  let user = {};
  if (file) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      // Tolerate a `//`-commented template — people annotate these files.
      user = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
    } catch (e) {
      console.error(`[figma-config] Could not parse ${file}: ${e.message}`);
      process.exit(1);
    }
  }

  cached = merge(DEFAULTS, user);
  cached.__root = root;
  cached.__file = file;
  return cached;
}

/** Absolute path for a project-relative config value. Returns null for null/absent input. */
function resolvePath(cfg, relative) {
  if (!relative) return null;
  return path.isAbsolute(relative) ? relative : path.join(cfg.__root, relative);
}

/**
 * Pick the file key for a call: an explicit `--file` wins, then the named slot, then
 * `files.default`. Exits with a helpful message when nothing is configured.
 */
function requireFileKey(cfg, explicit, slot = 'default') {
  const key = explicit || cfg.files[slot] || cfg.files.default;
  if (key) return key;
  console.error(
    `Missing Figma file key. Pass --file <key>, or set files.${slot} in figma.config.json` +
      (cfg.__file ? ` (${path.relative(process.cwd(), cfg.__file)})` : ' (no config file found)'),
  );
  process.exit(1);
}

/**
 * Evaluate a TS/JS token module and return its exports.
 *
 * Generated token files are plain data — `export const x = {...} as const` — so stripping the
 * type-only syntax and running the rest is enough, and it avoids making the kit depend on a
 * TypeScript toolchain. Throws on failure; callers warn and continue without suggestions.
 */
function loadTokenModule(absPath) {
  const source = fs
    .readFileSync(absPath, 'utf8')
    .replace(/^\s*import[^\n]*\n/gm, '')
    .replace(/^\s*export\s+type[^\n]*\n/gm, '')
    .replace(/^\s*type\s[^\n]*\n/gm, '')
    .replace(/\s+as const(\s+satisfies\s+[^;]+)?/g, '')
    .replace(/export const /g, 'module.exports.')
    .replace(/export default /g, 'module.exports.default = ');
  const mod = { exports: {} };
  new Function('module', 'exports', source)(mod, mod.exports);
  return mod.exports;
}

module.exports = {
  DEFAULTS,
  loadConfig,
  resolvePath,
  requireFileKey,
  loadTokenModule,
  merge,
  findUp,
};
