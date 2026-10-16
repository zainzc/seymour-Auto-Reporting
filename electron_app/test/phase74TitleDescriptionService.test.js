const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applyAcceptedRuntimeTitle,
  buildAirbagTitleLockUpdate,
  runtimeOutputFailure,
  shouldSkipEnrichedListing,
  runPhase74TitleDescription
} = require('../src/services/phase74TitleDescriptionService');
const AirtableService = require('../src/services/airtableService');
const AirtableSchemaService = require('../src/services/airtableSchemaService');

test('airbag title lock is triggered only by the source Title field', () => {
  const locked = buildAirbagTitleLockUpdate({
    Title: '2009 Nissan Altima Air Bag Control Module 1569517',
    'Item Title': 'Existing generated title',
    'Item Description': 'Existing description'
  });

  assert.deepEqual(locked, {
    matched: true,
    fields: {
      'Title Review Status': 'Airbag - Locked',
      'Title Review Reason': 'Airbag title locked',
      'Title Review Notes': 'Source Title identifies an airbag; Phase 7.4 left title and description unchanged.'
    }
  });
  assert.equal(Object.hasOwn(locked.fields, 'Title'), false);
  assert.equal(Object.hasOwn(locked.fields, 'Item Title'), false);
  assert.equal(Object.hasOwn(locked.fields, 'Item Description'), false);
});

test('airbag in generated Item Title alone does not activate the source-title lock', () => {
  assert.equal(buildAirbagTitleLockUpdate({
    Title: '2009 Nissan Altima Control Module 1569517',
    'Item Title': '2009 Nissan Altima Air Bag Control Module 1569517'
  }), null);
});

test('airbag lock skips enriched listings without calling AI or changing title content', async () => {
  const originalFetchAllRecords = AirtableService.prototype.fetchAllRecords;
  const originalRequest = AirtableService.prototype.request;
  const originalListTables = AirtableSchemaService.prototype.listTables;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase74-airbag-lock-'));
  const patches = [];
  let masterFetches = 0;
  let runtimeCalls = 0;
  const listing = {
    id: 'recAirbagLock',
    fields: {
      'IPN (Interchange Part Number)': '1569517',
      Title: '2009 Nissan Altima Air Bag Control Module 1569517',
      'Item Title': 'Existing generated title 1569517',
      'Item Description': 'Existing generated description',
      'Title Review Status': 'Completed',
      'Title Review Reason': '',
      'Title Review Notes': ''
    }
  };

  AirtableService.prototype.fetchAllRecords = async tableName => {
    assert.equal(tableName, 'Listings');
    return [listing];
  };
  AirtableService.prototype.request = async (method, url, options = {}) => {
    if (method === 'GET') {
      masterFetches += 1;
      return { records: [] };
    }
    if (method === 'PATCH') patches.push(options.data);
    return {};
  };
  AirtableSchemaService.prototype.listTables = async () => [{
    id: 'tblListings',
    name: 'Listings',
    fields: [
      { name: 'Item Title' },
      { name: 'Item Description' },
      { name: 'Title Review Status' },
      { name: 'Title Review Reason' },
      { name: 'Title Review Notes' }
    ]
  }];

  try {
    const summary = await runPhase74TitleDescription({
      airtableToken: 'test-token',
      airtableBaseId: 'test-base',
      phase74ListingsTable: 'Listings',
      airtableMasterTable: 'Master',
      openaiApiKey: 'test-key',
      phase74AiRequestLogDirectory: tempDir,
      phase74LogAiPayload: false,
      titleOptimizationRuntimeService: {
        async run() {
          runtimeCalls += 1;
          throw new Error('Airbag-locked listing must not call AI');
        }
      }
    });

    assert.equal(runtimeCalls, 0);
    assert.equal(masterFetches, 0);
    assert.equal(summary.titleReviewAirbagLocked, 1);
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].records, [{
      id: 'recAirbagLock',
      fields: {
        'Title Review Status': 'Airbag - Locked',
        'Title Review Reason': 'Airbag title locked',
        'Title Review Notes': 'Source Title identifies an airbag; Phase 7.4 left title and description unchanged.'
      }
    }]);
  } finally {
    AirtableService.prototype.fetchAllRecords = originalFetchAllRecords;
    AirtableService.prototype.request = originalRequest;
    AirtableSchemaService.prototype.listTables = originalListTables;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

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

test('rejects a blank title but writes an AI-accepted overlength title to Airtable', () => {
  const writeFields = {};
  assert.equal(applyAcceptedRuntimeTitle(writeFields, {}, runtime('ACCEPT_CANDIDATE', '')), false);
  assert.deepEqual(writeFields, {});

  const title = 'X'.repeat(81);
  assert.equal(applyAcceptedRuntimeTitle(writeFields, {}, runtime('ACCEPT_CANDIDATE', title)), true);
  assert.equal(writeFields['Item Title'], title);
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
