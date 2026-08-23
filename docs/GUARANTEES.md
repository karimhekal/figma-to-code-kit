# What this checks, and how strongly

Every developer implementing a design carries the same short list: use the real values, reference
tokens instead of hardcoding, get the spacing right, reuse what already exists, stay inside the
design system, build every state, don't break the other theme. Everyone agrees with that list. It
still gets missed constantly — not through carelessness, but because the checks that normally catch
it all run *after* the code is written (a visual-regression diff, a lint rule, a reviewer's eye),
and none of them can tell you what the design actually said.

This kit works on the other side of that line: it puts the design's real numbers in front of
whoever is writing the code, and makes disagreement visible afterwards.

This page maps each concern to what handles it, at one of three strengths:

| | Meaning |
|---|---|
| **Mechanical** | A script produces the fact or the flag. It does not depend on anyone remembering. |
| **Instructed** | The skill tells the agent, with the data to comply in front of it — nothing forces it. |
| **Wired by you** | A command exits non-zero, but you put it in CI. The kit ships no CI of its own. |

Read that middle row carefully, because most of this page lives there. Most steps still end in an
agent choosing to use data that is exact and present. What changes is not that the work is done more
carefully — it is that **a wrong choice becomes visible** instead of invisible in someone's memory.

---

## 1. Use the real values, never an estimate

**Mechanical.** `figma-extract` reads the node from Figma's API and prints size, auto-layout gap and
padding, corner radius, stroke weight and colour, every fill, and full text metrics. The numbers are
read, not inferred from an image.

**Catches:** the 13px gap that becomes 12. The radius rounded to "about 8". The font size nobody
checked because the label looked right.

**Where it stops:** the extractor supplies the numbers; something still has to use them. That is
instructed, and step 4 is what verifies it happened.

## 2. Reference the token, never the literal

**Mechanical detection, instructed application.** Every styled **colour, radius and stroke** is
flagged `✓bound` (Figma has a variable bound to this property) or `⚠LITERAL` (hardcoded in the design
file). Text metrics carry no binding flag — Figma text styles are not variables — and gap/padding
only carry one when `tokens.spacing.tokenizedInFigma` is true.

For a bound value the extractor prints the code reference to use:

```
fill=#3A2FF0 ✓bound  ⇒ token: components.checkbox.color.on ✓exact
```

`✓exact` means resolved by the variable's **id**, not by matching its colour. That is the difference
between an answer and a shortlist: three tokens can all be `#FFFFFF`, and value matching cannot tell
you which the designer meant. Id matching can, and it needs no Enterprise plan — the id is in the
ordinary node response and in your variables export, and `build-tokens` joins them.

The cost of dodging the Enterprise API: the export is **a file a designer drops in by hand, one per
mode**. Nothing re-exports it for you. Rule 10 can tell you the file changed; it cannot tell you the
file is old.

**Catches:** the hardcoded hex that looks perfect in light mode and breaks on theme switch. The
"close enough" token picked because two colours matched by eye.

**The inverse matters as much:** a `⚠LITERAL` is *reported, not silently copied*. A hardcoded value
in Figma is often an authoring mistake, so it goes back to the designer rather than being faithfully
reproduced in code.

## 3. Get the spacing right

**Mechanical detection, instructed application.** Every auto-layout frame's gap and padding is
checked against your spacing ramp. On-ramp **gap** prints the reference to use (`⇒ space[8]`);
padding is checked but prints as a bare number, flagged only when it is off-ramp. Off-ramp values
are tallied at the end in two lists — the split is what makes them usable:

- **spacing you authored** — actionable. Snap it, or extend the ramp deliberately.
- **spacing inside a component instance** — informational. The component owns it; reproducing it by
  hand is the bug.

**Catches:** the gutter faked with `width: 48%` that drifts on every screen size. The sub-pixel
`8.75` that is a scaling artifact. The large fixed gap that was really a space-between layout.

**Configure honestly:** `tokens.spacing.tokenizedInFigma` says whether your design system binds
variables to spacing. Most do not — a normal choice, and it means gap can never come back `✓bound`.
Extract one component and look before setting it.

## 4. Prove it looks right — don't assume

**Mechanical tools, instructed process.** `figma-render` pulls the design's own rendering as a PNG.
`figma-pixel` reads exact colours and content positions out of any PNG — including a screenshot of
your build — so a comparison is two sets of numbers rather than two impressions.

**Know what this is: a probe, not a diff.** You sample points and rows *you choose*. It confirms or
refutes a suspicion; it does not surface one. (The per-pixel image diff is `figma-drift`, and that
runs over a handful of baselined components, not over today's work.)

**Catches:** errors the numbers alone cannot show — a wrong variant, a mispositioned icon, a colour
that composited differently than expected, a 2px size error invisible to the eye.

**Three traps you have to carry:**

- Taking the screenshot of your build is **not automated**. You run `xcrun simctl io booted
  screenshot`, `adb exec-out screencap`, or a headless browser yourself.
- Sampled values are **composited** — a semi-transparent token never reads back as its own value.
- `--row` assumes dark ink on a light ground, so **dark-mode renders need `--invert`** or the reading
  silently inverts into nonsense.

Read both images with `--design` so they compare in design points and the device's pixel scale stops
mattering.

## 5. Reuse what already exists

**Instructed, with the data supplied.** Before building anything the skill has the agent scan your
component index — and the extractor prints each node's Figma type, so a component instance reads
`• Toast [INSTANCE]`. That name is the component to reach for; `components.instanceMap` translates
when the design's name and your code's name differ.

Then the rule that saves the most rework: **an instance's bound values are the truth; its variant
label is only a hint.** A designer can override an instance's fill, radius, padding or size while the
label still says `Style=Tinted`. Mapping it on the strength of that label ships the wrong thing.

**Honest limit:** nothing *prevents* hand-rolling a view. The component list is in front of the agent
and the instruction is explicit — that is all. Component names can also lie: one library tested had a
component called "Radio Button" that was actually a tick icon. Keying the map on Figma's stable
component id instead of its name is a known open improvement.

## 6. Build every state, not the one on screen

**Mechanical listing, instructed compliance.** For a component set the extractor prints
`COMPONENT PROPERTIES` first: every variant axis with all its options, plus every boolean, text and
instance-swap property. The complete list is on screen before you start.

**Counting the built states against it is still on you.** Nothing in the kit diffs the matrix against
your code. If you enable Code Connect, `components.codeConnect.parseCommand` is the command the skill
tells the agent to run — but **no script in this kit runs it**, and a parse only proves the mapping
file is valid. A component with nine variants and four mappings parses green.

**Catches:** the component with nine states where four got built — *if someone reads the list*.

## 7. Stay inside the design system's typography

**Mechanical suggestion, instructed compliance.** Text metrics are matched against your generated
type ramp, and the extractor prints the DS variant to reference alongside the raw metrics — the ramp
entry is what you reach for, the numbers are there to check it against. When a text node matches no
ramp entry it says so explicitly — *confirm with design (do NOT invent; use a DS variant)* — instead
of quietly emitting a font size.

`tokens.typography.forbiddenProps` lets a project name the props nobody may hand-set, with the reason
recorded beside it in the config the agent reads at the start of every task. Start it empty; add a
prop only after a real rendering problem forces the rule.

## 8. Keep every theme working

**Instructed, with a mechanical payoff.** Nothing checks that your component themes correctly. What
per-mode token generation gives you is this: *if* every value references a token, both modes come
free — and if one value does not, exactly one mode breaks. Theme correctness is rule 2's compliance,
measured by rule 4's comparison in each mode.

**A trap the kit knows about:** when a component-scoped token and a global palette token share a
value in one mode, picking the palette one silently breaks the other mode. Prefer the token scoped to
the component. Exact id resolution (rule 2) removes most of this class outright.

## 9. Icons and graphics exactly, never approximated

**Mechanical, for attribute paints.** `figma-icon` and `figma-asset` pull the real SVG from Figma.
`fill=`/`stroke=` attributes carrying a hex or the keywords `white`/`black` become `currentColor`;
`width`/`height` are stripped from the root tag so a size prop controls dimensions; `viewBox`
survives so each icon keeps its own grid.

**What is not rewritten:** paints written as inline CSS (`style="fill:#fff"`) or as `rgb()`/`hsl()`.
Check the emitted SVG once per icon source — an invisible white glyph on a light background is
exactly the failure this is meant to prevent. Multi-colour icons cannot collapse to one
`currentColor` at all; route those through `figma-asset`.

**Instructed, not detected:** the registry-versus-file split is a rule in the framework adapter, not
a size check. Nothing stops you registering a hero illustration as an icon.

## 10. Keep it true after today

**Mechanical detection; you schedule it.** The design in your repo is a copy, and a copy goes stale
silently — the build stays green while shipping last month's values. `figma-drift` checks three
things nothing else does: that the design file has not been edited since your baselines were
captured, that your generated tokens were built from the export currently on disk, and that your
canonical components still render the way they did when you last agreed with them.

**Catches:** the colour a designer changed six weeks ago that reached nobody.

**Two real limits.** The kit ships the detector, not the schedule — there is no workflow file here,
and a plain run **reports drift and still exits 0**, so a carelessly wired cron job is green forever.
Use `--fail-on-drift`. And it only watches the components you baselined (a handful, by design);
anything outside that set drifts silently and indefinitely.

---

## What this does not cover at all

The list at the top of this page is about *fidelity to a design file*. It is not the whole job, and
this kit is silent on several things a developer implementing a screen genuinely worries about:

- **Accessibility.** Nothing here checks contrast ratios, tap-target sizes, dynamic-type scaling,
  focus order, or screen-reader labelling. `figma-pixel` samples composited RGB and could compute a
  contrast ratio; it does not. Treat accessibility as entirely outside this kit today.
- **Responsive behaviour.** The kit compares against a fixed design frame. Rendering at two widths is
  a manual habit the skill suggests, not a check.
- **Interaction and animation.** Static renders only. Transitions, gestures, timing curves and
  pressed-state feedback are invisible to every tool here.
- **Loading, empty and error states.** Only states drawn in the design file as variants are
  enumerated. States nobody drew are states nobody catches.
- **Overflow and long content.** Nothing tests what happens with a 60-character name, a translated
  string twice the length, or dynamic type at maximum.
- **Performance.** No bundle-size, render-cost or re-render checks.

## What limits everything above

- **A weak design system caps the whole page.** If values are not bound to variables in Figma, rules
  2 and 8 have nothing to work with. Run the health check in [SETUP.md](SETUP.md) first — it turns
  "is this a real design system" into a two-minute measurement.
- **The visual comparison depends on someone doing it.** The tools make it cheap and precise. They do
  not make it automatic, and a skipped comparison guarantees nothing.
- **One framework is written.** The React Native adapter is the only one, and the one in production
  use. Others need writing — the guide is at the end of that adapter.

## The short version

Most of this list is normally enforced by a developer's memory and a reviewer's attention. Here it is
*surfaced* by a script printing a flag, and — once you wire them up — by a config or drift check
exiting non-zero in CI. Printing is not enforcing. But a flag you have to deliberately look away from
is a different kind of failure than a rule nobody wrote down.
