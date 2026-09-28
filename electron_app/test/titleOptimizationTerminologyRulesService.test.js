const test = require('node:test');
const assert = require('node:assert/strict');

const {
  seedTerminologyRules,
  validateRule,
  hydrateTerminologyConfiguration,
  visibleRules,
  enabledRules
} = require('../src/services/titleOptimizationTerminologyRulesService');

const expected = [
  ['Headlamp', 'Headlight'],
  ['Tail Lamp', 'Tail Light'],
  ['Door Mirror', 'Side View Mirror'],
  ['Door Side View Mirror', 'Side View Mirror'],
  ['Inside Mirror', 'Rear View Mirror'],
  ['High Mounted Stop Light', 'Third Brake Light'],
  ['Mount Stop Light', 'Third Brake Light'],
  ['Throttle Valve Assembly', 'Throttle Body'],
  ['Throttle Valve', 'Throttle Body'],
  ['Anti-Lock Brake Part', 'ABS Module'],
  ['Blower Motor Fan', 'HVAC Blower Motor'],
  ['Door Lock Actuator Latch', 'Door Lock Actuator'],
  ['Fog-driving', 'Fog Light'],
  ['Audio Equipment', 'Radio Stereo Receiver'],
  ['Steering Gear', 'Steering Rack'],
  ['Wiper Transmission', 'Wiper Linkage'],
  ['Speedometer Head', 'Speedometer'],
  ['Speedometer Cluster', 'Instrument Cluster'],
  ['Fuel Vapor Canister', 'EVAP Charcoal Canister'],
  ['Coil / Ignitor', 'Ignition Coil'],
  ['Coil Pack', 'Ignition Coil'],
  ['Floor Shift Assembly', 'Shifter Assembly'],
  ['Air Cleaner', 'Air Filter Box'],
  ['Info-GPS-TV Screen', 'Navigation Display Screen'],
  ['Temperature Control', 'AC Climate Temperature Control'],
  ['Fuel / Filler Door', 'Gas Fuel Door'],
  ['Spindle / Knuckle', 'Steering Knuckle Spindle'],
  ['Am-fm', 'AM FM'],
  ['Am-fm-cd', 'AM FM CD'],
  ['Chassis ECM', 'Control Module'],
  ['Auto', 'Automatic'],
  ['Radio', 'Radio Stereo Receiver'],
  ['User Defined', null],
  ['Accelerator', 'Gas Pedal Accelerator Pedal']
];

test('true first run seeds exactly the 34 client-v5 terminology swaps in order', () => {
  const rules = seedTerminologyRules({ now: '2026-09-17T00:00:00.000Z', actor: 'gary' });
  assert.deepEqual(rules.map(rule => [rule.sourceTerm, rule.replacementTerm]), expected);
  assert.deepEqual(rules.map(rule => rule.priority), expected.map((_, index) => (index + 1) * 10));
  assert.ok(rules.every(rule => rule.origin === 'client-v5' && rule.enabled === true));
  assert.ok(rules.every(rule => rule.createdAt === '2026-09-17T00:00:00.000Z' && rule.createdBy === 'gary'));
  assert.equal(new Set(rules.map(rule => rule.id)).size, 34);
  assert.equal(rules.find(rule => rule.sourceTerm === 'User Defined').action, 'remove');
  assert.equal(rules.find(rule => rule.sourceTerm === 'Auto').condition, 'transmission-context');
  assert.equal(rules.find(rule => rule.sourceTerm === 'Auto').appliesTo, 'transmission');
  assert.match(rules.find(rule => rule.sourceTerm === 'Chassis ECM').note, /ECM.*search term/i);
  assert.deepEqual(rules.find(rule => rule.sourceTerm === 'Anti-Lock Brake Part').conditionConfig, {
    criterion: 'pump-verified', whenVerified: 'ABS Pump', otherwise: 'ABS Module'
  });
  assert.deepEqual(rules.find(rule => rule.sourceTerm === 'Coil / Ignitor').conditionConfig, {
    criterion: 'identity-confirmed', whenVerified: 'Ignition Coil', otherwise: null
  });
  assert.equal(rules.find(rule => rule.sourceTerm === 'Anti-Lock Brake Part').condition, 'context-verified');
  assert.equal(rules.find(rule => rule.sourceTerm === 'Coil / Ignitor').condition, 'context-verified');
  assert.equal(rules.some(rule => /^Prefix |^LH$|^RH$|^PW Motor$|^Assy$|^CV Axle$/.test(rule.sourceTerm)), false);
});

