const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrefixRulesController } = require('../src/renderer/pages/title-optimization/prefix-rules.js');

const seeded = { id: 'client-v5-646', prefix: '646', approvedPartTerms: ['Fuse Box Engine Bay'], specialTrigger: null, specialReplacement: null, note: null, enabled: true, origin: 'client-v5', priority: 90 };
function harness(overrides = {}) {
  const calls = [];
  const api = {
    load: async () => ({ success: true, data: { rules: [seeded], issues: [], updatedAt: null } }),
    save: async input => { calls.push(['save', input]); return { success: true, data: { ...input, id: input.id || 'custom-1', origin: input.id ? 'client-v5' : 'custom', updatedAt: 'now' } }; },
    setRuleEnabled: async (id, enabled) => { calls.push(['toggle', id, enabled]); return { success: true, data: { ...seeded, id, enabled } }; },
    softDelete: async id => { calls.push(['delete', id]); return { success: true, data: { id } }; },
    ...overrides.api
  };
  const controller = createPrefixRulesController({ api, confirmDiscard: overrides.confirmDiscard || (async () => true), confirmDelete: overrides.confirmDelete || (async () => true) });
  return { controller, calls };
}

test('Add/Edit keeps terms local until Save and locks a seeded prefix', async () => {
  const h = harness();
  await h.controller.load();
  await h.controller.beginAdd();
  h.controller.setFormField('prefix', '046');
  h.controller.setTermDraft('First');
  h.controller.addTerm();
  h.controller.setTermDraft('Second');
  assert.deepEqual(h.calls, []);
  await h.controller.save();
  assert.deepEqual(h.calls[0][1].approvedPartTerms, ['First', 'Second']);
  assert.equal(h.calls[0][1].prefix, '046');
  await h.controller.beginEdit('client-v5-646');
  assert.equal(h.controller.state.prefixLocked, true);
  assert.equal(h.controller.setFormField('prefix', '647'), false);
  h.controller.setFormField('note', 'Reviewed');
  await h.controller.save();
  assert.equal(h.calls[1][1].prefix, '646');
  assert.equal(h.calls[1][1].note, 'Reviewed');
});

test('incomplete special pair blocks save with an inline error and preserves draft', async () => {
  const h = harness();
  await h.controller.load();
  await h.controller.beginAdd();
  h.controller.setFormField('prefix', '900');
  h.controller.setTermDraft('Part');
  h.controller.addTerm();
  h.controller.setFormField('specialTrigger', 'Source');
  await assert.rejects(h.controller.save(), /both a trigger and a replacement/);
  assert.ok(h.controller.state.formErrors.specialReplacement);
  assert.equal(h.controller.state.dirty, true);
  assert.deepEqual(h.calls, []);
});

test('immediate Enabled toggle rolls back on failure', async () => {
  const h = harness({ api: { setRuleEnabled: async () => ({ success: false, error: { message: 'Disk unavailable' } }) } });
  await h.controller.load();
  await assert.rejects(h.controller.toggleRule('client-v5-646', false), /Disk unavailable/);
  assert.equal(h.controller.state.rules[0].enabled, true);
  assert.match(h.controller.state.error, /restored/);
});

test('search covers prefix, approved terms, trigger, and replacement while status filters', async () => {
  const second = { ...seeded, id: 'custom-1', prefix: '629', approvedPartTerms: ['Wiper Switch'], specialTrigger: 'Column Switch', specialReplacement: 'Multifunction Switch', enabled: false, origin: 'custom' };
  const h = harness({ api: { load: async () => ({ success: true, data: { rules: [seeded, second], issues: [] } }) } });
  await h.controller.load();
  for (const query of ['629', 'Wiper', 'Column', 'Multifunction']) {
    h.controller.setFilters({ search: query, status: 'disabled' });
    assert.deepEqual(h.controller.filteredRules().map(rule => rule.id), ['custom-1']);
  }
});

test('seeded deletion is blocked; custom delete and dirty dismissal require confirmation', async () => {
  let approve = false;
  const custom = { ...seeded, id: 'custom-1', prefix: '900', origin: 'custom' };
  const h = harness({ confirmDelete: async () => approve, confirmDiscard: async () => approve, api: { load: async () => ({ success: true, data: { rules: [seeded, custom], issues: [] } }) } });
  await h.controller.load();
  assert.equal(await h.controller.deleteRule('client-v5-646'), false);
  assert.equal(await h.controller.deleteRule('custom-1'), false);
  approve = true;
  assert.equal(await h.controller.deleteRule('custom-1'), true);
  await h.controller.beginAdd();
  h.controller.setFormField('prefix', '901');
  approve = false;
  assert.equal(await h.controller.cancel(), false);
  assert.equal(await h.controller.canNavigateAway(), false);
  approve = true;
  assert.equal(await h.controller.cancel(), true);
});

test('in-flight Save cannot be dismissed or superseded', async () => {
  let finishSave;
  const h = harness({ api: { save: async input => new Promise(resolve => { finishSave = () => resolve({ success: true, data: { ...input, id: 'custom-1', origin: 'custom' } }); }) } });
  await h.controller.load();
  await h.controller.beginAdd();
  h.controller.setFormField('prefix', '901');
  h.controller.setTermDraft('Part');
  const pending = h.controller.save();
  assert.equal(await h.controller.cancel(), false);
  assert.equal(await h.controller.beginAdd(), false);
  assert.equal(await h.controller.canNavigateAway(), false);
  assert.equal(h.controller.shouldBlockUnload(), true);
  finishSave();
  await pending;
  assert.equal(h.controller.state.saving, false);
});
