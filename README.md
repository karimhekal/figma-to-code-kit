# figma-to-code-kit

**Extract, don't generate.** A set of scripts and an AI-agent skill for implementing Figma designs at high fidelity — in any codebase, with any design system.

Instead of asking a model to *generate* code from a design, this kit *extracts* the design's exact spec — geometry, variable bindings, the full component state matrix — into a compact printout, then hands that to your coding agent along with rules about your codebase. The agent writes code against facts rather than impressions.

```bash
node scripts/figma-extract.js 1234:5678     # exact spec + ✓bound/⚠LITERAL flags + state matrix
node scripts/figma-render.js  1234:5678     # ground-truth PNG to diff against your build
node scripts/figma-pixel.js   render.png --row 388   # measure, don't eyeball
```

---

## The problem

Design-to-code assistants fail in three predictable ways, and none of them are model-intelligence problems:

1. **The model guesses at values it could have read.** A 13px gap becomes 12. A radius becomes "rounded". Nobody notices until QA.
2. **Hardcoded values ship instead of tokens.** The design *has* a variable bound to that color, but the model saw `#3A2FF0` and wrote `#3A2FF0`. Dark mode breaks silently.
3. **Only the states you can see get built.** A component has nine variants; the model implements the default one, because that's the one in the frame.

All three are solvable by reading the Figma file properly — the REST API exposes exact geometry, which properties are bound to variables, and every variant axis. This kit reads those, digests them **outside** the model's context window, and gives the agent a spec small enough to reason about.

## Why not just use the Figma MCP server?

Use both — they're good at different things. But if you're picking one backbone for fidelity work, here's the honest comparison as of August 2026:

