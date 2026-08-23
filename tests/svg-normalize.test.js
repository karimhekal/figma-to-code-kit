/* eslint-disable */
/**
 * svg-normalize.test — the icon rewrite rules, each one pinned to the bug that created it.
 *
 * This module is regex surgery on markup, which is the kind of code that looks obviously correct
 * and is wrong in one specific case. Every test below is that one specific case:
 *   - `fill="white"` shipping an invisible glyph on a light surface (the drift that made this a
 *     shared module in the first place)
 *   - `fill="none"` turned into `currentColor`, flooding every outline icon into a solid blob
 *   - an inner `<rect width="16">` stripped along with the root's size, deforming the drawing
 *
 * The config is always passed EXPLICITLY. `recolorToCurrentColor(svg)` defaults to `loadConfig()`,
 * which walks up from cwd looking for a figma-kit.config.json — so a test that relied on the default
 * would read whatever config happens to sit above the checkout and stop being hermetic.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeIcon,
  recolorToCurrentColor,
  stripRootSize,
  collapseWhitespace,
} = require('../scripts/svg-normalize');

/** The default icon config, stated here so no test depends on an ambient config file. */
const CFG = { icons: { extraNamedColors: ['white', 'black'] } };

test('recolor: hex paints become currentColor, in both quote styles', () => {
  const svg =
    '<svg viewBox="0 0 24 24"><path fill="#1A1A1A" d="M0 0"/>' +
    "<path stroke='#abc' d='M1 1'/><path fill=\"#FF00FF80\" d=\"M2 2\"/></svg>";
  const out = recolorToCurrentColor(svg, CFG);
  assert.match(out, /fill="currentColor" d="M0 0"/);
  assert.match(out, /stroke="currentColor" d='M1 1'/);
  // 8-digit hex (with alpha) is still a hex paint.
  assert.match(out, /fill="currentColor" d="M2 2"/);
  assert.doesNotMatch(out, /#[0-9a-fA-F]{3}/);
});

test('recolor: named white and black become currentColor, case-insensitively', () => {
  // Figma exports pure white/black as CSS keywords, not hex. A hex-only rule set leaves them —
  // and a white glyph then ships white and is invisible on a light background.
  const svg =
    '<svg viewBox="0 0 24 24"><path fill="white" d="M0 0"/><path fill="White" d="M1 1"/>' +
    '<path stroke="BLACK" d="M2 2"/></svg>';
  const out = recolorToCurrentColor(svg, CFG);
  assert.equal(out.includes('"white"'), false);
  assert.equal(out.includes('"White"'), false);
  assert.equal(out.includes('"BLACK"'), false);
  assert.equal(out.match(/currentColor/g).length, 3);
});

test('recolor: fill="none" is left ALONE', () => {
  // "none" means "do not paint this shape", not "no color chosen". Rewriting it fills every
  // outline icon solid.
  const svg =
    '<svg viewBox="0 0 24 24"><path fill="none" stroke="#1A1A1A" d="M0 0"/>' +
    '<rect fill="transparent"/><circle fill="currentColor"/></svg>';
  const out = recolorToCurrentColor(svg, CFG);
  assert.match(out, /fill="none"/);
  assert.match(out, /fill="transparent"/);
  assert.match(out, /stroke="currentColor"/);
});

test('recolor: a config that tries to rewrite "none" is refused, loudly', () => {
  const warned = [];
  const original = console.warn;
  console.warn = (m) => warned.push(String(m));
  try {
    const out = recolorToCurrentColor(
      '<svg><path fill="none"/></svg>',
      { icons: { extraNamedColors: ['none', 'white'] } },
    );
    assert.match(out, /fill="none"/);
  } finally {
    console.warn = original;
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /Ignoring icons\.extraNamedColors entry "none"/);
});

test('recolor: unrecognised CSS keywords are left as-is (a documented limit, not a bug)', () => {
  const out = recolorToCurrentColor('<svg><path fill="rebeccapurple"/></svg>', CFG);
  assert.match(out, /fill="rebeccapurple"/);
});

test('stripRootSize: the root loses width/height, viewBox and inner geometry survive', () => {
  const svg =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none">' +
    '<rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
  const out = stripRootSize(svg);

  assert.match(out, /<svg viewBox="0 0 24 24" fill="none">/);
  // The inner rect's width/height are GEOMETRY. Stripping them deforms the drawing.
  assert.match(out, /<rect x="4" y="4" width="16" height="16" rx="2"\/>/);
});

test('stripRootSize: both quote styles, and odd spacing around "="', () => {
  const svg = "<svg width = '24' height='24' viewBox='0 0 24 24'><path d='M0 0'/></svg>";
  const out = stripRootSize(svg);
  assert.match(out, /<svg viewBox='0 0 24 24'>/);
});

test('stripRootSize: an <?xml?> prolog is not mistaken for the root tag', () => {
  const svg =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg width="32" height="32" viewBox="0 0 32 32"><path d="M0 0"/></svg>';
  const out = stripRootSize(svg);

  assert.match(out, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(out, /<svg viewBox="0 0 32 32">/);
});

test('stripRootSize: a ">" inside an attribute value does not end the tag early', () => {
  // Quote-awareness is the reason rootTagRange scans instead of regexing to the first ">".
  const svg = '<svg data-note="a > b" width="24" height="24" viewBox="0 0 24 24"><g/></svg>';
  const out = stripRootSize(svg);
  assert.match(out, /<svg data-note="a > b" viewBox="0 0 24 24">/);
});

test('stripRootSize: markup with no <svg> at all is returned untouched', () => {
  assert.equal(stripRootSize('<g><path/></g>'), '<g><path/></g>');
});

test('collapseWhitespace: comments go, the SVG stores as one line', () => {
  const svg = '<svg>\n  <!-- Generator: Figma -->\n  <path d="M0 0"/>\n</svg>\n';
  assert.equal(collapseWhitespace(svg), '<svg><path d="M0 0"/></svg>');
});

test('normalizeIcon: recolor + strip + collapse, end to end', () => {
  const svg =
    '<?xml version="1.0"?>\n' +
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">\n' +
    '  <!-- Generator: Figma -->\n' +
    '  <path d="M4 12h16" stroke="white" stroke-width="2"/>\n' +
    '  <rect x="4" y="4" width="16" height="16" fill="#1A1A1A"/>\n' +
    '</svg>\n';

  const out = normalizeIcon(svg, CFG);

  assert.equal(out.includes('\n'), false);
  assert.equal(out.includes('<!--'), false);
  assert.match(out, /<svg viewBox="0 0 24 24" fill="none"/);
  assert.match(out, /stroke="currentColor"/);
  assert.match(out, /<rect x="4" y="4" width="16" height="16" fill="currentColor"\/>/);
});
