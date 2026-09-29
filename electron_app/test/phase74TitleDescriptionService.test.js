const test = require('node:test');
const assert = require('node:assert/strict');

const { applyAcceptedRuntimeTitle } = require('../src/services/phase74TitleDescriptionService');

function runtime(decision, title) {
  return {
    decision: { decision },
    output: { title }
  };
}

test('writes Item Title only for an accepted runtime candidate and never writes Title', () => {
  const fields = { Title: 'Existing eBay Title', 'Item Title': 'Previous generated title' };
  const writeFields = {};

  const changed = applyAcceptedRuntimeTitle(writeFields, fields,
    runtime('ACCEPT_CANDIDATE', '2011 Honda Accord Mirror 00123'));

  assert.equal(changed, true);
  assert.equal(writeFields['Item Title'], '2011 Honda Accord Mirror 00123');
  assert.equal(Object.hasOwn(writeFields, 'Title'), false);
});

test('preserves Item Title for every nonaccepted runtime decision', () => {
  for (const decision of ['NEEDS_REVIEW', 'RETAIN_EXISTING', 'BLOCKED', 'BYPASSED_MANUAL_OVERRIDE']) {
    const fields = { Title: 'Existing eBay Title', 'Item Title': 'Previous generated title' };
    const writeFields = {};

    const changed = applyAcceptedRuntimeTitle(writeFields, fields,
      runtime(decision, 'Unsafe proposal 00123'));

    assert.equal(changed, false, decision);
    assert.deepEqual(writeFields, {}, decision);
  }
});

test('rejects blank and overlength accepted titles at the Airtable boundary', () => {
  for (const title of ['', 'X'.repeat(81)]) {
    const writeFields = {};
    assert.equal(applyAcceptedRuntimeTitle(writeFields, {}, runtime('ACCEPT_CANDIDATE', title)), false);
    assert.deepEqual(writeFields, {});
  }
});

test('does not rewrite an unchanged accepted Item Title', () => {
  const title = '2011 Honda Accord Mirror 00123';
  const writeFields = {};
  assert.equal(applyAcceptedRuntimeTitle(writeFields, { 'Item Title': title },
    runtime('ACCEPT_CANDIDATE', title)), false);
  assert.deepEqual(writeFields, {});
});
