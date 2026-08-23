# `figma-kit.config.json` reference

One file holds everything that differs between projects. The scripts are identical everywhere;
onboarding a project is filling this in, not editing code.

Fields are documented in the order they appear in `figma-kit.config.example.json`. Each one is tagged
with **how you get the value**, because that is the part nobody writes down:

| Tag | Meaning |
|---|---|
| **[from Figma URL]** | Copy it out of a Figma link. Thirty seconds, no judgement. |
| **[AI can scan the repo]** | An agent reading your codebase will find this faster and more accurately than you will remember it. |
| **[empirical — run an extract]** | You cannot know it until you run the extractor against the real file and look. |
| **[human judgement]** | A decision somebody has to make. No tool can derive it; a wrong guess here is worse than an empty field. |
| **[convention]** | The built-in default is almost always right. Change it only to match an existing project layout. |

---

## How the file is loaded

Resolution order, first match wins:

1. `$FIGMA_CONFIG` — an explicit path. Useful when the scripts live outside the project; the
   config's directory becomes the project root, so relative paths still resolve correctly.
2. `figma-kit.config.json`, searched upward from the current directory to the filesystem root.
3. Built-in defaults, so a fresh repo still runs.

Mechanics worth knowing:

- **A missing config is not an error.** Every field has a default and every feature degrades to a
  one-line warning rather than a crash. With no config at all the extractor still works as a plain
  extractor — you just pass `--file` per call and get no token suggestions.
- Your file is **deep-merged** onto the defaults, so you only write what differs. **Arrays replace
  wholesale** — there is no array merging, which means listing one entry in `icons.extraNamedColors`
  drops the defaults rather than adding to them.
- Lines beginning with `//` are stripped before parsing, so the annotated example file is valid
  input. (Sibling `"// field"` string keys are also harmless — they parse as ordinary unused keys.)
- Every path is resolved against the project root — the directory holding `figma-kit.config.json`.
  Absolute paths are passed through untouched.

---

## `files`

Which Figma files this project reads.

| Field | Type | Required | How you get it |
|---|---|---|---|
| `files.default` | string | **Yes**, unless every call passes `--file` | **[from Figma URL]** |
| `files.screens` | string \| null | Optional | **[from Figma URL]** |
| `files.volatile` | string[] | Optional | **[human judgement]** |

**`files.default`** — the design-system library: components, variants, variables, text styles.
Used by `figma-extract`, `figma-render`, `figma-icon`, `figma-asset` and `build-typography` unless
overridden. The key is the URL segment after `/design/` (older links: `/file/`):

```
https://www.figma.com/design/EXAMPLEFILEKEY123456/Product-Design-System?node-id=1234-5678
                             └────── files.default ──────┘
```

Omitted: nothing breaks up front, but every script call must pass `--file <key>` or it exits with
a message naming the slot it wanted.

**`files.screens`** — the product/screens file, when the org splits library from screens (most do).
`figma-text` reads this slot by default, because copy lives in screens while the library's text is
placeholder. Every script takes `--screens` to switch slots.

Omitted: the slot silently falls back to `files.default`, which is exactly right for a single-file
setup.

**`files.volatile`** — the slot names (`"screens"`, `"default"`) whose files get **republished
wholesale** rather than edited in place. Republishing renumbers every node id in the file, silently.
Ask the designer whether a new version of the file is an edit or a replacement. This field changes
no script behaviour; it is a standing warning to the agent (and to you) not to trust a node id
written down in a ticket for that file.

---

## `auth`

Where the Figma personal access token comes from. **[convention]** — leave both alone unless the
project already has a different convention.

| Field | Type | Default | Notes |
|---|---|---|---|
| `auth.envVar` | string | `FIGMA_ACCESS_TOKEN` | Checked in the environment first; always wins. |
| `auth.envFile` | string | `.env.local` | Fallback, resolved against the project root. |

The env-var-first order is what makes CI work without writing a secret to disk. The file parser
tolerates spacing around `=` and strips one layer of surrounding quotes. **Whatever file you name
here must be gitignored.**

Missing token: scripts that need it print how to create one (Figma → Settings → Security →
Personal access tokens) and exit. Read-only access is sufficient — nothing in the kit writes to
Figma.

---

## `design`

The frame your mocks are drawn on and how you verify against it.

| Field | Type | Required | How you get it |
|---|---|---|---|
| `design.frameWidth` | number \| null | Optional | **[empirical — run an extract]** |
| `design.frameHeight` | number \| null | Optional | **[empirical — run an extract]** |
| `design.compareWidths` | number[] | Optional | **[human judgement]** |
| `design.modes` | string[] | Optional | **[human judgement]** |

