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
  assert.equal(resolveVehicleDecision({ ...decision, yearRange: '2011' }, prompt, '2011 Ford Fusion Control 123').verified, false);
  assert.equal(resolveVehicleDecision({ ...decision, evidence: 'Ford Fusion 2010-2012' }, prompt, '2010-2012 Ford Fusion Control 123').verified, false);
});
test('citation cannot bridge different applications or omit the selected identity from the title', () => {
  assert.equal(resolveVehicleDecision({ ...decision, make: 'Mercury', evidence }, prompt, '2010-2012 Mercury Fusion Control 123').verified, false);
  assert.equal(resolveVehicleDecision(decision, prompt, '2010-2012 Mercury Fusion Control 123').verified, false);
});

test('rejected vehicle decisions identify the failed evidence boundary for correction', () => {
  const title = '2010-2012 Ford Fusion Control 123';
  assert.equal(resolveVehicleDecision({ ...decision, source: 'unknown-row' }, prompt, title).failureCode,
    'UNKNOWN_SOURCE');
  assert.equal(resolveVehicleDecision({ ...decision, evidence: '2010-2012 Ford Fusion invented qualifier' },
    prompt, title).failureCode, 'UNSUPPORTED_CITATION');
  assert.equal(resolveVehicleDecision({ ...decision, yearRange: '2010-2013' }, prompt,
    '2010-2013 Ford Fusion Control 123').failureCode, 'UNSUPPORTED_YEAR_RANGE');
  assert.equal(resolveVehicleDecision(decision, prompt, '2010-2012 Mercury Milan Control 123').failureCode,
    'TITLE_IDENTITY_MISMATCH');
});

test('validator passes a specific vehicle evidence failure into correction checks', () => {
  const result = validateTitleOptimizationRuntimeCandidate({ sourceResolution: { resolved: { fields: {} } },
    promptArtifact: prompt, candidateTitle: '2010-2012 Ford Fusion Control 123',
    vehicleDecision: { ...decision, source: 'unknown-row' } });
  assert.match(result.checks.find(check => check.checkId === 'vehicle-evidence').message,
    /UNKNOWN_SOURCE.*eligible trusted source IDs/);
});

test('AI may merge adjacent cited rows for the same advertised vehicle', () => {
  const same = 'Fits 2011-2014 Hyundai Sonata Seat Belt Driver Buckle; 2015 Hyundai Sonata Seat Belt Driver Buckle';
  const makePrompt = value => ({ userPayload: { resolvedListing: { categoryPriorityEvidenceSources: [
    { id: 'fitment', source: 'Part Fitment', evidence: value }
  ] } } });
  const selected = value => ({ resolved: true, make: 'Hyundai', model: 'Sonata', yearRange: '2011-2015',
    source: 'fitment', evidence: value, reason: 'Continuous application.' });
  const title = '2011-2015 Hyundai Sonata Seat Belt Driver Buckle 1570412';

  assert.equal(resolveVehicleDecision(selected(same), makePrompt(same), title).verified, true);
  assert.equal(resolveVehicleDecision(selected('2011-2014 Hyundai Sonata Seat Belt Driver Buckle; 2015 Hyundai Sonata Seat Belt Driver Buckle'), makePrompt(same), title).verified, true);
  assert.equal(resolveVehicleDecision(selected('2011-2014 Hyundai Sonata; 2016 Hyundai Sonata'), makePrompt(same), title).verified, false);
});

test('vehicle decision accepts multiple trusted source IDs for one continuous application', () => {
  const artifact = { userPayload: { resolvedListing: { titleFitmentCandidates: { candidates: [
    { id: 'title-fitment-001', evidence: '2007 Nissan Altima driver front door switch' },
    { id: 'title-fitment-002', evidence: '2008-2012 Nissan Altima driver front door switch' }
  ] } } } };
  const selected = {
    resolved: true,
    make: 'Nissan',
    model: 'Altima',
    yearRange: '2007-2012',
    source: 'title-fitment-001;title-fitment-002',
    evidence: '2007 Nissan Altima driver front door switch; 2008-2012 Nissan Altima driver front door switch',
    reason: 'The cited rows form one continuous application.'
  };

  assert.equal(resolveVehicleDecision(selected, artifact,
    '2007-2012 Nissan Altima Master Window Switch Driver 1375500').verified, true);
});

test('eligible fitment row IDs supply canonical evidence without requiring AI to repeat it', () => {
  const row = { id: 'title-fitment-001', evidence: '2010-2012 Ford Fusion 2.5L starter motor' };
  const artifact = { userPayload: { resolvedListing: { titleFitmentCandidates: {
    candidates: [row], eligibleCandidates: [row]
  } } } };
  const selected = { resolved: true, make: 'Ford', model: 'Fusion', yearRange: '2010-2012',
    source: row.id, evidence: 'Fusion starter', reason: 'Advertised application.' };
  const result = resolveVehicleDecision(selected, artifact, '2010-2012 Ford Fusion 2.5L Starter Motor 123');
  assert.equal(result.verified, true);
  assert.equal(result.decision.evidence, row.evidence);
  assert.equal(resolveVehicleDecision({ ...selected, evidence: '' }, artifact,
    '2010-2012 Ford Fusion 2.5L Starter Motor 123').verified, true);
  assert.equal(resolveVehicleDecision({ ...selected, source: 'unknown-row' }, artifact,
    '2010-2012 Ford Fusion 2.5L Starter Motor 123').verified, false);
});

