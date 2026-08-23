/* eslint-disable */
/**
 * figma-drift.test — the guard against a green build shipping last month's design.
 *
 * Drift is the one failure in this pipeline with NO error to see: the designer changes a color, the
 * repo does not change, the tokens still compile, the tests still pass. So the thing under test
 * here is whether the script is LOUD at the right moments — and, just as importantly, quiet at the
 * wrong ones. A drift checker that cries wolf gets muted in a week, and a muted checker detects
 * nothing at all.
 *
 * Layer 1b (the export-on-disk vs the hash the token build recorded) is fully offline, so it is
 * tested with no credentials at all. Layer 2 needs renders, so the tests serve canned PNGs through
 * the fetch stub — which installs itself into the `figma-render.js` child too, via NODE_OPTIONS.
 * That grandchild is the reason the stub is a preload rather than an in-process mock.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createProject } = require('./helpers/project');

// pngjs ships as the kit's only dependency, but `npm test` before `npm install` is a real thing.
// Rather than fail with a confusing module error, the per-pixel tests skip with an instruction.
let pngHelpers = null;
try {
  pngHelpers = require('./helpers/png');
} catch {
  pngHelpers = null;
}
const NEEDS_PNGJS = pngHelpers ? false : 'pngjs is not installed — run `npm install` first';

const NODE_ID = '1234:5678';
const BASELINE_PNG = 'figma-baselines/button-1234-5678.png';

// ─── layer 1b · the offline tripwire ──────────────────────────────────────────

test('the export moving without a rebuild is reported as drift', () => {
  const p = createProject({ envFile: false }); // no token: layer 1a and layer 2 stay off
  assert.equal(p.run('build-tokens.js').status, 0);

  // Same file set, different bytes — a designer re-exported and nobody re-ran the build. This is
  // the common case: dropping files in is the step a human does, re-running the build is the step
  // a human forgets.
  const dark = p.readJson('figma-variables/modes/Dark.tokens.json');
  dark.Component.Checkbox.Color.On.$value = '{color.brand.900}';
  p.writeJson('figma-variables/modes/Dark.tokens.json', dark);

  const res = p.run('figma-drift.js');
  assert.equal(res.status, 0, 'without --fail-on-drift, drift is news and not a build failure');

  assert.match(res.out, /no Figma access token — the lastModified tripwire is off/);
  assert.match(res.out, /export on disk 3 file\(s\), hash [0-9a-f]{12}/);
  assert.match(res.out, /the export on disk is NOT the one the tokens were generated from/);
  assert.match(res.out, /same files, different contents — a value inside the export changed\./);
  assert.match(res.out, /→ run `npm run tokens:build`/);
  assert.match(res.out, /drift detected \(1\)/);
  assert.match(res.out, /the variables export changed without the token build re-running/);
});

test('--fail-on-drift turns that into a non-zero exit for CI', () => {
  const p = createProject({ envFile: false });
  assert.equal(p.run('build-tokens.js').status, 0);

  const primitives = p.readJson('figma-variables/Primitives.tokens.json');
  primitives.color.brand['500'].$value.hex = '#4B3FF5';
  p.writeJson('figma-variables/Primitives.tokens.json', primitives);

  assert.equal(p.run('figma-drift.js').status, 0);
  assert.equal(p.run('figma-drift.js', ['--fail-on-drift']).status, 1);
});

test('when the export and the token build agree, it says so', () => {
  const p = createProject({ envFile: false });
  assert.equal(p.run('build-tokens.js').status, 0);

  const res = p.run('figma-drift.js');
  assert.equal(res.status, 0);
  assert.match(res.out, /token build {4}variable-map\.generated\.json recorded [0-9a-f]{12}/);
  assert.match(res.out, /✓ the generated tokens were built from the export that is on disk\./);
  assert.match(res.out, /no drift detected\./);
});

test('with no baselines yet it exits 0 and says how to make some', () => {
  const p = createProject({ envFile: false });
  assert.equal(p.run('build-tokens.js').status, 0);

  const res = p.run('figma-drift.js');
  assert.equal(res.status, 0, 'a project that has never baselined is not in a failed state');
  assert.match(res.out, /no baselines in figma-baselines yet\./);
  assert.match(res.out, /run `node scripts\/figma-drift\.js --update` once, review the PNGs, commit them/);
});

test('before the first token build, the freshness check switches off with a reason', () => {
  const p = createProject({ envFile: false });
  const res = p.run('figma-drift.js');
  assert.equal(res.status, 0);
  assert.match(
    res.out,
    /token-build freshness check is off — variable-map\.generated\.json has not been generated yet/,
  );
});

test('an unknown flag is refused rather than silently ignored', () => {
  const p = createProject({ envFile: false });
  const res = p.run('figma-drift.js', ['--tolerence', '4']);
  assert.equal(res.status, 1);
  assert.match(res.out, /Unknown argument "--tolerence"/);
});

// ─── layer 2 · visual baselines ───────────────────────────────────────────────

/** A project whose canonical node is baselined against `png`. Returns the project. */
function baselined(png) {
  const p = createProject();
  assert.equal(p.run('build-tokens.js').status, 0);
  const file = p.write('renders/source.png', png);
  p.setStub({ images: { [NODE_ID]: file } });

  const res = p.run('figma-drift.js', ['--update']);
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /button.*1234:5678.*8x8.*→ button-1234-5678\.png/);
  assert.match(res.out, /wrote figma-baselines\/baseline\.json/);
  assert.ok(p.exists(BASELINE_PNG));
  return p;
}

