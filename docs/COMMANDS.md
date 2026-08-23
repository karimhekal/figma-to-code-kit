# Command reference

Every script in the kit, its flags, and what it prints. All of them read
[`figma.config.json`](CONFIG.md) for defaults — a flag always overrides the config.

Run them with `node scripts/<name>.js`. Node 18+; no build step.

**Common to every script that talks to Figma**

| Flag | Meaning |
|---|---|
| `--file <key>` | Use this file key instead of the configured one. |
| `--screens` | Use the `files.screens` slot instead of `files.default`. |

Node ids may be written `1234:5678` (API form) or `1234-5678` (the form in a Figma URL) — both
work everywhere.

---

## Reading a design

### `figma-extract.js` — the exact spec

```bash
node scripts/figma-extract.js <nodeId> [--file <key>] [--screens] [--depth <n>]
```

The core of the kit. Prints, for every node in the subtree: size, auto-layout (gap and padding),
corner radius, stroke, **every** fill, and text style — each annotated `✓bound` (bound to a Figma
variable → reference the suggested token) or `⚠LITERAL` (hardcoded in Figma → verify it was
intended). For a component set it prints the **COMPONENT PROPERTIES** block first: every variant
axis with all its options, plus boolean, text and instance-swap props. That block is the contract
for what "done" means.

Ends with three tallies: unbound literals, off-grid spacing in your own layout (actionable), and
off-grid spacing inside component instances (informational — the component owns it). Any
`gotchas` in your config print last.

`--depth` limits how far down it walks; useful on a whole screen when you only want the top
structure.

> Suggestions require `tokens.index`, `tokens.spacing` and `tokens.typography` to be configured.
> Without them the script still runs and still flags bound-vs-literal — you just lose the mapping
> to *your* code. `[warn]` lines at the top tell you which half is off.

### `figma-render.js` — ground truth to diff against

```bash
node scripts/figma-render.js <nodeId> [...] [--file <key>] [--screens] \
     [--scale 4] [--format png|svg] [--out <dir>]
```

Renders one or more nodes through Figma's images endpoint and saves them (default: `paths.renderDir`).
Accepts several node ids in one call. `--scale` goes up to 4; drop it if a heavy node times out.

Retries the images API answering HTTP `200` with an `{ err: "Render timeout" }` body — a real quirk
that plain HTTP retry logic misses.

### `figma-pixel.js` — measure the render, don't eyeball it

```bash
node scripts/figma-pixel.js <png> [--design W] <x> <y> [<x> <y> ...]
node scripts/figma-pixel.js <png> --design W --row <y> [--thresh T] [--min N] [--invert]
```

Two modes. **Point sampling** prints the composited RGB at coordinates — use it to confirm a fill
really is the token you referenced. **Row scanning** (`--row`) prints the x-ranges on that row
where content sits, which locates an icon, a label's centre, or an edge inset as numbers instead
of an impression.

`--design W` interprets your coordinates in design space and scales them to the PNG (falls back to
`design.frameWidth`). `--invert` is required on dark-mode renders, where content is *brighter*
than the background rather than darker. `--thresh` tunes the content/background cutoff for
low-contrast pairs.

Works on any PNG, including screenshots of your own build — which is how you compare the two.

### `figma-text.js` — translatable copy

```bash
node scripts/figma-text.js <nodeId> [--file <key>] [--screens] [--rtl] [--json]
```

Pulls every text node's content grouped by screen frame, in reading order, with placeholder noise
filtered out (`text.noiseWords` / `text.noisePatterns`). Defaults to the `screens` slot, since copy
lives in the product file. `--rtl` flips the secondary sort for right-to-left frames. `--json` emits
machine-readable output for an i18n pipeline.

---

## Exporting assets

### `figma-icon.js` — small recolorable icons

```bash
node scripts/figma-icon.js <nodeId>=<name> [<nodeId>=<name> ...] [--file <key>] [--out <registry.json>]
```