**`frameWidth` / `frameHeight`** — extract any screen frame and read the size off the first line;
do not assume a device spec sheet matches what the designer actually drew. `frameWidth` is the
default for `figma-pixel --design`, which scales design-space coordinates up to render-space pixels.
Omitted: `--design` must be passed explicitly, or coordinates are treated as raw PNG pixels.

**`compareWidths`** — the widths you hold yourself to during visual compare. Fidelity is
width-dependent: a layout that matches at the design width can wrap or clip at a wider one, so list
the narrow and wide extremes you actually support. `figma-render` prints them as a reminder after
saving. Omitted: no reminder, nothing else changes.

**`modes`** — your theme modes, as the *app* names them. Printed alongside `compareWidths` so the
compare covers each. These are the modes you verify in; `variables.sources` separately decides the
mode keys in generated tokens. Keep them consistent.

---

## `paths`

Where generated artifacts land, all relative to the project root. Every one is **[AI can scan the
repo]** when the project already has these directories, **[convention]** when you are creating them.

| Field | Type | Default | What happens when omitted |
|---|---|---|---|
| `paths.tokensDir` | string \| null | `null` | Both token builds refuse to run — they have nowhere to write. |
| `paths.variablesExport` | string | `figma-variables` | Searched **recursively** for export files; Figma exports into subfolders. |
| `paths.iconRegistry` | string \| null | `null` | `figma-icon` needs `--out` per call. |
| `paths.graphicsDir` | string \| null | `null` | `figma-asset` needs `--out` per call. |
| `paths.renderDir` | string | `/tmp/figma-renders` | Renders are scratch files; keeping them out of the repo is the point. |
| `paths.fontSources` | string | `font-sources` | Pristine fonts — input to the font-metrics patcher. Keep the originals; the patcher is not reversible. |
| `paths.fontsOut` | string \| null | `null` | Where patched fonts are written. Only relevant if you patch metrics. |

---

## `tokens.index`

The modules the extractor indexes so it can suggest a **code reference** for a value it finds in
Figma. **[AI can scan the repo]** — this is the single highest-value field to get right, and the
one most likely to rot when a directory moves.

Type: array of entries, each either

```jsonc
{ "path": "<module path>", "exports": ["exportName"] }                    // export name = ref prefix
{ "path": "<module path>", "exports": { "exportName": "refPrefix" } }     // explicit prefix
{ "path": "<module path>", "nested": [
    { "export": "themes", "perMode": true, "pick": ["components"] } ] }   // index inside a wrapper
```

`nested` with `perMode: true` handles the common shape where generated tokens are wrapped in an
object keyed by theme mode: it indexes one mode's contents but suggests the reference *without* the
mode key, because that is how the code reads it through the theme accessor.

**This is the FALLBACK, not the primary path.** For a value that is bound to a Figma variable, the
extractor resolves the token **exactly**, by id, from
`<paths.tokensDir>/variable-map.generated.json` — written by the token build, no configuration and
no `tokens.index` required. Those print `✓exact` and there is nothing to choose between.

Value matching covers what exact resolution cannot: values that are **not** bound (a `⚠LITERAL`
hardcoded in Figma — the case where you most want to know which token it *should* have been), and
bound values whose variable is missing from your export. Matching by value ties — `#FFFFFF` can be
three tokens — so treat a suggestion without `✓exact` as a shortlist, not a verdict.

Omitted or wrong: `[warn] could not index …` and value matching switches off. Exact resolution is
unaffected, because it does not go through this index at all.

---

## The variable map

Not a config field — a generated file, listed here because it decides how the extractor's token
suggestions read. `build-tokens.js` writes `variable-map.generated.json` into `paths.tokensDir`,
mapping each Figma variable id to the code reference that token became. `figma-extract.js` reads it
from that same fixed location.

Nothing to configure beyond `paths.tokensDir`. What you *do* need is an export that is current: a
variable added to the design after your last export has no entry, and the extractor calls that out
inline and tallies it at the end (`bound to a variable missing from your export`) instead of quietly
picking a wrong token. When you see that tally, re-export the variables and re-run the token build.

Missing entirely — no token build yet, `paths.tokensDir` unset, or an export whose plugin dropped
the variable ids — costs one `[warn]` and falls back to value matching.

---

## `tokens.spacing`

| Field | Type | Default | How you get it |
|---|---|---|---|
| `tokenizedInFigma` | boolean | `false` | **[empirical — run an extract]** |
| `rampPath` | string \| null | `null` | **[AI can scan the repo]** |
| `rampExport` | string | `space` | **[AI can scan the repo]** |
| `refTemplate` | string | `space[{n}]` | **[AI can scan the repo]** |
| `banned` | string[] | `[]` | **[human judgement]** |

