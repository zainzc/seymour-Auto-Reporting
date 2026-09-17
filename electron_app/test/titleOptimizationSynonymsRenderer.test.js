const test = require('node:test');
const assert = require('node:assert/strict');
const { createSynonymsController } = require('../src/renderer/pages/title-optimization/synonyms.js');

const baseRule = { id: 'client-v5-01', primaryTerm: 'Headlight', synonyms: ['Headlamp'], condition: 'always', appliesTo: 'all', priority: 10, enabled: true, origin: 'client-v5' };

function harness(overrides = {}) {
  const calls = [];
  const api = {
    load: async () => ({ success: true, data: { enabled: true, rules: [baseRule], policies: { cvAxleFrontHalfShaft: { condition: 'confirmed-front-half-shaft', note: 'CV Axle may only be used for a confirmed FRONT half-shaft; never for rear axle or axle housing.' } }, issues: [], updatedAt: null } }),
    save: async input => { calls.push(['save', input]); return { success: true, data: { ...input, id: input.id || 'custom-1', origin: input.id ? 'client-v5' : 'custom' } }; },
    setRuleEnabled: async (id, enabled) => { calls.push(['rule-toggle', id, enabled]); return { success: true, data: { ...baseRule, id, enabled } }; },
    setMasterEnabled: async enabled => { calls.push(['master-toggle', enabled]); return { success: true, data: { enabled } }; },
    softDelete: async id => { calls.push(['delete', id]); return { success: true, data: { id } }; },
    ...overrides.api
  };
  const controller = createSynonymsController({ api, confirmDiscard: overrides.confirmDiscard || (async () => true), confirmDelete: overrides.confirmDelete || (async () => true) });
  return { controller, calls };
}

test('Add/Edit keeps multiple synonyms local until Save and retains internal priority', async () => {
  const h = harness();
  await h.controller.load();
  await h.controller.beginAdd();
  h.controller.setFormField('primaryTerm', 'Side View Mirror');
  h.controller.setSynonymDraft('Door Mirror');
  h.controller.addSynonym();
  h.controller.setSynonymDraft('Side Mirror');
  assert.deepEqual(h.calls, []);
  await h.controller.save();
  assert.deepEqual(h.calls[0][1].synonyms, ['Door Mirror', 'Side Mirror']);
  assert.equal(h.calls[0][1].priority, 20);
  await h.controller.beginEdit('client-v5-01');
  h.controller.setFormField('primaryTerm', 'Headlight Assembly');
  await h.controller.save();
  assert.equal(h.calls[1][1].priority, 10);
  assert.equal(h.calls[1][1].id, 'client-v5-01');
});

test('master and individual toggles persist immediately and revert on failure', async () => {
  const h = harness();
  await h.controller.load();
  await h.controller.toggleMaster(false);
  await h.controller.toggleRule('client-v5-01', false);
  assert.deepEqual(h.calls, [['master-toggle', false], ['rule-toggle', 'client-v5-01', false]]);
  assert.equal(h.controller.state.enabled, false);
  assert.equal(h.controller.state.rules[0].enabled, false);

  const failing = harness({ api: {
    setMasterEnabled: async () => ({ success: false, error: { message: 'Disk unavailable' } }),
    setRuleEnabled: async () => ({ success: false, error: { message: 'Disk unavailable' } })
  } });
  await failing.controller.load();
  await assert.rejects(failing.controller.toggleMaster(false), /Disk unavailable/);
  await assert.rejects(failing.controller.toggleRule('client-v5-01', false), /Disk unavailable/);
  assert.equal(failing.controller.state.enabled, true);
  assert.equal(failing.controller.state.rules[0].enabled, true);
});

test('search and filters include synonym text but never treat the CV policy as a normal row', async () => {
  const h = harness({ api: { load: async () => ({ success: true, data: { enabled: true, rules: [baseRule, { ...baseRule, id: 'custom-1', primaryTerm: 'Mirror', synonyms: ['Door Mirror'], condition: 'always', enabled: false, origin: 'custom' }], policies: { cvAxleFrontHalfShaft: { note: 'CV Axle may only be used for a confirmed FRONT half-shaft.' } }, issues: [] } }) } });
  await h.controller.load();
  h.controller.setFilters({ search: 'door mirror', status: 'disabled' });
  assert.deepEqual(h.controller.filteredRules().map(rule => rule.id), ['custom-1']);
  h.controller.setFilters({ search: 'CV Axle', status: 'all' });
  assert.deepEqual(h.controller.filteredRules(), []);
});

test('seeded deletion is blocked, custom deletion is confirmed, and dirty popup closes safely', async () => {
  let approve = false;
  const h = harness({ confirmDelete: async () => approve, confirmDiscard: async () => approve, api: { load: async () => ({ success: true, data: { enabled: true, rules: [baseRule, { ...baseRule, id: 'custom-1', primaryTerm: 'Mirror', origin: 'custom' }], policies: {}, issues: [] } }) } });
  await h.controller.load();
  assert.equal(await h.controller.deleteRule('client-v5-01'), false);
  assert.equal(await h.controller.deleteRule('custom-1'), false);
  approve = true;
  assert.equal(await h.controller.deleteRule('custom-1'), true);
  await h.controller.beginAdd();
  h.controller.setFormField('primaryTerm', 'Draft');
  approve = false;
  assert.equal(await h.controller.cancel(), false);
  assert.equal(await h.controller.canNavigateAway(), false);
  approve = true;
  assert.equal(await h.controller.cancel(), true);
  assert.equal(h.controller.state.dirty, false);
});

test('an in-flight Save cannot be discarded, replaced, or closed before its result', async () => {
  let finishSave;
  const h = harness({ api: { save: async input => new Promise(resolve => { finishSave = () => resolve({ success: true, data: { ...input, id: 'custom-1', origin: 'custom' } }); }) } });
  await h.controller.load();
  await h.controller.beginAdd();
  h.controller.setFormField('primaryTerm', 'Hood');
  h.controller.setSynonymDraft('Bonnet');
  const pending = h.controller.save();
  assert.equal(h.controller.state.saving, true);
  assert.equal(await h.controller.cancel(), false);
  assert.equal(await h.controller.beginAdd(), false);
  assert.equal(await h.controller.canNavigateAway(), false);
  assert.equal(h.controller.shouldBlockUnload(), true);
  finishSave();
  await pending;
  assert.equal(h.controller.state.saving, false);
  assert.equal(h.controller.state.rules.at(-1).primaryTerm, 'Hood');
});