test('vehicle decision accepts plus-separated cited candidate IDs', () => {
  const candidates = [
    { id: 'title-fitment-001', evidence: '2008-2013 Nissan Rogue Starter Motor' },
    { id: 'title-fitment-002', evidence: '2014-2015 Nissan Rogue Starter Motor VIN J Japan-built' }
  ];
  const artifact = { userPayload: { resolvedListing: { titleFitmentCandidates: { candidates, eligibleCandidates: candidates } } } };
  const decision = {
    resolved: true, make: 'Nissan', model: 'Rogue', yearRange: '2008-2015',
    source: 'title-fitment-001 + title-fitment-002',
    evidence: candidates.map(item => item.evidence).join('; '), reason: 'Continuous fitment.'
  };
  assert.equal(resolveVehicleDecision(decision, artifact,
    '2008-2015 Nissan Rogue Starter Motor 1591087').verified, true);
});

test('vehicle decision leaves year-scoped VIN meaning to independent fitment review', () => {
  const candidates = [
    { id: 'title-fitment-001', evidence: '2008-2013 Nissan Rogue Starter Motor' },
    { id: 'title-fitment-002', evidence: '2014-2015 Nissan Rogue Starter Motor VIN J Japan-built' }
  ];
  const artifact = { userPayload: { resolvedListing: { titleFitmentCandidates: { candidates, eligibleCandidates: candidates } } } };
  const decision = {
    resolved: true, make: 'Nissan', model: 'Rogue', yearRange: '2008-2015',
    source: 'title-fitment-001;title-fitment-002',
    evidence: candidates.map(item => item.evidence).join('; '), reason: 'Continuous fitment.'
  };
  assert.equal(resolveVehicleDecision(decision, artifact,
    '2008-2015 Nissan Rogue Starter Motor VIN J Japan Built 1591087').verified, true);
});

test('citation formatting is tolerated but invented or inaccurate excerpts are rejected', () => {
  const title = '2010-2012 Ford Fusion Control 123';
  for (const [open, close] of [['"', '"'], ["'", "'"], ['\u201c', '\u201d'], ['`', '`']]) {
    assert.equal(resolveVehicleDecision({ ...decision, evidence: open + decision.evidence + close }, prompt, title).verified, true);
    assert.equal(resolveVehicleDecision({ ...decision, evidence: open + 'Fits 2010-2013 Ford Fusion' + close }, prompt, title).verified, false);
  }
});

test('rejects a paraphrased vehicle citation instead of silently widening its authority', () => {
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

  assert.equal(resolveVehicleDecision(selected, artifact, '2017-2020 BMW 430i Speedometer Base MPH 1586101').verified, false);
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

test('vehicle decision may select a cited advertised application from an ambiguous compatibility list', () => {
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
    '2001-2005 Hyundai Accent Throttle Body 1584124').verified, true);
  assert.equal(resolveVehicleDecision({ ...selected, evidence: '2007 Hyundai Accent throttle body' }, artifact,
    '2007 Hyundai Accent Throttle Body 1584124').verified, false);
});

test('vehicle decision rejects a donor candidate excluded by the advertised Fits application', () => {
  const artifact = { userPayload: { resolvedListing: {
    titleFitmentCandidates: {
      candidates: [
        { id: 'title-fitment-001', evidence: '2007-2009 Dodge Nitro Starter Motor 3.7L' },
        { id: 'title-fitment-002', evidence: '2008-2012 Jeep Liberty Starter Motor 3.7L' }
      ],
      eligibleCandidates: [
        { id: 'title-fitment-001', evidence: '2007-2009 Dodge Nitro Starter Motor 3.7L' }
      ],
      selectionBasis: 'EXISTING_TITLE_FITS_APPLICATION'
    }
  } } };
  const donor = {
    resolved: true, make: 'Jeep', model: 'Liberty', yearRange: '2008-2012',
    source: 'title-fitment-002', evidence: '2008-2012 Jeep Liberty Starter Motor 3.7L',
    reason: 'Donor vehicle.'
  };
  const advertised = {
    resolved: true, make: 'Dodge', model: 'Nitro', yearRange: '2007-2009',
    source: 'title-fitment-001', evidence: '2007-2009 Dodge Nitro Starter Motor 3.7L',
    reason: 'Application advertised after Fits.'
  };

  assert.equal(resolveVehicleDecision(donor, artifact,
    '2008-2012 Jeep Liberty Starter Motor 1589513').verified, false);
  assert.equal(resolveVehicleDecision(advertised, artifact,
    '2007-2009 Dodge Nitro Starter Motor 1589513').verified, true);
});

