const test = require('node:test');
const assert = require('node:assert/strict');
const {
  seedCategoryRulesConfiguration,
  validateCategoryRule,
  hydrateCategoryRulesConfiguration,
  enabledCategoryRules
} = require('../src/services/titleOptimizationCategoryRulesService');

const NOW = '2026-09-21T12:00:00.000Z';
const seed = () => seedCategoryRulesConfiguration({ now: NOW, actor: 'gary' });

test('first-run seed contains exactly the authoritative twenty categories with explicit seed order', () => {
  const config = seed();
  assert.deepEqual(config.rules.map(rule => rule.categoryName), [
    'Engines', 'Transmissions', 'Mirrors', 'Rear View Mirrors', 'Headlights', 'Tail Lights',
    'Sun Visors', 'Master Window Switch', 'Column Switch', 'Clusters / Speedometers',
    'Fuel Doors', 'Fuel Pumps', 'EVAP Canisters', 'Pedals', 'Actuators', 'Airbags',
    'Fuse Boxes', 'Consoles', 'Seat Belts', 'Car Stereos'
  ]);
  assert.deepEqual(config.rules.map(rule => rule.seedOrder), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.ok(config.rules.every(rule => rule.origin === 'client-v5' && rule.enabled && !rule.deletedAt));
});

test('authoritative seeds preserve exact ordered details references and multiline notes', () => {
  const byName = Object.fromEntries(seed().rules.map(rule => [rule.categoryName, rule]));
  assert.deepEqual(byName.Engines.seriesRefs, ['300 Series']);
  assert.deepEqual(byName.Engines.priorityDetails, ['Size', 'Engine Code', 'VIN Identifier', 'Authorized Tested/Warranty Terminology']);
  assert.match(byName.Engines.note, /Restricted Terms.*\nDo not introduce Long Block or Short Block\.\nTested\/Warranty/s);
  assert.deepEqual(byName.Transmissions.seriesRefs, ['400 Series']);
  assert.deepEqual(byName.Transmissions.priorityDetails, ['Transmission Code', 'Speed / Type', 'Drivetrain']);
  assert.deepEqual(byName.Mirrors.priorityDetails, ['Adjustment', 'Type', 'Color', 'Paint Code']);
  assert.deepEqual(byName['Rear View Mirrors'].priorityDetails, ['Auto-Dimming / Manual']);
  assert.equal(byName['Rear View Mirrors'].note, 'Only use Auto-Dimming / Manual when verified.');
  assert.deepEqual(byName.Headlights.priorityDetails, ['Headlight', 'Verified Lighting Technology']);
  assert.deepEqual(byName['Tail Lights'].priorityDetails, ['Side', 'Lens Color', 'Lighting Technology']);
  assert.deepEqual(byName['Sun Visors'].prefixRefs, ['268']);
  assert.deepEqual(byName['Sun Visors'].priorityDetails, ['Color', 'With / Without Illumination']);
  assert.deepEqual(byName['Master Window Switch'].prefixRefs, ['641']);
  assert.deepEqual(byName['Master Window Switch'].priorityDetails, ['Master Power Window Switch']);
  assert.deepEqual(byName['Column Switch'].prefixRefs, ['629']);
  assert.deepEqual(byName['Column Switch'].priorityDetails, ['Wiper / Turn Signal / Multifunction']);
  assert.deepEqual(byName['Clusters / Speedometers'].prefixRefs, ['257']);
  assert.deepEqual(byName['Clusters / Speedometers'].priorityDetails, ['Speedometer / Tachometer']);
  assert.match(byName['Clusters / Speedometers'].note, /#SKU/);
  assert.deepEqual(byName['Fuel Doors'].priorityDetails, ['Color', 'Paint Code']);
  assert.deepEqual(byName['Fuel Pumps'].prefixRefs, ['323']);
  assert.deepEqual(byName['Fuel Pumps'].priorityDetails, ['Verified Fuel Type']);
  assert.deepEqual(byName['EVAP Canisters'].prefixRefs, ['375']);
  assert.deepEqual(byName['EVAP Canisters'].priorityDetails, ['EVAP Charcoal Canister', 'Manufacturer Part Number']);
  assert.deepEqual(byName.Pedals.prefixRefs, ['234']);
  assert.deepEqual(byName.Pedals.priorityDetails, ['Gas Pedal', 'Accelerator Pedal']);
  assert.deepEqual(byName.Actuators.prefixRefs, ['285']);
  assert.deepEqual(byName.Actuators.priorityDetails, ['Front / Rear', 'Side']);
  assert.equal(byName.Actuators.note, 'Use Side only when verified.');
  assert.deepEqual(byName.Airbags.priorityDetails, ['Verified Driver / Passenger Placement', 'Airbag']);
  assert.match(byName.Airbags.note, /authorized to sell applicable airbags/);
  assert.deepEqual(byName['Fuse Boxes'].prefixRefs, ['646', '663']);
  assert.deepEqual(byName['Fuse Boxes'].priorityDetails, ['Engine Bay vs Interior according to verified prefix']);
  assert.equal(byName['Fuse Boxes'].note, 'Do not infer Engine Bay vs Interior without verified prefix data.');
  assert.deepEqual(byName.Consoles.priorityDetails, ['Lid Only when applicable', 'Roof / Floor', 'Color']);
  assert.deepEqual(byName['Seat Belts'].priorityDetails, ['Buckle / Retractor / Receiver', 'Side', 'Color']);
  assert.deepEqual(byName['Car Stereos'].priorityDetails, ['Manufacturer Part Number', 'Stereo Receiver']);
});

test('validation normalizes category uniqueness and validates each list independently', () => {
  const base = { id: 'custom-1', categoryName: 'Fuel   Rails', prefixRefs: ['X', 'x'], seriesRefs: ['X'], priorityDetails: ['Type', ' type '], enabled: true, origin: 'custom', seedOrder: null };
  const issues = validateCategoryRule(base, [{ ...base, id: 'other', categoryName: ' fuel rails ', prefixRefs: [], priorityDetails: ['Other'] }]);
  assert.ok(issues.some(issue => issue.field === 'categoryName'));
  assert.ok(issues.some(issue => issue.field === 'prefixRefs'));
  assert.ok(issues.some(issue => issue.field === 'priorityDetails'));
  assert.ok(!issues.some(issue => issue.field === 'seriesRefs'));
});

test('hydration quarantines every member of duplicate-name groups and preserves unrelated valid rules', () => {
  const [engines, transmissions, mirrors] = seed().rules;
  const raw = { version: 1, rules: [engines, { ...transmissions, categoryName: ' Mirrors ' }, mirrors] };
  const hydrated = hydrateCategoryRulesConfiguration(raw);
  assert.deepEqual(hydrated.rules.map(rule => rule.categoryName), ['Engines']);
  assert.equal(hydrated.quarantined.length, 2);
  assert.match(hydrated.issues[0].message, /mirrors.*client-v5-transmissions.*client-v5-mirrors/i);
});

test('future read excludes invalid disabled and deleted rules and uses explicit deterministic ordering', () => {
  const config = seed();
  const enabled = enabledCategoryRules({
    rules: [
      { ...config.rules[2], enabled: false },
      config.rules[1], config.rules[0],
      { ...config.rules[3], deletedAt: NOW, deletedBy: 'gary' },
      { id: 'z', categoryName: 'beta', prefixRefs: [], seriesRefs: [], priorityDetails: ['One'], enabled: true, origin: 'custom', seedOrder: null },
      { id: 'a', categoryName: 'Alpha', prefixRefs: [], seriesRefs: [], priorityDetails: ['One'], enabled: true, origin: 'custom', seedOrder: null }
    ]
  });
  assert.deepEqual(enabled.map(rule => rule.categoryName), ['Engines', 'Transmissions', 'Alpha', 'beta']);
});
