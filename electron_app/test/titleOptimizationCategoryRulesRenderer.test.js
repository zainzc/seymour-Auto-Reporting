const test = require('node:test');
const assert = require('node:assert/strict');
const { createCategoryRulesController } = require('../src/renderer/pages/title-optimization/category-rules.js');

const response = data => ({ success: true, data });
const rule = (overrides = {}) => ({ id: 'client-v5-engines', categoryName: 'Engines', prefixRefs: [], seriesRefs: ['300 Series'], priorityDetails: ['Size', 'Engine Code'], note: 'Note', enabled: true, origin: 'client-v5', seedOrder: 1, ...overrides });

test('seeded identity references details notes and enabled are draft editable', async () => {
  const saves = [];
  const controller = createCategoryRulesController({ api: {
    load: async () => response({ rules: [rule()], issues: [] }),
    save: async input => { saves.push(input); return response(rule(input)); }
  } });
  await controller.load(); await controller.beginEdit('client-v5-engines');
  assert.equal(controller.setFormField('categoryName', 'Motors'), true);
  assert.equal(controller.addChip('prefixRefs', '300'), true);
  assert.equal(controller.removeChip('seriesRefs', 0), true);
  controller.setFormField('note', 'Changed\nLine'); controller.setFormField('enabled', false);
  controller.addChip('priorityDetails', 'VIN Identifier');
  await controller.save();
  assert.equal(saves[0].categoryName, 'Motors');
  assert.deepEqual(saves[0].prefixRefs, ['300']);
  assert.deepEqual(saves[0].seriesRefs, []);
  assert.deepEqual(saves[0].priorityDetails, ['Size', 'Engine Code', 'VIN Identifier']);
  assert.equal(saves[0].enabled, false);
});

test('chip lists reject normalized duplicates and detail movement remains local until save', async () => {
  let writes = 0;
  const controller = createCategoryRulesController({ api: { load: async () => response({ rules: [], issues: [] }), save: async input => { writes++; return response({ ...input, id: 'custom-1', origin: 'custom', seedOrder: null }); } } });
  await controller.load(); await controller.beginAdd();
  controller.setFormField('categoryName', 'Custom');
  assert.equal(controller.addChip('prefixRefs', ' 323 '), true);
  assert.equal(controller.addChip('prefixRefs', '  323  '), false);
  controller.addChip('seriesRefs', '323');
  controller.addChip('priorityDetails', 'First'); controller.addChip('priorityDetails', 'Second');
  assert.equal(controller.moveDetail(1, -1), true);
  assert.deepEqual(controller.state.form.priorityDetails, ['Second', 'First']);
  assert.equal(writes, 0);
  await controller.save(); assert.equal(writes, 1);
});

test('search status and reference presence filters combine while preserving server order', async () => {
  const rules = [rule(), rule({ id: 'custom-a', categoryName: 'Alpha', origin: 'custom', seedOrder: null, prefixRefs: ['1'], seriesRefs: [], note: 'Find me' }), rule({ id: 'custom-b', categoryName: 'Beta', origin: 'custom', seedOrder: null, prefixRefs: [], seriesRefs: [], enabled: false })];
  const controller = createCategoryRulesController({ api: { load: async () => response({ rules, issues: [] }) } });
  await controller.load();
  controller.setFilters({ search: 'find', status: 'enabled', references: 'has-prefix' });
  assert.deepEqual(controller.filteredRules().map(item => item.id), ['custom-a']);
  controller.setFilters({ search: '', status: 'all', references: 'no-references' });
  assert.deepEqual(controller.filteredRules().map(item => item.id), ['custom-b']);
});

test('immediate toggle rolls back on failure and does not mark popup dirty', async () => {
  const controller = createCategoryRulesController({ api: { load: async () => response({ rules: [rule()], issues: [] }), setRuleEnabled: async () => ({ success: false, error: { message: 'Write failed' } }) } });
  await controller.load();
  await assert.rejects(controller.toggleRule('client-v5-engines', false), /Write failed/);
  assert.equal(controller.state.rules[0].enabled, true);
  assert.equal(controller.state.dirty, false);
});

test('custom delete and dirty navigation require confirmation while seeded delete is blocked', async () => {
  let discard = false, deleted = false;
  const controller = createCategoryRulesController({ api: {
    load: async () => response({ rules: [rule(), rule({ id: 'custom-1', categoryName: 'Custom', origin: 'custom', seedOrder: null })], issues: [] }),
    softDelete: async id => { deleted = id === 'custom-1'; return response({ id }); }
  }, confirmDiscard: async () => discard, confirmDelete: async () => true });
  await controller.load();
  assert.equal(await controller.deleteRule('client-v5-engines'), false);
  assert.equal(await controller.deleteRule('custom-1'), true); assert.equal(deleted, true);
  await controller.beginAdd(); controller.setFormField('categoryName', 'Unsaved');
  assert.equal(await controller.canNavigateAway(), false);
  discard = true; assert.equal(await controller.canNavigateAway(), true); assert.equal(controller.shouldBlockUnload(), false);
});