Exports exact SVG and upserts a name-keyed registry (`paths.iconRegistry`). Normalizes hex **and
named** white/black paints to `currentColor` so one glyph recolors from a prop, and strips
`width`/`height` from the root tag so a size prop controls dimensions — `viewBox` survives, so each
icon keeps its own design grid.

You pass explicit `nodeId=name` pairs. That is deliberate: it means the kit assumes nothing about
how your library organises its icon page, which is why it works with any design system.

Not for multi-color art — every paint would collapse to one color. Use `figma-asset.js` instead.

### `figma-asset.js` — large or multi-color graphics

```bash
node scripts/figma-asset.js <nodeId>=<name> [...] [--file <key>] [--out <dir>] [--mono]
```

Writes one exact `.svg` file per name into `paths.graphicsDir`, **keeping original colors** — right
for illustrations and logos. `--mono` normalizes to `currentColor` for large single-color art.

Keep large art out of the icon registry: the registry is parsed at runtime, so big paths cost both
bundle size and startup time.

---

## Generating tokens

### `build-tokens.js` — variables export → typed modules

```bash
node scripts/build-tokens.js
```

Reads the Figma variables export from `paths.variablesExport` and writes `palette.generated.ts` and
`themes.generated.ts` into `paths.tokensDir`. Resolves `{alias.references}` across the export and
converts colors (hex, or `rgba()` when alpha applies).

Driven entirely by `variables.sources` (which exported file is which mode) and `variables.groups`
(where each top-level group lands). It reports **anything it could not route** and **every broken
alias** rather than guessing — both are defects worth taking back to design.

### `build-typography.js` — text styles → typed ramp

```bash
node scripts/build-typography.js [--file <key>]
```

Figma text styles are **not variables**, so they never appear in the variables export. This fetches
them from the REST API and writes `typography.generated.ts`. Configured by
`typographySource.prefixes` (first prefix is the base that drives metrics; later ones contribute
face overrides) and `typographySource.order`.

### `patch-font-metrics.py` — stop line-height clipping

```bash
python3 scripts/patch-font-metrics.py [--src <dir>] [--out <dir>] [--glob '*.ttf'] [--layout-range 0x20-0x24F]
```

Optional, and only relevant when your runtime sizes lines from font metrics. Some fonts declare a
much taller line box than they actually draw; applying a design system's tight line heights then
clips the glyphs. This measures the font's real ink from its glyph contours and rewrites the
vertical metrics to match — layout metrics from the layout script's ink, clipping metrics from the
full ink so tall marks overlap instead of being cut off.

Reads pristine sources from `paths.fontSources` and writes to `paths.fontsOut`. Idempotent: always
reads the untouched source, so re-running never compounds. Needs Python 3 + `fonttools`.

If the ramp looks right in Figma and clipped in your app, reach for this — **not** for inflating the
line heights, which quietly abandons the type ramp.

---

## Checking your setup

### `config-check.js` — validate the config against reality

```bash
node scripts/config-check.js [--online]
```

Verifies that configured paths exist, that token modules load and export what you claimed, that the
spacing and typography ramps resolve, that commands are set, and that your access token is found
(it never prints the value). Reports `✓` / `⚠` / `✗` and exits non-zero on errors.

`--online` adds one cheap API call to confirm the token can actually read `files.default`, and
prints that file's `lastModified` — the starting point of the stale-id protocol in
[`../skills/figma-to-code/core.md`](../skills/figma-to-code/core.md).

Run it after setup, and again whenever the repo moves a directory. A rotted config is worse than no
config: the extractor's suggestions silently stop appearing and nobody notices they were ever there.

---

## Where to go next

- [SETUP.md](SETUP.md) — ordered walkthrough for a new project
- [CONFIG.md](CONFIG.md) — every config field and how to obtain its value
- [`skills/figma-to-code/SKILL.md`](../skills/figma-to-code/SKILL.md) — the workflow these commands serve