test('vehicle decision cannot bypass an unmatched advertised application through broad Part Fitment evidence', () => {
  const sourceEvidence = '2008-2012 Jeep Liberty Starter Motor 3.7L';
  const artifact = { userPayload: { resolvedListing: {
    titleFitmentCandidates: {
      candidates: [{ id: 'title-fitment-001', evidence: sourceEvidence }],
      eligibleCandidates: [],
      selectionBasis: 'EXISTING_TITLE_FITS_APPLICATION_UNMATCHED'
    },
    categoryPriorityEvidenceSources: [{ id: 'fitment', source: 'Part Fitment', evidence: sourceEvidence }]
  } } };
  const donor = {
    resolved: true, make: 'Jeep', model: 'Liberty', yearRange: '2008-2012',
    source: 'fitment', evidence: sourceEvidence, reason: 'Only donor application available.'
  };

  assert.equal(resolveVehicleDecision(donor, artifact,
    '2008-2012 Jeep Liberty Starter Motor 1589513').verified, false);
});

test('vehicle evidence supports multiword makes and models without positional parsing', () => {
  const sourceEvidence = 'Fits 2009-2016 Ford Truck E350 Van window master; 2008-2011 Ford Truck Ranger window master';
  const artifact = { userPayload: { resolvedListing: { categoryPriorityEvidenceSources: [{
    id: 'fitment', source: 'Part Fitment', evidence: sourceEvidence
  }] } } };
  const selected = {
    resolved: true,
    make: 'Ford Truck',
    model: 'E350 Van',
    yearRange: '2009-2016',
    source: 'fitment',
    evidence: 'Fits 2009-2016 Ford Truck E350 Van window master',
    reason: 'The existing title advertises the E350 Van application.'
  };

  assert.equal(resolveVehicleDecision(selected, artifact,
    '2009-2016 Ford Truck E350 Van Master Window Switch 1590577').verified, true);
});

test('vehicle citation accepts letter-number model spacing but not a different numeric model', () => {
  const candidates = [
    { id: 'fit-1', evidence: '2010-2011 Mazda 3 Instrument Cluster' },
    { id: 'fit-2', evidence: '2010-2011 Mazda 6 Instrument Cluster' }
  ];
  const artifact = { userPayload: { resolvedListing: { titleFitmentCandidates: {
    candidates, eligibleCandidates: [candidates[0]]
  } } } };
  const selected = { resolved: true, make: 'Mazda', model: 'Mazda3', yearRange: '2010-2011',
    source: 'fit-1', evidence: candidates[0].evidence, reason: 'Supported by the cited application.' };
  assert.equal(resolveVehicleDecision(selected, artifact,
    '2010-2011 Mazda Mazda3 Instrument Cluster 1568656').verified, true);
  assert.equal(resolveVehicleDecision({ ...selected, model: 'Mazda6' }, artifact,
    '2010-2011 Mazda Mazda6 Instrument Cluster 1568656').verified, false);
});

test('a model that includes the make is not required to repeat the make in the title', () => {
  const candidates = [{ id: 'fit-1', evidence: '2010-2013 Mazda Mazda3 driver window switch' }];
  const artifact = { userPayload: { resolvedListing: { titleFitmentCandidates: {
    candidates, eligibleCandidates: candidates
  } } } };
  const selected = { resolved: true, make: 'Mazda', model: 'Mazda3', yearRange: '2010-2013',
    source: 'fit-1', evidence: null, reason: 'Advertised model.' };
  assert.equal(resolveVehicleDecision(selected, artifact,
    '2010-2013 Mazda 3 Master Window Switch 1592308').verified, true);
  assert.equal(resolveVehicleDecision(selected, artifact,
    '2010-2013 Mazda 6 Master Window Switch 1592308').verified, false);
});

test('another compatible model cannot replace the advertised model in a no-Fits title', () => {
  const candidates = [
    { id: 'fit-1', evidence: '1998-2005 Lexus GS300 right decklid tail light' },
    { id: 'fit-2', evidence: '1998-2000 Lexus GS400 right decklid tail light' }
  ];
  const artifact = { userPayload: { resolvedListing: { titleFitmentCandidates: {
    candidates, eligibleCandidates: [candidates[0]], selectionBasis: 'EXISTING_TITLE_MODEL_APPLICATION'
  } } } };
  const gs400 = { resolved: true, make: 'Lexus', model: 'GS400', yearRange: '1998-2000',
    source: 'fit-2', evidence: null, reason: 'Another compatible model.' };
  assert.equal(resolveVehicleDecision(gs400, artifact,
    '1998-2000 Lexus GS400 Right Tail Light 1056292').verified, false);
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
