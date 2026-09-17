const test = require('node:test');
const assert = require('node:assert/strict');
const { createTitleOptimizationTerminologyRulesRepository } = require('../src/services/titleOptimizationTerminologyRulesRepository');

function harness(initial, options = {}) {
  let stored = initial;
  let writes = 0;
  const repository = createTitleOptimizationTerminologyRulesRepository({
    getStored: () => stored,
    setStored: value => {
      if (options.failWrite) throw new Error('disk unavailable');
      stored = value;
      writes += 1;
    },
    getActor: async () => options.actor || 'gary@example.com',
    now: () => '2026-09-17T12:00:00.000Z',
    createId: () => 'custom-1'
  });
  return { repository, get stored() { return stored; }, get writes() { return writes; } };
}

function custom(overrides = {}) {
  return {
    sourceTerm: 'Power Window Motor', action: 'replace', replacementTerm: 'Window Motor',
    condition: 'always', conditionConfig: null, appliesTo: 'all', priority: 345, enabled: true,
    ...overrides
  };
}

test('undefined storage seeds once but an existing empty configuration never reseeds', async () => {
  const fresh = harness(undefined);
  const first = await fresh.repository.load();
  assert.equal(first.rules.length, 34);
  assert.equal(fresh.writes, 1);
  await fresh.repository.load();
  assert.equal(fresh.writes, 1);
  assert.equal(fresh.stored.updatedBy, 'gary@example.com');

  const empty = harness({ version: 1, rules: [], updatedAt: 'old', updatedBy: 'owner' });
  assert.deepEqual((await empty.repository.load()).rules, []);
  assert.equal(empty.writes, 0);
  const malformed = harness(null);
  assert.equal((await malformed.repository.load()).rules.length, 0);
  assert.equal(malformed.writes, 0);
});

test('custom Replace and Remove rules can be saved with audit metadata', async () => {
  const h = harness({ version: 1, rules: [] });
  const replace = await h.repository.saveRule(custom());
  assert.equal(replace.id, 'custom-1');
  assert.equal(replace.origin, 'custom');
  assert.equal(replace.createdBy, 'gary@example.com');
  assert.equal(h.stored.rules.length, 1);
  const removed = await h.repository.saveRule(custom({ id: 'custom-1', action: 'remove', replacementTerm: null }));
  assert.equal(removed.action, 'remove');
  assert.equal(removed.replacementTerm, null);
  assert.equal(removed.createdAt, replace.createdAt);
  assert.equal(h.stored.updatedBy, 'gary@example.com');
});

test('seeded rules can be edited and toggled but cannot be deleted', async () => {
  const h = harness(undefined);
  const initial = await h.repository.load();
  const headlamp = initial.rules[0];
  const edited = await h.repository.saveRule({ ...headlamp, replacementTerm: 'Preferred Headlight' });
  assert.equal(edited.origin, 'client-v5');
  assert.equal(edited.replacementTerm, 'Preferred Headlight');
  const disabled = await h.repository.setEnabled(headlamp.id, false);
  assert.equal(disabled.enabled, false);
  assert.equal((await h.repository.load()).rules[0].enabled, false);
  await assert.rejects(h.repository.softDelete(headlamp.id), error => error.code === 'PROTECTED_RULE');
});

test('custom deletion is soft, audited, and excluded from normal and runtime reads', async () => {
  const h = harness({ version: 1, rules: [] });
  const saved = await h.repository.saveRule(custom());
  await h.repository.softDelete(saved.id);
  assert.equal(h.stored.rules[0].deletedAt, '2026-09-17T12:00:00.000Z');
  assert.equal(h.stored.rules[0].deletedBy, 'gary@example.com');
  assert.equal(h.stored.rules[0].enabled, false);
  assert.equal((await h.repository.load()).rules.length, 0);
  assert.deepEqual(await h.repository.getTitleOptimizationTerminologyRules(), []);
});

test('invalid saves and failed persistence keep the previous config intact', async () => {
  const h = harness({ version: 1, rules: [] });
  await assert.rejects(h.repository.saveRule(custom({ replacementTerm: '' })), error => error.code === 'VALIDATION_ERROR');
  assert.equal(h.stored.rules.length, 0);
  const failing = harness({ version: 1, rules: [] }, { failWrite: true });
  await assert.rejects(failing.repository.saveRule(custom()), error => error.code === 'PERSISTENCE_ERROR');
  assert.equal(failing.stored.rules.length, 0);
  await assert.rejects(failing.repository.setEnabled('missing', false), error => error.code === 'NOT_FOUND');
});

test('partially malformed storage keeps valid entries and preserves invalid raw entries on save', async () => {
  const seed = await harness(undefined).repository.load();
  const good = seed.rules[0];
  const broken = { id: 'broken', sourceTerm: '' };
  const h = harness({ version: 1, rules: [good, broken] });
  const loaded = await h.repository.load();
  assert.deepEqual(loaded.rules.map(rule => rule.id), [good.id]);
  assert.equal(loaded.issues[0].id, 'broken');
  await h.repository.setEnabled(good.id, false);
  assert.deepEqual(h.stored.rules[1], broken);
  assert.equal(h.stored.rules[0].enabled, false);
  assert.equal(h.writes, 1);
});

test('runtime read returns only enabled valid rules in priority order', async () => {
  const h = harness(undefined);
  await h.repository.load();
  await h.repository.setEnabled('client-v5-01', false);
  const active = await h.repository.getTitleOptimizationTerminologyRules();
  assert.equal(active.length, 33);
  assert.equal(active[0].id, 'client-v5-02');
  assert.equal(active.at(-1).id, 'client-v5-34');
});
