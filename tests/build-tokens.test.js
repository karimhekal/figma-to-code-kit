/* eslint-disable */
/**
 * build-tokens.test — the DTCG export → typed token modules + variable map pipeline.
 *
 * The fixture export is small but deliberately awkward, because every awkward part is a real
 * failure this script has to survive:
 *   - a CROSS-FILE alias (`{color.brand.500}` in a mode file, defined only in the primitives file)
 *   - a numeric alias into a group whose keys are numbers (`{Corner radius.8}`)
 *   - a DELIBERATELY BROKEN alias (`{color.brand.retired}`), which must not throw, must not invent
 *     a value, and must be reported
 *   - a "Corner radius" group nested INSIDE a component, which must NOT be hoisted into the
 *     top-level radius scale by the bare-name routing rule
 *   - two mode files that share variable ids, which is what makes `values` a per-mode object
 *
 * The variable map gets the most attention here because it is a CONTRACT: figma-extract reads it,
 * figma-drift re-computes its hash, and both break silently if a ref is spelled differently.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createProject } = require('./helpers/project');
const { loadTokenModule } = require('../scripts/figma-config');
const { hashExport, resolveExportSources } = require('../scripts/figma-drift');

/** A built project, plus the run result — the shared arrangement of nearly every test below. */
function build(opts) {
  const p = createProject(opts);
  const res = p.run('build-tokens.js');
  return { p, res };
}

test('emits the token modules the config routes groups into', () => {
  const { p, res } = build();
  assert.equal(res.status, 0, res.out);

  assert.match(res.out, /\[build-tokens\] Generated:/);
  assert.match(res.out, /palette\.generated\.ts \(palette, cornerRadius\)/);
  assert.match(res.out, /themes\.generated\.ts \(modes: light, dark\)/);

  assert.ok(p.exists('src/theme/tokens/palette.generated.ts'));
  assert.ok(p.exists('src/theme/tokens/themes.generated.ts'));
  assert.ok(p.exists('src/theme/tokens/variable-map.generated.json'));
});

test('primitives: numeric ramp steps stay numeric, and translucent colors become rgba()', () => {
  const { p } = build();
  const mod = loadTokenModule(p.file('src/theme/tokens/palette.generated.ts'));

  assert.equal(mod.palette.brand[500], '#3A2FF0');
  assert.equal(mod.palette.neutral[0], '#FFFFFF');
  // An opaque color reads as hex (what a designer sees in review); only genuine translucency
  // becomes rgba(), so the generated file does not flip-flop between the two forms.
  assert.equal(mod.palette.scrim, 'rgba(0, 0, 0, 0.4)');
  // The radius export is named after the Figma group it came from ("Corner radius").
  assert.deepEqual(mod.cornerRadius, { 4: 4, 8: 8, 16: 16 });
});

test('aliases resolve across files, and per mode', () => {
  const { p } = build();
  const { themes } = loadTokenModule(p.file('src/theme/tokens/themes.generated.ts'));

  // `{color.neutral.0}` lives only in the primitives file; the mode files never define it.
  assert.equal(themes.light.semantic.background.primary, '#FFFFFF');
  assert.equal(themes.dark.semantic.background.primary, '#101014');
  assert.equal(themes.light.components.checkbox.color.on, '#3A2FF0');
  assert.equal(themes.dark.components.checkbox.color.on, '#E8E6FE');
  // A numeric alias into a numerically-keyed group.
  assert.equal(themes.light.components.checkbox.cornerRadius, 8);
});

test('a broken alias is reported, not thrown — and never silently invented', () => {
  const { p, res } = build();

  assert.equal(res.status, 0, 'a half-built token file helps nobody; the run must complete');
  assert.match(res.out, /1 BROKEN alias\(es\) in the Figma export/);
  assert.match(res.out, /substituted 'transparent'/);
  assert.match(res.out, /- \{color\.brand\.retired\}/);

  const { themes } = loadTokenModule(p.file('src/theme/tokens/themes.generated.ts'));
  // Visibly wrong on purpose: nobody ships `transparent` as a checkbox color by accident.
  assert.equal(themes.light.components.checkbox.color.disabled, 'transparent');
});

test('a bare group rule does not hoist a like-named group out of a component', () => {
  // "Corner radius" is routed to the radius scale at the TOP level. The identically-named group
  // nested under Component.Checkbox must stay where it is — component libraries reuse generic
  // subgroup names constantly, and hoisting them all into one export is a corruption that looks
  // plausible until you read the diff.
  const { p } = build();
  const { cornerRadius } = loadTokenModule(p.file('src/theme/tokens/palette.generated.ts'));
  const { themes } = loadTokenModule(p.file('src/theme/tokens/themes.generated.ts'));

  assert.deepEqual(Object.keys(cornerRadius), ['4', '8', '16']);
  assert.equal(themes.light.components.checkbox.cornerRadius, 8);
});

