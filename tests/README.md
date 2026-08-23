# Tests

```bash
npm install     # pngjs — the kit's only dependency, and the per-pixel drift tests need it
npm test
```

Node's built-in runner (`node:test` + `node:assert/strict`). **No test framework, no new
dependencies**, matching the kit itself.

The tests are **hermetic**: every one builds a throwaway project under `os.tmpdir()`, points the
scripts at it, and never touches the network, your `figma.config.json`, or your Figma token. They
take about six seconds.

> **Why `node --test` and not `node --test tests/`?** Node ≥ 22 stopped treating a directory
> argument as "search here" and tries to *run* the path instead. Bare `node --test` searches the
> current directory recursively for `**/*.test.js` on every supported Node (18+), which is the one
> form that works everywhere. To run a single file: `node --test tests/build-tokens.test.js`.

---

## Layout

```
tests/
├── figma-config.test.js     config contract: merge, findUp, requireFileKey, loadTokenModule
├── svg-normalize.test.js    the icon rewrite rules (pure functions, in-process)
├── build-tokens.test.js     DTCG export → token modules + the variable-map contract
├── figma-extract.test.js    the printout an agent builds from
├── figma-drift.test.js      export-hash tripwire + per-pixel baseline comparison
├── config-check.test.js     the ✓ / ⚠ / ✗ classification and its exit code
├── helpers/
│   ├── project.js           builds a temp project, runs a script against it
│   ├── fetch-stub.js        a --require preload that replaces global.fetch
│   └── png.js               generates the tiny PNGs the drift tests compare
└── fixtures/
    ├── project/             a synthetic consumer project (config, export, token modules)
    └── api/                 canned Figma REST responses
```

## How CLI scripts are tested

Every script in this kit is an IIFE that reads `process.argv`, prints, and calls `process.exit`.
There is no exported function to call and no injection seam — **the CLI is the interface**, and it
is the surface a user touches. So the tests run the real scripts as child processes and assert on
stdout, stderr and the exit code.

`helpers/project.js` does the arranging:

```js
const { createProject } = require('./helpers/project');

const p = createProject();                    // copies tests/fixtures/project into a temp dir
const res = p.run('build-tokens.js');         // { status, stdout, stderr, out }  (ANSI stripped)
assert.equal(res.status, 0, res.out);
```

Two deliberate choices in there are worth knowing before you add a test:

- **`$FIGMA_CONFIG` is always set explicitly.** `figma-config.findUp()` walks from the cwd to the
  *filesystem root* looking for `figma.config.json`. A stray config anywhere above `os.tmpdir()`
  would silently join your test and change its answers. The one test that wants built-in DEFAULTS
  therefore points `$FIGMA_CONFIG` at an **empty** config (`{}`) rather than unsetting it — same
  merged result, none of the ambient risk.
- **The child environment is built from scratch, not inherited.** A developer's real
  `FIGMA_ACCESS_TOKEN` must never be what makes a test pass. The fixture writes its own obviously
  fake token into a temp `.env.local`, which is also why that file is *written at runtime* rather
  than committed (the kit's `.gitignore` ignores `.env.*`, so a committed one would not survive a
  clone).

`spawnSync` is used rather than `execFileSync` because these CLIs signal failure through the exit
code, and exit codes are half of what is under test — `execFileSync` would throw the interesting
runs away as exceptions.

## How the network stub works

`helpers/fetch-stub.js` is loaded via `NODE_OPTIONS="--require …"`, which replaces `global.fetch`
before the script's first line runs. A preload rather than an in-process mock, for one concrete
reason: **`figma-drift.js` shells out to `figma-render.js`**, and `NODE_OPTIONS` is inherited, so
the stub installs itself in grandchildren too. A mock that only covered the parent would let the
render step reach `api.figma.com` for real.

**With no `$FIGMA_STUB` set, `fetch` throws.** A test that wanders onto an unstubbed code path must
fail loudly rather than quietly make a real request.

