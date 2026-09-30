const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyAcceptedRuntimeTitle,
  runtimeOutputFailure
} = require('../src/services/phase74TitleDescriptionService');

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

test('does not classify an intentionally withheld review title as blank AI output', () => {
  const result = {
    decision: { decision: 'RETAIN_EXISTING' },
    output: {
      title: '',
      proposedTitle: '2009 Nissan Altima Air Bag Control Module 1569517',
      description: 'Generated description',
      reviewStatus: 'Needs Review',
      reviewReason: 'Multiple year ranges require review'
    }
  };

  assert.equal(runtimeOutputFailure(result, false), null);
});

test('reports missing required output only for accepted title or generated description', () => {
  assert.equal(runtimeOutputFailure({
    decision: { decision: 'ACCEPT_CANDIDATE' },
    output: { title: '', description: 'Generated description' }
  }, false), 'accepted_title_missing');
  assert.equal(runtimeOutputFailure({
    decision: { decision: 'RETAIN_EXISTING' },
    output: { title: '', description: '' }
  }, false), 'description_missing');
});

test('does not replace a pre-generation source review with ai blank output', () => {
  assert.equal(runtimeOutputFailure({
    decision: { decision: 'NEEDS_REVIEW' },
    output: {
      title: '',
      description: '',
      generationSkipped: true,
      reviewStatus: 'Needs Review',
      reviewReason: 'Invalid Part Fitment date'
    }
  }, false), null);
});