| | This kit (REST) | Official Figma MCP |
|---|---|---|
| **Bound vs literal** | `boundVariables` on the nodes endpoint → every value flagged ✓bound or ⚠LITERAL | No bound-vs-literal concept in any tool contract |
| **Variant/state matrix** | `componentPropertyDefinitions` — every axis and prop enumerated | No extraction tool for it |
| **Context cost** | A full component-set extract measured **~3k tokens** | A documented `get_design_context` response hit **351k tokens** against a 25k client cap ([issue](https://github.com/Kilo-Org/kilocode/issues/2378)) |
| **Output framework** | Framework-agnostic data; your adapter maps it | Always React + Tailwind — [`clientFrameworks` doesn't change it](https://developers.figma.com/docs/figma-mcp-server/server-returning-web-code) |
| **Visual verification** | Images endpoint at scale 0.01–4× → pixel-diff loop | `get_screenshot` has no documented scale or fidelity contract |
| **Headless / CI** | Personal access token, fully scriptable | Remote server is OAuth-only; PATs rejected, no CI story |
| **Rate limits** | 10–20 requests/**minute** | 200–600 tool calls/**day** on Dev/Full seats |
| **Variable *names*** | Resolved **exactly** — `boundVariables` gives the variable id, the variables export gives the same id, `build-tokens` joins them into a map. No Enterprise plan, no value guessing. Needs an export on disk | ✅ `get_variable_defs` needs nothing but the file — the better answer when you have no export |
| **Component reuse** | Config-driven instance→component map | ✅ Code Connect integration is genuinely better ([Figma's eval](https://www.figma.com/blog/the-benefits-of-code-connect-in-mcp/): −29.5% tokens, −19.6% task time) |
| **Maintenance** | You own ~1.5k lines of scripts | Figma maintains it |

**The short version:** the MCP is closer to a specification viewer with a code-generation front-end. It wins on Code Connect, and on variable names when you have no variables export to join against. It loses on everything the fidelity loop actually depends on — binding detection, state enumeration, measured visual comparison, non-web frameworks, and automation.

Worth noting: the most-adopted third-party Figma MCP server ([Framelink](https://github.com/GLips/Figma-Context-MCP), ~15.7k stars) works by *wrapping the REST API and simplifying the response* — the same architecture as this kit, served over MCP. Compact structured extraction is the approach that keeps winning; this kit just gives you the pieces directly, and doesn't stop you from also pointing the MCP at the same file when you want a variable name.

## When to use this

**Good fit:**
- A design system with variables actually bound to values (run the health check below — it's measurable)
- Fidelity matters enough that "close enough" gets sent back
- Non-web targets — React Native, SwiftUI, Compose — where the MCP's React+Tailwind output is a translation step
- You want the loop to run in CI, or across many components in a batch

**Poor fit:**
- One-off marketing pages where approximate is fine
- A Figma file with no variables and no components — extraction gives you numbers, but there's no token to bind them to, so fix the design system first
- You want zero maintenance and are fine with the tradeoffs — use the official MCP

## How it works

```
  Figma REST API
        │
        ├─ figma-extract ──► compact spec: geometry, ✓bound/⚠LITERAL, full state matrix,
        │                    exact token per bound value (via the variable map)
        ├─ figma-render  ──► ground-truth PNG
        ├─ figma-icon    ──► exact SVG → currentColor-normalized registry
        ├─ figma-asset   ──► exact SVG files for large art
        ├─ figma-text    ──► translatable copy, grouped by screen
        └─ build-tokens  ──► your variables export → typed token modules + variable map
                    │
                    ▼
          figma-kit.config.json  ◄── the ONLY project-specific file
                    │
                    ▼
        skills/figma-to-code  ──► your AI agent builds against the spec,
                                   then renders and diffs before calling it done
```

Every script is identical in every project. Everything that differs — file keys, token paths, component names, output locations — lives in one config file. Onboarding a new project is filling that file, not editing scripts.

## Quick start

```bash
# 1. Get the kit and copy it into your project
git clone https://github.com/karimhekal/figma-to-code-kit.git
cp -r figma-to-code-kit/scripts       your-project/scripts
cp -r figma-to-code-kit/skills        your-project/.claude/skills
cd your-project && npm install pngjs          # the only runtime dependency (Node 18+)

# 2. Add your Figma token (get one: Figma → Settings → Security → Personal access tokens)
echo 'FIGMA_ACCESS_TOKEN=figd_...' >> .env.local
grep -q '.env.local' .gitignore || echo '.env.local' >> .gitignore

# 3. Create your config
cp figma-to-code-kit/figma-kit.config.example.json figma-kit.config.json
```

Then fill the config. **Don't do it by hand** — point your agent at the repo:

> Fill `figma-kit.config.json`. Scan this repo for: the theme accessor hook, generated token modules (paths + export names), the component barrel + naming prefix, the showcase screen, and the validate command. Then extract 3–4 core components from Figma file `<KEY>` and report: (a) is spacing bound to variables in this design system, (b) what are the variable mode names in the export filenames, (c) what percentage of styled values come back ✓bound vs ⚠LITERAL.

Review its draft and fill in the judgement calls it can't make: which files are `volatile`, `typography.forbiddenProps`, `icons.rtlMirrored`.

```bash
# 4. Validate
node scripts/config-check.js

# 5. Health-check the design system before committing to it
node scripts/figma-extract.js <a-core-component-node-id>
```

**Read the ✓bound ratio from step 5.** It tells you whether this design system is ready. If most values come back ⚠LITERAL, they're hardcoded in Figma — every downstream step degrades, and the fix belongs with the design team, not in your code. This is what "a well-defined design system" means in practice.

**Docs:** [SETUP.md](docs/SETUP.md) — the full walkthrough, from clone to first component · [COMMANDS.md](docs/COMMANDS.md) — every script and flag · [CONFIG.md](docs/CONFIG.md) — every config field and how to obtain its value · [GUARANTEES.md](docs/GUARANTEES.md) — what each developer concern maps to, how strongly, and what is not covered

## What's in the box

| Script | What it does |
|---|---|
| `figma-extract.js` | The core. Exact spec per node + ✓bound/⚠LITERAL flags + the full component state matrix + the **exact** token behind each bound value (resolved by variable id, not guessed from the value). |
| `figma-render.js` | Renders nodes to PNG at up to 4× for visual comparison. Retries the images API's 200-with-`{err}` render timeouts. |
| `figma-pixel.js` | Samples composited RGB at a point, or finds content runs on a row. Turns "looks right" into a measurement. |
| `figma-icon.js` | Exports icons as exact SVG, normalizes hex **and named** white/black to `currentColor`, upserts a name-keyed registry. |
| `figma-asset.js` | Exports large/multicolor art as `.svg` files, colors preserved (or `--mono`). |
| `figma-text.js` | Pulls translatable copy grouped by screen frame in reading order. |
| `build-tokens.js` | Figma variables export (DTCG) → typed token modules, with alias resolution and a broken-alias report. Also emits the **variable map** (variable id → code reference) that makes the extractor's token resolution exact. |
| `build-typography.js` | Fetches Figma **text styles** (which are not variables, so they're absent from the export) → a typed type ramp. |
| `patch-font-metrics.py` | Rewrites a font's vertical metrics to its measured ink box, so design line heights render without clipping. |
| `config-check.js` | Validates the config against reality. The guard against config rot. |
| `figma-drift.js` | Detects the design moving while the code stands still: the file's `lastModified` vs your baselines, the export on disk vs the hash the token build recorded, and a per-pixel re-render of your canonical components with a diff image. The CI-schedulable guard against a green build shipping last month's design. |

## The skill

`skills/figma-to-code/` is a [Claude Code](https://claude.com/claude-code) skill (it works as plain instructions for any agent). It's deliberately split three ways so the knowledge doesn't rot:

- **`core.md`** — universal Figma truths. Instance overrides beat variant labels. A `BOOLEAN_OPERATION` paints with its own fill. Extracts include hidden layers. Republished files renumber every node id. These are true against any Figma file, forever.
- **`adapter-react-native.md`** — framework rules. Auto-layout→flexbox, gap-never-margins, the `react-native-svg` capability boundary, artboard scaling instead of `cover`. Swap in an adapter for your framework; there's a guide for writing one.
- **`SKILL.md`** — the spine. Reads your config, runs the Definition of Done: reuse → extract → bind → build → render & compare → gate.

Nothing project-specific is written in prose. That's on purpose: prose can't be validated, and it silently goes stale. Config can be checked by a script.

## Honest limitations

- **Exact variable resolution is only as current as your export.** The kit names the exact token behind a bound property without an Enterprise plan: `boundVariables` on the nodes endpoint returns the variable's *id*, every leaf of the variables export carries that *same id*, and `build-tokens` joins the two into `variable-map.generated.json` — so `⇒ token: components.checkbox.color.on ✓exact` is a fact, not a match. The catch is the export: a variable added to the design after your last export has no entry, and those show up inline and in an end-of-run tally as "missing from your export" rather than being silently mis-resolved. Re-export, re-run the token build, and they resolve. With no export at all you fall back to value matching, which ties when two tokens share a value — that is where the MCP's `get_variable_defs` is the better answer.
- **The variables export is a manual step.** A designer exports from Figma; you drop the files in. The Variables REST API that would automate it is Enterprise-only.
- **One battle-tested adapter.** React Native is proven. Other frameworks need an adapter written.
- **You own the scripts.** ~1.5k lines. Figma's REST shapes evolve.

## Contributing

```bash
npm install     # pngjs, the only dependency
npm test        # Node's built-in test runner — no framework, ~6s
```

The suite runs the real CLIs as child processes against throwaway projects under your temp
directory, with the Figma API stubbed out — so it never touches the network, your
`figma-kit.config.json`, or your token. If you change a script's **output**, expect a test to fail:
the printout is the contract, and a `✓bound` flag that quietly stops appearing is a regression with
no other symptom.

See [tests/README.md](tests/README.md) for how the network stub works and how to add a fixture.

PRs that change extraction behaviour should come with the case that motivated it — the fixture
Figma response in `tests/fixtures/api/` is hand-authored to hold one clean example of each
situation, and it is meant to grow that way.

## Prior art & credit

The approach owes a lot to work that arrived at the same conclusion independently: [Framelink](https://github.com/GLips/Figma-Context-MCP)'s compact-extraction thesis, [Figma's own guidance](https://github.com/figma/mcp-server-guide) on design-system rules files and Code Connect, and [Builder.io's critique](https://www.builder.io/blog/figma-mcp-server) identifying the missing visual feedback loop — which is precisely the gap `figma-render` + `figma-pixel` close.

This kit was extracted from a production React Native app's design pipeline, then genericized: every project-specific value moved into config, and the framework-agnostic lessons kept.

## License

MIT
