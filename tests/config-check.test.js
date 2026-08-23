/* eslint-disable */
/**
 * config-check.test — the one script in the kit that is allowed to be loud.
 *
 * Its whole value is a classification: a field left UNSET is a ⚠ (that feature is simply off), a
 * field the config EXPLICITLY names and that isn't there is a ✗ (config rot — you pointed at
 * something that no longer exists). Get that backwards in either direction and the script becomes
 * useless: too strict and a MINIMAL config fails CI, too lax and a moved token module goes
 * unnoticed until every extracted value starts printing as a literal.
 *
 * So the two cases that matter most are the two extremes, and both are asserted on the EXIT CODE,
 * because that is what CI reads:
 *   - the documented minimal config (files + auth) → 0
 *   - a path the config explicitly names and that is missing → non-zero
 *
 * Every test also asserts the token value never appears in the output. The single worst outcome
 * this kit can produce is a leaked credential, and a validation script that helpfully echoes what
 * it found is one `> check.log` away from committing one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createProject, FAKE_TOKEN } = require('./helpers/project');

/** The config the docs call minimal: a file key and where the token comes from. Nothing else. */
const MINIMAL = {
  files: { default: 'EXAMPLEFILEKEY123456' },
  auth: { envVar: 'FIGMA_ACCESS_TOKEN', envFile: '.env.local' },
};

/** Every assertion in this file wants this, so it lives in one place. */
function assertNoTokenLeak(res) {
  assert.equal(res.out.includes(FAKE_TOKEN), false, 'config-check must never print the token');
  assert.equal(res.out.includes(FAKE_TOKEN.slice(0, 12)), false, 'not even a prefix of it');
}

test('the documented MINIMAL config passes: warnings only, exit 0', () => {
  // `copyFixture: false` — a bare directory holding only the config, the env file and .gitignore.
  // Everything else is unset, so everything else must be a ⚠ and none of it may be a ✗.
  const p = createProject({ copyFixture: false, config: MINIMAL });

  const res = p.run('config-check.js');
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /config-check passed with warnings/);
  assert.match(res.out, /0 error\(s\)/);

  // Built-in defaults that do not exist are features switched off, NOT rot.
  assert.match(res.out, /⚠ paths\.tokensDir unset/);
  assert.match(res.out, /⚠ paths\.variablesExport defaults to "figma-variables", which does not exist/);
  assert.match(res.out, /⚠ tokens\.index is empty/);
  assert.match(res.out, /⚠ drift\.nodes is empty/);
  assertNoTokenLeak(res);
});

test('the token is reported as FOUND, with its SOURCE and never its value', () => {
  const p = createProject({ copyFixture: false, config: MINIMAL });

  const res = p.run('config-check.js');
  assert.match(res.out, /✓ FIGMA_ACCESS_TOKEN: FOUND \(from \.env\.local\)/);
  assertNoTokenLeak(res);

  // Same script, token supplied through the environment instead — the other branch of the loader.
  const fromEnv = p.run('config-check.js', [], { env: { FIGMA_ACCESS_TOKEN: FAKE_TOKEN } });
  assert.match(fromEnv.out, /✓ FIGMA_ACCESS_TOKEN: FOUND \(from environment \(\$FIGMA_ACCESS_TOKEN\)\)/);
  assertNoTokenLeak(fromEnv);
});

test('an env file that exists but is NOT gitignored is an error', () => {
  // The single worst outcome this kit can produce is a committed token, so it gets its own check.
  const p = createProject({ copyFixture: false, config: MINIMAL, gitignore: false });

  const res = p.run('config-check.js');
  assert.equal(res.status, 1);
  assert.match(res.out, /✗ \.env\.local exists but does not appear to be gitignored/);
  assert.match(res.out, /a committed token must be revoked/);
  assertNoTokenLeak(res);
});

test('a missing token is an error that says where to mint one', () => {
  const p = createProject({ copyFixture: false, config: MINIMAL, envFile: false });

  const res = p.run('config-check.js');
  assert.equal(res.status, 1);
  assert.match(res.out, /✗ FIGMA_ACCESS_TOKEN: MISSING/);
  assert.match(res.out, /Personal access tokens/);
});

test('a path the config EXPLICITLY names and that is missing exits non-zero', () => {
  const p = createProject();
  p.patchConfig((c) => {
    c.paths.iconRegistry = 'src/components/icons/registry.generated.json';
  });

  const res = p.run('config-check.js');
  assert.equal(res.status, 1, 'this is config rot, not an unused feature');
  assert.match(
    res.out,
    /✗ paths\.iconRegistry → src\/components\/icons\/registry\.generated\.json does not exist/,
  );
  assert.match(res.out, /config-check FAILED/);
  assertNoTokenLeak(res);
});

