const test = require('node:test');
const assert = require('node:assert/strict');
const { seedPrefixRulesConfiguration, validatePrefixRule, hydratePrefixRulesConfiguration, enabledPrefixRules } = require('../src/services/titleOptimizationPrefixRulesService');

test('true first-run seed contains exactly the eleven approved prefix mappings and metadata', () => {
  const config = seedPrefixRulesConfiguration({ now: '2026-09-17T00:00:00.000Z', actor: 'Gary' });
  assert.deepEqual(config.rules.map(rule => rule.prefix), ['234', '257', '268', '285', '323', '375', '629', '641', '646', '659', '663']);
  assert.deepEqual(config.rules.find(rule => rule.prefix === '234').approvedPartTerms, ['Gas Pedal', 'Accelerator Pedal']);
  assert.deepEqual(config.rules.find(rule => rule.prefix === '257').approvedPartTerms, ['Speedometer', 'Instrument Cluster']);
  assert.match(config.rules.find(rule => rule.prefix === '257').note, /#SKU/);
  assert.deepEqual(config.rules.find(rule => rule.prefix === '629').approvedPartTerms, ['Wiper Switch', 'Turn Signal Switch', 'Multifunction Switch']);
  assert.equal(config.rules.find(rule => rule.prefix === '629').specialTrigger, 'Column Switch');
  assert.equal(config.rules.find(rule => rule.prefix === '629').specialReplacement, 'Wiper / Turn Signal / Multifunction Switch');
  assert.equal(config.rules.find(rule => rule.prefix === '641').specialTrigger, 'Front Door Switch');
  assert.equal(config.rules.find(rule => rule.prefix === '641').specialReplacement, 'Master Power Window Switch');
  assert.deepEqual(config.rules.find(rule => rule.prefix === '646').approvedPartTerms, ['Fuse Box Engine Bay']);
  assert.deepEqual(config.rules.find(rule => rule.prefix === '663').approvedPartTerms, ['Fuse Box Interior']);
  assert.ok(config.rules.every(rule => rule.origin === 'client-v5' && rule.enabled && rule.createdBy === 'Gary'));
});

test('validation preserves string prefixes and requires complete special pairs', () => {
  const rule = { id: 'custom-1', prefix: '046', approvedPartTerms: ['Part Name'], specialTrigger: null, specialReplacement: null, enabled: true };
  assert.deepEqual(validatePrefixRule(rule), []);
  assert.ok(validatePrefixRule({ ...rule, prefix: 46 }).some(issue => issue.field === 'prefix'));
  assert.ok(validatePrefixRule({ ...rule, prefix: ' 046 ' }).some(issue => issue.field === 'prefix'));
  assert.ok(validatePrefixRule({ ...rule, approvedPartTerms: [] }).some(issue => issue.field === 'approvedPartTerms'));
  assert.ok(validatePrefixRule({ ...rule, specialTrigger: 'Column Switch' }).some(issue => issue.field === 'specialReplacement'));
  assert.ok(validatePrefixRule({ ...rule, specialReplacement: 'Switch' }).some(issue => issue.field === 'specialTrigger'));
});

test('duplicate prefix is rejected even when existing rule is disabled but deleted history is ignored', () => {
  const rule = { id: 'new', prefix: '646', approvedPartTerms: ['A'], specialTrigger: null, specialReplacement: null, enabled: true };
  const existing = { ...rule, id: 'old', enabled: false };
  assert.ok(validatePrefixRule(rule, [existing]).some(issue => issue.field === 'prefix'));
  assert.deepEqual(validatePrefixRule(rule, [{ ...existing, deletedAt: '2026-09-17' }]), []);
});

test('hydration preserves valid rules, quarantines malformed entries, and future read excludes disabled and deleted', () => {
  const valid = { id: 'a', prefix: '046', approvedPartTerms: ['One'], specialTrigger: null, specialReplacement: null, enabled: true, origin: 'custom', priority: 20, deletedAt: null, deletedBy: null, createdAt: '2026-09-17T00:00:00.000Z', createdBy: 'Gary', updatedAt: '2026-09-17T00:00:00.000Z', updatedBy: 'Gary' };
  const disabled = { ...valid, id: 'b', prefix: '047', enabled: false, priority: 10 };
  const deleted = { ...valid, id: 'c', prefix: '048', deletedAt: '2026-09-17T00:00:00.000Z', deletedBy: 'Gary', priority: 5 };
  const malformed = { ...valid, id: 'd', prefix: '049', specialTrigger: 'Only trigger' };
  const hydrated = hydratePrefixRulesConfiguration({ rules: [valid, disabled, deleted, malformed] });
  assert.equal(hydrated.rules.length, 3);
  assert.equal(hydrated.quarantined.length, 1);
  assert.equal(hydrated.issues[0].id, 'd');
  assert.deepEqual(enabledPrefixRules(hydrated).map(rule => rule.prefix), ['046']);
});

test('a malformed entry does not hide a later valid rule with the same prefix', () => {
  const valid = { ...seedPrefixRulesConfiguration({ now: '2026-09-17T00:00:00.000Z', actor: 'Gary' }).rules[8], id: 'good' };
  const malformed = { ...valid, id: 'bad', approvedPartTerms: [] };
  const hydrated = hydratePrefixRulesConfiguration({ rules: [malformed, valid] });
  assert.deepEqual(hydrated.rules.map(rule => rule.id), ['good']);
  assert.deepEqual(hydrated.quarantined.map(rule => rule.id), ['bad']);
});

test('hydration quarantines missing origin or audit fields from future reads', () => {
  const seed = seedPrefixRulesConfiguration({ now: '2026-09-17T00:00:00.000Z', actor: 'Gary' });
  const valid = seed.rules[0];
  const missingOrigin = { ...seed.rules[1], origin: undefined };
  const missingAudit = { ...seed.rules[2], createdBy: '' };
  const malformedDeleted = { ...seed.rules[3], origin: 'custom', deletedAt: '2026-09-17T00:00:00.000Z', deletedBy: null };
  const hydrated = hydratePrefixRulesConfiguration({ rules: [valid, missingOrigin, missingAudit, malformedDeleted] });
  assert.deepEqual(hydrated.rules.map(rule => rule.id), [valid.id]);
  assert.deepEqual(enabledPrefixRules(hydrated).map(rule => rule.id), [valid.id]);
  assert.equal(hydrated.issues.length, 3);
});
