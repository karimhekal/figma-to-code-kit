/* eslint-disable */
/**
 * figma-config.test — the config contract every other script is built on.
 *
 * These are the functions with no output of their own: when `merge` drops a sibling default, or
 * `requireFileKey` stops falling back, nothing crashes — a feature just quietly switches off three
 * scripts downstream and every extracted value starts looking like a literal. That silence is the
 * reason this file exists.
 *
 * Most cases run in-process (these are pure functions). The two that cannot are `loadConfig`, which
 * memoizes its answer for the life of the process, and `requireFileKey`'s failure path, which calls
 * `process.exit` — both run as child processes instead.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CONFIG_MODULE = path.resolve(__dirname, '..', 'scripts', 'figma-config.js');
const { DEFAULTS, merge, findUp, resolvePath, requireFileKey, loadTokenModule } =
  require(CONFIG_MODULE);
const { createProject } = require('./helpers/project');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-kit-config-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

test('merge: an override keeps every sibling default', () => {
  const cfg = merge(DEFAULTS, { paths: { tokensDir: 'src/theme/tokens' } });
  assert.equal(cfg.paths.tokensDir, 'src/theme/tokens');
  // The whole point of a deep merge: naming one path must not blank the other seven.
  assert.equal(cfg.paths.variablesExport, DEFAULTS.paths.variablesExport);
  assert.equal(cfg.paths.renderDir, DEFAULTS.paths.renderDir);
});

test('merge: reaches three levels down', () => {
  const cfg = merge(DEFAULTS, { tokens: { spacing: { rampPath: 'src/theme/space.ts' } } });
  assert.equal(cfg.tokens.spacing.rampPath, 'src/theme/space.ts');
  assert.equal(cfg.tokens.spacing.rampExport, 'space');
  assert.equal(cfg.tokens.spacing.refTemplate, 'space[{n}]');
  assert.equal(cfg.tokens.typography.rampExport, 'textStyles');
});

test('merge: arrays replace wholesale, they do not concatenate', () => {
  const cfg = merge(DEFAULTS, { icons: { extraNamedColors: ['grey'] } });
  // Concatenating would mean a project could never REMOVE a default entry — only ever add.
  assert.deepEqual(cfg.icons.extraNamedColors, ['grey']);
});

test('merge: never mutates DEFAULTS', () => {
  merge(DEFAULTS, { paths: { tokensDir: 'somewhere' }, files: { default: 'EXAMPLEFILEKEY123456' } });
  assert.equal(DEFAULTS.paths.tokensDir, null);
  assert.equal(DEFAULTS.files.default, null);
});

test('findUp: locates the config from a nested subdirectory', () => {
  const root = path.join(TMP, 'walk');
  const deep = path.join(root, 'src', 'components', 'ui');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(root, 'figma-kit.config.json'), '{}');

  assert.equal(findUp('figma-kit.config.json', deep), root);
  assert.equal(findUp('figma-kit.config.json', root), root);
});

test('findUp: returns null rather than looping at the filesystem root', () => {
  // A name that cannot plausibly exist anywhere above tmpdir, so this walks all the way to `/`.
  assert.equal(findUp('figma.config.this-name-cannot-exist.json', TMP), null);
});

test('loadConfig: $FIGMA_CONFIG wins over the cwd walk, and roots paths at the config', () => {
  const home = path.join(TMP, 'explicit');
  fs.mkdirSync(home, { recursive: true });
  const configPath = path.join(home, 'figma-kit.config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ paths: { tokensDir: 'src/theme/tokens' }, files: { default: 'ABC' } }),
  );

  const code = `
    const { loadConfig, resolvePath } = require(${JSON.stringify(CONFIG_MODULE)});
    const cfg = loadConfig();
    process.stdout.write(JSON.stringify({
      root: cfg.__root,
      file: cfg.__file,
      tokensDir: cfg.paths.tokensDir,
      resolved: resolvePath(cfg, cfg.paths.tokensDir),
      untouchedDefault: cfg.paths.variablesExport,
    }));
  `;
  const res = spawnSync(process.execPath, ['-e', code], {
    // cwd is deliberately somewhere else: $FIGMA_CONFIG must beat the upward walk.
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH || '', FIGMA_CONFIG: configPath },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.root, home);
  assert.equal(out.file, configPath);
  assert.equal(out.resolved, path.join(home, 'src/theme/tokens'));
  assert.equal(out.untouchedDefault, 'figma-variables');
});

test('requireFileKey: an unset slot falls back to files.default', () => {
  const cfg = { files: { default: 'EXAMPLEFILEKEY123456', screens: null }, __file: null };
  assert.equal(requireFileKey(cfg, null, 'screens'), 'EXAMPLEFILEKEY123456');
});

test('requireFileKey: a set slot wins over default, and --file wins over both', () => {
  const cfg = {
    files: { default: 'EXAMPLEFILEKEY123456', screens: 'EXAMPLESCREENSKEY7890' },
    __file: null,
  };
  assert.equal(requireFileKey(cfg, null, 'screens'), 'EXAMPLESCREENSKEY7890');
  assert.equal(requireFileKey(cfg, 'EXPLICITKEY0987654321', 'screens'), 'EXPLICITKEY0987654321');
});

test('requireFileKey: with nothing configured it exits 1 and says how to fix it', () => {
  // The exit path, exercised through a real CLI — that is where a user meets it.
  const p = createProject({ config: { files: {} } });
  const res = p.run('figma-extract.js', ['1234:5678']);
  assert.equal(res.status, 1);
  assert.match(res.out, /Missing Figma file key/);
  assert.match(res.out, /--file <key>/);
  assert.match(res.out, /files\.default in figma-kit\.config\.json/);
});

test('loadTokenModule: evaluates a generated module after stripping TS-only syntax', () => {
  const file = path.join(TMP, 'tokens.ts');
  fs.writeFileSync(
    file,
    [
      "import type { Mode } from './modes';",
      "import { helper } from './helper';",
      "export type Weight = 'regular' | 'bold';",
      'type Internal = { a: number };',
      'export const space = { 0: 0, 8: 8, 12: 12 } as const;',
      "export const theme = { text: '#101014' } as const satisfies Record<string, string>;",
      "export default { name: 'fixture' };",
      '',
    ].join('\n'),
  );

  const mod = loadTokenModule(file);
  // The imports are the point: a generated module that still `require`s something at runtime would
  // throw here, which is exactly the "token modules must be plain data" rule config-check states.
  assert.equal(mod.space[8], 8);
  assert.equal(mod.theme.text, '#101014');
  assert.equal(mod.default.name, 'fixture');
});

test('resolvePath: null in, null out — and absolute paths pass straight through', () => {
  const cfg = { __root: '/project' };
  // Every caller does `resolvePath(cfg, cfg.paths.something)` on fields that are null by default,
  // so null-safety here is what keeps "feature not configured" from becoming a crash.
  assert.equal(resolvePath(cfg, null), null);
  assert.equal(resolvePath(cfg, undefined), null);
  assert.equal(resolvePath(cfg, ''), null);
  assert.equal(resolvePath(cfg, 'src/theme'), path.join('/project', 'src/theme'));
  assert.equal(resolvePath(cfg, '/tmp/elsewhere'), '/tmp/elsewhere');
});

// ─── the Code Connect filename collision ──────────────────────────────────────
// `figma.config.json` is Figma Code Connect's own config file. This kit used the same name, so
// adopting it in a repo that already ran Code Connect meant two tools writing one file — and the
// kit read Code Connect's settings as its own, yielding a config with no file key and no paths,
// then blaming the user for it. The kit now owns `figma-kit.config.json` and stays out of the way.

test("Code Connect's figma.config.json is refused, not misread as ours", () => {
  const p = createProject();
  p.writeJson('figma.config.json', {
    codeConnect: { parser: 'react', include: ['src/**/*.tsx'] },
  });

  const res = p.run('config-check.js', [], {
    figmaConfig: path.join(p.dir, 'figma.config.json'),
  });
  assert.notEqual(res.status, 0, res.out);
  assert.match(res.out, /Code Connect/i);
  assert.match(res.out, /figma-kit\.config\.json/);
});

test('a legacy figma.config.json that IS ours still loads', () => {
  const p = createProject();
  p.writeJson('figma.config.json', { files: { default: 'LEGACYFILEKEY1234567' } });

  const res = p.run('config-check.js', [], {
    figmaConfig: path.join(p.dir, 'figma.config.json'),
  });
  // It was genuinely read — the key it names came from that file, not from the fixture's config.
  assert.match(res.out, /LEGACYFILEKEY1234567/, res.out);
});
