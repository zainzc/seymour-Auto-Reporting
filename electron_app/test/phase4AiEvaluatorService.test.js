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
    materialRestrictions: [{ detail: 'VIN J', appliesTo: '2014-2015', sourceRowIds: ['title-fitment-001'], material: true, titleTreatment: 'included' }],
    restrictedTermDecisions: [{ term: 'Complete Assembly', used: false, authorized: false, source: null, evidence: null }],
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
    'needs-review'
  ]);
  assert.deepEqual(schema.properties.categoryPriorityDetails.items.properties.detail.enum, ['Engine Code']);
  assert.deepEqual(result.materialRestrictions, responsePayload.materialRestrictions);
  assert.deepEqual(result.restrictedTermDecisions, responsePayload.restrictedTermDecisions);
  assert.deepEqual(result.titleSegments, responsePayload.titleSegments);
  assert.deepEqual(result.ruleSelfAudit, responsePayload.ruleSelfAudit);
});
