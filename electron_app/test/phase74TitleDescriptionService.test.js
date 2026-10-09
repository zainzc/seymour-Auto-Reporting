const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  applyAcceptedRuntimeTitle,
  runtimeOutputFailure,
  shouldSkipEnrichedListing
} = require('../src/services/phase74TitleDescriptionService');

test('explicit IPN runs retry Needs Review rows without reprocessing completed rows', () => {
  const fields = {
    'Item Title': 'Previous title', 'Item Description': 'Previous description',
    'Title Review Status': 'Needs Review'
  };
  assert.equal(shouldSkipEnrichedListing(fields, false), true);
  assert.equal(shouldSkipEnrichedListing(fields, true), false);
  assert.equal(shouldSkipEnrichedListing({ ...fields, 'Title Review Status': 'Completed' }, true), true);
});

function runtime(decision, title, reviewStatus = '') {
  return {
    decision: { decision },
    output: { title, reviewStatus }
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

test('writes the generated Item Title while retaining Needs Review status', () => {
  for (const decision of ['NEEDS_REVIEW', 'RETAIN_EXISTING']) {
    const fields = { Title: 'Existing eBay Title', 'Item Title': 'Previous generated title' };
    const writeFields = {};

    const changed = applyAcceptedRuntimeTitle(writeFields, fields,
      runtime(decision, 'Review proposal 00123', 'Needs Review'));

    assert.equal(changed, true, decision);
    assert.equal(writeFields['Item Title'], 'Review proposal 00123', decision);
  }
});

test('preserves Item Title for blocked and manual-override runtime decisions', () => {
  for (const decision of ['BLOCKED', 'BYPASSED_MANUAL_OVERRIDE']) {
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

test('writes an overlength Needs Review draft but still rejects a blank title', () => {
  const writeFields = {};
  const title = 'X'.repeat(81);
  assert.equal(applyAcceptedRuntimeTitle(writeFields, {},
    runtime('NEEDS_REVIEW', title, 'Needs Review')), true);
  assert.equal(writeFields['Item Title'], title);
  assert.equal(applyAcceptedRuntimeTitle({}, {},
    runtime('NEEDS_REVIEW', '', 'Needs Review')), false);
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

test('writer does not override the AI review decision with title-text deduplication', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/phase74TitleDescriptionService.js'), 'utf8');
  assert.doesNotMatch(source, /duplicate_unresolved|usedTitleKeys/);
});
