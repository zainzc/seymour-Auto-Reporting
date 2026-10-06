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
  assert.deepEqual(input.vehicleDecision, { source: 'title-fitment-001;title-fitment-002' });
  assert.deepEqual(input.selectedRows.map(row => row.id), ['title-fitment-001', 'title-fitment-002']);
  assert.match(input.selectedRows[1].evidence, /VIN J Japan-built/);
  assert.deepEqual(input.additionalEligibleRows.map(row => row.id), ['title-fitment-003']);
  assert.deepEqual(input.otherTrustedEvidence, [
    { id: 'evidence-001', source: 'Item Specifics:Engine', evidence: '2.5L' }
  ]);
  assert.deepEqual(input.selectedRows.map(row => [row.startYear, row.endYear]), [
    [null, null], [null, null]
  ]);
});

test('review input retains every variant in a grouped application', () => {
  const input = buildFitmentReviewInput({
    title: '2014-2020 Nissan Rogue Alternator 2.5L 1234567',
    vehicleDecision: { source: 'title-fitment-001' },
    promptArtifact: { userPayload: { resolvedListing: { titleFitmentCandidates: {
      eligibleCandidates: [{
        id: 'title-fitment-001', startYear: 2014, endYear: 2015,
        evidence: '2014-2015 Nissan Rogue VIN 5; 2015 Nissan Rogue VIN K',
        variantEvidence: ['2014-2015 Nissan Rogue VIN 5', '2015 Nissan Rogue VIN K']
      }]
    } } } }
  });
  assert.deepEqual(input.selectedRows[0].variantEvidence, [
    '2014-2015 Nissan Rogue VIN 5', '2015 Nissan Rogue VIN K'
  ]);
  assert.equal(input.selectedRows[0].startYear, 2014);
});

test('review response cannot pass without citing every selected row', () => {
  const input = { selectedRows: [{ id: 'row-1' }, { id: 'row-2' }] };
  const rowAssessments = ['row-1', 'row-2'].map(rowId => ({ rowId,
    yearScope: '2010-2012', conditions: 'none', titleCoverage: 'ACCURATE', explanation: 'Covered.' }));
  assert.throws(() => checkedFitmentReview({ verdict: 'PASS', reason: 'Looks safe.', citedRowIds: ['row-1'],
    rowAssessments }, input),
    /every selected row/);
  assert.deepEqual(checkedFitmentReview({ verdict: 'REVIEW', reason: 'Row 2 restricts the later years.',
    citedRowIds: ['row-2'], rowAssessments }, input).citedRowIds, ['row-2']);
});

test('review cannot pass without an accurate assessment for every selected fitment row', () => {
  const input = { selectedRows: [{ id: 'row-1' }, { id: 'row-2' }] };
  const response = { verdict: 'PASS', reason: 'Looks safe.', citedRowIds: ['row-1', 'row-2'],
    rowAssessments: [{ rowId: 'row-1', yearScope: '2008-2013', conditions: 'none',
      titleCoverage: 'ACCURATE', explanation: 'The year range is represented.' }] };
  assert.throws(() => checkedFitmentReview(response, input), /every selected row/);
  response.rowAssessments.push({ rowId: 'row-2', yearScope: '2014-2015', conditions: 'VIN J',
    titleCoverage: 'OVERAPPLIED', explanation: 'VIN J is applied to earlier years.' });
  assert.throws(() => checkedFitmentReview(response, input), /cannot pass/);
  response.verdict = 'REVIEW';
  assert.equal(checkedFitmentReview(response, input).rowAssessments.length, 2);
});

test('review assesses cited source rows without asking AI to repeat year metadata', () => {
  const input = { selectedRows: [{ id: 'row-1', startYear: 2007, endYear: 2008 }] };
  const response = { verdict: 'PASS', reason: 'Supported.', citedRowIds: ['row-1'],
    rowAssessments: [{ rowId: 'row-1', conditions: '4-door sedan',
      titleCoverage: 'ACCURATE', explanation: 'The title covers the row.' }] };
  assert.equal(checkedFitmentReview(response, input).verdict, 'PASS');
});

test('OpenAI fitment reviewer uses a separate strict schema and focused evidence', async () => {
  const service = new Phase4AiEvaluatorService({ apiKey: 'test-key', model: 'gpt-5.1', maxAttempts: 1 });
  let sent;
  service.client.post = async (_path, request) => {
    sent = request;
    return { data: { choices: [{ message: { content: JSON.stringify({
      verdict: 'REVIEW', reason: '2014-2015 is limited to VIN J.', citedRowIds: ['row-2'],
      rowAssessments: [
        { rowId: 'row-1', yearScope: '2008-2013', conditions: 'none', titleCoverage: 'ACCURATE', explanation: 'Covered.' },
        { rowId: 'row-2', yearScope: '2014-2015', conditions: 'VIN J', titleCoverage: 'OVERAPPLIED', explanation: 'VIN J is applied to earlier years.' }
      ]
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
  assert.deepEqual(sent.response_format.json_schema.schema.required,
    ['verdict', 'reason', 'citedRowIds', 'rowAssessments']);
  assert.match(sent.messages[0].content, /condition.*only.*some.*years/i);
  assert.match(sent.messages[0].content, /longer model name/i);
  assert.match(sent.messages[0].content, /another compatible model/i);
  assert.doesNotMatch(sent.messages[0].content, /Write yearScope/i);
  assert.match(sent.messages[0].content, /each independently narrowing condition/i);
  assert.match(sent.messages[0].content, /one condition.*substitute for another/i);
  assert.match(sent.messages[1].content, /2014-2015 Nissan Rogue Starter Motor VIN J Japan-built/);
  assert.doesNotMatch(JSON.stringify(sent.response_format.json_schema.schema), /yearScope/);
  assert.match(sent.messages[1].content, /Item Specifics:Engine/);
  assert.match(sent.messages[1].content, /2\.5L/);
  assert.doesNotMatch(sent.messages[1].content, /generatedDescription/);
  assert.equal(result.verdict, 'REVIEW');
});
