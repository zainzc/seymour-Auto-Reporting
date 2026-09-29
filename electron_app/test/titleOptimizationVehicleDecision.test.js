const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveVehicleDecision } = require('../src/services/titleOptimizationVehicleDecisionService');
const { validateTitleOptimizationRuntimeCandidate } = require('../src/services/titleOptimizationRuntimeValidatorService');
const { decideTitleOptimizationRuntimeResult } = require('../src/services/titleOptimizationRuntimeDecisionService');

const evidence = 'Fits 2010-2012 Ford Fusion temperature control; 2010-2011 Mercury Milan temperature control';
const prompt = { userPayload: { resolvedListing: { categoryPriorityEvidenceSources: [{ source: 'Part Fitment', evidence }] } } };
const decision = { resolved: true, make: 'Ford', model: 'Fusion', yearRange: '2010-2012', source: 'Part Fitment', evidence: 'Fits 2010-2012 Ford Fusion temperature control', reason: 'Current title identifies Fusion.' };
test('vehicle decision accepts a supported application and rejects mixed vehicles and years', () => {
  assert.equal(resolveVehicleDecision(decision, prompt, '2010-2012 Ford Fusion Control 123').verified, true);
  for (const changes of [{ make: 'Mercury' }, { yearRange: '2010-2013' }, { resolved: false }]) {
    assert.equal(resolveVehicleDecision({ ...decision, ...changes }, prompt, '2010-2012 Ford Fusion Control 123').verified, false);
  }
  assert.equal(resolveVehicleDecision({ ...decision, evidence: 'Ford Fusion 2010-2012' }, prompt, '2010-2012 Ford Fusion Control 123').verified, true);
});
test('citation cannot bridge different applications or omit the selected identity from the title', () => {
  assert.equal(resolveVehicleDecision({ ...decision, make: 'Mercury', evidence }, prompt, '2010-2012 Mercury Fusion Control 123').verified, false);
  assert.equal(resolveVehicleDecision(decision, prompt, '2010-2012 Mercury Fusion Control 123').verified, false);
});

test('adjacent fitment ranges merge only when their application qualifiers are identical', () => {
  const same = 'Fits 2011-2014 Hyundai Sonata Seat Belt Driver Buckle; 2015 Hyundai Sonata Seat Belt Driver Buckle';
  const different = `${same} VIN C 5th Digit Hybrid`;
  const makePrompt = value => ({ userPayload: { resolvedListing: { categoryPriorityEvidenceSources: [
    { id: 'fitment', source: 'Part Fitment', evidence: value }
  ] } } });
  const selected = value => ({ resolved: true, make: 'Hyundai', model: 'Sonata', yearRange: '2011-2015',
    source: 'fitment', evidence: value, reason: 'Continuous application.' });
  const title = '2011-2015 Hyundai Sonata Seat Belt Driver Buckle 1570412';

  assert.equal(resolveVehicleDecision(selected(same), makePrompt(same), title).verified, true);
  assert.equal(resolveVehicleDecision(selected(different), makePrompt(different), title).verified, false);
});

test('citation formatting and inaccurate excerpts do not override full trusted evidence', () => {
  const title = '2010-2012 Ford Fusion Control 123';
  for (const [open, close] of [['"', '"'], ["'", "'"], ['\u201c', '\u201d'], ['`', '`']]) {
    assert.equal(resolveVehicleDecision({ ...decision, evidence: open + decision.evidence + close }, prompt, title).verified, true);
    assert.equal(resolveVehicleDecision({ ...decision, evidence: open + 'Fits 2010-2013 Ford Fusion' + close }, prompt, title).verified, true);
  }
});

test('validates a selected application against the full cited source when the AI shortens its quotation', () => {
  const fullEvidence = 'Fits 2017-2020 BMW 430i speedometer cluster, Base trim, MPH, without head-up display, without multifunction display';
  const artifact = { userPayload: { resolvedListing: { categoryPriorityEvidenceSources: [{
    id: 'evidence-020', source: 'Part Fitment', evidence: fullEvidence
  }] } } };
  const selected = {
    resolved: true,
    make: 'BMW',
    model: '430i',
    yearRange: '2017-2020',
    source: 'evidence-020',
    evidence: '2017-2020 BMW 430i cluster, Base trim, MPH, without head-up display, without multifunction display',
    reason: 'The selected fitment matches the advertised vehicle.'
  };

  assert.equal(resolveVehicleDecision(selected, artifact, '2017-2020 BMW 430i Speedometer Base MPH 1586101').verified, true);
});

