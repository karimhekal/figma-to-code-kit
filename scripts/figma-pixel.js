/* eslint-disable */
/**
 * figma-pixel — read EXACT colors and positions out of a render PNG, so a visual compare is
 * measured rather than eyeballed. Twice over it has caught a wrong-color / wrong-icon-position
 * guess that looked fine at a glance.
 *
 * Nothing here is Figma-specific: it works on any PNG, so point it at the Figma render AND at a
 * screenshot of the build and compare the two readings.
 *
 *   # sample composited RGB at point(s) — PNG px coords by default:
 *   node scripts/figma-pixel.js <png> 784 1300 1340 1552
 *
 *   # ...or in DESIGN space (the artboard width); coords are scaled up to the PNG.
 *   # --design defaults to design.frameWidth from figma-kit.config.json:
 *   node scripts/figma-pixel.js <png> --design 393 196 330
 *
 *   # find content runs on a row (locate an icon, a label, a divider, an edge): prints the
 *   # x-ranges where the row differs from the background, in PNG px and design px:
 *   node scripts/figma-pixel.js <png> --row 388 [--thresh 150] [--min 4] [--invert] [--bg RRGGBB]
 *
 * Sampled values are COMPOSITED, so pair them with the token you actually used: a
 * semi-transparent token only matches once it is composited over what is behind it (e.g. a 4%
 * black surface over #FFFFFF reads back as rgb(245,245,245), never as the token's own value).
 *
 * LIMITATION — `--row` is contrast-directional. By default a pixel counts as content when it is
 * DARKER than `--thresh`, i.e. it assumes a LIGHT render (dark ink on a light background). Run it
 * against a dark-mode render and the readings invert into nonsense: the background becomes one
 * giant "content" run and the real content disappears. Pass `--invert` for dark renders — content
 * is then anything BRIGHTER than the threshold. The test is a flat average of R,G,B, so for a
 * low-contrast pair (a mid-grey label on a mid-grey surface) tune `--thresh` instead of trusting
 * the default; sample a background pixel and a content pixel first and pick a value between them.
 *
 * Requires `pngjs` — the only runtime dependency in this kit.
 */
const fs = require('fs');
const { loadConfig } = require('./figma-config');

let PNG;
try {
  ({ PNG } = require('pngjs'));
} catch {
  console.error(
    "figma-pixel needs the 'pngjs' package (the only runtime dependency in this kit). " +
      'Add pngjs to your project and install, then re-run.',
  );
  process.exit(1);
}

const cfg = loadConfig();

const argv = process.argv.slice(2);
const file = argv[0];
if (!file || file.startsWith('--')) {
  console.error(
    'Usage: node scripts/figma-pixel.js <png> [--design W] ' +
      '[--bg RRGGBB] [--row Y [--thresh T] [--min N] [--invert] | <x> <y> ...]',
  );
  process.exit(1);
}

let designW = null;
let row = null;
let thresh = 150;
let min = 4;
let invert = false; // dark render: content is BRIGHTER than the background
// The background transparent pixels are composited over. White matches a light-mode screen;
// pass --bg for a dark surface (and you will usually want --invert with it).
let bg = [255, 255, 255];
const nums = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--design') designW = Number(argv[++i]);
  else if (a === '--row') row = Number(argv[++i]);
  else if (a === '--thresh') thresh = Number(argv[++i]);
  else if (a === '--min') min = Number(argv[++i]);
  else if (a === '--invert') invert = true;
  else if (a === '--bg') {
    const raw = String(argv[++i] || '').trim();
    const m = /^#?([0-9a-f]{6})$/i.exec(raw);
    if (!m) {
      console.error(`--bg expects a 6-digit hex colour (e.g. --bg 101014); got "${raw}".`);
      process.exit(1);
    }
    bg = [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16));
  } else nums.push(Number(a));
}

// Design-space coords are the useful unit (they match what the design tool shows), so fall back
// to the project's frame width when the flag is omitted. No config, no fallback — px it is.
let designFromConfig = false;
if (designW === null && cfg.design && Number(cfg.design.frameWidth) > 0) {
  designW = Number(cfg.design.frameWidth);
  designFromConfig = true;
}
if (designW !== null && !(designW > 0)) {
  console.error('--design must be a positive number (the artboard width in design px).');
  process.exit(1);
}

let png;
try {
  png = PNG.sync.read(fs.readFileSync(file));
} catch (e) {
  console.error(`Could not read PNG "${file}": ${e.message}`);
  process.exit(1);
}

