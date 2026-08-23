# Adapter: React Native

How the extracted spec becomes React Native code. Read [`core.md`](core.md) first — it holds
the Figma truths this file assumes. [`SKILL.md`](SKILL.md) is the ordered workflow; this file
is step 3 (BUILD) plus the RN-specific parts of step 4 (RENDER & COMPARE).

Every concrete name below comes from `figma-kit.config.json`: the spacing ramp reference from
`tokens.spacing.refTemplate`, the text component from `tokens.typography.component`, the
theme accessor from `components.themeAccessor`, the barrel from `components.index`.

---

## Spacing & layout

**Spacing is a quality gate, not a nicety.** Review every vertical and horizontal gap
deliberately — sloppy spacing is the most visible fidelity miss there is.

### `gap` on the parent, never `margin` on the child

Separate siblings with `gap` / `rowGap` / `columnGap` **on the parent**. Never a `margin*` on
a child. One parent gap is a single source of truth; RN margins do **not** collapse, so they
double up, and they scatter the spacing contract across every child that has to remember its
own offset. `padding` is a container's *inner* inset; `gap` is the space *between* its
children. Margin is only for deliberate overlap and negative offsets.

### Map Figma auto-layout 1:1

| Figma | React Native |
| --- | --- |
| `VERTICAL` + `itemSpacing N` | `rowGap: <ramp ref for N>` |
| `HORIZONTAL` + `itemSpacing N` | `columnGap: <ramp ref for N>` |
| `pad[T R B L]` | `paddingTop/Right/Bottom/Left` |
| primary-axis alignment | `justifyContent` |
| counter-axis alignment | `alignItems` |

The extractor prints one `<layoutMode> gap=N … pad[T… R… B… L…]` line per auto-layout frame,
with the ramp reference already resolved. Reproduce it; never eyeball it. Reference the ramp, never a bare number, and never a
legacy module listed in `tokens.spacing.banned` — those satisfy "no literals" while silently
drifting from the Figma value.

### Off-grid triage

The extractor ends with two tallies. They mean different things:

- **`⚠ OFF-GRID … in YOUR layout`** — actionable. Triage each one:
  - A **large fixed gap** (say 196) is almost always a Figma space-between layout that got
    baked into a number. Use `justifyContent: 'space-between'`, not a token.
  - A **sub-pixel value** (say 8.75) is a scaling artifact. Snap to the nearest ramp step.
  - A **genuine recurring new step** — add it to the ramp (one line) after a quick design
    check. Do this rarely; a ramp that grows on every screen is not a ramp.
- **`ℹ off-ramp … INSIDE component instances`** — informational. That geometry is owned by
  the component, not authored in the layout you are porting. **Never reproduce a component
  instance's internal spacing.** Use the component and let it apply its own. The reason to
  skip it is *ownership*, not grid alignment — which is why on-ramp internal values are
  equally not yours to set.

### Never fake a gutter

`width: '48%'` + `justifyContent: 'space-between'` (or any `%` widths) is not a gutter. The
gap drifts with screen width and breaks the moment the child count changes. A fixed Figma
gutter is a real `columnGap` / `rowGap` with `flex: 1` children. For a grid, chunk items into
rows and pad an odd last cell with an empty `flex: 1` spacer so it stays the right width.

## Theming

Read colors and radii through `components.themeAccessor` so the component flips modes
automatically. A raw hex, or a mode-agnostic palette step chosen because it matched the
current mode's value, is a component that looks correct in review and breaks in the other
mode.

## Structure & states

- **Replicate the exact node STRUCTURE, not just the pixels.** A floating label belongs
  *inside* the box; a checkbox is a box plus an SVG tick; a switch is a track plus an
  animated knob. Two implementations can measure identically and behave nothing alike.
- **Handle every state from the matrix** — default, pressed, disabled, focused, error,
  selected, and whatever else the variant axes list. State colors come from the component's
  own token set (`…Pressed`, `…Disabled`, and so on), **never** from ad-hoc opacity applied
  to the default color.

## Icons & graphics

Exact SVG from the pipeline. Never approximate a glyph, never substitute a similar one.

```bash
node scripts/figma-icon.js  1234:5678=icon-name    # small, recolorable, single-color
node scripts/figma-asset.js 1234:5678=hero-art     # big / multicolor  (--mono for large single-color)
```

- **Small recolorable icons → the runtime registry** (`paths.iconRegistry`), rendered through
  the project's `<Icon name size color>` component. The exporter normalizes hex **and the
  named colors** in `icons.extraNamedColors` to `currentColor`, so the glyph recolors via the
  `color` prop — an un-normalized `white` fill ships invisible on a light background.
- **Big or multicolor art → a `.svg` file** in `paths.graphicsDir`, imported as a build-time
  component via `react-native-svg-transformer`. **Do not put big art in the icon registry**:
  the registry is parsed at runtime and bloats the bundle. The split is bundle size versus
  runtime parse cost, and it matters at real illustration sizes.
