const test = require('node:test');
const assert = require('node:assert/strict');
const { seedSynonymConfiguration, validateSynonymRule, hydrateSynonymConfiguration, enabledSynonymRules } = require('../src/services/titleOptimizationSynonymsService');

test('seeds ten exact mappings and keeps CV Axle as a separate policy', () => {
  const config = seedSynonymConfiguration({ now: '2026-09-17T00:00:00.000Z', actor: 'gary' });
  assert.deepEqual(config.rules.map(rule => [rule.primaryTerm, rule.synonyms]), [
    ['Headlight', ['Headlamp']], ['Tail Light', ['Tail Lamp']],
    ['Side View Mirror', ['Door Mirror', 'Side Mirror']], ['Fuel Tank', ['Gas Tank']],
    ['Air Filter Box', ['Air Cleaner']], ['Sun Visor', ['Sunvisor']],
    ['Instrument Cluster', ['Speedometer', 'Gauge Cluster']], ['Caliper', ['Disc Brake']],
    ['Blower Motor', ['Heater Fan']], ['Radio', ['Stereo Receiver']]
  ]);
  assert.deepEqual(config.rules.map(rule => rule.priority), [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(config.enabled, true);
  assert.deepEqual(config.policies.cvAxleFrontHalfShaft, {
    condition: 'confirmed-front-half-shaft',
    note: 'CV Axle may only be used for a confirmed FRONT half-shaft; never for rear axle or axle housing.'
  });
});

test('validation rejects blanks, duplicate synonyms, and normalized active fingerprints', () => {
  const base = seedSynonymConfiguration({}).rules[0];
  assert.ok(validateSynonymRule({ ...base, primaryTerm: '  ', synonyms: ['x', ' X '] }).some(issue => issue.field === 'primaryTerm'));
  assert.ok(validateSynonymRule({ ...base, synonyms: ['x', ' X '] }).some(issue => issue.field === 'synonyms'));
  assert.ok(validateSynonymRule({ ...base, id: 'custom', primaryTerm: ' headLIGHT  ' }, [base]).some(issue => issue.field === 'primaryTerm'));
  assert.ok(validateSynonymRule({ ...base, condition: 'bad', appliesTo: 'bad', priority: 0, enabled: 1 }).length >= 4);
});

test('hydration isolates malformed entries and future reads sort only valid enabled rules', () => {
  const [first, second] = seedSynonymConfiguration({}).rules;
  const malformed = { id: 'broken', primaryTerm: '' };
  const hydrated = hydrateSynonymConfiguration({ enabled: true, rules: [{ ...second, priority: 1 }, malformed, first, { ...first, id: 'dupe' }] });
  assert.equal(hydrated.rules.length, 2);
  assert.deepEqual(hydrated.quarantined, [malformed, { ...first, id: 'dupe' }]);
  assert.deepEqual(enabledSynonymRules(hydrated).map(rule => rule.id), [second.id, first.id]);
});

test('malformed CV Axle policy is warned about and excluded from future-facing config', () => {
  const seeded = seedSynonymConfiguration({});
  const raw = { ...seeded, policies: { cvAxleFrontHalfShaft: { condition: 'always', note: 'Unsafe rule' } } };
  const hydrated = hydrateSynonymConfiguration(raw);
  assert.equal(hydrated.rules.length, 10);
  assert.equal(hydrated.policies.cvAxleFrontHalfShaft, undefined);
  assert.match(hydrated.issues.at(-1).message, /CV Axle policy/i);
  assert.deepEqual(raw.policies.cvAxleFrontHalfShaft, { condition: 'always', note: 'Unsafe rule' });
  const malformedOuter = hydrateSynonymConfiguration({ enabled: true, policies: raw.policies });
  assert.deepEqual(malformedOuter.policies, {});
});