**`tokenizedInFigma`** decides which world you are in, and it is a fact about the design file, not
a preference. Extract a component and look at what comes back for gap/padding:

- **`false`** — the design system does not bind variables to gap/padding, so those values can never
  report as bound and the ramp is **code-owned**. Each gap/padding value is checked against your
  ramp: on-ramp values get a code reference, off-ramp values are flagged `⚠OFF-GRID` with the
  nearest step and summarised at the end. This is the common case and a perfectly healthy one.
- **`true`** — your system does bind them. Gap/padding then get the same bound/literal treatment as
  every other styled value.

Guessing wrong is loud in both directions: set it `true` on an untokenized system and every gap
reads as a hardcoded literal; set it `false` on a tokenized one and you get off-grid noise about
values the design system already blessed.

**`refTemplate`** is how one ramp step is written in your code; `{n}` is replaced by the step. Match
the codebase's real syntax — the suggestion is meant to be pasted.

**`banned`** lists legacy or deprecated spacing modules that must not be used for fidelity work.
Only you know which module is the dead one.

Omitted `rampPath`: `[warn] no tokens.spacing.rampPath configured — off-grid spacing checks are
off.` Extraction continues; gap/padding print as plain numbers.

---

## `tokens.typography`

| Field | Type | Default | How you get it |
|---|---|---|---|
| `rampPath` | string \| null | `null` | **[AI can scan the repo]** |
| `rampExport` | string | `textStyles` | **[AI can scan the repo]** |
| `component` | string \| null | `null` | **[AI can scan the repo]** |
| `suggestionTemplate` | string | `<{component} variant={variant} weight={weight}>` | **[AI can scan the repo]** |
| `forbiddenProps` | string[] | `[]` | **[human judgement]** |
| `forbiddenReason` | string | `""` | **[human judgement]** |

**`rampPath` / `rampExport`** point at the generated text ramp. The extractor matches a Figma text
node's size and line height against it and suggests the matching variant, so the agent writes a
ramp reference instead of a font size. Omitted: `[warn] no tokens.typography.rampPath configured —
text-style suggestions are off.`

**`component`** is your design system's text component; `null` means the project uses a plain text
element and the suggestion is rendered accordingly. **`suggestionTemplate`** is the exact snippet
form — `{component}`, `{variant}` and `{weight}` are substituted. Make it look like real code from
your repo, including the framework's prop syntax.

**`forbiddenProps`** is the list of props your project refuses to let anyone hand-set on design
system text, and **`forbiddenReason`** is the sentence the agent is shown when it is about to. Start
**empty**. Add an entry only after a real rendering problem forces the rule — for example, a project
might forbid hand-setting a line height because its generated ramp is tuned to patched font metrics
and overriding it reintroduces clipping. A forbidden list invented up front is just friction with no
evidence behind it, and the reason string is what stops the rule from being deleted by the next
person who finds it inconvenient.

---

## `components`

The code side of the design system.

| Field | Type | Default | How you get it |
|---|---|---|---|
| `index` | string \| null | `null` | **[AI can scan the repo]** |
| `prefix` | string | `""` | **[AI can scan the repo]** |
| `themeAccessor` | string \| null | `null` | **[AI can scan the repo]** |
| `instanceMap` | object | `{}` | **[human judgement]** |
| `showcase` | string \| null | `null` | **[AI can scan the repo]** |
| `codeConnect.enabled` | boolean | `false` | **[human judgement]** |
| `codeConnect.glob` | string \| null | `null` | **[convention]** |
| `codeConnect.parseCommand` | string \| null | `null` | **[AI can scan the repo]** |

**`index`** — the barrel the agent reads *before* building anything, so reuse beats reinvention.
This is the field that prevents a fifth button component. Omitted: the skill cannot enforce reuse
and the agent builds from scratch by default.

**`prefix`** — the naming convention for design system components, used to recognise and to name
new ones consistently.

**`themeAccessor`** — the mode-aware accessor every component calls to read tokens, written exactly
as it is called in code (for example, a project might configure a hook named `useTokens()`). The
skill uses it to insist that mode-flipping values are read through the theme rather than pinned to a
mode-agnostic constant — the single most common cause of a dark mode that silently breaks.

**`instanceMap`** — Figma instance name → your component name, for the cases where the two
genuinely differ. Only a human knows that the thing Figma calls one name is the component your
codebase calls another.

