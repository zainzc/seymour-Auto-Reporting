const test = require('node:test');
const assert = require('node:assert/strict');
const { createTitleOptimizationSynonymsRepository } = require('../src/services/titleOptimizationSynonymsRepository');

function harness(initial, failWrite = false) {
  let stored = initial;
  let writes = 0;
  const repository = createTitleOptimizationSynonymsRepository({
    getStored: () => stored,
    setStored: value => { if (failWrite) throw Error('disk unavailable'); stored = value; writes++; },
    getActor: async () => 'gary', now: () => '2026-09-17T12:00:00.000Z', createId: () => 'custom-1'
  });
  return { repository, get stored() { return stored; }, get writes() { return writes; } };
}

test('seeds only absent storage and preserves existing empty or malformed storage', async () => {
  const fresh = harness(undefined);
  assert.equal((await fresh.repository.load()).rules.length, 10);
  await fresh.repository.load();
  assert.equal(fresh.writes, 1);
  for (const raw of [{ version: 1, enabled: false, rules: [] }, null]) {
    const existing = harness(raw);
    assert.equal((await existing.repository.load()).rules.length, 0);
    assert.equal(existing.writes, 0);
  }
});

test('edits and toggles seeded rules but rejects deletion', async () => {
  const h = harness(undefined);
  const first = (await h.repository.load()).rules[0];
  const edited = await h.repository.saveRule({ ...first, synonyms: ['Head Lamp'] });
  assert.deepEqual(edited.synonyms, ['Head Lamp']);
  assert.equal(edited.createdAt, first.createdAt);
  assert.equal(edited.updatedBy, 'gary');
  assert.equal((await h.repository.setRuleEnabled(first.id, false)).enabled, false);
  await assert.rejects(h.repository.softDelete(first.id), error => error.code === 'PROTECTED_RULE');
});

test('custom soft deletion and master toggle update audit and future reads', async () => {
  const h = harness(undefined);
  await h.repository.load();
  const saved = await h.repository.saveRule({ primaryTerm: 'Hood', synonyms: ['Bonnet'], condition: 'always', appliesTo: 'all', priority: 110, enabled: true });
  assert.equal(saved.origin, 'custom');
  assert.equal((await h.repository.getTitleOptimizationSynonymConfig()).rules.length, 11);
  const master = await h.repository.setMasterEnabled(false);
  assert.equal(master.enabled, false);
  assert.equal((await h.repository.getTitleOptimizationSynonymConfig()).enabled, false);
  await h.repository.softDelete(saved.id);
  assert.equal(h.stored.rules.at(-1).deletedBy, 'gary');
  assert.equal((await h.repository.getTitleOptimizationSynonymConfig()).rules.length, 10);
});

test('valid edits preserve invalid raw entries and failed writes leave storage intact', async () => {
  const seed = await harness(undefined).repository.load();
  const broken = { id: 'broken', primaryTerm: '' };
  const h = harness({ version: 1, enabled: true, rules: [seed.rules[0], broken], policies: seed.policies });
  assert.equal((await h.repository.load()).issues.length, 1);
  await h.repository.setRuleEnabled(seed.rules[0].id, false);
  assert.deepEqual(h.stored.rules[1], broken);
  const bad = harness(h.stored, true);
  await assert.rejects(bad.repository.setMasterEnabled(false), error => error.code === 'PERSISTENCE_ERROR');
  assert.equal(bad.stored.enabled, true);
});
