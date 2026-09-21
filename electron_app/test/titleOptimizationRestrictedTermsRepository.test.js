const test = require('node:test');
const assert = require('node:assert/strict');
const { createTitleOptimizationRestrictedTermsRepository } = require('../src/services/titleOptimizationRestrictedTermsRepository');

const NOW = '2026-09-18T12:00:00.000Z';

function harness(initial, failWrite = false) {
  let stored = initial;
  let writes = 0;
  let nextId = 0;
  const repository = createTitleOptimizationRestrictedTermsRepository({
    getStored: () => stored,
    setStored: value => { if (failWrite) throw Error('disk unavailable'); stored = value; writes++; },
    getActor: async () => 'gary', now: () => NOW, createId: () => `custom-${++nextId}`
  });
  return { repository, get stored() { return stored; }, get writes() { return writes; } };
}

test('seeds exactly once only when stored configuration is absent', async () => {
  const fresh = harness(undefined);
  assert.equal((await fresh.repository.load()).rules.length, 20);
  await fresh.repository.load();
  assert.equal(fresh.writes, 1);
  const existing = harness({ version: 1, rules: [] });
  assert.equal((await existing.repository.load()).rules.length, 0);
  assert.equal(existing.writes, 0);
});

test('seeded identity fields can change while safety rules stay enabled and all seeded rules stay non-deletable', async () => {
  const h = harness(undefined);
  const longBlock = (await h.repository.load()).rules.find(rule => rule.term === 'Long Block');
  const rebuilt = (await h.repository.load()).rules.find(rule => rule.term === 'Rebuilt');
  const updated = await h.repository.saveRule({ ...rebuilt, term: 'Refurbished', ruleType: 'remove-noise', scope: 'all', note: 'Reviewed', enabled: false });
  assert.deepEqual({ term: updated.term, ruleType: updated.ruleType, scope: updated.scope }, { term: 'Refurbished', ruleType: 'remove-noise', scope: 'all' });
  assert.equal(updated.note, 'Reviewed');
  assert.equal(updated.enabled, false);
  await assert.rejects(h.repository.setRuleEnabled(longBlock.id, false), error => error.code === 'LOCKED_RULE');
  await assert.rejects(h.repository.saveRule({ ...longBlock, enabled: false }), error => error.code === 'LOCKED_RULE');
  const renamedSafetyRule = await h.repository.saveRule({ ...longBlock, term: 'Engine Block', ruleType: 'must-preserve', scope: 'all', enabled: true });
  assert.deepEqual({ term: renamedSafetyRule.term, ruleType: renamedSafetyRule.ruleType, scope: renamedSafetyRule.scope }, { term: 'Engine Block', ruleType: 'must-preserve', scope: 'all' });
  await assert.rejects(h.repository.softDelete(longBlock.id), error => error.code === 'PROTECTED_RULE');
  await assert.rejects(h.repository.softDelete(rebuilt.id), error => error.code === 'PROTECTED_RULE');
});

test('concurrent rule toggles serialize their whole-configuration writes', async () => {
  let stored;
  let actorCalls = 0;
  const repository = createTitleOptimizationRestrictedTermsRepository({
    getStored: () => stored, setStored: value => { stored = value; },
    getActor: async () => {
      actorCalls++;
      if (actorCalls > 1) await new Promise(resolve => setTimeout(resolve, 5));
      return 'gary';
    },
    now: () => NOW
  });
  const initial = await repository.load();
  const complete = initial.rules.find(rule => rule.term === 'Complete');
  const rebuilt = initial.rules.find(rule => rule.term === 'Rebuilt');
  await Promise.all([repository.setRuleEnabled(complete.id, false), repository.setRuleEnabled(rebuilt.id, false)]);
  assert.equal(stored.rules.find(rule => rule.id === complete.id).enabled, false);
  assert.equal(stored.rules.find(rule => rule.id === rebuilt.id).enabled, false);
});

test('custom terms support audit-backed CRUD, normalized duplicate protection, and reuse after soft delete', async () => {
  const h = harness(undefined);
  await h.repository.load();
  const custom = await h.repository.saveRule({ term: ' Turbo   Kit ', ruleType: 'never-introduce', scope: 'engine', note: 'Avoid guessing', enabled: true });
  assert.equal(custom.term, 'Turbo   Kit');
  assert.deepEqual({ origin: custom.origin, locked: custom.locked, createdBy: custom.createdBy, updatedBy: custom.updatedBy }, { origin: 'custom', locked: false, createdBy: 'gary', updatedBy: 'gary' });
  const edited = await h.repository.saveRule({ ...custom, term: 'Turbo Kit', ruleType: 'remove-noise', scope: 'all', enabled: false });
  assert.equal(edited.ruleType, 'remove-noise');
  await assert.rejects(h.repository.saveRule({ term: ' turbo kit ', ruleType: 'must-preserve', scope: 'all', enabled: true }), error => error.code === 'VALIDATION_ERROR');
  await h.repository.softDelete(edited.id);
  assert.deepEqual({ enabled: h.stored.rules.at(-1).enabled, deletedAt: h.stored.rules.at(-1).deletedAt, deletedBy: h.stored.rules.at(-1).deletedBy }, { enabled: false, deletedAt: NOW, deletedBy: 'gary' });
  const reused = await h.repository.saveRule({ term: 'turbo kit', ruleType: 'must-preserve', scope: 'all', enabled: true });
  assert.equal(reused.term, 'turbo kit');
});

test('partial malformed storage is preserved during writes and persistence failure leaves stored data untouched', async () => {
  const seed = await harness(undefined).repository.load();
  const valid = seed.rules.find(rule => rule.term === 'Complete');
  const longBlock = seed.rules.find(rule => rule.term === 'Long Block');
  const shortBlock = seed.rules.find(rule => rule.term === 'Short Block');
  const broken = { id: 'broken', term: 'Broken', enabled: true };
  const h = harness({ version: 1, rules: [broken, longBlock, shortBlock, valid] });
  const loaded = await h.repository.load();
  assert.equal(loaded.rules.length, 3);
  assert.equal(loaded.issues.length, 1);
  await h.repository.setRuleEnabled(valid.id, false);
  assert.deepEqual(h.stored.rules[0], broken);
  const failed = harness(h.stored, true);
  await assert.rejects(failed.repository.setRuleEnabled(valid.id, true), error => error.code === 'PERSISTENCE_ERROR');
  assert.equal(failed.stored.rules[3].enabled, false);
});

test('future read injects locked terms for damaged persisted configuration without persisting a repair', async () => {
  const seed = await harness(undefined).repository.load();
  const disabledLong = { ...seed.rules.find(rule => rule.term === 'Long Block'), enabled: false };
  const h = harness({ version: 1, rules: [disabledLong] });
  const loaded = await h.repository.load();
  assert.ok(loaded.issues.some(issue => /Long Block.*canonical enabled rule/i.test(issue.message)));
  assert.deepEqual((await h.repository.getTitleOptimizationRestrictedTerms()).map(rule => rule.term), ['Long Block', 'Short Block']);
  assert.equal(h.writes, 0);
});
