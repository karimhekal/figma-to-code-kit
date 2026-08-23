# Setting up the kit in a new project

An ordered walkthrough: from an empty project to one component built at full fidelity and a
config you can trust. Budget an hour the first time, most of it waiting on a designer for the
variables export.

**Prerequisites**

- Node 18+ (the scripts use global `fetch`; there is no polyfill and no transpile step).
- A Figma account with *view* access to the files you are porting. No paid seat is required for
  the core loop — see [step 5](#5-design-system-health-check) for what a lower plan costs you.
- `pngjs`, the kit's only runtime dependency, and only for `figma-pixel.js`.
- Optional, only if you also patch font metrics: Python 3 with `fonttools`.

---

## 1. Install

Copy two directories into the project. The scripts are byte-identical in every project that uses
the kit — everything that differs lives in one config file — so copying (or vendoring as a
submodule) is the whole install story.

```bash
cp -r figma-to-code-kit/scripts  your-project/scripts
cp -r figma-to-code-kit/skills   your-project/.claude/skills

cd your-project
npm install pngjs        # or: yarn add pngjs / pnpm add pngjs
```

If you would rather not vendor the scripts, clone the kit *alongside* the project and point it at
your config instead:

```bash
FIGMA_CONFIG=/abs/path/to/your-project/figma.config.json \
  node /abs/path/to/figma-to-code-kit/scripts/figma-extract.js 1234:5678
```

`$FIGMA_CONFIG` also fixes the project root, so every relative path in the config still resolves
against your project and not against the kit checkout.

The skill in `skills/figma-to-code/` is written for Claude Code but is plain Markdown — any agent
that can read files can follow it. Put it wherever your agent looks for instructions.

---

## 2. Credentials

Mint a **personal access token**:

> Figma → your avatar → **Settings** → **Security** → **Personal access tokens** → *Generate new
> token*

Two things worth knowing before you pick scopes:

- The token is **per user**, not per team. It carries exactly your access — if you cannot open a
  file in the browser, the token cannot read it either. That is also why a token minted by a
  contractor stops working the day their seat is removed.
- **Read-only scopes are enough.** The kit only ever reads: file nodes, file styles, and the
  images endpoint. Nothing in it writes to Figma. Granting write scopes buys you nothing and turns
  a leaked token into an incident.

Put it in the project's env file and make sure that file is ignored:

```bash
echo 'FIGMA_ACCESS_TOKEN=<your-token>' >> .env.local
grep -q '^\.env\.local$' .gitignore || echo '.env.local' >> .gitignore
git check-ignore -v .env.local        # prints the matching rule — silence means it is NOT ignored
```

No quotes are needed around the value, and quotes are tolerated if you add them anyway. An
exported `FIGMA_ACCESS_TOKEN` in the environment always wins over the file, which is how you run
this in CI without writing a secret to disk.

---

## 3. File keys, and which files are volatile

A Figma file key is the segment after `/design/` (older links say `/file/`) in the URL:

```
https://www.figma.com/design/EXAMPLEFILEKEY123456/Product-Design-System?node-id=1234-5678
                             └────────┬────────┘                                └───┬───┘
                                  file key                                       node id
```

Most organisations split their work across at least two files, and the kit models exactly that:

- **`files.default`** — the design-system library: components, variants, variables, text styles.
  This is what `figma-extract`, `figma-icon`, `figma-asset` and `build-typography` read by default.
- **`files.screens`** — the product/screens file, where flows are assembled from library
  instances. `figma-text` reads this one by default (copy lives in screens; the library's text is
  placeholder). Every script accepts `--screens` to switch slots and `--file <key>` to override
  both.

If your team keeps everything in one file, set `files.default` and leave `screens` null — the slot
falls back to `default` automatically.

**Now the judgement call: which files are `volatile`.** A file is volatile when it gets
*republished wholesale* — duplicated, regenerated from a template, or re-imported — rather than
edited in place. Republishing renumbers every node id in the file. Nothing warns you; ids you
wrote down last month simply resolve to *Node not found*, or worse, to a different node.

In practice the screens file is volatile in most orgs (designers duplicate a page per release) and
the component library is not. Ask the designer: *"when you ship a new version of this file, do you
edit it or replace it?"* List the volatile slot names in `files.volatile`. Nothing enforces this —
it exists so the skill tells the agent to re-derive ids from a fresh link instead of trusting a
stale one written in a ticket.

---

## 4. Write `figma.config.json`

```bash
cp figma-to-code-kit/figma.config.example.json figma.config.json
```

The example is annotated with `//`-prefixed sibling keys; the loader strips `//` comment lines, so
you can keep or delete them.

### Don't fill it by hand — run a discovery pass

Half the config is facts about your repo (where the token modules are, what the theme accessor is
called, what the validate command is) and half is facts about your Figma file (does it bind
spacing, what are the mode names). Both halves are things an agent can go and *look up* faster and
more accurately than you can remember them. Point one at the repo with this prompt:

```
Fill in a draft `figma.config.json` for this repo using the schema in
`figma.config.example.json`. Work in two passes and do not guess — every value must
come from something you actually read.

PASS 1 — scan the repository:
  1. Find the mode-aware theme accessor the UI uses to read design tokens (the hook,
     context or singleton every component calls). Report its exact call form.
  2. Find the GENERATED design-token modules — files produced by a token build, not
     hand-written constants. For each: its path relative to the repo root, the names it
     exports, and whether any export is a per-mode wrapper (an object keyed by theme
     mode with the real token groups nested inside).
  3. Find the spacing ramp and the typography ramp: path, export name, and the exact
     syntax the codebase uses to reference one step of each.
  4. Find the shared-component barrel/index the team imports UI primitives from, the
     naming prefix (if any), and a living showcase/storybook screen if one exists.
  5. Find the project's real commands for (a) rebuilding tokens and (b) running the
     full validation gate (typecheck + lint + tests). Quote them exactly as written in
     the project manifest.
  6. Note any legacy/deprecated spacing or color module that new code must NOT use.

PASS 2 — probe the Figma file (key: <FILE_KEY>) with the kit's extractor. Pick 3–4
CORE components — a button, an input, a list row or card, and one component set with
several variants — and run:
     node scripts/figma-extract.js <nodeId>
  Then report, with the evidence you read it from:
  (a) Is spacing bound to Figma variables in this design system? Look at whether
      gap/padding values come back marked bound, or only colors and radii do.
  (b) What are the variable MODE names, exactly as they appear in the filenames of the
      variables export in the configured export directory (list the filenames too), and
      what are the top-level groups inside each file?
  (c) What proportion of styled values come back bound to a variable versus flagged as
      an unbound literal? Give the counts per component and the overall ratio.

OUTPUT: the draft `figma.config.json`, plus a short report of what you could not
determine. LEAVE THESE FIELDS EMPTY for a human — do not invent them:
`files.volatile`, `tokens.typography.forbiddenProps`, `icons.rtlMirrored`, `gotchas`.
```

### Then fill in the judgement fields yourself

These four cannot be derived from either the repo or the Figma file, because they encode a
decision somebody made:

| Field | The question it answers |
|---|---|
| `files.volatile` | Which files get republished wholesale, so their node ids cannot be trusted (see step 3). |
| `tokens.typography.forbiddenProps` | Which text props your project refuses to let anyone hand-set, and **why** — the reason string is shown to the agent. Start empty. Add a prop only after a real rendering problem forces the rule; a forbidden list invented up front just makes the agent argue with you. |
| `icons.rtlMirrored` | Which icons flip under right-to-left layout. Directional arrows and chevrons usually do; a "next track" media glyph usually does not; a logo never does. This is a UX call, not something to auto-detect from the shape. |
| `gotchas` | Empty on day one. One line per surprise, added as you hit them (step 8). |

---

## 5. Design-system health check

**Do this before you write any code against the file.** Run the extractor on the core components
from pass 2 and read one number.

```bash
node scripts/figma-extract.js 1234:5678
```

Every styled value in the printout carries a flag:

- `✓bound` — the property is bound to a Figma variable. The design *intends* a token, and the
  extractor suggests the code reference by matching the resolved value against your generated
  token modules.
- `⚠LITERAL` — the value is hardcoded in the Figma file. Sometimes deliberate; more often a
  hand-typed number nobody meant. The end of the run summarises them:
  `⚠ N UNBOUND styled value(s) — verify these are intentional`.

Compare the count in that summary against the number of `✓bound` values in the tree above it.
Roughly:

| Bound ratio | What it means | What to do |
|---|---|---|
| High — most colors, radii and text styles bound | The design system is real. The pipeline will work as designed. | Proceed. |
| Mixed — colors bound, radii and one-offs literal | Normal for a system mid-migration. | Proceed, but expect to ask design about each literal. Log the recurring ones in `gotchas`. |
| Low — most values literal | The file *looks* like a design system but is painted with raw values. | **Stop and raise it with the design team.** |

That last row is worth being blunt about, because it is the failure mode this whole kit exists to
surface early. When values are not bound:

- The extractor has nothing to suggest, so every value becomes a question for a designer, one at a
  time, forever.
- Dark mode (or any second theme) cannot be derived — there is no variable to carry a second
  value, so somebody hand-maintains a parallel set of hex codes.
- `build-tokens.js` produces a thin, patchy token set, because the export only contains variables
  that exist.
- Every downstream step degrades in the same direction: the agent guesses, review catches some of
  it, QA catches the rest.

None of that is fixable in code. "A well-defined design system" usually gets asserted; this makes
it **measurable**, in about two minutes, before anyone commits to a delivery date.

Two caveats on reading the ratio:

- **Spacing is a special case.** Many design systems never bind variables to gap/padding — the
  ramp is code-owned. That is a normal, healthy choice and it means gap can *never* come back
  bound. Set `tokens.spacing.tokenizedInFigma` from what you actually observed in pass 2; when
  it is `false`, the extractor checks gap/padding against your code ramp and flags `⚠OFF-GRID`
  instead.
- **Variable *names* need an Enterprise plan.** The kit detects *that* a property is bound (from
  `boundVariables` on the ordinary nodes endpoint, available on every plan) and suggests the token
  by matching values. It cannot read the variable's name, because the Variables REST API is
  Enterprise-only. So a tie between two tokens that share a value is possible — the suggestion is
  a shortlist, not a verdict.

---

## 6. Token pipeline

### 6a. Get the variables export

Figma's Variables REST API is **Enterprise-only** (403 on every other plan), so this step is
deliberately manual and works for everyone:

1. A designer exports the file's variables — either the editor's own variables export, or one of
   the community export plugins that emits the W3C DTCG shape. Figma writes **one file per mode**
   (a mode is a column in the variables table).
2. Drop the exported files into the directory named by `paths.variablesExport` (default
   `figma-variables/`). Subfolders are fine — the loader searches recursively.
3. Commit them. The export is now a reviewable artifact: the next export's diff is exactly what
   design changed.

### 6b. Map the export onto generated files

Look at what you actually got, then write `variables.sources` and `variables.groups`:

```bash
ls -R figma-variables                                   # the filenames drive `sources`
node -e "console.log(Object.keys(require('./figma-variables/<one-file>.json')).join('\n'))"
                                                        # the top-level groups drive `groups`
```

- **`sources`** matches each filename to a role: exactly one `"primitives"` entry (the
  mode-independent file) plus one `"mode:<name>"` per theme mode. The mode names are *yours* —
  whatever you write after `mode:` becomes the key in the generated themes object, so name them
  after your app's modes, not after whatever the export happens to call them.
- **`groups`** routes each top-level group to a destination: `palette`, `radius`, `ramp:<mode>`,
  `semantic`, `components`, or `ignore`. Use a dotted path (`"Parent.Child"`) when a nested group
  needs a different destination from its parent; the most specific rule wins.

### 6c. Build

```bash
node scripts/build-tokens.js
```

It writes `palette.generated.ts` and `themes.generated.ts` into `paths.tokensDir`, then prints a
summary and — importantly — a list of anything it could not route:

```
[build-tokens] N group(s) in the export have no destination:
```

**Nothing is ever guessed at.** An unrouted group is either a hole in your config or something the
library just added, and both deserve a human. Add each to `variables.groups` (or `ignoreKeys`) and
re-run until that warning is gone. Also read the broken-alias and circular-alias reports: those are
defects *in the Figma file*, and they belong back with design rather than being papered over.

### 6d. Text styles are a second, separate build

Figma text styles are **not variables**. They live somewhere else entirely and are completely
absent from the variables export — re-exporting will never make them appear. They come from the
REST API instead:

```bash
node scripts/build-typography.js
```

Set `typographySource.prefixes` first (the style-name prefixes to read, first one is the base that
drives metrics and faces) and `typographySource.order` (the display order of categories). This
writes `typography.generated.ts` into the same tokens directory.

If the generated ramp looks right in Figma and **clipped** in your app, do not inflate the line
heights — that quietly abandons the type ramp. The cause is the font declaring a taller line box
than it draws; `scripts/patch-font-metrics.py` (Python 3 + `fonttools`) rewrites a font's vertical
metrics to its measured ink box. That step is optional and only relevant to runtimes that size
lines from font metrics.

Finally, point `commands.tokensBuild` at whatever wrapper your project exposes for these, so the
skill can tell the agent to re-run it after a token change.

---

## 7. Validate the config

```bash
node scripts/config-check.js
```

It checks the config against reality: that configured paths exist, that token modules load and
export what you claimed, that the commands resolve, that the file keys and credentials work. Run
it until it is green, and run it again whenever the repo moves a directory — a config that has
quietly rotted is worse than no config, because the extractor's suggestions silently stop
appearing and nobody notices they were ever there.

Every failure it reports is a feature switching off, not a crash: the scripts degrade gracefully
by design. `[warn] could not index …` means you lose token suggestions, not that extraction stops.

---

## 8. Pilot one component, end to end

Do not roll the kit out across a backlog before one component has been through the whole loop.
Pick something with real variants — a button or an input, not a divider — and run the skill's
Definition of Done:

1. **Reuse** — check the component barrel first. The best implementation is the one that already
   exists.
2. **Extract** — `node scripts/figma-extract.js <nodeId>`. Read the **COMPONENT PROPERTIES** block
   at the top: it enumerates every variant axis and every prop. That list *is* the definition of
   done. Implement all of it, not the state that happens to be on screen.
3. **Bind** — reference the suggested tokens. Never copy a value the extractor flagged `✓bound`;
   never copy a `⚠LITERAL` without asking design whether it was meant.
4. **Build** — against the spec, in your framework's adapter rules.
5. **Render and compare** — `node scripts/figma-render.js <nodeId>` for the ground truth, then
   screenshot your build at the same width and diff. Do this in **every mode** in `design.modes`
   and at every width in `design.compareWidths`. When "it looks right" is doing the work, measure
   instead: `node scripts/figma-pixel.js <png> --row <y>` turns an impression into numbers.
6. **Gate** — run `commands.validate`.

Then do the part everyone skips: **write down what surprised you** in `gotchas`. A component whose
Figma name does not match its code name, a variant axis your code deliberately ignores, a hole in
a token set, a layer that is hidden in the file but shipped in the app. Each entry is one line, and
the extractor prints them back at the exact moment somebody is next reading a spec out of this
library — which is when that knowledge is worth something and not before.

---

## Troubleshooting

**`Node not found / not exportable` — and the id is definitely right.**
Two very different causes, and they are easy to confuse:

- *Rate limiting.* Figma limits per token. Several scripts running at once, or one script over
  many nodes, trips a 429, and an un-retried 429 surfaces as a bogus "not found". The scripts
  retry 429 with backoff and honour `Retry-After`, so this should be rare — but if you are running
  parallel sessions against one token, serialise them and try again in a minute.
- *The file was republished.* Every node id in a republished file is renumbered. The fix is never
  to hunt for the old id: open the current file, copy a fresh node id from the URL, and add that
  file's slot to `files.volatile` so the next person knows not to trust a written-down id. If the
  ids in your tickets and docs are all dead at once, this is why.

**Node ids from a URL use `-`, the API uses `:`.** Both forms are accepted everywhere; only the
first hyphen is swapped, so instance ids survive intact. Not a bug you need to work around.

**Render fails or hangs.** The images endpoint can answer `200` with `{ err: "Render timeout" }` —
not an HTTP error, so it is retried separately (four attempts with backoff). If it still fails, the
node is too heavy to render at that scale: drop `--scale`, or render a smaller subtree instead of
the whole page.

**No token suggestions in the extract output.** Look for `[warn]` lines at the top of the run:
`could not index …`, `no export named …`, `no tokens.spacing.rampPath configured`. Every one means
a path or export name in `tokens.index` / `tokens.spacing` / `tokens.typography` does not match the
repo any more. `node scripts/config-check.js` names the exact mismatch. Extraction keeps working
without them — you just lose the half of the value that maps Figma to *your* code.

**The extract lists layers I cannot see in the design.** The API returns **hidden layers**, and a
component set contains every variant, most of them invisible in any given frame. This is a feature
when you are enumerating states and a trap when you are reading a screen. Cross-check with
`figma-render.js` — the render shows what actually paints.

**A color I sampled doesn't match the token I used.** Sampled pixels are *composited*. A
semi-transparent token only equals its own value in isolation; over a background it reads back as
the blend. Compare like with like — sample the Figma render and your build's screenshot at the same
point.

**`--row` readings look like nonsense on a dark-mode render.** `figma-pixel --row` is
contrast-directional and assumes dark ink on a light background by default. Pass `--invert` for
dark renders. For a low-contrast pair, sample a background pixel and a content pixel first, then
set `--thresh` between them.

**`figma-pixel` refuses to start.** It needs `pngjs` — the kit's only runtime dependency. Install
it in the project.

**403 from one script, success from another, same token.** Historically caused by an env file whose
value carried quotes; the single shared loader now strips one layer of quotes and tolerates spacing
around `=`. If it persists, the token genuinely lacks access to *that file* — remember the token
carries your personal access, so check you can open the file in a browser.

**"Why can't the pipeline read variable names / fetch the export itself?"** The Variables REST API
is Enterprise-only. On every other plan it answers 403. That is why the export is a manual drop and
why token suggestions are matched by *value* instead of by name. It is a plan limit, not a missing
feature — and it is a good reason to also point the official Figma MCP server at the same file when
you specifically need a variable's name.