The manifest (`$FIGMA_STUB` → a JSON file, re-read on every request):

```json
{
  "file":   { "name": "Example Design System", "lastModified": "2026-01-05T10:00:00Z" },
  "nodes":  "/abs/path/to/tests/fixtures/api/nodes-checkbox.json",
  "images": { "1234:5678": "/abs/path/to/an.png" }
}
```

| Request | Answer |
|---|---|
| `GET /v1/files/<key>?depth=1` | `file` |
| `GET /v1/files/<key>/nodes?ids=…` | the JSON at `nodes` |
| `GET /v1/images/<key>?ids=…` | `{ images: { <id>: "https://stub.invalid/image/<id>" } }`, `null` for ids not in `images` |
| `GET https://stub.invalid/image/<id>` | the PNG bytes at `images[<id>]` |
| anything else | 404 |

Because the manifest is re-read per request, a test can change the canned answer **between two
runs of the same script**. That is the whole trick behind the drift tests: baseline against image
A, then serve image B and watch the check report the change.

```js
const p = createProject();
p.setStub({ images: { '1234:5678': p.write('renders/a.png', solidPng(8, 8, [255, 255, 255])) } });
p.run('figma-drift.js', ['--update']);        // captures the baseline
p.setStub({ images: { '1234:5678': p.write('renders/b.png', changed) } });
p.run('figma-drift.js');                       // reports the diff
```

## Adding a fixture

**A canned API response** → drop it in `tests/fixtures/api/` and point the stub's `nodes` key at
it. Keep node ids obviously fake (`1234:5678`) and file keys obviously fake
(`EXAMPLEFILEKEY123456`). `nodes-checkbox.json` is hand-authored so that each interesting case
appears exactly once — a component set with a variant axis *and* a non-variant prop, a bound
radius, a bound fill, an unbound literal, a multi-fill node, two text nodes (one on the type ramp,
one off it), off-grid spacing in the layout and off-grid spacing inside an instance, and a
binding to a variable id the export does not contain. Extend it rather than starting a second
file, so a new test does not need a new stub.

**A project-side file** (a token module, a config field) → add it under
`tests/fixtures/project/`. It is copied wholesale into each temp project, so anything you add is
available to every test immediately. Two things live there deliberately and are worth preserving:

- `figma-variables/` — the DTCG export. It carries **two modes**, a cross-file alias, a numeric
  alias into a numerically-keyed group, a **deliberately broken alias**
  (`{color.brand.retired}` — do not "fix" it, a test asserts the broken-alias report), and
  `com.figma.variableId` on every leaf.
- The three files sort differently by relative path than by basename
  (`Primitives.tokens.json`, `modes/Dark.tokens.json`, `modes/Light.tokens.json`). That is on
  purpose: the export-hash recipe sorts by *relative path*, and a fixture that could not tell the
  two apart would let that regress unnoticed.

Anything a script *generates* (`palette.generated.ts`, `themes.generated.ts`,
`variable-map.generated.json`, baseline PNGs) is **not** committed. Tests that need it run
`build-tokens.js` first. A committed generated file drifts from its own inputs the moment someone
reformats the export, and then the fixture is lying.

## Conventions

- Assert on the **text** the scripts print. Nothing downstream parses it; a human or a model reads
  it, and a flag that stops appearing is a real regression with no other symptom.
- Every `config-check` test asserts the token value never appears in the output. A validation
  script that helpfully echoes what it found is one `> check.log` away from committing a
  credential.
- Every temp directory is created under one per-file root and removed on process exit. `node --test`
  runs each file in its own process, so the files are independent by construction — but tests
  within a file must be too: each one gets its own project copy.
- The per-pixel drift tests skip with an instruction (rather than erroring) when `pngjs` is not
  installed, matching the kit's own rule that a missing optional input turns a feature off, never
  crashes.
