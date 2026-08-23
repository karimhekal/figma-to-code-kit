/* eslint-disable */
/**
 * figma-pixel.test — the measuring tape that makes a visual compare a measurement.
 *
 * The regression that produced this file is worth stating, because it was invisible and it broke
 * the tool's main use case. Figma renders a component with NO background unless the node paints
 * one, so every pixel outside the artwork comes back rgba(0,0,0,0) — transparent, but STORED as
 * black. The row scan tested the raw channels for darkness, so it counted all that empty space as
 * ink: scanning a real 288×136 component render returned the run `0-20  76-288`, claiming content
 * ran to the right edge when the artwork stopped at x=96. Not an error, not a crash — just
 * confidently wrong numbers, in the one output people use to decide whether a build matches.
 *
 * So these tests pin the composite: transparent must read as the background you will view the
 * component on, not as black. Everything else here guards the properties a measuring tool has to
 * have — that it reports what it read, and says so plainly when it read nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createProject } = require('./helpers/project');

let pngHelpers = null;
try {
  pngHelpers = require('./helpers/png');
} catch {
  pngHelpers = null;
}
const NEEDS_PNGJS = pngHelpers ? false : 'pngjs is not installed — run `npm install` first';

/** Write a PNG into the project and return the path to hand the CLI. */
function putPng(p, rel, buffer) {
  p.write(rel, buffer);
  return rel;
}

// ─── the transparency composite ───────────────────────────────────────────────

test('transparent background is not counted as content', { skip: NEEDS_PNGJS }, () => {
  const p = createProject();
  // 40px wide, fully transparent except an opaque dark bar from x=10 to x=20.
  // Read raw, the 30 transparent pixels are (0,0,0) and swamp the bar.
  putPng(p, 'shot.png', pngHelpers.transparentWithBar(40, 10, 10, 20, [20, 20, 20]));

  const res = p.run('figma-pixel.js', ['shot.png', '--row', '5', '--min', '2']);
  assert.equal(res.status, 0, res.out);

  // Exactly the bar, nothing else. Before the composite this reported 0-40.
  assert.match(res.out, /px\s*:\s*10-20\s*$/m);
  assert.doesNotMatch(res.out, /0-40/);
});

test('--bg composites over a dark surface instead of white', { skip: NEEDS_PNGJS }, () => {
  const p = createProject();
  // An opaque WHITE bar on transparent. On a dark surface the bar is the bright thing,
  // so this is the --invert case, and the empty space must read as the dark background.
  putPng(p, 'shot.png', pngHelpers.transparentWithBar(40, 10, 10, 20, [255, 255, 255]));

  const res = p.run('figma-pixel.js', [
    'shot.png', '--row', '5', '--min', '2', '--bg', '101014', '--invert',
  ]);
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /px\s*:\s*10-20\s*$/m);
});

test('a fully transparent pixel is explained, not reported as black', { skip: NEEDS_PNGJS }, () => {
  const p = createProject();
  putPng(p, 'shot.png', pngHelpers.transparentWithBar(40, 10, 10, 20, [20, 20, 20]));

  // x=0 is empty space. Saying only "rgb(0,0,0)" sends people hunting for a black fill.
  const res = p.run('figma-pixel.js', ['shot.png', '0', '5']);
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /fully transparent/i);
  assert.match(res.out, /rgb\(255,255,255\)/); // what it actually reads over white
});

test('an opaque pixel is reported plainly, with no composite noise', { skip: NEEDS_PNGJS }, () => {
  const p = createProject();
  putPng(p, 'shot.png', pngHelpers.solidPng(8, 8, [51, 0, 255]));

  const res = p.run('figma-pixel.js', ['shot.png', '2', '2']);
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /rgb\(51,0,255\)/);
  assert.match(res.out, /#3300ff/i);
  assert.doesNotMatch(res.out, /transparent|it reads/i);
});

// ─── the properties any measuring tool needs ──────────────────────────────────

test('both images can be measured with the identical command', { skip: NEEDS_PNGJS }, () => {
  const p = createProject();
  // This is the actual workflow: the design render and a screenshot of the build, same scan.
  putPng(p, 'figma.png', pngHelpers.transparentWithBar(40, 10, 10, 20, [20, 20, 20]));
  putPng(p, 'build.png', pngHelpers.transparentWithBar(40, 10, 10, 24, [20, 20, 20]));

  const args = ['--row', '5', '--min', '2'];
  const fig = p.run('figma-pixel.js', ['figma.png', ...args]);
  const bld = p.run('figma-pixel.js', ['build.png', ...args]);

  assert.match(fig.out, /px\s*:\s*10-20\s*$/m);
  assert.match(bld.out, /px\s*:\s*10-24\s*$/m); // 4px wider — the defect, as a number
});

test('an empty row says so and names the flag that fixes it', { skip: NEEDS_PNGJS }, () => {
  const p = createProject();
  putPng(p, 'shot.png', pngHelpers.solidPng(20, 20, [255, 255, 255])); // all background

  const res = p.run('figma-pixel.js', ['shot.png', '--row', '10']);
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /\(none\)/);
  assert.match(res.out, /--invert/); // the usual cause: it is a dark render
});

test('--bg rejects a value that is not a hex colour', { skip: NEEDS_PNGJS }, () => {
  const p = createProject();
  putPng(p, 'shot.png', pngHelpers.solidPng(8, 8, [0, 0, 0]));

  const res = p.run('figma-pixel.js', ['shot.png', '--row', '4', '--bg', 'white']);
  assert.notEqual(res.status, 0);
  assert.match(res.out, /6-digit hex/i);
});

test('a row outside the image fails with the height, not a stack trace', { skip: NEEDS_PNGJS }, () => {
  const p = createProject();
  putPng(p, 'shot.png', pngHelpers.solidPng(8, 8, [0, 0, 0]));

  const res = p.run('figma-pixel.js', ['shot.png', '--row', '999']);
  assert.notEqual(res.status, 0);
  assert.match(res.out, /outside the image/i);
  assert.doesNotMatch(res.out, /at Object\.|node:internal/); // no raw stack
});
