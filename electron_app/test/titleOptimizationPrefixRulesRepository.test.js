const test = require('node:test');
const assert = require('node:assert/strict');
const { createTitleOptimizationPrefixRulesRepository } = require('../src/services/titleOptimizationPrefixRulesRepository');

function harness(initial, failWrite = false) {
  let stored = initial;
  let writes = 0;
  let nextId = 0;
  const repository = createTitleOptimizationPrefixRulesRepository({
    getStored: () => stored,
    setStored: value => { if (failWrite) throw Error('disk unavailable'); stored = value; writes++; },
    getActor: async () => 'gary', now: () => '2026-09-17T12:00:00.000Z', createId: () => `custom-${++nextId}`
  });
  return { repository, get stored() { return stored; }, get writes() { return writes; } };
}

test('seeds exactly once only when configuration is absent', async () => {
  const fresh = harness(undefined);
  assert.equal((await fresh.repository.load()).rules.length, 11);
  await fresh.repository.load();
  assert.equal(fresh.writes, 1);
  for (const raw of [{ version: 1, rules: [] }, null]) {
    const existing = harness(raw);
    assert.equal((await existing.repository.load()).rules.length, 0);
    assert.equal(existing.writes, 0);
  }
});

test('seeded prefix and all popup fields can change while the seeded rule remains non-deletable', async () => {
  const h = harness(undefined);
  const first = (await h.repository.load()).rules[0];
  const edited = await h.repository.saveRule({ ...first, prefix: '235', approvedPartTerms: ['Accelerator'], specialTrigger: 'Source', specialReplacement: 'Buyer', note: 'Reviewed', enabled: false });
  assert.equal(edited.prefix, '235');
  assert.deepEqual(edited.approvedPartTerms, ['Accelerator']);
  assert.equal(edited.specialReplacement, 'Buyer');
  assert.equal(edited.updatedBy, 'gary');
  await assert.rejects(h.repository.softDelete(first.id), error => error.code === 'PROTECTED_RULE');
  assert.equal((await h.repository.setRuleEnabled(first.id, true)).enabled, true);
});

test('disabled rule reserves prefix while custom prefixes preserve leading zeros and can be edited', async () => {
  const h = harness(undefined);
  const first = (await h.repository.load()).rules[0];
  await h.repository.setRuleEnabled(first.id, false);
  await assert.rejects(h.repository.saveRule({ prefix: '234', approvedPartTerms: ['Duplicate'], enabled: true }), error => error.code === 'VALIDATION_ERROR');
  const saved = await h.repository.saveRule({ prefix: '046', approvedPartTerms: ['Part'], enabled: true });
  assert.equal(saved.prefix, '046');
  assert.equal(saved.origin, 'custom');
  const edited = await h.repository.saveRule({ ...saved, prefix: '047' });
  assert.equal(edited.prefix, '047');
  await h.repository.softDelete(edited.id);
  assert.equal(h.stored.rules.at(-1).deletedBy, 'gary');
  assert.equal(h.stored.rules.at(-1).enabled, false);
  assert.deepEqual((await h.repository.getTitleOptimizationPrefixRules()).map(rule => rule.prefix).includes('047'), false);
  const reused = await h.repository.saveRule({ prefix: '047', approvedPartTerms: ['New'], enabled: true });
  assert.equal(reused.prefix, '047');
});

test('partial corruption preserves valid records without reseeding and failed writes preserve storage', async () => {
  const seed = await harness(undefined).repository.load();
  const broken = { id: 'broken', prefix: '', approvedPartTerms: [] };
  const h = harness({ version: 1, rules: [seed.rules[0], broken] });
  assert.equal((await h.repository.load()).rules.length, 1);
  assert.equal((await h.repository.load()).issues.length, 1);
  await h.repository.setRuleEnabled(seed.rules[0].id, false);
  assert.deepEqual(h.stored.rules[1], broken);
  assert.equal(h.writes, 1);
  const bad = harness(h.stored, true);
  await assert.rejects(bad.repository.setRuleEnabled(seed.rules[0].id, true), error => error.code === 'PERSISTENCE_ERROR');
  assert.equal(bad.stored.rules[0].enabled, false);
});

