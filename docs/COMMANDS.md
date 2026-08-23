# Command reference

Every script in the kit, its flags, and what it prints. All of them read
[`figma-kit.config.json`](CONFIG.md) for defaults — a flag always overrides the config.

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

**Naming the token is exact, not a guess.** A bound property carries its variable *id* in
`boundVariables`, and `build-tokens.js` records that same id against the code reference the token
became, in `<paths.tokensDir>/variable-map.generated.json`. So a bound value prints one answer:

```
fill=#3A2FF0 ✓bound  ⇒ token: components.checkbox.color.on ✓exact
```

`✓exact` means resolved by id — that *is* the token. It works on any Figma plan (no Variables API
involved) and it resolves cases value matching cannot: a paint at 50% opacity composites to an
`rgba()` that matches no token, yet its id still names one.

Three outcomes, in descending order of trust:

| Printed | Means | What to do |
|---|---|---|
| `⇒ token: X ✓exact` | The bound id is in your variable map. | Reference `X`. Done. |
| `⇒ ⚠ bound to a variable missing from your export (id) — re-export variables` | The design has a variable your export predates. Falls back to a value match. | Re-export the variables, re-run the token build. |
| `⇒ token: X \| Y \| Z` (no `✓exact`) | No variable map, or the property isn't bound. A **value** match — several tokens can share a value. | Treat as a shortlist; pick with design intent in mind. |

Ends with up to four tallies: unbound literals, off-grid spacing in your own layout (actionable),
off-grid spacing inside component instances (informational — the component owns it), and any values
bound to variables **missing from your export**. That last one is a statement about your *pipeline*,
not about the design or the code: the design file has moved ahead of your generated tokens. Any
`gotchas` in your config print last.

`--depth` limits how far down it walks; useful on a whole screen when you only want the top
structure.

> Exact resolution requires the variable map — run the token build once and it appears. Without it
> the script says so in one `[warn]` and falls back to value matching, which is what it did before
> the map existed.
>
> Value matching itself requires `tokens.index`, `tokens.spacing` and `tokens.typography`. Without
> them the script still runs and still flags bound-vs-literal — you just lose the mapping to *your*
> code. `[warn]` lines at the top tell you which half is off.

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
node scripts/figma-pixel.js <png> [--design W] [--bg RRGGBB] <x> <y> [<x> <y> ...]
node scripts/figma-pixel.js <png> [--design W] [--bg RRGGBB] --row <y> [--thresh T] [--min N] [--invert]
```

Two modes. **Point sampling** prints the RGB at coordinates — use it to confirm a fill really is
the token you referenced. **Row scanning** (`--row`) prints the x-ranges on that row where content
sits, which locates an icon, a label's centre, or an edge inset as numbers instead of an impression.

`--design W` interprets your coordinates in design space and scales them to the PNG (falls back to
`design.frameWidth`). `--invert` is required on dark-mode renders, where content is *brighter*
than the background rather than darker. `--thresh` tunes the content/background cutoff for
low-contrast pairs.

**Transparency matters here more than it looks.** Figma renders a component with no background
unless the node paints one, so empty space comes back as `rgba(0,0,0,0)` — transparent, but stored
as black. Both modes therefore composite over an assumed background (white by default, `--bg` to
change) before deciding what is content. Without that, a row scan counts every empty pixel as ink
and reports one run spanning the whole image. On a dark surface, pair `--bg 101014` with `--invert`.

**This is how the comparison actually works.** It runs on any PNG, so you run the *same command* on
the Figma render and on a screenshot of your build, then compare the two readings:

```bash
node scripts/figma-pixel.js figma.png --row 68    #  px : 0-20  76-96
node scripts/figma-pixel.js build.png --row 68    #  px : 0-24  80-104   ← 8px wider
```

There is no automatic diff between the two — you read two sets of numbers and they either agree or
they don't. That is deliberate: the mismatch tells you *where* and *by how much*, which a
pass/fail would not. (For an automated image-vs-image comparison over time, that is
[`figma-drift.js`](#figma-driftjs--has-the-design-moved-without-us).)

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

It also writes **`variable-map.generated.json`** next to them — the join that makes
`figma-extract`'s token resolution exact:

```json
{
  "$meta": { "generator": "build-tokens.js", "exportHash": "9f4c1b7ae023",
             "sources": ["Primitives.tokens.json", "modes/Light.tokens.json"], "variableCount": 134 },
  "variables": {
    "VariableID:35:590": {
      "ref": "components.checkbox.color.on",
      "figmaPath": "Component.Checkbox.Color.On",
      "values": { "light": "#3A2FF0", "dark": "#E8E6FE" }
    }
  }
}
```

Every leaf of the export carries `$extensions["com.figma.variableId"]`, and the ordinary nodes
endpoint returns that **same id** for a bound property — so this is the one place that can pair a
variable with the code reference it becomes, because it is the only place that knows both. `ref` is
spelled exactly as the extractor prints references (`palette.brand[500]`,
`components.checkbox.color.on`), so it can be pasted straight into code. `values` is keyed by mode
(`"*"` for a single-mode source such as the primitives file). `exportHash` fingerprints the export
that produced the map — that is how a stale token build is detected without asking Figma.

Reported as `variable map : N variables → <path>`. If **no** leaf in your export carries a variable
id (some export plugins drop them) no map is written and one `[warn]` explains that exact
resolution will be unavailable — the token modules themselves are unaffected.

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

### `figma-drift.js` — has the design moved without us?

```bash
node scripts/figma-drift.js [--update] [--fail-on-drift] [--tolerance N] \
     [--scale N] [--file <key>] [--screens] [--baselines <dir>]