test('validation keeps text but rejects malformed Replace, Remove, and active duplicates', () => {
  const source = { id: 'one', sourceTerm: 'Air  Cleaner', action: 'replace', replacementTerm: 'Air Filter Box', condition: 'always', appliesTo: 'all', priority: 10, enabled: true };
  assert.deepEqual(validateRule(source, []), []);
  assert.ok(validateRule({ ...source, replacementTerm: '' }, []).some(issue => issue.field === 'replacementTerm'));
  assert.ok(validateRule({ ...source, action: 'remove', replacementTerm: 'wrong' }, []).some(issue => issue.field === 'replacementTerm'));
  for (const replacementTerm of ['', '   ', undefined]) {
    assert.ok(validateRule({ ...source, action: 'remove', replacementTerm }, []).some(issue => issue.field === 'replacementTerm'));
  }
  assert.deepEqual(validateRule({ ...source, action: 'remove', replacementTerm: null }, []), []);
  assert.ok(validateRule({ ...source, priority: -1 }, []).some(issue => issue.field === 'priority'));
  assert.ok(validateRule({ ...source, enabled: 'yes' }, []).some(issue => issue.field === 'enabled'));
  assert.ok(validateRule({ ...source, id: 'two' }, [source]).some(issue => issue.field === 'sourceTerm'));
  assert.ok(validateRule({ ...source, id: 'two' }, [{ ...source, enabled: false }]).every(issue => issue.field !== 'sourceTerm'));
});

test('hydration preserves valid rules and quarantines only malformed entries', () => {
  const valid = seedTerminologyRules({ now: '2026-09-17T00:00:00.000Z', actor: 'gary' })[0];
  const result = hydrateTerminologyConfiguration({ version: 1, rules: [valid, { id: 'broken', sourceTerm: '' }] });
  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].id, valid.id);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].id, 'broken');
  assert.equal(result.quarantined.length, 1);
});

test('hydration quarantines duplicate IDs and malformed Remove values without losing valid entries', () => {
  const [first, second] = seedTerminologyRules({ now: '2026-09-17T00:00:00.000Z', actor: 'gary' });
  const duplicateId = { ...second, id: first.id };
  const malformedRemove = { ...second, id: 'custom-remove', sourceTerm: 'User Defined', action: 'remove', replacementTerm: '' };
  const result = hydrateTerminologyConfiguration({ version: 1, rules: [first, duplicateId, second, malformedRemove] });
  assert.deepEqual(result.rules.map(rule => rule.id), [first.id, second.id]);
  assert.equal(result.quarantined.length, 2);
  assert.match(result.issues[0].message, /duplicate.*ID/i);
  assert.match(result.issues[1].message, /Remove.*null/i);
});

test('visible and enabled rules exclude deleted entries and sort priority then ID', () => {
  const [one, two] = seedTerminologyRules({ now: '2026-09-17T00:00:00.000Z', actor: 'gary' });
  const config = { rules: [{ ...one, id: 'b', priority: 20 }, { ...two, id: 'a', priority: 20 }, { ...one, id: 'c', priority: 5, enabled: false }, { ...two, id: 'd', priority: 1, deletedAt: '2026-09-17T00:00:00.000Z' }] };
  assert.deepEqual(visibleRules(config).map(rule => rule.id), ['c', 'a', 'b']);
  assert.deepEqual(enabledRules(config).map(rule => rule.id), ['a', 'b']);
});
