---
name: figma-to-code
description: Implement, align, or review any UI component or screen against its Figma source at exact fidelity. Use whenever a task involves building an element from a design, aligning existing code to a design, reviewing a component against Figma, or when given a Figma node id or URL. Enforces reading the real spec (geometry, variable bindings, the full state matrix) instead of guessing, referencing design tokens instead of literals, and rendering-and-comparing before calling it done.
---

# Figma → code (exact-fidelity workflow)

**Goal:** the built UI matches the design exactly, every value that Figma bound to a
variable is referenced through the corresponding **token** (never a literal), and the
result is reusable and mode-aware across every mode the project ships.

This file is the spine — the ordered Definition of Done. The knowledge lives in two
companions:

- **[`core.md`](core.md)** — universal Figma truths. **Always read it**; it is true of any
  Figma file and it is where the expensive mistakes are documented.
- **`adapter-<framework>.md`** — the framework rules. Read the one matching this project
  (e.g. [`adapter-react-native.md`](adapter-react-native.md)). If none matches, read the
  React Native adapter's closing section, which says what an adapter must answer.

## Step −1: read the config. It is the project's source of truth for every concrete name.

Nothing project-specific is written in this skill on purpose — prose goes stale silently and
cannot be validated. `figma.config.json` at the project root holds every concrete value, and
`node scripts/config-check.js` validates it against the repo.

```bash
cat figma.config.json
# or, fully merged with defaults:
node -e "console.log(JSON.stringify(require('./scripts/figma-config').loadConfig(), null, 2))"
```

Fields you will need on almost every task:

| Field | What it tells you |
| --- | --- |
| `files.default` / `files.screens` | which Figma file to extract from (`--screens` selects the second slot) |
| `files.volatile` | which files are republished wholesale, so their node ids renumber — see the stale-id protocol in `core.md` |
| `design.frameWidth` / `frameHeight` | the artboard the mocks are drawn on (the scaling basis) |
| `design.compareWidths` | the widths to render-compare at |
| `design.modes` | every mode the component must be verified in |
| `components.index` | the barrel to scan **before building anything** |
| `components.prefix` | the naming convention for components |
| `components.instanceMap` | Figma instance name → code component, where the names differ |
| `components.themeAccessor` | how a component reads mode-aware values |
| `components.showcase` | where a new component gets registered |
| `components.codeConnect` | whether Code Connect mappings are expected, and how to parse them |
| `tokens.index` | the token modules the extractor suggests references from |
| `tokens.spacing.*` | the spacing ramp, its code reference template, and any banned legacy modules |
| `tokens.typography.*` | the text ramp, the text component, and props the project forbids hand-setting |
| `commands.validate` / `commands.tokensBuild` | the real commands to run — never guess a package manager |
| `gotchas` | incidents this library has already cost someone (the extractor prints them too) |

## Definition of done — do ALL of these, in order

### 0. REUSE — look it up before you build it

Custom-building something that already exists is a defect, every time. Check both sides:

1. **Code:** scan the barrel at `components.index`. If a primitive fits, compose it. Never
   hand-roll a raw view/text element for something the design system already ships.
2. **Figma:** the element is almost always a component instance — the extractor prints
   `[INSTANCE] <name>` in the node tree. That name is the component to reach for; translate
   it through `components.instanceMap` when the design's name and the code's name differ.
3. **Verify the instance's BOUND VALUES against the component's tokens.** An instance keeps
   its variant label (`Style=…`) even when the designer has overridden fill, text, radius,
   padding, gap or size away from that variant's defaults. Extract the design-system
   component itself and compare. **The bound value is the truth; the variant name is only a
   hint.** If they diverge, decide consciously between: (a) it is a *different* variant,
   (b) the code token is *stale* versus the design system — fix the token, which fixes the
   whole app, or (c) it is a genuine *bespoke* one-off — build a small dedicated component
   and document what it is plus its Figma node id.

