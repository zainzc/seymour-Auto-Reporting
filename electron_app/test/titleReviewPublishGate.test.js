const test = require('node:test');
const assert = require('node:assert/strict');
const { isTitleApprovedForPublish } = require('../src/services/titleReviewPublishGate');

test('only completed or explicitly manual titles pass the publish gate', () => {
  assert.equal(isTitleApprovedForPublish({ 'Title Review Status': 'Completed' }), true);
  assert.equal(isTitleApprovedForPublish({ 'Title Review Status': 'Skipped - Manual Override' }), true);
  for (const status of ['Needs Review', 'Airbag - Locked', '', 'Unknown']) {
    assert.equal(isTitleApprovedForPublish({ 'Title Review Status': status }), false);
  }
});

test('an overlength review draft cannot publish after its status is changed', () => {
  assert.equal(isTitleApprovedForPublish({
    'Title Review Status': 'Completed',
    'Item Title': 'X'.repeat(81)
  }), false);
  assert.equal(isTitleApprovedForPublish({
    'Title Review Status': 'Completed',
    'Item Title': 'X'.repeat(80)
  }), true);
  assert.equal(isTitleApprovedForPublish({
    'Title Review Status': 'Skipped - Manual Override',
    'Item Title': 'X'.repeat(81)
  }), false);
});
