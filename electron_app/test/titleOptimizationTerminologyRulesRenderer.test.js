const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminologyRulesController } = require('../src/renderer/pages/title-optimization/terminology-rules.js');

function rule(overrides = {}) {
  return { id: 'client-v5-01', sourceTerm: 'Headlamp', action: 'replace', replacementTerm: 'Headlight', condition: 'always', conditionConfig: null, appliesTo: 'all', priority: 10, enabled: true, origin: 'client-v5', note: null, ...overrides };
}

function harness(overrides = {}) {
  const calls = [];
  const api = {
    load: async () => ({ success: true, data: { rules: [rule()], issues: [], updatedAt: '2026-09-17T12:00:00.000Z' } }),
    save: async input => { calls.push(['save', input]); return { success: true, data: { ...input, id: input.id || 'custom-1', origin: input.id ? 'client-v5' : 'custom' } }; },
    setEnabled: async (id, enabled) => { calls.push(['toggle', id, enabled]); return { success: true, data: { ...rule(), id, enabled } }; },
    softDelete: async id => { calls.push(['delete', id]); return { success: true, data: { id } }; },
    ...overrides.api
  };
  const controller = createTerminologyRulesController({ api, confirmDiscard: overrides.confirmDiscard || (async () => true), confirmDelete: overrides.confirmDelete || (async () => true) });
  return { controller, calls };
}

test('Add and Edit keep form changes local until Save Rule', async () => {
  const h = harness();
  await h.controller.load();
  h.controller.beginAdd();
  h.controller.setFormField('sourceTerm', 'New Term');
  h.controller.setFormField('replacementTerm', 'Preferred Term');
  assert.equal(h.controller.state.dirty, true);
  assert.deepEqual(h.calls, []);
  await h.controller.save();
  assert.equal(h.calls[0][0], 'save');
  assert.equal(h.calls[0][1].sourceTerm, 'New Term');
  assert.equal(h.calls[0][1].priority, 20);
  assert.equal(h.controller.state.dirty, false);
  await h.controller.beginEdit('client-v5-01');
  h.controller.setFormField('replacementTerm', 'New Headlight');
  assert.equal(h.calls.length, 1);
  await h.controller.save();
  assert.equal(h.calls[1][1].id, 'client-v5-01');
  assert.equal(h.calls[1][1].replacementTerm, 'New Headlight');
  assert.equal(h.calls[1][1].priority, 10);
});

test('Remove sends null replacement and Context Verified sends structured outcomes', async () => {
  const h = harness();
  await h.controller.load();
  h.controller.beginAdd();
  h.controller.setFormField('sourceTerm', 'User Defined');
  h.controller.setFormField('action', 'remove');
  await h.controller.save();
  assert.equal(h.calls[0][1].replacementTerm, null);
  h.controller.beginAdd();
  h.controller.setFormField('sourceTerm', 'Anti-Lock Brake Part');
  h.controller.setFormField('replacementTerm', 'ABS Module');
  h.controller.setFormField('condition', 'context-verified');
  h.controller.setFormField('verificationCriterion', 'pump-verified');
  h.controller.setFormField('verifiedReplacement', 'ABS Pump');
  h.controller.setFormField('otherwiseReplacement', 'ABS Module');
  await h.controller.save();
  assert.deepEqual(h.calls[1][1].conditionConfig, { criterion: 'pump-verified', whenVerified: 'ABS Pump', otherwise: 'ABS Module' });
});

test('dependent form controls refresh when action or condition changes', async () => {
  const h = harness();
  await h.controller.load();
  h.controller.setFormField('replacementTerm', 'Old value');
  const beforeAction = h.controller.state.formRevision;
  h.controller.setFormField('action', 'remove');
  assert.equal(h.controller.state.form.replacementTerm, '');
  assert.ok(h.controller.state.formRevision > beforeAction);
  const beforeCondition = h.controller.state.formRevision;
  h.controller.setFormField('condition', 'transmission-context');
  assert.equal(h.controller.state.form.appliesTo, 'transmission');
  assert.ok(h.controller.state.formRevision > beforeCondition);
});

test('Add asks before discarding an unsaved form', async () => {
  let approved = false;
  const h = harness({ confirmDiscard: async () => approved });
  await h.controller.load();
  h.controller.setFormField('sourceTerm', 'Draft');
  assert.equal(await h.controller.beginAdd(), false);
  assert.equal(h.controller.state.form.sourceTerm, 'Draft');
  approved = true;
  assert.equal(await h.controller.beginAdd(), true);
  assert.equal(h.controller.state.form.sourceTerm, '');
});