test('failed save retains the complete popup draft and field errors', async () => {
  const controller = createCategoryRulesController({ api: {
    load: async () => response({ rules: [], issues: [] }),
    save: async () => ({ success: false, error: { message: 'Invalid', details: [{ field: 'categoryName', message: 'Duplicate category.' }] } })
  } });
  await controller.load(); await controller.beginAdd();
  controller.setFormField('categoryName', 'Custom'); controller.addChip('priorityDetails', 'Color'); controller.setFormField('enabled', false);
  await assert.rejects(controller.save(), /Invalid/);
  assert.equal(controller.state.form.categoryName, 'Custom'); assert.deepEqual(controller.state.form.priorityDetails, ['Color']);
  assert.equal(controller.state.form.enabled, false); assert.equal(controller.state.formErrors.categoryName, 'Duplicate category.');
});

test('adding or renaming custom rules immediately restores deterministic display order', async () => {
  const savedRules = [
    rule({ id: 'custom-z', categoryName: 'Zulu', origin: 'custom', seedOrder: null }),
    rule({ id: 'custom-a', categoryName: 'Alpha', origin: 'custom', seedOrder: null })
  ];
  const controller = createCategoryRulesController({ api: {
    load: async () => response({ rules: [rule(), savedRules[0]], issues: [] }),
    save: async input => response(savedRules.find(item => item.id === input.id) || savedRules[1])
  } });
  await controller.load(); await controller.beginAdd(); controller.setFormField('categoryName', 'Alpha'); controller.addChip('priorityDetails', 'One'); await controller.save();
  assert.deepEqual(controller.state.rules.map(item => item.categoryName), ['Engines', 'Alpha', 'Zulu']);
  await controller.beginEdit('custom-z'); controller.setFormField('categoryName', 'Beta');
  savedRules[0] = { ...savedRules[0], categoryName: 'Beta' }; await controller.save();
  assert.deepEqual(controller.state.rules.map(item => item.categoryName), ['Engines', 'Alpha', 'Beta']);
});

test('overlapping delete and toggle completions update rows by stable ID', async () => {
  let finishDelete, finishToggle;
  const deleting = new Promise(resolve => { finishDelete = resolve; });
  const toggling = new Promise(resolve => { finishToggle = resolve; });
  const alpha = rule({ id: 'a', categoryName: 'Alpha', origin: 'custom', seedOrder: null });
  const beta = rule({ id: 'b', categoryName: 'Beta', origin: 'custom', seedOrder: null });
  const controller = createCategoryRulesController({ api: {
    load: async () => response({ rules: [alpha, beta], issues: [] }),
    softDelete: async () => deleting,
    setRuleEnabled: async () => toggling
  }, confirmDelete: async () => true });
  await controller.load();
  const deletePromise = controller.deleteRule('a');
  const togglePromise = controller.toggleRule('b', false);
  finishDelete(response({ id: 'a' })); await deletePromise;
  finishToggle(response({ ...beta, enabled: false })); await togglePromise;
  assert.deepEqual(controller.state.rules.map(item => [item.id, item.enabled]), [['b', false]]);
});

test('pending chip text is protected as draft, flushed on save, and cleared after accepted reset', async () => {
  const saves = [];
  let discard = false;
  const controller = createCategoryRulesController({ api: {
    load: async () => response({ rules: [], issues: [] }),
    save: async input => { saves.push(input); return response({ ...input, id: 'custom-1', origin: 'custom', seedOrder: null }); }
  }, confirmDiscard: async () => discard });
  await controller.load(); await controller.beginAdd();
  controller.setFormField('categoryName', 'Custom'); controller.setChipDraft('priorityDetails', ' Pending detail ');
  assert.equal(controller.state.dirty, true); assert.equal(await controller.cancel(), false);
  await controller.save();
  assert.deepEqual(saves[0].priorityDetails, ['Pending detail']);
  assert.equal(controller.state.chipDrafts.priorityDetails, '');
  await controller.beginAdd(); controller.setChipDraft('prefixRefs', 'stale'); discard = true; assert.equal(await controller.cancel(), true);
  assert.deepEqual(controller.state.chipDrafts, { prefixRefs: '', seriesRefs: '', priorityDetails: '' });
});

test('column switch combined priority detail is split before save', async () => {
  const saves = [];
  const controller = createCategoryRulesController({ api: {
    load: async () => response({ rules: [rule({ id: 'client-v5-column-switch', categoryName: 'Column Switch', prefixRefs: ['629'], priorityDetails: ['Wiper / Turn Signal / Multifunction'], seedOrder: 9 })], issues: [] }),
    save: async input => { saves.push(input); return response({ ...input, origin: 'client-v5', updatedAt: '2026-09-28T00:00:00.000Z' }); }
  } });
  await controller.load();
  await controller.beginEdit('client-v5-column-switch');
  await controller.save();
  assert.deepEqual(saves[0].priorityDetails, ['Wiper', 'Turn Signal', 'Multifunction']);
});