/** Serve a different image for the same node — i.e. the designer changed the component. */
function serve(p, png, name) {
  const file = p.write(`renders/${name}`, png);
  p.setStub({ images: { [NODE_ID]: file } });
}

test('--update captures a baseline and records what it was captured against', { skip: NEEDS_PNGJS }, () => {
  const p = baselined(pngHelpers.solidPng(8, 8, [255, 255, 255]));

  const index = p.readJson('figma-baselines/baseline.json');
  assert.equal(index.$meta.generator, 'figma-drift.js');
  assert.equal(index.$meta.fileKey, 'EXAMPLEFILEKEY123456');
  assert.equal(index.$meta.figmaLastModified, '2026-01-05T10:00:00Z');
  // Scale is part of the reference, not a preference: re-baselining at a different scale changes
  // every recorded dimension, and the next check then reports "changed" on untouched components.
  assert.equal(index.$meta.scale, 2);
  assert.deepEqual(index.nodes[NODE_ID].width, 8);
  assert.equal(index.nodes[NODE_ID].file, 'button-1234-5678.png');
});

test('an unchanged render is reported as identical', { skip: NEEDS_PNGJS }, () => {
  const p = baselined(pngHelpers.solidPng(8, 8, [255, 255, 255]));

  const res = p.run('figma-drift.js');
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /✓ button.*1234:5678 {2}identical/);
  assert.match(res.out, /✓ the design file has not been touched since the baselines were captured\./);
  assert.match(res.out, /no drift detected\./);
});

