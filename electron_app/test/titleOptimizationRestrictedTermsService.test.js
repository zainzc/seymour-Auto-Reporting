const test = require('node:test');
const assert = require('node:assert/strict');
const {
  seedRestrictedTermsConfiguration,
  validateRestrictedTerm,
  hydrateRestrictedTermsConfiguration,
  enabledRestrictedTerms
} = require('../src/services/titleOptimizationRestrictedTermsService');

const NOW = '2026-09-18T00:00:00.000Z';

test('first-run seed has exactly the approved twenty client-v5 terms in deterministic order', () => {
  const config = seedRestrictedTermsConfiguration({ now: NOW, actor: 'Gary' });
  assert.deepEqual(config.rules.map(rule => rule.term), [
    'Long Block', 'Short Block', 'Complete', 'Complete Engine', 'Complete Assembly', 'Rebuilt', 'Remanufactured', 'Tested', '6 Mo Warranty',
    'OEM Part', 'Used Auto', 'Redundant Part', 'ECM', 'ABS', 'BCM', 'PCM', 'TCM', 'EVAP', 'HVAC', 'TPMS'
  ]);
  assert.equal(config.rules.some(rule => rule.term === 'User Defined'), false);
  const longBlock = config.rules.find(rule => rule.term === 'Long Block');
  const shortBlock = config.rules.find(rule => rule.term === 'Short Block');
  assert.deepEqual({ ruleType: longBlock.ruleType, scope: longBlock.scope, enabled: longBlock.enabled, locked: longBlock.locked }, { ruleType: 'never-introduce', scope: 'engine', enabled: true, locked: true });
  assert.deepEqual({ ruleType: shortBlock.ruleType, scope: shortBlock.scope, enabled: shortBlock.enabled, locked: shortBlock.locked }, { ruleType: 'never-introduce', scope: 'engine', enabled: true, locked: true });
  assert.ok(config.rules.every(rule => rule.origin === 'client-v5' && rule.createdAt === NOW && rule.createdBy === 'Gary'));
  assert.deepEqual(config.rules.filter(rule => rule.ruleType === 'must-preserve').map(rule => rule.term), ['ECM', 'ABS', 'BCM', 'PCM', 'TCM', 'EVAP', 'HVAC', 'TPMS']);
});

test('validation requires complete fields and rejects normalized duplicates including disabled rules', () => {
  const rule = { id: 'custom-1', term: '  Turbo   Kit ', ruleType: 'never-introduce', scope: 'engine', enabled: true };
  assert.deepEqual(validateRestrictedTerm(rule), []);
  assert.ok(validateRestrictedTerm({ ...rule, term: '  ' }).some(issue => issue.field === 'term'));
  assert.ok(validateRestrictedTerm({ ...rule, ruleType: 'unknown' }).some(issue => issue.field === 'ruleType'));
  assert.ok(validateRestrictedTerm({ ...rule, scope: 'unknown' }).some(issue => issue.field === 'scope'));
  assert.ok(validateRestrictedTerm({ ...rule, enabled: 'yes' }).some(issue => issue.field === 'enabled'));
  assert.ok(validateRestrictedTerm(rule, [{ ...rule, id: 'old', term: 'turbo kit', enabled: false }]).some(issue => issue.field === 'term'));
  assert.deepEqual(validateRestrictedTerm(rule, [{ ...rule, id: 'old', term: 'turbo kit', deletedAt: NOW }]), []);
});

test('hydration preserves valid entries while quarantining malformed entries', () => {
  const seed = seedRestrictedTermsConfiguration({ now: NOW, actor: 'Gary' });
  const valid = seed.rules[2];
  const malformed = { ...valid, id: 'bad', enabled: 'true' };
  const laterValid = { ...valid, id: 'custom-1', term: 'Turbo Kit', origin: 'custom', locked: false };
  const hydrated = hydrateRestrictedTermsConfiguration({ rules: [seed.rules[0], seed.rules[1], valid, malformed, laterValid] });
  assert.deepEqual(hydrated.rules.map(rule => rule.id), [seed.rules[0].id, seed.rules[1].id, valid.id, laterValid.id]);
  assert.deepEqual(hydrated.quarantined.map(rule => rule.id), ['bad']);
  assert.equal(hydrated.issues.length, 1);
});

test('future read excludes invalid, disabled, and deleted entries but injects unavailable locked safety rules in memory with warnings', () => {
  const seed = seedRestrictedTermsConfiguration({ now: NOW, actor: 'Gary' });
  const complete = seed.rules.find(rule => rule.term === 'Complete');
  const disabledShort = { ...seed.rules.find(rule => rule.term === 'Short Block'), enabled: false };
  const deleted = { ...seed.rules.find(rule => rule.term === 'OEM Part'), deletedAt: NOW, deletedBy: 'Gary' };
  const malformedLong = { ...seed.rules.find(rule => rule.term === 'Long Block'), enabled: 'true' };
  const hydrated = hydrateRestrictedTermsConfiguration({ rules: [malformedLong, disabledShort, complete, deleted] });
  assert.ok(hydrated.issues.some(issue => /Long Block.*canonical enabled rule/i.test(issue.message)));
  assert.ok(hydrated.issues.some(issue => /Short Block.*canonical enabled rule/i.test(issue.message)));
  assert.deepEqual(enabledRestrictedTerms(hydrated).map(rule => rule.term), ['Long Block', 'Short Block', 'Complete']);
  assert.ok(enabledRestrictedTerms(hydrated).slice(0, 2).every(rule => rule.enabled && rule.locked && rule.scope === 'engine'));
});

test('hydration treats tampered client-v5 identity and lock metadata as malformed', () => {
  const seed = seedRestrictedTermsConfiguration({ now: NOW, actor: 'Gary' });
  const tamperedLong = { ...seed.rules[0], locked: false };
  const tamperedSeed = { ...seed.rules[2], scope: 'all' };
  const hydrated = hydrateRestrictedTermsConfiguration({ rules: [tamperedLong, tamperedSeed, seed.rules[1]] });
  assert.deepEqual(hydrated.rules.map(rule => rule.term), ['Short Block']);
  assert.deepEqual(hydrated.quarantined.map(rule => rule.term), ['Long Block', 'Complete']);
  assert.ok(hydrated.issues.some(issue => /Long Block.*canonical enabled rule/i.test(issue.message)));
});
