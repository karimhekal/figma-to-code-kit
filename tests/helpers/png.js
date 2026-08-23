/* eslint-disable */
/**
 * png — build the tiny PNGs the drift tests compare.
 *
 * Generated rather than committed, because the interesting property is the RELATIONSHIP between two
 * images (identical / one pixel apart / a different size), and a committed pair states that
 * relationship in a filename instead of in code. Generating them also keeps the difference honest:
 * `changedPixel` moves one channel far past the drift tolerance, so a passing test proves the
 * comparison found a real change rather than encoder noise.
 *
 * Every pixel is fully opaque on purpose. `figma-drift` skips pixels that are transparent in BOTH
 * images (the RGB under a zero alpha is whatever the encoder felt like writing), so a test built on
 * transparent art would compare nothing and report "identical" no matter what.
 *
 * pngjs is already a dependency of the kit — this adds none.
 */
const { PNG } = require('pngjs');

/** A solid `[r,g,b]` image, fully opaque. */
function solidPng(width, height, [r, g, b]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    png.data[o] = r;
    png.data[o + 1] = g;
    png.data[o + 2] = b;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** The same image with one pixel repainted — the smallest change a per-pixel diff should catch. */
function withChangedPixel(buffer, x, y, [r, g, b]) {
  const png = PNG.sync.read(buffer);
  const o = (y * png.width + x) * 4;
  png.data[o] = r;
  png.data[o + 1] = g;
  png.data[o + 2] = b;
  png.data[o + 3] = 255;
  return PNG.sync.write(png);
}

function dimensions(buffer) {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height };
}

/**
 * A transparent canvas with one opaque horizontal bar — the shape Figma actually returns.
 *
 * A component render has NO background unless the node paints one, so every pixel outside the
 * artwork is rgba(0,0,0,0): transparent, but stored as black. This is the fixture that proves
 * figma-pixel composites before testing darkness instead of counting empty space as ink.
 */
function transparentWithBar(width, height, barFrom, barTo, [r, g, b]) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const inBar = x >= barFrom && x < barTo;
      png.data[o] = inBar ? r : 0;
      png.data[o + 1] = inBar ? g : 0;
      png.data[o + 2] = inBar ? b : 0;
      png.data[o + 3] = inBar ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

module.exports = { solidPng, withChangedPixel, dimensions, transparentWithBar };
