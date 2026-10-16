const test = require('node:test');
const assert = require('node:assert/strict');

const Phase4AiEvaluatorService = require('../src/services/phase4AiEvaluatorService');

test('runtime generation schema requires structured rule decisions and parses them', async () => {
  const service = new Phase4AiEvaluatorService({ apiKey: 'test-key', maxAttempts: 1 });
  let requestBody;
  const responsePayload = {
    generatedTitle: '2014-2015 Honda Accord Engine VIN J 1234567',
    generatedDescription: 'Description',
    shortDescription: 'Short',
    reasoningSummary: 'Used supplied evidence.',
    titleReviewStatus: 'Completed',
    titleReviewReason: 'completed',
    titleReviewNotes: 'Selected one supported application.',
    categoryPriorityDetails: [{ detail: 'Engine Code', verified: true, source: 'evidence-001', evidence: 'VIN J' }],
    vehicleDecision: { resolved: true, make: 'Honda', model: 'Accord', yearRange: '2014-2015', source: 'title-fitment-001', evidence: null, reason: 'Supported.' },
    sideDecision: { side: null, placement: null, source: null, evidence: null },
    materialRestrictions: [{ detail: 'VIN J', appliesTo: '2014-2015', sourceRowIds: ['title-fitment-001'], evidence: '2014-2015 Honda Accord VIN J', material: true, titleTreatment: 'included', omissionReason: '' }],
    restrictedTermDecisions: [{ term: 'Complete Assembly', used: false, evidenceVerified: false, source: null, evidence: null }],
    titleSegments: [{ key: 'yearOrRange', value: '2014-2015' }, { key: 'sku', value: '1234567' }],
    ruleSelfAudit: { structureFollowed: true, unresolvedSourceConflict: false, unsupportedClaim: false, notes: 'All checks passed.' }
  };
  service.client = {
    post: async (_path, body) => {
      requestBody = body;
      return { data: { choices: [{ message: { content: JSON.stringify(responsePayload) } }] } };
    }
  };

  const result = await service.generateTitleAndDescriptionFromRuntimePrompt({
    systemMessage: 'Return valid JSON only.',
    userPayload: {
      titlePolicy: {
        categoryRules: [{ priorityDetails: [{ detail: 'Engine Code' }] }]
      }
    },
    metadata: { configurationVersion: 'v5' }
  });

  const schema = requestBody.response_format.json_schema.schema;
  for (const key of ['materialRestrictions', 'restrictedTermDecisions', 'titleSegments', 'ruleSelfAudit']) {
    assert.equal(schema.required.includes(key), true, key);
  }
  assert.deepEqual(schema.properties.materialRestrictions.items.properties.titleTreatment.enum, [
    'included',
    'not-applicable-to-selected-application',
    'omitted-safe',
    'needs-review'
  ]);
  assert.equal(schema.properties.materialRestrictions.items.required.includes('omissionReason'), true);
  assert.equal(schema.properties.materialRestrictions.items.properties.omissionReason.type, 'string');
  assert.equal(schema.properties.materialRestrictions.items.required.includes('evidence'), true);
  assert.deepEqual(schema.properties.materialRestrictions.items.properties.evidence.type, ['string', 'null']);
  assert.deepEqual(schema.properties.restrictedTermDecisions.items.required,
    ['term', 'used', 'evidenceVerified', 'source', 'evidence']);
  assert.deepEqual(schema.properties.categoryPriorityDetails.items.properties.detail.enum, ['Engine Code']);
  assert.deepEqual(result.materialRestrictions, responsePayload.materialRestrictions);
  assert.deepEqual(result.restrictedTermDecisions, responsePayload.restrictedTermDecisions);
  assert.deepEqual(result.titleSegments, responsePayload.titleSegments);
  assert.deepEqual(result.ruleSelfAudit, responsePayload.ruleSelfAudit);
});

test('single-attempt runtime generation does not retry a transient HTTP failure', async () => {
  const service = new Phase4AiEvaluatorService({ apiKey: 'test-key', maxAttempts: 4 });
  let calls = 0;
  service.client = { post: async () => {
    calls += 1;
    const error = new Error('Temporary server error');
    error.response = { status: 503 };
    throw error;
  } };

  await assert.rejects(service.generateTitleAndDescriptionFromRuntimePrompt(
    { systemMessage: 'Return valid JSON.', userPayload: {} }, null, { singleAttempt: true }
  ), /Temporary server error/);
  assert.equal(calls, 1);
});

test('single-attempt runtime generation does not resend after a prompt-cache rejection', async () => {
  const service = new Phase4AiEvaluatorService({ apiKey: 'test-key', maxAttempts: 4, promptCacheKey: 'runtime-test' });
  let calls = 0;
  service.client = { post: async () => {
    calls += 1;
    const error = new Error('Unknown parameter: prompt_cache_key');
    error.response = { status: 400 };
    throw error;
  } };

  await assert.rejects(service.generateTitleAndDescriptionFromRuntimePrompt(
    { systemMessage: 'Return valid JSON.', userPayload: {} }, null, { singleAttempt: true }
  ), /prompt_cache_key/);
  assert.equal(calls, 1);
});
