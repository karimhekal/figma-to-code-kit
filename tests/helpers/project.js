/* eslint-disable */
/**
 * project — build a throwaway consumer project in a temp directory and run the kit's CLIs against
 * it, with the network stubbed out.
 *
 * WHY EVERY TEST GETS ITS OWN COPY
 * --------------------------------
 * The scripts write into the project they are pointed at: `build-tokens` emits token modules,
 * `figma-drift --update` writes baseline PNGs. Sharing one fixture directory across tests would
 * make them order-dependent, and an order-dependent suite is one that passes locally and fails in
 * CI. So `createProject()` copies `tests/fixtures/project` fresh each time, under one temp root
 * that is removed when the test process exits.
 *
 * WHY $FIGMA_CONFIG IS ALWAYS SET
 * -------------------------------
 * `figma-config.findUp()` walks from cwd to the FILESYSTEM ROOT looking for `figma-kit.config.json`.
 * A temp project lives under `os.tmpdir()`, and a stray config anywhere above that — someone's
 * experiment in `/tmp`, a config at `$HOME` on a machine where tmpdir is inside it — would silently
 * join the test and change its answers. Naming the config explicitly closes that door. The one test
 * that wants DEFAULTS behaviour therefore points `$FIGMA_CONFIG` at an EMPTY config object rather
 * than unsetting it: same merged result, none of the ambient risk.
 *
 * The child environment is built from scratch rather than inherited for the same reason: a
 * developer's real `FIGMA_ACCESS_TOKEN` must never be what makes a test pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const KIT_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(KIT_ROOT, 'scripts');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const FIXTURE_PROJECT = path.join(FIXTURES_DIR, 'project');
const FETCH_STUB = path.join(__dirname, 'fetch-stub.js');

/** Obviously fake, and asserted never to appear in any script's output. */
const FAKE_TOKEN = 'figd_EXAMPLE_TOKEN_NOT_A_REAL_CREDENTIAL';

// One root per test FILE (node --test runs each file in its own process), cleaned up on exit.
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-kit-tests-'));
process.on('exit', () => {
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not worth failing a suite over */
  }
});

let seq = 0;

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

/** Strip SGR escapes so assertions match the words, not the colours. */
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * A throwaway project.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.copyFixture=true]  copy `tests/fixtures/project` in (false = bare dir)
 * @param {object|null} [opts.config]        replace figma-kit.config.json wholesale
 * @param {boolean} [opts.envFile=true]      write `.env.local` holding the fake token
 * @param {boolean} [opts.gitignore=true]    write a `.gitignore` that ignores `.env.local`
 * @param {object}  [opts.stub={}]           seed the fetch-stub manifest (`file`/`nodes`/`images`)
 */
function createProject(opts = {}) {
  const {
    copyFixture = true,
    config = null,
    envFile = true,
    gitignore = true,
    stub = {},
  } = opts;

  const dir = path.join(TEST_ROOT, `p${++seq}`);
  if (copyFixture) copyDir(FIXTURE_PROJECT, dir);
  else fs.mkdirSync(dir, { recursive: true });

  if (config) fs.writeFileSync(path.join(dir, 'figma-kit.config.json'), JSON.stringify(config, null, 2));
  // The env file is written here, never committed: the kit's own .gitignore ignores `.env.*`, so a
  // committed fixture env file would not survive a clone and every token test would evaporate.
  if (envFile) fs.writeFileSync(path.join(dir, '.env.local'), `FIGMA_ACCESS_TOKEN=${FAKE_TOKEN}\n`);
  if (gitignore) fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env.local\n');

  const stubPath = path.join(dir, 'fetch-stub.manifest.json');
  const api = {
    file: {
      name: 'Example Design System',
      lastModified: '2026-01-05T10:00:00Z',
      version: '1000000000',
    },
    nodes: path.join(FIXTURES_DIR, 'api', 'nodes-checkbox.json'),
    images: {},
    ...stub,
  };
  fs.writeFileSync(stubPath, JSON.stringify(api, null, 2));

  const project = {
    dir,
    stubPath,
    token: FAKE_TOKEN,

    file: (...parts) => path.join(dir, ...parts),
    exists: (...parts) => fs.existsSync(path.join(dir, ...parts)),
    read: (...parts) => fs.readFileSync(path.join(dir, ...parts), 'utf8'),
    readJson: (...parts) => JSON.parse(fs.readFileSync(path.join(dir, ...parts), 'utf8')),
    remove: (...parts) => fs.rmSync(path.join(dir, ...parts), { recursive: true, force: true }),
    write: (rel, contents) => {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, contents);
      return abs;
    },
    writeJson: (rel, value) => project.write(rel, `${JSON.stringify(value, null, 2)}\n`),

    /** Change what the canned API answers with, between two runs of the same script. */
    setStub: (patch) => {
      const current = JSON.parse(fs.readFileSync(stubPath, 'utf8'));
      fs.writeFileSync(stubPath, JSON.stringify({ ...current, ...patch }, null, 2));
    },

    /** Edit figma-kit.config.json in place. `mutate` receives the parsed object. */
    patchConfig: (mutate) => {
      const p = path.join(dir, 'figma-kit.config.json');
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      mutate(json);
      fs.writeFileSync(p, JSON.stringify(json, null, 2));
    },

    /**
     * Run one of the kit's scripts against this project.
     *
     * `spawnSync` rather than `execFileSync`: these CLIs signal failure through the EXIT CODE, and
     * exit codes are half of what is under test — execFileSync would throw the interesting runs
     * away as exceptions. Returns `{ status, stdout, stderr, out }` with ANSI stripped; `out` is
     * both streams joined, which is what most assertions want (the scripts warn on stderr and
     * report on stdout, and a reader sees one interleaved transcript).
     */
    run: (script, args = [], runOpts = {}) => {
      const env = {
        PATH: process.env.PATH || '',
        // Explicit, so `findUp` can never wander out of the temp project. See the header.
        FIGMA_CONFIG: runOpts.figmaConfig || path.join(dir, 'figma-kit.config.json'),
        // Quoted: NODE_OPTIONS is split on whitespace unless the value is quoted, and a checkout
        // path containing a space would otherwise silently disable the stub — and silently start
        // making real network calls.
        NODE_OPTIONS: `--require ${JSON.stringify(FETCH_STUB)}`,
        FIGMA_STUB: stubPath,
        // FIGMA_ACCESS_TOKEN is deliberately absent: the fixture carries `.env.local`, and reading
        // the token from there is the path the kit actually ships. Pass
        // `{ env: { FIGMA_ACCESS_TOKEN: … } }` to exercise the env-var branch instead.
        ...(runOpts.env || {}),
      };
      const res = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, script), ...args], {
        cwd: runOpts.cwd || dir,
        env,
        encoding: 'utf8',
      });
      if (res.error) throw res.error;
      const stdout = stripAnsi(res.stdout || '');
      const stderr = stripAnsi(res.stderr || '');
      return { status: res.status, stdout, stderr, out: `${stdout}\n${stderr}` };
    },
  };

  return project;
}

module.exports = {
  createProject,
  stripAnsi,
  FAKE_TOKEN,
  KIT_ROOT,
  SCRIPTS_DIR,
  FIXTURES_DIR,
  FIXTURE_PROJECT,
  TEST_ROOT,
};
