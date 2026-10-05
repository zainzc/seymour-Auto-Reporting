const test = require('node:test');
const assert = require('node:assert/strict');
const Phase4AiEvaluatorService = require('../src/services/phase4AiEvaluatorService');
const { buildFitmentReviewInput, checkedFitmentReview } = require('../src/services/titleOptimizationFitmentReviewService');

test('review input contains exact selected rows and the final title', () => {
  const input = buildFitmentReviewInput({
    title: '2008-2015 Nissan Rogue Starter Motor 1591087',
    vehicleDecision: { source: 'title-fitment-001;title-fitment-002' },
    promptArtifact: { userPayload: {
      existingTitle: { currentTitle: '2014 Nissan Rogueold Starter Fits 08-15 ROGUE 1591087' },
      resolvedListing: { titleFitmentCandidates: { eligibleCandidates: [
        { id: 'title-fitment-001', evidence: '2008-2013 Nissan Rogue Starter Motor' },
        { id: 'title-fitment-002', evidence: '2014-2015 Nissan Rogue Starter Motor VIN J Japan-built' },
        { id: 'title-fitment-003', evidence: '2014-2015 Nissan Rogue Sport Starter Motor' }
      ] }, categoryPriorityEvidenceSources: [
        { id: 'evidence-001', source: 'Item Specifics:Engine', evidence: '2.5L' }
      ] }
    } }
  });
  assert.equal(input.title, '2008-2015 Nissan Rogue Starter Motor 1591087');
  assert.deepEqual(input.selectedRows.map(row => row.id), ['title-fitment-001', 'title-fitment-002']);
  assert.match(input.selectedRows[1].evidence, /VIN J Japan-built/);
  assert.deepEqual(input.additionalEligibleRows.map(row => row.id), ['title-fitment-003']);
  assert.deepEqual(input.otherTrustedEvidence, [
    { id: 'evidence-001', source: 'Item Specifics:Engine', evidence: '2.5L' }
  ]);
});

test('review response cannot pass without citing every selected row', () => {
  const input = { selectedRows: [{ id: 'row-1' }, { id: 'row-2' }] };
  assert.throws(() => checkedFitmentReview({ verdict: 'PASS', reason: 'Looks safe.', citedRowIds: ['row-1'] }, input),
    /every selected row/);
  assert.deepEqual(checkedFitmentReview({ verdict: 'REVIEW', reason: 'Row 2 restricts the later years.',
    citedRowIds: ['row-2'] }, input).citedRowIds, ['row-2']);
});

test('OpenAI fitment reviewer uses a separate strict schema and focused evidence', async () => {
  const service = new Phase4AiEvaluatorService({ apiKey: 'test-key', model: 'gpt-5.1', maxAttempts: 1 });
  let sent;
  service.client.post = async (_path, request) => {
    sent = request;
    return { data: { choices: [{ message: { content: JSON.stringify({
      verdict: 'REVIEW', reason: '2014-2015 is limited to VIN J.', citedRowIds: ['row-2']
    }) } }] } };
  };
  const result = await service.reviewTitleFitment({
    title: '2008-2015 Nissan Rogue Starter Motor 1591087',
    existingTitle: '2014 Nissan Rogue Starter Fits 08-15 ROGUE',
    selectedRows: [
      { id: 'row-1', evidence: '2008-2013 Nissan Rogue Starter Motor' },
      { id: 'row-2', evidence: '2014-2015 Nissan Rogue Starter Motor VIN J Japan-built' }
    ],
    otherTrustedEvidence: [
      { id: 'evidence-001', source: 'Item Specifics:Engine', evidence: '2.5L' }
    ]
  });
  assert.equal(sent.model, 'gpt-5.1');
  assert.equal(sent.response_format.json_schema.strict, true);
  assert.match(sent.messages[0].content, /condition.*only.*some.*years/i);
  assert.match(sent.messages[1].content, /2014-2015 Nissan Rogue Starter Motor VIN J Japan-built/);
  assert.match(sent.messages[1].content, /Item Specifics:Engine/);
  assert.match(sent.messages[1].content, /2\.5L/);
  assert.doesNotMatch(sent.messages[1].content, /generatedDescription/);
  assert.equal(result.verdict, 'REVIEW');
});