test('special pair validation prevents incomplete saves and future read excludes invalid entries', async () => {
  const h = harness(undefined);
  await h.repository.load();
  await assert.rejects(h.repository.saveRule({ prefix: '900', approvedPartTerms: ['Part'], specialTrigger: 'Only', enabled: true }), error => error.code === 'VALIDATION_ERROR' && error.details.some(issue => issue.field === 'specialReplacement'));
  await assert.rejects(h.repository.saveRule({ prefix: '900', approvedPartTerms: ['Part'], specialTrigger: 0, specialReplacement: null, enabled: true }), error => error.code === 'VALIDATION_ERROR' && error.details.some(issue => issue.field === 'specialTrigger'));
  const custom = await h.repository.saveRule({ prefix: '900', approvedPartTerms: ['Part'], specialTrigger: 'Source', specialReplacement: 'Buyer', enabled: true });
  assert.equal(custom.specialTrigger, 'Source');
  assert.equal((await h.repository.getTitleOptimizationPrefixRules()).length, 12);
});

test('malformed duplicate history does not block editing or toggling a valid rule', async () => {
  const seed = await harness(undefined).repository.load();
  const valid = seed.rules.find(rule => rule.prefix === '646');
  const malformed = { id: 'broken-646', prefix: '646', approvedPartTerms: [], enabled: false };
  const h = harness({ version: 1, rules: [malformed, valid] });
  assert.deepEqual((await h.repository.load()).rules.map(rule => rule.id), [valid.id]);
  await h.repository.setRuleEnabled(valid.id, false);
  const edited = await h.repository.saveRule({ ...valid, approvedPartTerms: ['Engine Bay Fuse Box'] });
  assert.deepEqual(edited.approvedPartTerms, ['Engine Bay Fuse Box']);
  assert.deepEqual(h.stored.rules[0], malformed);
});

test('editing a rule can clear an existing note', async () => {
  const h = harness(undefined);
  const rule = (await h.repository.load()).rules.find(item => item.prefix === '257');
  const edited = await h.repository.saveRule({ ...rule, note: null });
  assert.equal(edited.note, null);
  assert.equal(h.stored.rules.find(item => item.id === rule.id).note, null);
});

test('a malformed record sharing an ID does not hijack a later valid rule edit', async () => {
  const seed = await harness(undefined).repository.load();
  const valid = seed.rules.find(rule => rule.prefix === '646');
  const malformed = { id: valid.id, prefix: '', approvedPartTerms: [] };
  const h = harness({ version: 1, rules: [malformed, valid] });
  assert.equal((await h.repository.load()).rules.length, 1);
  await h.repository.setRuleEnabled(valid.id, false);
  assert.deepEqual(h.stored.rules[0], malformed);
  assert.equal(h.stored.rules[1].enabled, false);
});

test('a quarantined malformed prefix does not reserve the prefix against a new valid rule', async () => {
  const malformed = { id: 'broken', prefix: '900', approvedPartTerms: [], enabled: false };
  const h = harness({ version: 1, rules: [malformed] });
  const saved = await h.repository.saveRule({ prefix: '900', approvedPartTerms: ['Part'], enabled: true });
  assert.equal(saved.prefix, '900');
  assert.deepEqual(h.stored.rules[0], malformed);
  assert.equal((await h.repository.getTitleOptimizationPrefixRules()).length, 1);
});

test('Delete targets the valid custom record when malformed history shares its ID', async () => {
  const fresh = harness(undefined);
  await fresh.repository.load();
  const custom = await fresh.repository.saveRule({ prefix: '900', approvedPartTerms: ['Part'], enabled: true });
  const malformed = { id: custom.id, prefix: '', approvedPartTerms: [] };
  const h = harness({ version: 1, rules: [malformed, custom] });
  await h.repository.softDelete(custom.id);
  assert.deepEqual(h.stored.rules[0], malformed);
  assert.equal(h.stored.rules[1].deletedBy, 'gary');
});
