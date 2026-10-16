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

test('structure segments default to required and can be explicitly marked optional', () => {
  const controller = createTitleStructureController({ api: {} });
  controller.state.form = { structureName: 'Custom', appliesTo: 'Parts', segments: [], note: '', enabled: true };
  assert.equal(controller.addSegment('Year'), true);
  assert.equal(controller.state.form.segments[0].optional, false);
  assert.equal(controller.setSegmentOptional(0, true), true);
  assert.equal(controller.state.form.segments[0].optional, true);
  assert.equal(controller.state.dirty, true);
});