test('a token-index entry claiming an export the module does not have is an error', () => {
  // This is the difference between "⇒ token: <ref>" and a bare number an agent hardcodes.
  const p = createProject();
  assert.equal(p.run('build-tokens.js').status, 0);
  p.patchConfig((c) => {
    c.tokens.index[0].exports = { palette: 'palette', elevation: 'elevation' };
  });

  const res = p.run('config-check.js');
  assert.equal(res.status, 1);
  assert.match(res.out, /tokens\.index claims export "elevation", but the module does not export it/);
});

test('a fully-configured project passes once the token build has run', () => {
  const p = createProject();
  assert.equal(p.run('build-tokens.js').status, 0);

  const res = p.run('config-check.js');
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /✓ files\.default = EXAMPLEFILEKEY123456/);
  assert.match(res.out, /✓ paths\.tokensDir → src\/theme\/tokens/);
  assert.match(res.out, /✓ src\/theme\/tokens\/palette\.generated\.ts: palette \(\d+\), cornerRadius \(3\)/);
  assert.match(res.out, /✓ src\/theme\/tokens\/space\.ts → space: 7 steps \[0, 4, 8, 12, 16, 24, 32\]/);
  assert.match(res.out, /✓ src\/theme\/tokens\/typography\.generated\.ts → textStyles: 4 variants/);
  assert.match(res.out, /✓ commands\.tokensBuild: "npm run tokens:build"/);
  assert.match(res.out, /✓ variable-map\.generated\.json: generated tokens match the export on disk/);
  assertNoTokenLeak(res);
});

test('an export that moved without a rebuild is an error here too, offline', () => {
  const p = createProject();
  assert.equal(p.run('build-tokens.js').status, 0);
  const dark = p.readJson('figma-variables/modes/Dark.tokens.json');
  dark.Component.Checkbox.Color.On.$value = '{color.brand.900}';
  p.writeJson('figma-variables/modes/Dark.tokens.json', dark);

  const res = p.run('config-check.js');
  assert.equal(res.status, 1);
  assert.match(res.out, /records export hash [0-9a-f]{12}, but the export on disk hashes [0-9a-f]{12}/);
  assert.match(res.out, /The export was updated and the token build never re-ran/);
});

test('a variables.sources pattern that matches nothing is an error, with the files listed', () => {
  // build-tokens hard-fails on this, so a stale pattern means the whole token pipeline is down —
  // usually because a re-export renamed the collection files.
  const p = createProject();
  p.patchConfig((c) => {
    c.variables.sources[1].match = '^Daylight\\.tokens\\.json$';
  });

  const res = p.run('config-check.js');
  assert.equal(res.status, 1);
  assert.match(res.out, /\(mode:light\) matches nothing — the token build will fail here/);
  assert.match(res.out, /Files present: .*Primitives\.tokens\.json/);
});

test('a file key left as the example placeholder is caught', () => {
  const p = createProject({
    copyFixture: false,
    config: { ...MINIMAL, files: { default: 'PUT_YOUR_DESIGN_SYSTEM_FILE_KEY_HERE' } },
  });

  const res = p.run('config-check.js');
  assert.equal(res.status, 1);
  assert.match(res.out, /✗ files\.default is still the example placeholder/);
});

test('a full Figma URL pasted where a key belongs is a warning that extracts the key', () => {
  const p = createProject({
    copyFixture: false,
    config: {
      ...MINIMAL,
      files: { default: 'https://www.figma.com/design/EXAMPLEFILEKEY123456/Example-Library' },
    },
  });

  const res = p.run('config-check.js');
  assert.equal(res.status, 0, 'a paste mistake is recoverable — say what to use, do not fail CI');
  assert.match(res.out, /⚠ files\.default looks like a full URL, not a key\. Use just: EXAMPLEFILEKEY123456/);
});

test('commands.* are resolved statically and never executed', () => {
  const p = createProject();
  p.patchConfig((c) => {
    c.commands.validate = 'npm run there-is-no-such-script';
  });

  const res = p.run('config-check.js');
  assert.equal(res.status, 1);
  assert.match(res.out, /package\.json has no "there-is-no-such-script" script/);
  // Running a project's build command as a side effect of a validation pass is not a trade anyone
  // agreed to. `commands.tokensBuild` is a real, runnable script in this fixture — so the proof is
  // that it did NOT run: no generated token modules appeared.
  assert.equal(p.exists('src/theme/tokens/variable-map.generated.json'), false);
  assert.equal(p.exists('src/theme/tokens/themes.generated.ts'), false);
});

test('--help exits 0 without checking anything', () => {
  const p = createProject({ copyFixture: false, config: MINIMAL });
  const res = p.run('config-check.js', ['--help']);
  assert.equal(res.status, 0);
  assert.match(res.out, /Usage: node scripts\/config-check\.js \[--online\]/);
});
