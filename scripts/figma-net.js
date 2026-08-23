/* eslint-disable */
/**
 * figma-net — the shared HTTP + credential layer every figma-* script goes through:
 * `fetchRetry` for every Figma call, and the single token loader they all authenticate with.
 *
 * Both live here rather than in each script on purpose. Per-script copies drift, and the two
 * comments below record exactly what that drift cost (a token that authenticated from one
 * script and 403'd from the next, and a rate-limit that masqueraded as a dead node id).
 *
 * Zero dependencies — Node 18+ for global `fetch`.
 */
const fs = require('fs');
const { loadConfig, resolvePath } = require('./figma-config');

/** Escape a config-supplied name before splicing it into a RegExp. */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read the Figma personal access token from the environment or the project's env file.
 * Returns null when unset, so the caller owns the error message.
 *
 * Both the variable name (`auth.envVar`) and the file (`auth.envFile`, resolved against the
 * project root) come from figma.config.json — the env var always wins, the file is the fallback.
 *
 * THE ONE loader — every figma-* script must call this rather than re-deriving it. Scripts that
 * carried their own copy had drifted: the strict `^TOKEN=(.+)$` variants kept the surrounding
 * quotes of a quoted value and sent `"<token>"` — quotes included — as the token, so the very same
 * env file authenticated from one script and 403'd from the next. This parse tolerates spacing
 * around `=` and strips ONE layer of surrounding quotes.
 */
function loadFigmaToken(cfg = loadConfig()) {
  const envVar = (cfg && cfg.auth && cfg.auth.envVar) || 'FIGMA_ACCESS_TOKEN';
  if (process.env[envVar]) return process.env[envVar];

  const envFile = resolvePath(cfg, cfg && cfg.auth ? cfg.auth.envFile : null);
  if (!envFile) return null;
  try {
    const env = fs.readFileSync(envFile, 'utf8');
    const m = env.match(new RegExp(`^\\s*${escapeRe(envVar)}\\s*=\\s*(.+?)\\s*$`, 'm'));
    if (m) return m[1].replace(/^['"]|['"]$/g, '');
  } catch {}
  return null;
}

/** `loadFigmaToken()` for scripts that cannot proceed without it: prints and exits when missing. */
function requireFigmaToken(cfg = loadConfig()) {
  const t = loadFigmaToken(cfg);
  if (t) return t;
  const envVar = (cfg && cfg.auth && cfg.auth.envVar) || 'FIGMA_ACCESS_TOKEN';
  const envFile = (cfg && cfg.auth && cfg.auth.envFile) || null;
  console.error(
    `Missing ${envVar}. Export it, or put "${envVar}=<your token>" in` +
      (envFile ? ` ${envFile}` : ' your env file (auth.envFile in figma.config.json)') +
      '.\nCreate a personal access token at Figma → Settings → Security → Personal access tokens.' +
      (envFile ? `\nKeep ${envFile} out of version control.` : ''),
  );
  process.exit(1);
}

/**
 * Figma's API + image CDN time out often (UND_ERR_CONNECT_TIMEOUT) and occasionally 5xx; without
 * this every script call needed a manual re-run. Retries transport errors, 5xx and 429 with
 * exponential backoff. It does NOT retry other 4xx (a bad node-id won't fix itself) — and a 200
 * carrying `{ err }` (e.g. the images API "Render timeout") is the caller's to re-check, since
 * that body isn't an HTTP error.
 *
 * 429 is retried because Figma rate-limits per token: running several figma-* calls at once
 * (or one script over many nodes) trips it, and the un-retried 429 surfaced as a bogus
 * "Node not found" — indistinguishable from a genuinely dead node id. Honour `Retry-After`
 * when the response carries it, and jitter the backoff so parallel callers don't sync up.
 */
async function fetchRetry(url, opts = {}, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    let retryAfterMs;
    try {
      const res = await fetch(url, opts);
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (res.status === 429) {
        const after = Number(res.headers.get('retry-after'));
        retryAfterMs = Number.isFinite(after) && after > 0 ? after * 1000 : undefined;
        throw new Error('HTTP 429 (rate limited)');
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) {
        const backoff = retryAfterMs ?? 600 * 2 ** i + Math.floor(Math.random() * 400);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

module.exports = { fetchRetry, loadFigmaToken, requireFigmaToken };
