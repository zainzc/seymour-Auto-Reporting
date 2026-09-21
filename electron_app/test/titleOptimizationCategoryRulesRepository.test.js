const test = require('node:test');
const assert = require('node:assert/strict');
const { createTitleOptimizationCategoryRulesRepository } = require('../src/services/titleOptimizationCategoryRulesRepository');

const NOW = '2026-09-21T12:00:00.000Z';
function harness(initial, options = {}) {
  let stored = initial, writes = 0, ids = 0;
  const repository = createTitleOptimizationCategoryRulesRepository({
    getStored: () => stored,
    setStored: value => { if (options.failWrite) throw Error('disk unavailable'); stored = value; writes++; },
    getActor: options.getActor || (async () => 'gary'), now: () => NOW, createId: () => `custom-${++ids}`
  });
  return { repository, get stored() { return stored; }, get writes() { return writes; } };
}

test('seeds once only for absent storage and never reseeds existing empty configuration', async () => {
  const fresh = harness(undefined);
  assert.equal((await fresh.repository.load()).rules.length, 20);
  await fresh.repository.load();
  assert.equal(fresh.writes, 1);
  const empty = harness({ version: 1, rules: [] });
  assert.equal((await empty.repository.load()).rules.length, 0);
  assert.equal(empty.writes, 0);
});

test('seeded identity references details notes and enabled are editable while deletion remains blocked', async () => {
  const h = harness(undefined);
  const engines = (await h.repository.load()).rules[0];
  const saved = await h.repository.saveRule({ ...engines, categoryName: 'Motors', prefixRefs: ['300'], seriesRefs: [], priorityDetails: ['Engine Code', 'Size'], note: 'Changed\nExactly', enabled: false });
  assert.deepEqual({ categoryName: saved.categoryName, prefixRefs: saved.prefixRefs, seriesRefs: saved.seriesRefs }, { categoryName: 'Motors', prefixRefs: ['300'], seriesRefs: [] });
  assert.deepEqual(saved.priorityDetails, ['Engine Code', 'Size']);
  assert.equal(saved.note, 'Changed\nExactly');
  assert.equal(saved.enabled, false);
  await assert.rejects(h.repository.softDelete(engines.id), error => error.code === 'PROTECTED_RULE');
});

test('custom CRUD is audited normalized unique and soft-deleted names can be reused', async () => {
  const h = harness(undefined); await h.repository.load();
  const custom = await h.repository.saveRule({ categoryName: ' Turbo   Assemblies ', prefixRefs: ['T'], seriesRefs: ['T'], priorityDetails: ['Type', 'Color'], note: null, enabled: true });
  assert.equal(custom.categoryName, 'Turbo   Assemblies');
  assert.deepEqual({ origin: custom.origin, seedOrder: custom.seedOrder, createdBy: custom.createdBy }, { origin: 'custom', seedOrder: null, createdBy: 'gary' });
  await assert.rejects(h.repository.saveRule({ categoryName: ' turbo assemblies ', prefixRefs: [], seriesRefs: [], priorityDetails: ['One'], enabled: false }), error => error.code === 'VALIDATION_ERROR');
  const edited = await h.repository.saveRule({ ...custom, categoryName: 'Turbo Assembly', priorityDetails: ['Color', 'Type'] });
  assert.deepEqual(edited.priorityDetails, ['Color', 'Type']);
  await h.repository.softDelete(edited.id);
  assert.deepEqual({ enabled: h.stored.rules.at(-1).enabled, deletedAt: h.stored.rules.at(-1).deletedAt, deletedBy: h.stored.rules.at(-1).deletedBy }, { enabled: false, deletedAt: NOW, deletedBy: 'gary' });
  assert.equal((await h.repository.saveRule({ categoryName: ' turbo assembly ', prefixRefs: [], seriesRefs: [], priorityDetails: ['One'], enabled: true })).categoryName, 'turbo assembly');
});

test('malformed raw entries survive unrelated writes and failed persistence remains atomic', async () => {
  const seed = (await harness(undefined).repository.load()).rules;
  const broken = { id: 'broken', categoryName: 'Broken' };
  const h = harness({ version: 1, rules: [broken, seed[0], seed[1]] });
  const loaded = await h.repository.load();
  assert.equal(loaded.rules.length, 2); assert.equal(loaded.issues.length, 1);
  await h.repository.setRuleEnabled(seed[1].id, false);
  assert.deepEqual(h.stored.rules[0], broken);
  const failed = harness(h.stored, { failWrite: true });
  await assert.rejects(failed.repository.setRuleEnabled(seed[1].id, true), error => error.code === 'PERSISTENCE_ERROR');
  assert.equal(failed.stored.rules[2].enabled, false);
});

test('concurrent mutations serialize and future reads exclude invalid disabled and deleted rules', async () => {
  let stored, actorCalls = 0;
  const h = createTitleOptimizationCategoryRulesRepository({
    getStored: () => stored, setStored: value => { stored = value; }, now: () => NOW,
    getActor: async () => { actorCalls++; if (actorCalls > 1) await new Promise(resolve => setTimeout(resolve, 5)); return 'gary'; }
  });
  const initial = await h.load();
  await Promise.all([h.setRuleEnabled(initial.rules[0].id, false), h.setRuleEnabled(initial.rules[1].id, false)]);
  assert.equal(stored.rules.find(rule => rule.id === initial.rules[0].id).enabled, false);
  assert.equal(stored.rules.find(rule => rule.id === initial.rules[1].id).enabled, false);
  assert.equal((await h.getTitleOptimizationCategoryRules()).length, 18);
});

test('concurrent first-run loads share initialization and cannot overwrite a later mutation', async () => {
  let stored, actorCalls = 0;
  let releaseActor;
  const actorGate = new Promise(resolve => { releaseActor = resolve; });
  const repository = createTitleOptimizationCategoryRulesRepository({
    getStored: () => stored, setStored: value => { stored = value; }, now: () => NOW,
    getActor: async () => { actorCalls++; if (actorCalls === 1) await actorGate; return 'gary'; }
  });
  const first = repository.load(), second = repository.load();
  releaseActor();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(actorCalls, 1);
  assert.equal(one.rules.length, 20); assert.equal(two.rules.length, 20);
  await repository.setRuleEnabled(one.rules[0].id, false);
  assert.equal(stored.rules[0].enabled, false);
});
