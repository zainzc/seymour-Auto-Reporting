const test = require('node:test');
const assert = require('node:assert/strict');
const { createRestrictedTermsController } = require('../src/renderer/pages/title-optimization/restricted-terms.js');

const rule = (overrides = {}) => ({ id: 'client-v5-ecm', term: 'ECM', ruleType: 'must-preserve', scope: 'all', note: '', enabled: true, origin: 'client-v5', locked: false, ...overrides });
const response = data => ({ success: true, data });

test('seeded identity is read-only but notes and enabled can change', async () => {
  const saves = [];
  const controller = createRestrictedTermsController({ api: {
    load: async () => response({ rules: [rule()], issues: [] }),
    save: async input => { saves.push(input); return response(rule({ ...input })); }
  } });
  await controller.load();
  await controller.beginEdit('client-v5-ecm');
  assert.equal(controller.setFormField('term', 'Other'), false);
  assert.equal(controller.setFormField('ruleType', 'remove-noise'), false);
  assert.equal(controller.setFormField('scope', 'engine'), false);
  controller.setFormField('note', 'Keep when verified');
  await controller.save();
  assert.equal(saves[0].term, 'ECM');
  assert.equal(saves[0].note, 'Keep when verified');
});

test('locked rule cannot be disabled and failed immediate toggle rolls back', async () => {
  const controller = createRestrictedTermsController({ api: {
    load: async () => response({ rules: [rule({ id: 'client-v5-long-block', term: 'Long Block', locked: true }), rule()], issues: [] }),
    setRuleEnabled: async () => ({ success: false, error: { message: 'Write failed' } })
  } });
  await controller.load();
  assert.equal(await controller.toggleRule('client-v5-long-block', false), false);
  await assert.rejects(controller.toggleRule('client-v5-ecm', false), /Write failed/);
  assert.equal(controller.state.rules.find(item => item.id === 'client-v5-ecm').enabled, true);
});

test('dirty Add/Edit draft blocks navigation until confirmed', async () => {
  let confirmed = false;
  const controller = createRestrictedTermsController({ api: { load: async () => response({ rules: [], issues: [] }) }, confirmDiscard: async () => confirmed });
  await controller.load();
  await controller.beginAdd();
  controller.setFormField('term', 'New term');
  assert.equal(await controller.canNavigateAway(), false);
  confirmed = true;
  assert.equal(await controller.canNavigateAway(), true);
  assert.equal(controller.shouldBlockUnload(), false);
});

test('search and type, scope, status filters combine without mutating rules', async () => {
  const controller = createRestrictedTermsController({ api: { load: async () => response({ rules: [
    rule({ id: 'one', term: 'Tested', note: 'Engine approval', scope: 'engine', ruleType: 'requires-authorization', enabled: false }),
    rule({ id: 'two', term: 'OEM Part', note: 'Remove from title', scope: 'all', ruleType: 'remove-noise' })
  ], issues: [] }) } });
  await controller.load();
  controller.setFilters({ search: 'approval', type: 'requires-authorization', scope: 'engine', status: 'disabled' });
  assert.deepEqual(controller.filteredRules().map(item => item.id), ['one']);
  controller.setFilters({ scope: 'all-categories' });
  assert.equal(controller.filteredRules().length, 0);
  assert.equal(controller.state.rules.length, 2);
});

test('only custom rules can be soft-deleted after confirmation', async () => {
  const deleted = [];
  const controller = createRestrictedTermsController({ api: {
    load: async () => response({ rules: [rule(), rule({ id: 'custom-1', term: 'Other', origin: 'custom' })], issues: [] }),
    softDelete: async id => { deleted.push(id); return response({ id }); }
  }, confirmDelete: async () => true });
  await controller.load();
  assert.equal(await controller.deleteRule('client-v5-ecm'), false);
  assert.equal(await controller.deleteRule('custom-1'), true);
  assert.deepEqual(deleted, ['custom-1']);
  assert.deepEqual(controller.state.rules.map(item => item.id), ['client-v5-ecm']);
});
