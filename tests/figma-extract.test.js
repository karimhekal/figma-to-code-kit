/* eslint-disable */
/**
 * figma-extract.test — the printout an agent actually builds from.
 *
 * The extractor's output IS its contract. Nothing downstream parses it; a human or a model reads
 * it, and every regression here is invisible until it has already shipped wrong code:
 *   - a ✓bound flag that stops appearing turns every token into a hardcoded literal
 *   - a variant axis that stops printing means only the visible state gets built
 *   - a multi-fill node collapsed to `paints[0]` ships the wrong color
 *   - `✓exact` degrading to a value match silently reintroduces the guess the variable map removed
 *
 * So these assert on the TEXT. The canned node response is hand-authored to carry one clean
 * example of each case, and the network never leaves the machine (see tests/helpers/fetch-stub.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createProject, FAKE_TOKEN } = require('./helpers/project');

const NODE = '1234:5678';

/** A project with tokens already generated — the state the extractor is designed for. */
function extractable(opts) {
  const p = createProject(opts);
  const build = p.run('build-tokens.js');
  assert.equal(build.status, 0, build.out);
  return p;
}

test('prints the full state matrix: every variant axis AND every non-variant prop', () => {
  const p = extractable();
  const res = p.run('figma-extract.js', [NODE]);
  assert.equal(res.status, 0, res.out);

  assert.match(res.stdout, /## COMPONENT PROPERTIES \(states & props\)/);
  // The definition of done is the WHOLE matrix, not the subset that happens to be on screen.
  assert.match(res.stdout, /State {2}\[VARIANT \/ state\] {2}→ {2}Default \| Checked \| Disabled/);
  assert.match(res.stdout, /Size {2}\[VARIANT \/ state\] {2}→ {2}Small \| Large/);
  assert.match(res.stdout, /Label {2}\[TEXT\] {2}default="Remember me"/);
  assert.match(res.stdout, /Show hint {2}\[BOOLEAN\] {2}default=false/);
  assert.match(res.stdout, /\(3 variant combinations in the set\)/);
});

test('✓bound vs ⚠LITERAL, and the end-of-run tally of unbound values', () => {
  const p = extractable();
  const res = p.run('figma-extract.js', [NODE]);

  assert.match(res.stdout, /radius=8 ✓bound/);
  // A hand-typed radius nobody meant is a real and frequent authoring bug; so is a deliberate
  // one-off. The flag says "ask", which is why it is also tallied at the end.
  assert.match(res.stdout, /radius=5 ⚠LITERAL/);
  assert.match(res.stdout, /stroke=1px #E8E6FE ⚠LITERAL/);
  assert.match(res.stdout, /UNBOUND styled value\(s\) — verify these are intentional/);
  assert.match(res.stdout, /- State=Checked, Size=Large: cornerRadius=5/);
  assert.match(res.stdout, /- State=Default, Size=Small: stroke #E8E6FE/);
});

test('with the variable map present, a bound property resolves to exactly one token', () => {
  const p = extractable();
  const res = p.run('figma-extract.js', [NODE]);

  // No shortlist and no judgement call: the bound variable id was found in the export.
  assert.match(res.stdout, /radius=8 ✓bound {2}⇒ token: cornerRadius\[8\] ✓exact/);
  assert.match(res.stdout, /fill=#3A2FF0 ✓bound {2}⇒ token: components\.checkbox\.color\.on ✓exact/);
  assert.match(res.stdout, /✓exact = resolved by variable id from your export/);
});

test('a bound id the export has never heard of is called out inline and tallied', () => {
  const p = extractable();
  const res = p.run('figma-extract.js', [NODE]);

  // Not a design defect and not a code defect — a PIPELINE one: the design gained a variable the
  // token build predates.
  assert.match(
    res.stdout,
    /⇒ ⚠ bound to a variable missing from your export \(VariableID:99:999\) — re-export variables/,
  );
  assert.match(res.stdout, /value match: cornerRadius\[8\]/);
  assert.match(res.stdout, /bound to variables MISSING from your variables export/);
  assert.match(res.stdout, /- State=Disabled, Size=Small: cornerRadius → VariableID:99:999/);
  // The remedy names the project's own command, from commands.tokensBuild.
  assert.match(res.stdout, /re-run `npm run tokens:build`/);
});

test('without the variable map it falls back to value matching, with one warning', () => {
  const p = extractable();
  p.remove('src/theme/tokens/variable-map.generated.json');

  const res = p.run('figma-extract.js', [NODE]);
  assert.equal(res.status, 0, res.out);

  assert.match(res.stderr, /\[warn\] no variable map at src\/theme\/tokens\/variable-map\.generated\.json/);
  assert.match(res.stderr, /tokens are suggested by VALUE \(can tie\)/);
  assert.match(res.stderr, /Run `npm run tokens:build`/);

  // The extract still works, still suggests — it just cannot promise the suggestion is THE token.
  assert.match(res.stdout, /radius=8 ✓bound {2}⇒ token: cornerRadius\[8\]/);
  assert.equal(res.stdout.includes('✓exact'), false, 'no exact claim is available without the map');
});

test('value matching prints a SHORTLIST when several tokens share one value', () => {
  const p = extractable();
  const res = p.run('figma-extract.js', [NODE]);

  // `#101014` is legitimately three tokens. Showing all of them is the honest answer, and it is
  // exactly the ambiguity that ✓exact removes for bound properties.
  const line = res.stdout.split('\n').find((l) => l.includes('fill=#101014'));
  assert.ok(line, res.stdout);
  assert.match(line, /⇒ token: palette\.neutral\[900\]/);
  assert.match(line, / \| /);
});

test('a multi-fill node lists every paint, bottom→top, and refuses to name one color', () => {
  const p = extractable();
  const res = p.run('figma-extract.js', [NODE]);

  // Printing only paints[0] ships the wrong color whenever a translucent wash sits on a background.
  assert.match(
    res.stdout,
    /fills\[2\] — MULTI-FILL, these composite bottom→top; no single flat color/,
  );
  const bottom = res.stdout.indexOf('[0/bottom] #FFFFFF');
  const top = res.stdout.indexOf('[1/top] rgba(58, 47, 240, 0.12)');
  assert.ok(bottom > -1 && top > -1, res.stdout);
  assert.ok(bottom < top, 'paints must be listed in composite order');
});

test('off-grid spacing is flagged with the nearest ramp step', () => {
  const p = extractable();
  const res = p.run('figma-extract.js', [NODE]);

  assert.match(res.stdout, /HORIZONTAL gap=8 ⇒ space\[8\]/);
  assert.match(res.stdout, /VERTICAL gap=13 ⚠OFF-GRID \(≈ space\[12\]\)/);
  assert.match(res.stdout, /OFF-GRID spacing value\(s\) in YOUR layout/);
  assert.match(res.stdout, /- State=Checked, Size=Large: gap=13px \(nearest space\[12\]\)/);
});

test('off-grid spacing INSIDE an instance is reported separately, as information', () => {
  const p = extractable();
  const res = p.run('figma-extract.js', [NODE]);

  // That geometry belongs to the component instance, not to the layout being ported. Telling
  // someone to "snap" it would send them editing a component they did not open.
  assert.match(res.stdout, /off-ramp value\(s\) INSIDE component instances/);
  assert.match(res.stdout, /Do NOT snap these/);
  assert.match(res.stdout, /- Box: gap=7px \(nearest space\[8\]\)/);
});

test('text nodes are matched to a DS style, disambiguated by lineHeight', () => {
  const p = extractable();
  const res = p.run('figma-extract.js', [NODE]);

  // `body` and `subheadline` share fontSize 15; only lineHeight separates them.
  assert.match(res.stdout, /"Remember me" fontSize=15 weight=700 lineHeight=20/);
  assert.match(res.stdout, /⇒ <AppText variant=body weight=bold>/);
});

test('a text size with no DS style refuses to invent one', () => {
  const p = extractable();
  const res = p.run('figma-extract.js', [NODE]);

  // Inventing a close-enough style here is how a design system quietly grows a twelfth heading.
  assert.match(res.stdout, /⚠ no DS text style at 17px — confirm with design/);
  assert.match(res.stdout, /do NOT invent; use a DS variant/);
});

test('the per-project gotchas ledger is printed with the spec', () => {
  const p = extractable();
  const res = p.run('figma-extract.js', [NODE]);

  assert.match(res.stdout, /## Known gotchas for this library:/);
  assert.match(res.stdout, /two components named Chip/);
});

test('a node id copied from a Figma URL (1234-5678) is accepted', () => {
  const p = extractable();
  const res = p.run('figma-extract.js', ['1234-5678']);
  assert.equal(res.status, 0, res.out);
  assert.match(res.stdout, /=== Checkbox \(1234-5678\)/);
});

test('with nothing configured it still extracts, and names each feature it switched off', () => {
  // An EMPTY config rather than no config at all: `findUp` walks to the filesystem root, so a
  // stray figma-kit.config.json above the temp directory would otherwise join the test. Pointing
  // $FIGMA_CONFIG at `{}` gives the same built-in DEFAULTS with none of that ambient risk.
  const p = createProject({ config: {} });
  const res = p.run('figma-extract.js', [NODE, '--file', 'EXAMPLEFILEKEY123456'], {
    env: { FIGMA_ACCESS_TOKEN: FAKE_TOKEN },
  });
  assert.equal(res.status, 0, res.out);

  assert.match(res.stderr, /\[warn\] paths\.tokensDir is not set/);
  assert.match(res.stderr, /\[warn\] no tokens\.index configured — running as a plain extractor/);
  assert.match(res.stderr, /\[warn\] no tokens\.spacing\.rampPath configured/);
  assert.match(res.stderr, /\[warn\] no tokens\.typography\.rampPath configured/);

  // Degraded, not broken: the geometry, the binding flags and the state matrix all still print.
  assert.match(res.stdout, /• Checkbox \[COMPONENT_SET\] 240×132/);
  assert.match(res.stdout, /State {2}\[VARIANT \/ state\]/);
  assert.match(res.stdout, /radius=8 ✓bound/);
  assert.match(res.stdout, /radius=5 ⚠LITERAL/);
  assert.match(res.stdout, /HORIZONTAL gap=8/);
});

test('a node the file does not contain exits 1 rather than printing an empty spec', () => {
  const p = extractable();
  const res = p.run('figma-extract.js', ['9999:9999']);
  assert.equal(res.status, 1);
  assert.match(res.out, /Node not found \/ not exportable/);
});

test('no --depth means the whole tree; --depth 0 stops at the node itself', () => {
  const p = extractable();
  const shallow = p.run('figma-extract.js', [NODE, '--depth', '0']);
  assert.equal(shallow.status, 0, shallow.out);
  assert.match(shallow.stdout, /• Checkbox \[COMPONENT_SET\]/);
  assert.equal(shallow.stdout.includes('State=Default, Size=Small ['), false);
});