test('a single changed pixel is found, located, and written to a diff image', { skip: NEEDS_PNGJS }, () => {
  const base = pngHelpers.solidPng(8, 8, [255, 255, 255]);
  const p = baselined(base);
  serve(p, pngHelpers.withChangedPixel(base, 3, 3, [255, 0, 0]), 'changed.png');

  const res = p.run('figma-drift.js');
  assert.equal(res.status, 0);
  assert.match(res.out, /% of pixels differ \(1 of 64\)/);
  assert.match(res.out, /changed region {2}x 3-3, y 3-3 px/);
  assert.match(res.out, /diff: figma-baselines\/button-1234-5678\.diff\.png {2}\(magenta = changed/);
  assert.ok(p.exists('figma-baselines/button-1234-5678.diff.png'));

  assert.match(res.out, /drift detected \(1\)/);
  assert.match(res.out, /· button changed/);
  assert.match(res.out, /Drift is not automatically a defect/);

  assert.equal(p.run('figma-drift.js', ['--fail-on-drift']).status, 1);
});

test('a change smaller than the tolerance is NOT reported', { skip: NEEDS_PNGJS }, () => {
  // PNG encoders are not bit-identical across versions. Without this slack the checker fires on
  // noise, somebody mutes it, and it detects nothing forever after.
  const base = pngHelpers.solidPng(8, 8, [200, 200, 200]);
  const p = baselined(base);
  serve(p, pngHelpers.withChangedPixel(base, 3, 3, [201, 199, 202]), 'noise.png');

  const res = p.run('figma-drift.js');
  assert.equal(res.status, 0);
  assert.match(res.out, /✓ button.*identical/);
  assert.match(res.out, /no drift detected\./);
});

test('a resized render is reported as a dimension change, not compared per pixel', { skip: NEEDS_PNGJS }, () => {
  const p = baselined(pngHelpers.solidPng(8, 8, [255, 255, 255]));
  serve(p, pngHelpers.solidPng(12, 8, [255, 255, 255]), 'wider.png');

  const res = p.run('figma-drift.js');
  assert.equal(res.status, 0, 'a different size must be reported, never crashed on');
  assert.match(res.out, /dimensions changed 8x8 → 12x8/);
  // The new render is copied next to the baseline so it can be opened without hunting in /tmp.
  assert.ok(p.exists('figma-baselines/button-1234-5678.current.png'));
  assert.match(res.out, /drift detected \(1\)/);
});

test('a node id that no longer renders is called out as a possibly-dead id', { skip: NEEDS_PNGJS }, () => {
  const p = baselined(pngHelpers.solidPng(8, 8, [255, 255, 255]));
  p.setStub({ images: {} }); // the images API answers with a null URL

  const res = p.run('figma-drift.js');
  assert.equal(res.status, 0);
  assert.match(res.out, /no image returned by Figma/);
  assert.match(res.out, /the node id may be dead: a republished file renumbers every id\./);
});

test('the lastModified tripwire fires when the design file was edited after baselining', { skip: NEEDS_PNGJS }, () => {
  const p = baselined(pngHelpers.solidPng(8, 8, [255, 255, 255]));
  p.setStub({
    file: {
      name: 'Example Design System',
      lastModified: '2026-01-12T10:00:00Z',
      version: '1000000001',
    },
  });

  const res = p.run('figma-drift.js');
  assert.equal(res.status, 0);
  assert.match(res.out, /✗ the design file has been edited since the baselines were captured \(7 days later\)/);
  assert.match(res.out, /the design file was edited after the baselines were captured/);
  assert.match(res.out, /1\. re-export the variables into figma-variables\//);
});

test('drift.nodes empty leaves layer 2 off, with instructions', () => {
  const p = createProject({ envFile: false });
  p.patchConfig((c) => {
    c.drift.nodes = [];
  });

  const res = p.run('figma-drift.js');
  assert.equal(res.status, 0);
  assert.match(res.out, /drift\.nodes is empty — layer 2 is off/);
  assert.match(res.out, /"drift": \{ "nodes": \[\{ "id": "1234:5678", "name": "button" \}\] \}/);
});

test('a --update that cannot reach Figma keeps the baselines it already had', { skip: NEEDS_PNGJS }, () => {
  const p = baselined(pngHelpers.solidPng(8, 8, [255, 255, 255]));
  const before = p.readJson('figma-baselines/baseline.json');

  // Take the credentials away, then re-run --update. A failed capture must never blank the index:
  // the next check would report a clean bill of health because there is nothing left to compare
  // against — the worst possible failure for a tool whose whole job is noticing.
  p.remove('.env.local');
  const res = p.run('figma-drift.js', ['--update']);
  assert.equal(res.status, 0);
  assert.match(res.out, /baselines were not captured, the existing ones are kept/);

  const after = p.readJson('figma-baselines/baseline.json');
  assert.deepEqual(Object.keys(after.nodes), [NODE_ID]);
  assert.deepEqual(after.nodes[NODE_ID], before.nodes[NODE_ID]);
  // The recorded timestamp survives too, so the tripwire does not silently switch itself off.
  assert.equal(after.$meta.figmaLastModified, before.$meta.figmaLastModified);
  assert.ok(p.exists(BASELINE_PNG));
});