test('vehicle decision must select one eligible title fitment candidate without merging candidates', () => {
  const artifact = { userPayload: { resolvedListing: {
    titleFitmentCandidates: {
      status: 'ONE_DISTINCT_APPLICATION',
      resolution: 'UNAMBIGUOUS',
      candidates: [
        { id: 'title-fitment-001', evidence: '2001-2005 Hyundai Accent throttle body 1.6L DOHC' }
      ]
    },
    categoryPriorityEvidenceSources: [{
      id: 'evidence-017', source: 'Part Fitment',
      evidence: '2001-2006 Hyundai Accent throttle body 1.6L DOHC'
    }]
  } } };
  const base = { resolved: true, make: 'Hyundai', model: 'Accent', source: 'title-fitment-001',
    evidence: '2001-2005 Hyundai Accent throttle body 1.6L DOHC', reason: 'Matches trusted year.' };

  assert.equal(resolveVehicleDecision({ ...base, yearRange: '2001-2005' }, artifact,
    '2001-2005 Hyundai Accent Throttle Body 1584124').verified, true);
  assert.equal(resolveVehicleDecision({ ...base, yearRange: '2001-2006' }, artifact,
    '2001-2006 Hyundai Accent Throttle Body 1584124').verified, false);
});

test('vehicle decision cannot select one application when fitment remains ambiguous', () => {
  const artifact = { userPayload: { resolvedListing: {
    titleFitmentCandidates: {
      status: 'MULTIPLE_DISTINCT_APPLICATIONS',
      resolution: 'AMBIGUOUS',
      candidates: [
        { id: 'title-fitment-001', evidence: '2001-2005 Hyundai Accent throttle body' },
        { id: 'title-fitment-002', evidence: '2006 Hyundai Accent hatchback 3-door throttle body' }
      ]
    }
  } } };
  const selected = { resolved: true, make: 'Hyundai', model: 'Accent', yearRange: '2001-2005',
    source: 'title-fitment-001', evidence: '2001-2005 Hyundai Accent throttle body', reason: 'Selected by the model.' };

  assert.equal(resolveVehicleDecision(selected, artifact,
    '2001-2005 Hyundai Accent Throttle Body 1584124').verified, false);
});

test('vehicle decision may use another trusted source when Part Fitment is unavailable', () => {
  const sourceEvidence = '2011 Honda Accord mirror';
  const artifact = { userPayload: { resolvedListing: {
    titleFitmentCandidates: {
      status: 'NO_PARSEABLE_PART_FITMENT',
      resolution: 'UNAVAILABLE',
      candidates: [],
      distinctApplications: []
    },
    categoryPriorityEvidenceSources: [{ id: 'evidence-title', source: 'Current eBay Title', evidence: sourceEvidence }]
  } } };
  const selected = { resolved: true, make: 'Honda', model: 'Accord', yearRange: '2011',
    source: 'evidence-title', evidence: sourceEvidence, reason: 'Current title is one unambiguous application.' };

  assert.equal(resolveVehicleDecision(selected, artifact, '2011 Honda Accord Mirror 00123').verified, true);
});

test('validated AI application reaches no-degrade decision without suppressing unrelated conflicts', () => {
  const sourceResolution = { normalized: { fields: { existingTitle: { value: '2010 Ford Fusion Control 123' } },
    titleAuthority: { partFitment: { value: evidence } } }, resolved: { fields: {
      title: { resolvedValue: '2010 Ford Fusion Control 123' }, brandMake: { resolvedValue: 'Mercury' },
      model: { resolvedValue: 'Fusion' }, year: { resolvedValue: '2010' }, sku: { resolvedValue: '123' }
    }, conflicts: [{ field: 'brandMake', resolvedValue: 'Mercury' }] } };
  const original = JSON.stringify(sourceResolution);
  const ruleResolution = { flagReasons: [{ id: 'conflict', reason: 'Conflicting source data' }] };
  const validate = (vehicleDecision, candidateTitle) => validateTitleOptimizationRuntimeCandidate({
    sourceResolution, ruleResolution, promptArtifact: prompt, vehicleDecision, candidateTitle });
  const validationResult = validate(decision, '2010-2012 Ford Fusion Control 123');
  assert.equal(validationResult.vehicleVerification.verified, true);
  const accepted = decideTitleOptimizationRuntimeResult({ sourceResolution, ruleResolution, validationResult });
  assert.equal(accepted.decision, 'ACCEPT_CANDIDATE');
  const invalid = validate({ ...decision, make: 'Mercury' }, '2010-2012 Mercury Fusion Control 123');
  assert.equal(invalid.vehicleVerification.verified, false);
  assert.ok(invalid.checks.some(check => check.checkId === 'vehicle-evidence' && check.status === 'FAIL'));
  const unrelated = decideTitleOptimizationRuntimeResult({ sourceResolution: { ...sourceResolution,
    resolved: { ...sourceResolution.resolved, conflicts: [...sourceResolution.resolved.conflicts, { field: 'engineCode' }] } },
    ruleResolution, validationResult });
  assert.equal(unrelated.decision, 'NEEDS_REVIEW');
  assert.equal(JSON.stringify(sourceResolution), original);
});