test('variable map: the $meta contract', () => {
  const { p } = build();
  const map = p.readJson('src/theme/tokens/variable-map.generated.json');

  assert.equal(map.$meta.generator, 'build-tokens.js');
  assert.match(map.$meta.exportHash, /^[0-9a-f]{12}$/);
  assert.equal(map.$meta.variableCount, Object.keys(map.variables).length);
  // Sorted by RELATIVE PATH, not by basename — this fixture tells the two apart (a basename sort
  // would put Dark and Light before Primitives).
  assert.deepEqual(map.$meta.sources, [
    'Primitives.tokens.json',
    'modes/Dark.tokens.json',
    'modes/Light.tokens.json',
  ]);
});

test('variable map: an entry is id → { ref, figmaPath, values-by-mode }', () => {
  const { p } = build();
  const map = p.readJson('src/theme/tokens/variable-map.generated.json');

  // One variable, two mode files, ONE entry — later modes merge into the entry the first created.
  assert.deepEqual(map.variables['VariableID:35:590'], {
    ref: 'components.checkbox.color.on',
    figmaPath: 'Component.Checkbox.Color.On',
    values: { light: '#3A2FF0', dark: '#E8E6FE' },
  });
});

test('variable map: refs are spelled the way code indexes them — numeric keys in brackets', () => {
  const { p } = build();
  const { variables } = p.readJson('src/theme/tokens/variable-map.generated.json');

  // This spelling is the whole contract: figma-extract prints these verbatim for a bound property,
  // so a ref that is not a real code path is a suggestion nobody can paste.
  assert.equal(variables['VariableID:10:101'].ref, 'palette.brand[500]');
  assert.equal(variables['VariableID:20:801'].ref, 'cornerRadius[8]');
  assert.equal(variables['VariableID:10:120'].ref, 'palette.scrim');
  assert.equal(variables['VariableID:30:410'].ref, 'semantic.text.primary');
  assert.equal(variables['VariableID:35:593'].ref, 'components.checkbox.cornerRadius');
});

test('variable map: a single-mode source records its value under "*"', () => {
  const { p } = build();
  const { variables } = p.readJson('src/theme/tokens/variable-map.generated.json');
  assert.deepEqual(variables['VariableID:20:801'].values, { '*': 8 });
});

test('exportHash is stable across runs, and matches what figma-drift recomputes', () => {
  const { p } = build();
  const first = p.readJson('src/theme/tokens/variable-map.generated.json').$meta;

  assert.equal(p.run('build-tokens.js').status, 0);
  const second = p.readJson('src/theme/tokens/variable-map.generated.json').$meta;
  assert.equal(second.exportHash, first.exportHash, 'a fingerprint that moves on its own is worse than none');

  // The recipe lives in two places by design (figma-drift must not depend on the token build to
  // decide whether the token build is stale). Two copies of a hash is exactly how two "identical"
  // hashes start disagreeing — so pin them to each other.
  const cfgJson = p.readJson('figma-kit.config.json');
  const cfg = { __root: p.dir, paths: cfgJson.paths, variables: cfgJson.variables };
  const src = resolveExportSources(cfg);
  assert.ok(src.files, src.reason);
  const recomputed = hashExport(src.dir, src.files);

  assert.equal(recomputed.hash, first.exportHash);
  assert.deepEqual(recomputed.sources, first.sources);
});

test('a group the config does not route is reported, never guessed at', () => {
  const p = createProject();
  const primitives = p.readJson('figma-variables/Primitives.tokens.json');
  primitives['Elevation'] = {
    card: { $type: 'number', $value: 2, $extensions: { 'com.figma.variableId': 'VariableID:40:1' } },
  };
  p.writeJson('figma-variables/Primitives.tokens.json', primitives);

  const res = p.run('build-tokens.js');
  assert.equal(res.status, 0);
  assert.match(res.out, /1 group\(s\) in the export have no destination/);
  assert.match(res.out, /- Elevation/);
  assert.match(res.out, /Add each to variables\.groups/);
});

test('an export with no variable ids still builds tokens, and says what was lost', () => {
  const p = createProject();
  for (const file of [
    'figma-variables/Primitives.tokens.json',
    'figma-variables/modes/Light.tokens.json',
    'figma-variables/modes/Dark.tokens.json',
  ]) {
    const stripped = JSON.parse(
      JSON.stringify(p.readJson(file), (key, value) => (key === '$extensions' ? undefined : value)),
    );
    p.writeJson(file, stripped);
  }

  const res = p.run('build-tokens.js');
  assert.equal(res.status, 0);
  assert.ok(p.exists('src/theme/tokens/themes.generated.ts'));
  assert.equal(p.exists('src/theme/tokens/variable-map.generated.json'), false);
  assert.match(res.out, /no leaf in the export carries \$extensions\["com\.figma\.variableId"\]/);
  assert.match(res.out, /EXACT variable resolution will be unavailable/);
});

test('an empty variables.sources fails loudly, listing the files it can see', () => {
  const p = createProject();
  p.patchConfig((c) => {
    c.variables.sources = [];
  });

  const res = p.run('build-tokens.js');
  assert.equal(res.status, 1);
  assert.match(res.out, /variables\.sources is empty/);
  // Listing what it CAN see is the difference between a dead end and a next step.
  assert.match(res.out, /Primitives\.tokens\.json/);
  assert.match(res.out, /modes\/Light\.tokens\.json/);
});