- **Figma "Subtract" boolean masking** — e.g. a headline with a hole revealing a subject
  behind it — becomes a `react-native-svg` `<Mask>` (white glyphs minus a black shape) over a
  token-filled `<Rect>`. **For RTL and complex scripts, fall back to native `<Text>`:**
  `react-native-svg` text shaping and bidi are unreliable, worst on Android.
- **The capability boundary:** `react-native-svg` cannot render filters/blur, SMIL animation,
  `<foreignObject>`, or full CSS. If render-and-compare shows a graphic broken, export it as
  PNG/WebP instead (`figma-render.js --format png`). Never hand-draw the difference.

## Text

- **Every text node goes through the project's text component** (`tokens.typography.component`)
  with the extractor's suggested variant and weight — **use them verbatim**. Set color via a
  token. Never a raw `<Text>` with hand-typed numbers.
- **Never invent font metrics.** `fontSize`, `fontFamily`, line height and tracking come from
  the generated ramp (`tokens.typography.rampPath`, regenerated by `commands.tokensBuild`
  straight from the design system's text styles). If the extractor prints
  `⚠ no DS text style at Npx`, flag it to design and pick the nearest ramp variant — do not
  hardcode a size. A deliberately bespoke display face is the only exception, and it gets a
  comment saying why it is off-ramp.
- **Honour `tokens.typography.forbiddenProps`.** Those are props this project has decided
  nobody hand-sets on design-system text, and `tokens.typography.forbiddenReason` says why.
  When you skip one, print the reason so the next reader does not "fix" it back. (Typical
  entries: a metric already emitted by the ramp, or a property that broke rendering with the
  project's font.)
- **Vertically center text with the container, not the line height.** In a fixed-height row
  or cell use `height` + `justifyContent`/`alignItems: 'center'`. A `lineHeight` tuned to
  match the box centers the text at exactly one font size and silently breaks at every other
  — and it overrides the ramp value the variant was supposed to carry.

## Full-bleed screens & responsive scaling

- **Artboard scaling, NOT `resizeMode="cover"`.** For full-bleed art, place everything on the
  Figma frame's coordinates scaled by `screenWidth / design.frameWidth`: size the background
  `<Image>` explicitly to `width × (design.frameHeight · scale)` at `top: 0`, and position
  overlays at `figmaY · scale`. A full-bleed `<Image resizeMode="cover">` renders
  **unpredictably on device** — subject scaled up, shoved off-screen — even when the asset's
  aspect ratio is correct. Do not rely on it.
- **Scale `fontSize` AND all SVG/mask geometry by the same `screenWidth / design.frameWidth`**
  so type fills the same proportion of the screen on every device and masks stay aligned with
  what they mask.
- **Render-compare at every width in `design.compareWidths`** to catch responsiveness and
  mask drift before shipping.

## Native modules cost the user a rebuild

Fonts load at runtime — no native rebuild. **Every new native module does not:** it costs a
prebuild plus a rebuild that the user has to run, and it is a permanent addition to the
project's native surface. Prefer capabilities of libraries that are already installed
(gradients and masks from `react-native-svg`, for instance) over adding a dependency for one
screen. When adding one is genuinely unavoidable, say so explicitly and state what the user
must run.

## The device is the final word

For anything the platform renders natively — SVG text (especially RTL), image scaling, fonts,
blur and platform glass effects — **only a real device build settles it.** A token-driven HTML
preview screenshotted in headless Chrome is a useful, cheap proxy for geometry and color, and
`figma-pixel.js` makes it measurable, but it does not predict native rendering. Confirm on the
dev build before calling it done.

---

## Writing an adapter for another framework

An adapter is short. It has to answer exactly these questions for its framework, and nothing
else — everything framework-independent belongs in `core.md`:

1. **Layout primitive mapping.** How does Figma auto-layout translate? Which direction,
   spacing, and alignment properties correspond to `layoutMode`, `itemSpacing`, padding, and
   the two alignment axes?
2. **Spacing mechanism.** Is there a real gap primitive, or does spacing have to be expressed
   some other way? Say which mechanism is authoritative and which ones are forbidden, and why
   — the failure mode ("margins do not collapse here") is the useful part, not the rule.
3. **Theming accessor.** How does a component read a mode-aware value, and what is the
   specific way this framework lets a mode-agnostic value leak in and break the other mode?
4. **SVG / asset strategy.** What renders vector natively, what does not (filters, animation,
   embedded HTML, CSS), where is the size threshold between an inline/runtime icon and a
   build-time asset, and what is the fallback when the vector cannot render?
5. **Text component and metrics policy.** How is text written, where do metrics come from,
   which properties must never be hand-set, and how is text vertically centered without
   abusing line height?
6. **Scaling model.** How does a design drawn on one artboard width adapt — what scales, what
   is fixed, and which built-in "fit" mode is untrustworthy?
7. **Cost of adding a dependency.** Does a new package require a rebuild, a native step, or a
   config change the user must run? Say so, so the agent prefers what is installed.
8. **What only a real device or browser can confirm.** Name the specific things a preview
   cannot predict, so the agent knows when the cheap proxy is not enough.
