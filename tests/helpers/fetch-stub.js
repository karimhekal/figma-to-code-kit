/* eslint-disable */
/**
 * fetch-stub — a `--require` preload that replaces `global.fetch` with a canned Figma API.
 *
 * WHY A PRELOAD AND NOT A MOCK
 * ----------------------------
 * Every script in this kit is an IIFE that reads argv, prints, and calls `process.exit`. There is
 * no exported function to mock and no injection seam to reach for — the CLI *is* the interface, and
 * that is exactly the surface a user touches. So the tests run the real scripts as child processes
 * and swap the network out from underneath them. `NODE_OPTIONS="--require <this file>"` installs the
 * stub before the script's first line runs, and — because `NODE_OPTIONS` is inherited — it installs
 * itself in GRANDCHILDREN too. That matters: `figma-drift.js` shells out to `figma-render.js`, and a
 * stub that only covered the parent would let the render step reach api.figma.com for real.
 *
 * NO FIGMA_STUB, NO NETWORK. When the manifest env var is unset, `fetch` is replaced by one that
 * throws. A test that accidentally exercises an unstubbed path must FAIL LOUDLY, not quietly make a
 * real request against whatever token happens to be in the developer's environment.
 *
 * THE MANIFEST (`$FIGMA_STUB` → a JSON file; re-read on every request, so a test can change the
 * canned answers between two runs of the same script — which is the whole trick behind the drift
 * tests: baseline against image A, then serve image B and watch it report the change):
 *
 *   {
 *     "file":   { "name": "...", "lastModified": "2026-01-05T10:00:00Z", "version": "1" },
 *     "nodes":  "/abs/path/to/a/nodes-response.json",
 *     "images": { "1234:5678": "/abs/path/to/a.png" }
 *   }
 *
 * Routes served (everything else answers 404, never a real request):
 *   GET /v1/files/<key>?depth=1        → `file`
 *   GET /v1/files/<key>/nodes?ids=…    → the JSON at `nodes`
 *   GET /v1/images/<key>?ids=…         → { images: { <id>: "https://stub.invalid/image/<id>" } }
 *   GET https://stub.invalid/image/<id> → the PNG bytes at `images[<id>]`
 */
const fs = require('fs');

const IMAGE_ORIGIN = 'https://stub.invalid/image/';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function notFound(url) {
  return jsonResponse({ err: `fetch-stub has no route for ${url}` }, 404);
}

function readManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function handle(manifestPath, rawUrl) {
  const url = new URL(String(rawUrl));
  const manifest = readManifest(manifestPath);

  if (String(rawUrl).startsWith(IMAGE_ORIGIN)) {
    // The id round-trips through the URL, so decode it back to Figma's `1234:5678` form.
    const id = decodeURIComponent(String(rawUrl).slice(IMAGE_ORIGIN.length));
    const file = (manifest.images || {})[id];
    if (!file || !fs.existsSync(file)) return notFound(rawUrl);
    return new Response(fs.readFileSync(file), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
  }

  if (url.hostname !== 'api.figma.com') return notFound(rawUrl);

  const nodesMatch = url.pathname.match(/^\/v1\/files\/[^/]+\/nodes$/);
  if (nodesMatch) {
    if (!manifest.nodes) return notFound(rawUrl);
    return jsonResponse(JSON.parse(fs.readFileSync(manifest.nodes, 'utf8')));
  }

  const imagesMatch = url.pathname.match(/^\/v1\/images\/[^/]+$/);
  if (imagesMatch) {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
    const images = {};
    for (const id of ids) {
      // A null URL is the real API's answer for "the node rendered to nothing" — keep that shape
      // rather than omitting the key, so the scripts' null-handling stays on the tested path.
      images[id] = (manifest.images || {})[id] ? `${IMAGE_ORIGIN}${encodeURIComponent(id)}` : null;
    }
    return jsonResponse({ err: null, images });
  }

  if (/^\/v1\/files\/[^/]+$/.test(url.pathname)) {
    return jsonResponse(manifest.file || { name: 'Stub File', lastModified: null });
  }

  return notFound(rawUrl);
}

const manifestPath = process.env.FIGMA_STUB || null;

global.fetch = async function stubbedFetch(input) {
  const rawUrl = typeof input === 'string' ? input : input && input.url;
  if (!manifestPath) {
    throw new Error(
      `fetch-stub: network access is disabled in tests and $FIGMA_STUB is unset (tried ${rawUrl}).`,
    );
  }
  return handle(manifestPath, rawUrl);
};