const { width, height, data } = png;
const sx = designW ? width / designW : 1;
const toPx = (v) => Math.round(v * sx);
const fromPx = (v) => (designW ? Math.round(v / sx) : v);
const px = (x, y) => {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
};

/**
 * Composite a pixel over the assumed page background.
 *
 * This matters more than it looks. Figma renders a component with a TRANSPARENT background
 * unless the node itself paints one — and a fully transparent pixel is stored as rgba(0,0,0,0).
 * Test that raw and every empty pixel reads as pure black, i.e. as "dark content": a row scan
 * then reports one giant run covering the whole image and the real edges vanish. Composite over
 * the background you will actually view the component on (white by default, --bg to change) and
 * transparent correctly becomes background, exactly as your eye sees it on screen.
 */
const composite = (r, g, b, a) => {
  if (a === 255) return [r, g, b];
  const t = a / 255;
  return [
    Math.round(r * t + bg[0] * (1 - t)),
    Math.round(g * t + bg[1] * (1 - t)),
    Math.round(b * t + bg[2] * (1 - t)),
  ];
};
const inBounds = (x, y) => x >= 0 && x < width && y >= 0 && y < height;

console.log(
  `PNG ${width}x${height}` +
    (designW
      ? ` (design ${designW}${designFromConfig ? ' from config' : ''} → scale ${sx.toFixed(3)})`
      : ''),
);

if (row !== null) {
  const y = toPx(row);
  if (y < 0 || y >= height) {
    console.error(`row y=${row} maps to px ${y}, outside the image (height ${height}).`);
    process.exit(1);
  }
  const isContent = (r, g, b) => (invert ? (r + g + b) / 3 > thresh : (r + g + b) / 3 < thresh);
  const runs = [];
  let inRun = false;
  let start = 0;
  for (let x = 0; x < width; x++) {
    const [r, g, b] = composite(...px(x, y));
    const content = isContent(r, g, b);
    if (content && !inRun) {
      inRun = true;
      start = x;
    } else if (!content && inRun) {
      inRun = false;
      if (x - start >= min) runs.push([start, x]);
    }
  }
  if (inRun && width - start >= min) runs.push([start, width]);
  const test = invert ? `avg>${thresh}, inverted for a dark render` : `avg<${thresh}`;
  console.log(`row y=${row} (px ${y}) content runs (${test}):`);
  console.log('  px    :', runs.map((r) => `${r[0]}-${r[1]}`).join('  ') || '(none)');
  if (designW) {
    console.log('  design:', runs.map((r) => `${fromPx(r[0])}-${fromPx(r[1])}`).join('  ') || '(none)');
  }
  if (!runs.length) {
    console.log(
      `  (nothing matched — if this is a ${invert ? 'light' : 'dark'} render, ` +
        `${invert ? 'drop' : 'add'} --invert; otherwise adjust --thresh)`,
    );
  }
} else {
  if (nums.length < 2) {
    console.error('Give at least one <x> <y> pair to sample, or use --row Y.');
    process.exit(1);
  }
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = toPx(nums[i]);
    const y = toPx(nums[i + 1]);
    const label = designW ? `design(${nums[i]},${nums[i + 1]}) px(${x},${y})` : `px(${x},${y})`;
    if (!inBounds(x, y)) {
      console.log(`${label} -> outside the image (${width}x${height})`);
      continue;
    }
    const [r, g, b, a] = px(x, y);
    const hex = [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
    if (a === 255) {
      console.log(`${label} -> rgb(${r},${g},${b})  #${hex}`);
      continue;
    }
    // Partly or fully transparent. Report BOTH: the stored paint (which is what you compare
    // against a token, since a token is authored without a background) and what the eye actually
    // sees once it composites. A fully transparent pixel stores as black — saying only "rgb(0,0,0)"
    // has sent people hunting for a black fill that does not exist.
    const [cr, cg, cb] = composite(r, g, b, a);
    const chex = [cr, cg, cb].map((c) => c.toString(16).padStart(2, '0')).join('');
    const note = a === 0 ? 'fully transparent — nothing painted here' : `a=${(a / 255).toFixed(2)}`;
    console.log(
      `${label} -> rgb(${r},${g},${b}) #${hex}  [${note}]  ` +
        `over #${bg.map((c) => c.toString(16).padStart(2, '0')).join('')} it reads rgb(${cr},${cg},${cb}) #${chex}`,
    );
  }
}