**`showcase`** — a living showcase or storybook screen where new components get registered, so a
new variant is visible without hunting for a route.

**`codeConnect`** — set `enabled: true` only if the project actually publishes Code Connect
mappings; `parseCommand` is verified by `config-check.js`, so a stale command is caught rather than
silently skipped. Note that Code Connect *publishing* requires a paid Figma plan tier.

---

## `icons`

| Field | Type | Default | How you get it |
|---|---|---|---|
| `extraNamedColors` | string[] | `["white", "black"]` | **[empirical]** |
| `rtlMirrored` | string[] | `[]` | **[human judgement]** |

**`extraNamedColors`** — CSS color *keywords* Figma emits that must be rewritten to `currentColor`.
Hex is always handled; keywords are not, and a white glyph exported with a keyword fill ships white
and vanishes on a light background. Add a keyword when you see one survive an export. Remember
arrays replace: listing your own drops the defaults, so include them.

**`rtlMirrored`** — icons that flip under right-to-left layout. Directional arrows and chevrons
usually do; a media transport glyph or a logo usually does not. This is a UX decision per glyph, not
something to infer from the artwork.

---

## `text`

Noise filtering for copy extraction. **[human judgement]**, and locale-specific.

| Field | Type | Default | Notes |
|---|---|---|---|
| `noiseWords` | string[] | `["Title", "Subtitle", "Label", "text"]` | Exact placeholder strings to drop. Add your locale's equivalents. |
| `noisePatterns` | string[] | `[]` | Regex **sources** as strings — pure numbers, currency formats, dates. An unparseable pattern is reported and skipped, never fatal. |
| `rtl` | boolean | `false` | Sort columns right-to-left within a row. |

Only one filter is built in — the status-bar clock, which is a screenshot artifact in every mobile
file in every language. Everything else is yours, because "noise" depends entirely on how your
library labels placeholders.

**`rtl`** matters more than it looks: reading order is top→bottom, then start→end, and "start" is
the right-hand side in an RTL frame. Left with the default, an RTL screen is extracted backwards
while claiming to be in reading order. `--rtl` overrides per call; for a mixed-direction file, run
it once per direction over the relevant sections.

---

## `variables`

How the Figma variables export maps onto generated token modules. **[empirical]** — run the export
once, list the filenames and the top-level keys inside, then fill this in. You cannot know these
before seeing real output, and inventing them produces a build that reports everything as unrouted.

| Field | Type | Default | Notes |
|---|---|---|---|
| `sources` | `[{ match, role }]` | `[]` | `match` is a regex **source string**, tested case-insensitively against each export file's basename. `role` is `"primitives"` or `"mode:<name>"`. |
| `groups` | object | `{}` | Top-level (or dotted) group path → `palette` \| `radius` \| `ramp:<mode>` \| `semantic` \| `components` \| `ignore`. |
| `ignoreKeys` | string[] | `[]` | Stray keys anywhere in the export to skip entirely. |

Figma writes **one file per mode** (a mode is a column in the variables table). The mode names in
`"mode:<name>"` are **yours** — whatever you write becomes the key in the generated themes object,
so name them after your app's modes rather than after whatever the export happens to call them, and
keep them consistent with `design.modes`.

In `groups`, a bare name matches at the top level or directly under a group that is itself routed;
spell out a dotted path (`"Parent.Child"`) for anything deeper, because component groups reuse
generic child names constantly. The most specific rule wins, so you can route a parent one way and
one of its children another.

Anything unrouted is **reported, never guessed at** — it is either a config gap or something the
library just added, and both want a human. Omitted entirely: `build-tokens.js` has nothing to do and
says so.

---

## `typographySource`

Text styles are **not variables**, so they never appear in the export and are fetched from the REST
API instead.

| Field | Type | Default | How you get it |
|---|---|---|---|
| `prefixes` | string[] | `[]` | **[empirical]** |
| `order` | string[] | `[]` | **[human judgement]** |
| `faceFixes` | object | `{}` | **[empirical]** |

**`prefixes`** — the style-name prefixes to read, in priority order. The **first is the base**: it
drives the metrics and the base face map. Every later prefix contributes **face overrides only** —
just the slots whose face differs from the base — which is how a second script or locale with
diverging weights is expressed without duplicating the ramp. Read the real names off the file (a
library might organise them as, for example, `Type/Body/Regular`, giving a prefix of `"Type/"`).
Omitted: the build has nothing to select and exits.

**`order`** — the display order of categories in the generated file. Source order is arbitrary; put
them in ramp order so the generated file reads like the type scale it is.