test('search and condition/status filters narrow displayed rows without mutating rules', async () => {
  const h = harness({ api: { load: async () => ({ success: true, data: { rules: [rule(), rule({ id: 'custom-2', sourceTerm: 'Auto', replacementTerm: 'Automatic', condition: 'transmission-context', appliesTo: 'transmission', enabled: false, origin: 'custom' })], issues: [] } }) } });
  await h.controller.load();
  h.controller.setFilters({ search: 'automatic', condition: 'all', status: 'all' });
  assert.deepEqual(h.controller.filteredRules().map(item => item.id), ['custom-2']);
  h.controller.setFilters({ search: '', condition: 'transmission-context', status: 'disabled' });
  assert.deepEqual(h.controller.filteredRules().map(item => item.id), ['custom-2']);
  assert.equal(h.controller.state.rules.length, 2);
});

test('Enabled toggle persists immediately and reverts on failure', async () => {
  const h = harness();
  await h.controller.load();
  await h.controller.toggle('client-v5-01', false);
  assert.deepEqual(h.calls[0], ['toggle', 'client-v5-01', false]);
  assert.equal(h.controller.state.rules[0].enabled, false);
  const failing = harness({ api: { setEnabled: async () => ({ success: false, error: { message: 'Disk unavailable' } }) } });
  await failing.controller.load();
  await assert.rejects(failing.controller.toggle('client-v5-01', false), /Disk unavailable/);
  assert.equal(failing.controller.state.rules[0].enabled, true);
  assert.match(failing.controller.state.error, /Disk unavailable/);
});

test('seeded rules cannot be deleted and custom deletion requires confirmation', async () => {
  let allowDelete = false;
  const h = harness({ confirmDelete: async () => allowDelete, api: { load: async () => ({ success: true, data: { rules: [rule(), rule({ id: 'custom-1', origin: 'custom' })], issues: [] } }) } });
  await h.controller.load();
  assert.equal(await h.controller.deleteRule('client-v5-01'), false);
  assert.equal(await h.controller.deleteRule('custom-1'), false);
  assert.deepEqual(h.calls, []);
  allowDelete = true;
  assert.equal(await h.controller.deleteRule('custom-1'), true);
  assert.deepEqual(h.calls, [['delete', 'custom-1']]);
  assert.equal(h.controller.state.rules.length, 1);
});

test('failed form save preserves draft and displays field errors', async () => {
  const h = harness({ api: { save: async () => ({ success: false, error: { message: 'Correct the form', details: [{ field: 'replacementTerm', message: 'Required' }] } }) } });
  await h.controller.load();
  h.controller.beginAdd();
  h.controller.setFormField('sourceTerm', 'New Term');
  await assert.rejects(h.controller.save(), /Correct the form/);
  assert.equal(h.controller.state.form.sourceTerm, 'New Term');
  assert.equal(h.controller.state.dirty, true);
  assert.equal(h.controller.state.formErrors.replacementTerm, 'Required');
});

test('dirty navigation uses discard confirmation and authorizes one unload', async () => {
  let approved = false;
  const h = harness({ confirmDiscard: async () => approved });
  await h.controller.load();
  h.controller.setFormField('sourceTerm', 'Draft');
  assert.equal(await h.controller.canNavigateAway(), false);
  assert.equal(h.controller.shouldBlockUnload(), true);
  approved = true;
  assert.equal(await h.controller.canNavigateAway(), true);
  assert.equal(h.controller.shouldBlockUnload(), false);
  assert.equal(h.controller.shouldBlockUnload(), true);
});

test('closing the editor preserves an unsaved draft unless discard is confirmed', async () => {
  let approved = false;
  const h = harness({ confirmDiscard: async () => approved });
  await h.controller.load();
  h.controller.setFormField('sourceTerm', 'Draft rule');
  assert.equal(await h.controller.cancel(), false);
  assert.equal(h.controller.state.form.sourceTerm, 'Draft rule');
  approved = true;
  assert.equal(await h.controller.cancel(), true);
  assert.equal(h.controller.state.form.sourceTerm, '');
  assert.equal(h.controller.state.dirty, false);
});
