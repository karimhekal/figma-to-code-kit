# Universal Figma truths

Everything here is true of **any** Figma file, on any plan, in any framework. Most of it was
learned by shipping something wrong first. Read this before the framework adapter; the
adapter assumes you know it.

Companion files: [`SKILL.md`](SKILL.md) (the ordered workflow) and
`adapter-<framework>.md` (e.g. [`adapter-react-native.md`](adapter-react-native.md)).

---

## 1. Extract, never guess

A model looking at a rendered design is guessing at numbers it could have *read*. The REST
API returns the exact geometry, the exact paints, which properties are bound to variables,
and every variant axis. A 13px gap guessed as 12 is invisible in review and obvious in QA.

```bash
node scripts/figma-extract.js 1234:5678
```

Guessing is also expensive in the other direction: dumping the raw node JSON at a model is
enormous and mostly noise. The extractor exists to make the spec small enough to reason
about — trust its printout and its suggestions rather than re-deriving them by hand.

## 2. Finding the node when all you have is a URL

Figma URLs frequently carry no `node-id` at all. Navigate the file instead of hunting in the
UI:

1. `GET /v1/files/{key}?depth=2` → the page list, then each page's top-level sections.
2. Grep the section names for the flow you want.
3. Drill one section: `GET /v1/files/{key}/nodes?ids=<id>&depth=2`.
4. **Sort children by `absoluteBoundingBox.x`** to get screens in left-to-right order — the
   order in `children` is z-order/creation order, not reading order.

## 3. The component state matrix is an enumerable contract

A component set carries `componentPropertyDefinitions`: every VARIANT axis with all its
options, plus BOOLEAN, TEXT and INSTANCE_SWAP props. The extractor prints this first.

Treat it as the definition of done: **every state and every prop gets implemented, and
mapped in Code Connect.** The failure mode is systematic — the frame on screen shows one
variant, so one variant gets built, and the other eight surface as bugs later.

## 4. `✓bound` versus `⚠LITERAL` — code the intent, flag the literal

- `✓bound` means the property is bound to a Figma variable. That is the design's *intent*;
  reference the corresponding token.
- `⚠LITERAL` means the value is hardcoded in the Figma file. Sometimes deliberate. Often an
  **authoring bug** — a radius typed by hand that nobody meant, a color pasted instead of
  picked. Verify with design, then reference the *intended* token in code. Copying a literal
  into code launders a design bug into the product.

**The binding check needs no Enterprise plan.** `boundVariables` ships on the ordinary nodes
endpoint on every plan. The Variables API that resolves a variable's *name* is
Organization/Enterprise-only — which is why the extractor suggests the code reference by
matching the **resolved value** against your generated token modules. That means suggestions
can tie when two tokens share a value: prefer the one scoped to the component over a
mode-agnostic palette step (see `SKILL.md` step 2).

## 5. Instances get overridden — the bound value is the truth, the name is a hint

An `[INSTANCE]` keeps the source component's variant label even after the designer has
overridden its fill, text, radius, padding, gap or size away from that variant's defaults.
A row labelled `Style=Tinted` can be five axes away from the tinted variant.

So before mapping an instance to a code component, extract the source component too and
compare **bound values**, not labels. Mapping on the label alone ships the wrong thing while
every name in the diff looks right.

## 6. Reading paints correctly

Three ways the "color" of a shape is not what the first line of the extract says:

- **A `BOOLEAN_OPERATION` paints with its OWN fill. Its children's fills are dead data.**
  The extractor prints the whole subtree, so a boolean op looks like it has two or three
  colors. Only the top node's fill renders. This is a real trap when the children bind a
  different variable than the parent — and the two can even differ per mode. Render the node
  and sample it to settle it.
- **A shape can carry MULTIPLE fills, and they COMPOSITE.** The extractor prints every paint
  as `fills[N]`, listed bottom→top (`fills[0]` is the bottom). No single paint is "the
  color" — read the whole stack. A white base plus a translucent ink wash is a different
  color from white, and in another mode the same stack can composite to exactly the
  background and disappear. That may well be the design; verify before "fixing" it.
- **Image fills: render the NODE, never the raw `imageRef`.** `figma-render.js <node>
  --format png` gives the image as Figma crops, scales and positions it. The `imageRef` from
  the images endpoint is the original upload — a different aspect and crop — and will land
  misplaced. Composite separate layers at their Figma offsets if you need them apart.

## 7. What the extract does not tell you

- **Extracts include HIDDEN layers.** A node tree lists things that do not render. Render
  the PNG and *look at it* before building anything from a tree.
- **Layer and instance names lie.** Icon instance names survive a swap: a layer named for
  one glyph routinely contains another. Identify a glyph **visually** — crop the render —
  never by its layer name. The same applies to any name-based inference.
- **Instance-swap component properties expose their default component's node id.** That is
  the reliable way to find the node id of an icon used inside a component: read it off the
  INSTANCE_SWAP prop's default value rather than hunting the icon page.

## 8. The stale-id protocol (for republished files)

Some Figma files are **republished wholesale** rather than edited in place — typically the
product/screens file, where each delivery re-imports every section. When that happens
**every node id in the file renumbers**. `files.volatile` in `figma.config.json` names which
of this project's files are that kind. Assume the generation has moved since anything was
written down.

- **Never trust a node id older than the file's `lastModified`** (`GET /v1/files/:key` at
  depth 1 is cheap). Ids stored in tickets, docs, or a previous session's notes are usually
  a generation stale.
- **Re-list the page and grep names** before extracting. Names survive republishing; ids do
  not.
- The **comments API** (`GET /v1/files/:key/comments`) pins what the designer changed and
  when — the cheapest way to find which section moved and why.
- **Deleted nodes are recoverable:** `GET /v1/files/:key/versions`, then fetch the node at
  the version a comment was pinned on.
- **A 429 can masquerade as "Node not found."** The scripts retry (`scripts/figma-net.js`),
  but if a node comes back missing on a file that was recently republished, treat it as
  **renumbered**, not deleted, and re-list.

## 9. Extraction economy

Extraction tokens are a real budget. The dominant waste is fully extracting near-identical
screens.

**Spot the clones first.** Sign-up by email versus by phone differ by one field; two OTP
screens differ by copy and an icon. Fully extract the **one** canonical screen, note the
diff in a sentence, and build a single parameterized component. Extracting each clone in
full produces the same component three times and three chances to diverge.

Other economies: pass `--depth` when you only need the outer frame's geometry; extract the
component set once instead of each variant; let the extractor's suggestions stand rather
than re-deriving a token by hand.

## 10. Networking, tokens and rate limits

- The Figma API is rate-limited per minute, and its images endpoint can return **HTTP 200
  with an `{ err: "Render timeout" }` body**. `scripts/figma-net.js` retries transport
  timeouts and 5xx, and `figma-render.js` retries the 200-with-error case, so a manual
  re-run loop is not your job. If a call still fails after retries, the API is genuinely
  unavailable — say so rather than working around it.
- `figma-net.js` also owns the **one** access-token loader, tolerant of spacing and
  surrounding quotes in the env file. Never re-derive token loading in a new script: the
  classic failure is one script tolerating a quoted value and the next shipping the quotes
  verbatim, so the same env file authenticates from one script and 403s from another.

## 11. Code Connect requires an Organization/Enterprise plan to publish

Mappings **parse** on any plan, so writing them is never wasted — they validate locally and
queue for whenever the plan allows. Only `publish` is gated. If publishing errors on plan,
that is expected: keep the mapping, keep the parse gate green, and move on.