**`faceFixes`** — corrections for known Figma *authoring* bugs, keyed `"<prefix><category>/<slot>"`.
Every correction is logged loudly on purpose: a silent fix here becomes an invisible divergence
between the library and the app. Fix it in Figma too, then delete the entry. Note that an irregular
face-per-slot is usually **not** a bug — a "bold" slot legitimately bound to a medium-weight face is
common and is captured verbatim. Only add a fix for something design agrees is wrong.

---

## `commands`

**[AI can scan the repo]** — quote them exactly as the project manifest writes them.

| Field | Type | Default | Notes |
|---|---|---|---|
| `commands.tokensBuild` | string \| null | `null` | Your wrapper for the token builds. |
| `commands.validate` | string \| null | `null` | The full gate: typecheck + lint + tests. |

These are the commands the skill tells the agent to run, and `config-check.js` verifies they
resolve — which is the only thing standing between you and a skill that confidently recommends a
command that was renamed six months ago. Use whichever package manager the project actually uses.

---

## `gotchas`

**[human judgement]**, and empty on day one. Free-form strings; the extractor prints them under
`## Known gotchas for this library` at the end of every run.

This is the per-project ledger of incidents: a component whose Figma name does not match its code
name, a variant axis your code deliberately ignores, a hole in a token set, a layer hidden in the
file but shipped in the app. One line each, added the moment you hit them. The value is the timing —
they are delivered at the exact moment somebody is reading a spec out of this library, which is when
that knowledge is worth something, instead of being re-derived next quarter by the next person.

---

## What is required, and what unlocks what

| Field | Effect if missing |
|---|---|
| **`files.default`** | **Required to run** — or pass `--file` on every call. |
| **`auth.*` (a working token)** | **Required to run.** Everything is a Figma API call. |
| `files.screens` | Falls back to `files.default`. Fine for single-file setups. |
| `files.volatile` | No behaviour change; the agent loses the "these ids renumber" warning. |
| `design.frameWidth` | `figma-pixel --design` needs the width passed explicitly. |
| `design.compareWidths` / `modes` | No compare reminder after a render. |
| `paths.tokensDir` | **Both token builds cannot run**, and there is nowhere to read the variable map from — so token resolution is never exact. |
| `paths.iconRegistry` / `graphicsDir` | `figma-icon` / `figma-asset` need `--out` per call. |
| **`tokens.index`** | → **value-matched** token suggestions, the fallback for unbound values. Without it, unbound values print unmapped; exact resolution still works. |
| **`tokens.spacing.rampPath`** | → **spacing suggestions + off-grid detection.** |
| `tokens.spacing.tokenizedInFigma` | Wrong value = false literals, or false off-grid noise. |
| **`tokens.typography.rampPath`** | → **text variant suggestions.** |
| `tokens.typography.forbiddenProps` | → the skill's guard against hand-set text props. |
| **`variables.sources` / `groups`** | → **the token build.** Nothing generates without them. |
| **`typographySource.prefixes`** | → **the typography build.** |
| **`components.index`** | → **reuse enforcement in the skill.** Without it the agent rebuilds what exists. |
| `components.themeAccessor` | → the skill's mode-awareness rule. |
| `components.instanceMap` | Name mismatches are not translated. |
| `icons.extraNamedColors` | Keyword-colored icons keep a hard fill and can ship invisible. |
| `icons.rtlMirrored` | Directional icons do not flip under RTL. |
| `text.*` | Copy extraction includes placeholder noise, and RTL frames read backwards. |
| `commands.*` | The skill cannot name the build/validate step; `config-check` cannot verify it. |
| `gotchas` | No per-library reminders at extract time. |

Nothing in the second half of that table is fatal. Each missing field switches one feature off with
a `[warn]` line and the rest of the pipeline keeps working — which is deliberate, so you can adopt
the kit in an afternoon and deepen the config as you learn the file.

---

## Minimal working config

This is enough to extract, render and pixel-measure — the whole fidelity loop, minus the
suggestions that map Figma onto your specific codebase:

```json
{
  "files": { "default": "EXAMPLEFILEKEY123456" },
  "auth": { "envVar": "FIGMA_ACCESS_TOKEN", "envFile": ".env.local" }
}
```

```bash
node scripts/figma-extract.js 1234:5678      # spec + bound/literal flags + full state matrix
node scripts/figma-render.js  1234:5678      # ground-truth PNG
```

Start here on day one. Add `tokens.index` when you want suggestions, `variables.*` when the export
lands, and `components.*` when you point an agent at it. Run `node scripts/config-check.js` after
each addition — it tells you what you just switched on, and what is still off.
