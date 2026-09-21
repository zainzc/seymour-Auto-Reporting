const test = require('node:test');
const assert = require('node:assert/strict');
const { createSystemRulesController } = require('../src/renderer/pages/title-optimization/system-rules');

test('System Rules search and category filters preserve canonical order', async () => {
  const rules = [
    { id:'SR-01', title:'Never Guess', category:'Safety', behavior:'Accuracy', locked:true },
    { id:'SR-02', title:'Manual Override', category:'Protection', behavior:'Do not overwrite', locked:true },
    { id:'SR-03', title:'Fitment', category:'Safety', behavior:'Preserve', locked:true }
  ];
  const controller = createSystemRulesController({ api: { load: async () => ({ success:true, data:rules }) } });
  await controller.load();
  controller.setFilters({ category:'Safety', search:'preserve' });
  assert.deepEqual(controller.filtered().map(rule => rule.id), ['SR-03']);
});