```

The kit reads a **committed snapshot** of the design — a variables export somebody dropped in, plus
node ids captured by hand. That is what makes it work on any Figma plan, and it is also the one
thing that can rot without a single error: a designer changes a color today, nothing in the repo
changes, the build stays green, and the app ships last month's design. This script makes that loud.

Two layers, because they catch different failures.

**Layer 1 — the tripwire.** One cheap API call for the file's `lastModified`, compared against the
timestamp recorded when the baselines were captured: *somebody edited the design after the last time
anyone here looked.* Then, entirely offline, a hash of the variables export on disk compared against
the hash the token build stamped into `variable-map.generated.json`: *a fresh export was dropped in
and the token build never re-ran*, so the generated tokens describe an export that is no longer the
one sitting next to them. The offline half is the one that fires most often — dropping files in is
the step a human does; re-running the build is the step a human forgets.

**Layer 2 — visual baselines.** Layer 1 only knows that *something* moved. A token check cannot see
a 4px padding tweak, a new disabled state, or a swapped icon — none of those touch a variable, so
none of them change a single generated token. Rendered pixels see all three.

```bash
node scripts/figma-drift.js --update      # capture/refresh the baselines, then commit them
node scripts/figma-drift.js               # re-render and compare
```

`--update` renders every node in `drift.nodes` into `drift.baselineDir` and writes a `baseline.json`
recording the file's `lastModified`, each PNG's dimensions and a content hash. The default run
re-renders those nodes to a temp directory and compares **per pixel**, reporting for each one:

| Report | Meaning |
|---|---|
| `identical` | No pixel differs by more than the tolerance. |
| `N% of pixels differ` | With the bounding box of the changed region, in render px **and** at 1×, plus a diff PNG. |
| `dimensions changed W×H → W×H` | A definite change — a different size is never encoder noise, so it is reported rather than diffed. |
| `no image returned by Figma` | The node id is dead. A republished file renumbers every id (see `files.volatile`). |

The diff PNG lands next to the baseline as `<name>-<id>.diff.png`: the new render, washed out, with
changed pixels in **magenta** and a **cyan** box around the region. The wash is deliberate — a
full-contrast diff makes a 0.3% change impossible to spot.

`--tolerance` (default `drift.tolerance`, 2) is the per-channel slack that stops PNG encoder noise
from crying wolf; drop it to 0 only if you want to see every last bit. A check always re-renders at
the scale recorded in `baseline.json`, because a different scale changes every dimension and would
report a "definite change" on components nobody touched.

`--fail-on-drift` exits non-zero, which is the switch for a **weekly CI job**. Drift is not
automatically a defect — it is a design change nobody has looked at yet. Review it, decide whether
the code should follow, then `--update` to accept the new reference.

> Everything degrades: no token or file key → the online half is off and the offline hash check
> still runs; no `drift.nodes` → layer 2 is off and the run says how to switch it on; no baselines
> yet → it tells you to `--update` and exits 0; no `pngjs` → the compare falls back to whole-image
> hashes, which still says *this changed*, just not where.

Commit `drift.baselineDir` — an uncommitted baseline detects nothing. The `baseline.json` and the
plain `<name>-<id>.png` files are the reference; `*.diff.png` and `*.current.png` are regenerated on
every run and can be ignored.

---

## Where to go next

- [SETUP.md](SETUP.md) — ordered walkthrough for a new project
- [CONFIG.md](CONFIG.md) — every config field and how to obtain its value
- [`skills/figma-to-code/SKILL.md`](../skills/figma-to-code/SKILL.md) — the workflow these commands serve
