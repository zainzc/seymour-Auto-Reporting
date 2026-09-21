const test = require('node:test');
const assert = require('node:assert/strict');
const { createTitleStructureController } = require('../src/renderer/pages/title-optimization/title-structure');

test('dirty Title Structure navigation asks before leaving', async () => {
  let answer = false;
  const controller = createTitleStructureController({ api: {}, confirmDiscard: async () => answer });
  controller.setField('structureName', 'Changed');
  assert.equal(await controller.canNavigateAway(), false);
  answer = true;
  assert.equal(await controller.canNavigateAway(), true);
  assert.equal(controller.shouldBlockUnload(), false);
  assert.equal(controller.shouldBlockUnload(), true);
});