Only build something new when nothing maps, or when it maps only after overrides (case c).
When you do, say so explicitly.

### 1. EXTRACT the real spec — never guess

```bash
node scripts/figma-extract.js 1234:5678            # add --screens for the product file
```

You get every node's size, auto-layout (gap/padding), radius, stroke, **every** fill, and
text style — each annotated `✓bound` / `⚠LITERAL` with a suggested code reference.

**The state matrix is the contract.** For a component set the extractor prints
`COMPONENT PROPERTIES (states & props)` first: every variant axis with all its options, plus
boolean / text / instance-swap props. Implement **every** state and **every** prop — in code
and in the Code Connect mapping. Shipping the subset that happened to be on screen is the
single most common way a component comes back from review.

### 2. BIND — every value becomes its token

- Every `✓bound` value → reference the **suggested token**. Never hardcode the literal.
- Every `⚠LITERAL` value → **verify intent before copying it**. A literal is hardcoded in
  Figma, which is often an authoring bug (a hand-typed radius nobody meant) and sometimes a
  deliberate one-off. Flag the suspicious ones to design and reference the *intended* token
  in code. The flag says "ask", not "wrong".
- **Prefer the component's OWN token set over a palette token that matched only by value.**
  The extractor suggests by resolved value, so two tokens can tie. Palette tokens are usually
  mode-agnostic: picking one that happens to equal the current mode's value silently breaks
  the other mode. When two tokens share a value, take the one scoped to the component.
- Spacing follows `tokens.spacing`: when `tokenizedInFigma` is false the ramp is code-owned,
  so gap/padding can never come back `✓bound` — the extractor suggests the ramp reference
  instead. Never satisfy the "no literals" rule by reaching for a legacy module listed in
  `tokens.spacing.banned`; those drift from the Figma value.

### 3. BUILD on tokens

Follow the framework adapter. Everything about layout primitives, spacing mechanics,
theming, icons, text and asset strategy lives there, because all of it is framework-specific.

### 4. RENDER & COMPARE — never skip

```bash
node scripts/figma-render.js 1234:5678
node scripts/figma-pixel.js <render.png> --design <design.frameWidth> --row 388
```

Open the PNG and diff it against the build — shape, sizing, icon, spacing — **in every mode
in `design.modes`**, and at every width in `design.compareWidths`.

- **Measure, don't eyeball.** Eyeballing a PNG is where wrong colors and wrong positions slip
  through (a "blue" that is actually a neutral wash; an icon you think is centered but is
  pinned). `figma-pixel.js` samples the composited RGB at a point, or prints the content runs
  on a row so you can find an icon's x, a label's centre, an edge inset. Confirm the sampled
  RGB equals the token you used. On a dark-mode render pass `--invert`, since content there is
  brighter than the background rather than darker. This is also how a mis-mapped instance
  (step 0, case c) surfaces: a fill that does not equal the component's token is an override.
- **This is the cheap proxy when launching the real build is expensive — do it.** Never skip
  the visual compare because the app is heavy to run.
- **Audit every gap.** Walk each sibling gap and container padding against the Figma
  `itemSpacing`/padding — both axes, both modes. Confirm pinned footers and CTAs share the
  content's horizontal inset; a footer inset that differs from the content's by one ramp step
  misaligns an edge by exactly that many pixels. Mismatched gaps are the most common
  fidelity defect after missing states.

### 5. GATE

1. If `components.codeConnect.enabled`, write the mapping at `components.codeConnect.glob`
   and run `components.codeConnect.parseCommand` — green. Map Figma variant props to code
   props with aligned names, covering the whole matrix from step 1.
2. Run `commands.validate` — green.
3. Register the component in `components.showcase`.

## If the config is missing or wrong

Run `node scripts/config-check.js`, read what it reports, and **fix the config**. Never
hard-code around it — a value written into a component or into this skill is a value no
script can validate and no future project can reuse. If a field the task needs genuinely
does not exist yet, add it to `figma.config.json` and say that you did.
