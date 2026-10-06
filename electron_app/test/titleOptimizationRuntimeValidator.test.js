const test = require('node:test');
const assert = require('node:assert/strict');

const { validateTitleOptimizationRuntimeCandidate } = require('../src/services/titleOptimizationRuntimeValidatorService');

function resolvedField(value, source = 'itemSpecifics') {
  return {
    resolvedValue: value,
    resolvedSource: source,
    missing: value === null || value === undefined || value === ''
  };
}

function baseInputs(overrides = {}) {
  const sourceResolution = {
    normalized: {
      manualOverride: { active: false, status: { value: '' }, title: { value: '' } },
      fields: {
        existingTitle: { value: '2011 Honda Accord Side View Mirror ABS 00123' },
        sku: { value: '00123' },
        ipnPrefix: { value: '0641' }
      },
      descriptionOnly: {
        partFitment: { value: 'Fits driver side donor only', titleAuthority: false }
      },
      structured: {
        itemSpecifics: {
          value: {
            'C:Brand': 'Honda',
            Model: 'Accord',
            Year: '2011',
            Side: 'Driver',
            MPN: 'MPN-9',
            'Engine Code': 'K24A',
            'Transmission Code': 'BAYA',
            VIN: 'VIN J'
          }
        }
      }
    },
    resolved: {
      fields: {
        title: resolvedField('2011 Honda Accord Side View Mirror ABS 00123', 'currentEbay'),
        sku: resolvedField('00123', 'otherStructuredFields'),
        brandMake: resolvedField('Honda'),
        model: resolvedField('Accord'),
        year: resolvedField('2011'),
        part: resolvedField('Side View Mirror'),
        side: resolvedField('Driver'),
        manufacturerPartNumber: resolvedField('MPN-9'),
        engineCode: resolvedField('K24A'),
        transmissionCode: resolvedField('BAYA'),
        vin: resolvedField('VIN J')
      },
      conflicts: []
    }
  };
  const ruleResolution = {
    runtimeMode: 'authoritative',
    listingContext: { sku: '00123', ipnPrefix: '0641', make: 'Honda', part: 'Side View Mirror' },
    prefixRule: { normalizedPrefix: '0641', rule: { id: 'prefix-0641', prefix: '0641' }, systemRule: null },
    restrictedTerms: {
      groups: {
        'never-introduce': [
          { id: 'rt-long', term: 'Long Block', ruleType: 'never-introduce', locked: true },
          { id: 'rt-short', term: 'Short Block', ruleType: 'never-introduce', locked: true }
        ],
        'requires-authorization': [
          { id: 'rt-complete', term: 'Complete', ruleType: 'requires-authorization' }
        ],
        'remove-noise': [
          { id: 'rt-oem-part', term: 'OEM Part', ruleType: 'remove-noise' }
        ],
        'must-preserve': [
          { id: 'rt-abs', term: 'ABS', ruleType: 'must-preserve' }
        ]
      }
    },
    categoryRules: [
      { rule: { id: 'cat-mirror', categoryName: 'Mirrors', priorityDetails: ['Engine Code', 'Transmission Code', 'VIN Identifier'] }, matchedBy: ['category'] }
    ],
    titleStructure: {
      selected: {
        id: 'structure-general',
        structureName: 'General',
        segments: [
          { key: 'year', label: 'Year', kind: 'field' },
          { key: 'brandMake', label: 'Make', kind: 'field' },
          { key: 'model', label: 'Model', kind: 'field' },
          { key: 'part', label: 'Part', kind: 'field' },
          { key: 'sku', label: 'SKU', kind: 'field' }
        ]
      }
    },
    flagReasons: [
      { id: 'flag-year', reason: 'Missing verified year', enabled: true },
      { id: 'flag-make', reason: 'Make cannot be verified', enabled: true },
      { id: 'flag-engine', reason: 'Required engine fitment missing', enabled: true },
      { id: 'flag-transmission', reason: 'Transmission code cannot be verified', enabled: true },
      { id: 'flag-conflict', reason: 'Conflicting source data', enabled: true },
      { id: 'flag-fitment', reason: 'Cannot preserve essential fitment within 80 characters', enabled: true },
      { id: 'flag-degrade', reason: 'Proposed title would degrade existing title', enabled: true },
      { id: 'flag-multiple-ranges', reason: 'Multiple year ranges require review', enabled: true }
    ],
    systemRules: [
      { id: 'SR-03', title: 'Preserve verified acronyms' },
      { id: 'SR-04', title: 'MPN safety' },
      { id: 'SR-05', title: 'SKU exactly once at end' },
      { id: 'SR-06', title: 'Prefix 257 #SKU exception' },
      { id: 'SR-07', title: '80 character maximum' },
      { id: 'SR-09', title: 'AC formatting' },
      { id: 'SR-11', title: 'Side validation' },
      { id: 'SR-14', title: 'No degrade risk' }
    ],
    warnings: []
  };
  const promptArtifact = {
    runtimeMode: 'authoritative',
    kind: 'prompt',
    metadata: { selectedStructureId: 'structure-general' }
  };
  return {
    snapshot: { runtimeMode: 'authoritative' },
    sourceResolution,
    ruleResolution,
    promptArtifact,
    candidateTitle: '2011 Honda Accord Driver Side View Mirror ABS MPN-9 K24A BAYA VIN J 00123',
    ...overrides
  };
}

function validate(overrides = {}) {
  return validateTitleOptimizationRuntimeCandidate(baseInputs(overrides));
}

test('passes a clean valid title without corrections', () => {
  const result = validate();

  assert.equal(result.valid, true);
  assert.equal(result.safeToContinue, true);
  assert.equal(result.outcome, 'PASS');
  assert.equal(result.changed, false);
  assert.equal(result.validatedTitle, '2011 Honda Accord Driver Side View Mirror ABS MPN-9 K24A BAYA VIN J 00123');
  assert.deepEqual(result.corrections, []);
  assert.deepEqual(result.violations, []);
});

test('does not flag multiple compatibility rows without an unresolved vehicle decision', () => {
  const inputs = baseInputs();
  inputs.promptArtifact.userPayload = { resolvedListing: { titleFitmentCandidates: {
    resolution: 'AMBIGUOUS',
    distinctApplications: [
      { id: 'title-fitment-001', evidence: '2010-2012 Honda Accord mirror' },
      { id: 'title-fitment-002', evidence: '2013 Honda Crosstour mirror' }
    ],
    candidates: []
  } } };

  const result = validateTitleOptimizationRuntimeCandidate(inputs);

  assert.equal(result.outcome, 'PASS');
  assert.equal(result.safeToContinue, true);
  assert.equal(result.checks.some(check => check.checkId === 'multiple-fitment-applications'), false);
  assert.equal(result.suggestedReviewReasons.some(item => item.reason === 'Multiple year ranges require review'), false);
});

test('accepts AI semantic category verification when its citation exists in trusted evidence', () => {
  const inputs = baseInputs({ candidateTitle: '2011 Honda Accord Master Power Window Switch 00123' });
  inputs.ruleResolution.categoryRules = [{ rule: {
    id: 'cat-window-switch', categoryName: 'Window Switch', priorityDetails: ['Master Power Window Switch']
  }, matchedBy: ['category'] }];
  inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [{
    id: 'fitment', source: 'Part Fitment', evidence: "ALTIMA 07 Driver's; lock and window master"
  }] } };
  inputs.categoryPriorityDetails = [{
    detail: 'Master Power Window Switch', verified: true, source: 'fitment', evidence: "Driver's; lock and window master"
  }];

  const result = validateTitleOptimizationRuntimeCandidate(inputs);

  assert.equal(result.violations.some(item => item.checkId === 'category-priority-verification'), false);
});

test('legacy safety approval cannot override category evidence validation', () => {
  const inputs = baseInputs({
    candidateTitle: '2011 Honda Accord Heated Sun Visor Driver 00123',
    safetyDecision: {
      safeToPublish: true,
      reason: 'Heated is directly supported by the supplied listing evidence.',
      concerns: []
    }
  });
  inputs.ruleResolution.categoryRules = [{ rule: {
    id: 'cat-visor', categoryName: 'Sun Visor', priorityDetails: ['Heated']
  }, matchedBy: ['category'] }];
  inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [{
    id: 'fitment', source: 'Part Fitment', evidence: 'Jetta driver sun visor without heat'
  }] } };
  inputs.categoryPriorityDetails = [{
    detail: 'Heated', verified: true, source: 'fitment', evidence: 'without heat'
  }];

  const result = validateTitleOptimizationRuntimeCandidate(inputs);

  assert.equal(result.safeToContinue, false);
  assert.equal(result.violations.some(item => item.checkId === 'category-priority-verification'), true);
  assert.equal(result.semanticSafety, undefined);
});

test('legacy safety approval cannot suppress model ambiguity', () => {
  const inputs = baseInputs({
    safetyDecision: {
      safeToPublish: true,
      reason: 'The supplied evidence supports the normalized model and title.',
      concerns: []
    }
  });
  inputs.sourceResolution.resolved.modelAmbiguity = {
    ambiguous: true,
    candidates: ['OUTBAKLEG', 'Outback Legacy']
  };

  const result = validateTitleOptimizationRuntimeCandidate(inputs);

  assert.equal(result.outcome, 'FLAG');
  assert.equal(result.warnings.find(item => item.checkId === 'model-ambiguity')?.status, 'WARN');
});

test('ignores removed semantic audit metadata', () => {
  const result = validate({
    safetyDecision: {
      safeToPublish: true,
      reason: 'Approved.',
      concerns: [],
      claims: [{
        titleClaim: 'Passenger side',
        dimension: 'placement',
        status: 'contradictory',
        evidence: 'Driver side',
        material: true
      }]
    }
  });

  assert.equal(result.safeToContinue, true);
  assert.equal(result.violations.some(item => item.checkId === 'semantic-audit-consistency'), false);
});

test('does not expose removed semantic audit results', () => {
  const result = validate({
    safetyDecision: {
      safeToPublish: true,
      reason: 'All material claims are supported.',
      concerns: [],
      claims: [
        { titleClaim: 'Side View Mirror', dimension: 'product_identity', status: 'equivalent', evidence: 'Door Mirror', material: true },
        { titleClaim: 'Color omitted', dimension: 'configuration', status: 'optional_omission', evidence: 'Gray', material: false }
      ]
    }
  });

  assert.equal(result.safeToContinue, true);
  assert.equal(result.semanticSafety, undefined);
});

test('does not validate the removed selected-facts and omission audit metadata', () => {
  const result = validate({
    selectedTitleFacts: {
      keyDetails: ['With Illumination']
    },
    removedTitleDetails: [],
    safetyDecision: {
      safeToPublish: true,
      reason: 'All material claims are supported.',
      concerns: [],
      claims: []
    }
  });

  assert.equal(result.safeToContinue, true);
  assert.equal(result.violations.some(item => item.checkId === 'title-fact-audit-consistency'), false);
});

test('accepts a selected key detail when its meaningful words are represented in the title', () => {
  const result = validate({
    candidateTitle: '2011 Honda Accord Driver Side View Mirror Lock Window ABS MPN-9 K24A BAYA VIN J 00123',
    selectedTitleFacts: {
      keyDetails: ['Lock And Window']
    },
    removedTitleDetails: [],
    safetyDecision: {
      safeToPublish: true,
      reason: 'All material claims are supported.',
      concerns: [],
      claims: []
    }
  });

  assert.equal(result.violations.some(item => item.checkId === 'title-fact-audit-consistency'), false);
});

test('does not reject legacy omission audit metadata', () => {
  const result = validate({
    selectedTitleFacts: { keyDetails: [] },
    removedTitleDetails: [{
      detail: 'From 02/17/08',
      reason: 'Removed for space.',
      safeToRemove: true
    }],
    safetyDecision: {
      safeToPublish: true,
      reason: 'All material claims are supported.',
      concerns: [],
      claims: [{
        titleClaim: 'From 02/17/08',
        dimension: 'fitment',
        status: 'optional_omission',
        evidence: 'From 02/17/08',
        material: true
      }]
    }
  });

  assert.equal(result.safeToContinue, true);
  assert.equal(result.violations.some(item => item.checkId === 'title-fact-audit-consistency'), false);
});

test('AI safety approval cannot waive objective title length enforcement', () => {
  const result = validate({
    candidateTitle: `${'A'.repeat(81)} 00123`,
    safetyDecision: { safeToPublish: true, reason: 'Semantically accurate.', concerns: [] }
  });

  assert.equal(result.safeToContinue, false);
  assert.equal(result.violations.some(item => item.checkId === 'length-80' || item.checkId === 'final-invariant-recheck'), true);
});

test('accepts an AI-selected fitment range that contains the structured single year', () => {
  const inputs = baseInputs({
    candidateTitle: '2010-2012 Honda Accord Driver Side View Mirror ABS MPN-9 K24A BAYA VIN J 00123'
  });
  inputs.sourceResolution.normalized.titleAuthority = {
    partFitment: {
      value: 'Fits 2010-2012 Honda Accord',
      titleAuthority: true
    }
  };

  const result = validateTitleOptimizationRuntimeCandidate(inputs);

  assert.equal(result.violations.some(item => item.checkId === 'unsupported-information'), false);
  assert.equal(result.validatedTitle.startsWith('2010-2012 Honda Accord'), true);
});

test('does not use a hardcoded existing-title detail protection list', () => {
  const inputs = baseInputs({
    candidateTitle: '2013-2015 Honda Accord Engine 2.4L VIN 1 1585847'
  });
  inputs.sourceResolution.normalized.fields.existingTitle = {
    value: 'Engine 2.4L VIN 1 6th Digit Coupe Federal Emissions Fits 13-15 ACCORD 1585847'
  };
  inputs.sourceResolution.resolved.fields.title = resolvedField(
    'Engine 2.4L VIN 1 6th Digit Coupe Federal Emissions Fits 13-15 ACCORD 1585847',
    'currentEbay'
  );
  inputs.sourceResolution.resolved.fields.sku = resolvedField('1585847', 'otherStructuredFields');
  inputs.sourceResolution.normalized.fields.sku = { value: '1585847' };
  inputs.sourceResolution.normalized.titleAuthority = {
    importantExistingTitleDetails: [
      { key: 'bodyStyle', value: 'Coupe', acceptedValues: ['Coupe'] },
      { key: 'engineDisplacement', value: '2.4L', acceptedValues: ['2.4L'] },
      { key: 'vinIdentifier', value: 'VIN 1', acceptedValues: ['VIN 1'] },
      { key: 'vinPosition', value: '6th Digit', acceptedValues: ['6th Digit', '6th'] },
      { key: 'emissions', value: 'Federal Emissions', acceptedValues: ['Federal Emissions', 'Federal'] }
    ]
  };

  const result = validateTitleOptimizationRuntimeCandidate(inputs);

  assert.equal(result.violations.some(item => item.checkId === 'detail-assessment'), false);
});

test('flags missing required year and make evidence with approved client reasons', () => {
  const inputs = baseInputs({ candidateTitle: 'Accord Side View Mirror ABS 00123' });
  inputs.sourceResolution.resolved.fields.year = resolvedField(null);
  inputs.sourceResolution.resolved.fields.brandMake = resolvedField(null);

  const result = validateTitleOptimizationRuntimeCandidate(inputs);

  assert.notEqual(result.outcome, 'PASS');
  assert.equal(result.warnings.some(item => item.checkId === 'missing-verified-year'), true);
  assert.equal(result.warnings.some(item => item.checkId === 'missing-verified-make'), true);
  assert.equal(result.suggestedReviewReasons.some(item => item.reason === 'Missing verified year'), true);
  assert.equal(result.suggestedReviewReasons.some(item => item.reason === 'Make cannot be verified'), true);
});

test('flags missing category-required engine and transmission evidence', () => {
  const engineInputs = baseInputs({ candidateTitle: '2013 Honda Accord Engine 00123' });
  engineInputs.ruleResolution.titleStructure.selected.structureName = 'Engines';
  engineInputs.ruleResolution.titleStructure.selected.appliesTo = 'Engines';
  engineInputs.sourceResolution.resolved.fields.engineDisplacement = resolvedField(null);
  engineInputs.sourceResolution.resolved.fields.engineCode = resolvedField(null);
  const engine = validateTitleOptimizationRuntimeCandidate(engineInputs);
  assert.equal(engine.warnings.some(item => item.checkId === 'missing-engine-fitment'), true);
  assert.equal(engine.suggestedReviewReasons.some(item => item.reason === 'Required engine fitment missing'), true);

  const transmissionInputs = baseInputs({ candidateTitle: '2013 Honda Accord Automatic Transmission FWD 00123' });
  transmissionInputs.ruleResolution.titleStructure.selected.structureName = 'Transmissions';
  transmissionInputs.ruleResolution.titleStructure.selected.appliesTo = 'Transmissions';
  transmissionInputs.sourceResolution.resolved.fields.transmissionCode = resolvedField(null);
  const transmission = validateTitleOptimizationRuntimeCandidate(transmissionInputs);
  assert.equal(transmission.warnings.some(item => item.checkId === 'missing-transmission-code'), true);
  assert.equal(transmission.suggestedReviewReasons.some(item => item.reason === 'Transmission code cannot be verified'), true);
});

test('performs safe whitespace cleanup and rejects blank candidates', () => {
  const cleaned = validate({ candidateTitle: '  2011   Honda   Accord   Driver   Side View Mirror   ABS   MPN-9   K24A   BAYA   VIN J   00123  ' });
  assert.equal(cleaned.outcome, 'CLEANUP');
  assert.equal(cleaned.validatedTitle, '2011 Honda Accord Driver Side View Mirror ABS MPN-9 K24A BAYA VIN J 00123');
  assert.equal(cleaned.corrections.some(item => item.checkId === 'basic-formatting'), true);

  const blank = validate({ candidateTitle: '     ' });
  assert.equal(blank.valid, false);
  assert.equal(blank.safeToContinue, false);
  assert.equal(blank.outcome, 'BLOCK');
  assert.equal(blank.violations.some(item => item.checkId === 'blank-title'), true);
});

test('enforces 80 characters with safe reduction, no mid-word truncation, and review when unsafe', () => {
  const reducible = validate({
    candidateTitle: '2011 Honda Accord Driver Side View Mirror OEM Part OEM Part ABS MPN-9 K24A BAYA VIN J 00123'
  });
  assert.equal(reducible.valid, true);
  assert.equal(reducible.validatedTitle.length <= 80, true);
  assert.equal(/\S$/.test(reducible.validatedTitle), true);
  assert.equal(reducible.corrections.some(item => item.checkId === 'remove-noise'), true);
  assert.doesNotMatch(reducible.validatedTitle, /OEM Part/);

  const unsafe = validate({
    candidateTitle: '2011 Honda Accord Driver Side View Mirror ABS MPN-9 K24A BAYA VIN J Critical Verified Fitment Cannot Drop 00123'
  });
  assert.equal(unsafe.valid, false);
  assert.equal(unsafe.safeToContinue, false);
  assert.equal(unsafe.outcome, 'RETAIN_EXISTING_REQUIRED');
  assert.equal(unsafe.violations.some(item => item.checkId === 'length-80'), true);
  assert.equal(unsafe.suggestedReviewReasons.some(item => item.reason === 'Cannot preserve essential fitment within 80 characters'), true);
});

test('normalizes SKU exactly once at the end and applies #SKU only for prefix 257', () => {
  const missing = validate({ candidateTitle: '2011 Honda Accord Driver Side View Mirror ABS' });
  assert.equal(missing.validatedTitle.endsWith('00123'), true);
  assert.equal(missing.corrections.some(item => item.checkId === 'sku-exactly-once'), true);

  const duplicate = validate({ candidateTitle: '00123 2011 Honda Accord Driver Side View Mirror ABS 00123' });
  assert.equal((duplicate.validatedTitle.match(/00123/g) || []).length, 1);
  assert.equal(duplicate.validatedTitle.endsWith('00123'), true);

  const wrongPosition = validate({ candidateTitle: '2011 Honda 00123 Accord Driver Side View Mirror ABS' });
  assert.equal(wrongPosition.validatedTitle, '2011 Honda Accord Driver Side View Mirror ABS 00123');

  const prefix257 = validate({
    sourceResolution: {
      ...baseInputs().sourceResolution,
      normalized: {
        ...baseInputs().sourceResolution.normalized,
        fields: { ...baseInputs().sourceResolution.normalized.fields, ipnPrefix: { value: '257' } }
      }
    },
    ruleResolution: {
      ...baseInputs().ruleResolution,
      listingContext: { ...baseInputs().ruleResolution.listingContext, ipnPrefix: '257' },
      prefixRule: { normalizedPrefix: '257', rule: { id: 'prefix-257', prefix: '257' }, systemRule: { id: 'SR-06' } }
    },
    candidateTitle: '2011 Honda Accord Speedometer 00123'
  });
  assert.equal(prefix257.validatedTitle.endsWith('#00123'), true);
  assert.equal((prefix257.validatedTitle.match(/#?00123/g) || []).length, 1);

  const non257 = validate({ candidateTitle: '2011 Honda Accord Side View Mirror #00123' });
  assert.equal(non257.validatedTitle.endsWith('00123'), true);
  assert.doesNotMatch(non257.validatedTitle, /#00123$/);
});

test('normalizes AC formatting and conservative duplicate wording', () => {
  const result = validate({ candidateTitle: '2011 Honda Accord A/C AC AC Side View Mirror Mirror ABS 00123' });

  assert.equal(result.validatedTitle.includes('A/C'), false);
  assert.equal(result.validatedTitle.includes('AC AC'), false);
  assert.equal(result.validatedTitle.includes('Mirror Mirror'), false);
  assert.equal(result.corrections.some(item => item.checkId === 'ac-formatting'), true);
  assert.equal(result.corrections.some(item => item.checkId === 'duplicate-wording'), true);
});

test('validates side from verified evidence and never from description-only fitment', () => {
  const preserved = validate({ candidateTitle: '2011 Honda Accord Driver Mirror ABS MPN-9 K24A BAYA VIN J 00123' });
  assert.equal(preserved.valid, true);

  const equivalentLeft = validate({
    sourceResolution: {
      ...baseInputs().sourceResolution,
      resolved: {
        ...baseInputs().sourceResolution.resolved,
        fields: { ...baseInputs().sourceResolution.resolved.fields, side: resolvedField('Driver/Left') }
      }
    },
    candidateTitle: '2011 Honda Accord Driver Left LH Side View Mirror ABS MPN-9 K24A BAYA VIN J 00123'
  });
  assert.equal(equivalentLeft.valid, true);

  const unsupported = validate({ candidateTitle: '2011 Honda Accord Passenger Side View Mirror ABS 00123' });
  assert.equal(unsupported.valid, false);
  assert.equal(unsupported.safeToContinue, false);
  assert.equal(unsupported.violations.some(item => item.checkId === 'side-validation'), true);

  const onlyDescriptionSide = validate({
    sourceResolution: {
      ...baseInputs().sourceResolution,
      resolved: {
        ...baseInputs().sourceResolution.resolved,
        fields: { ...baseInputs().sourceResolution.resolved.fields, side: resolvedField(null) }
      }
    },
    candidateTitle: '2011 Honda Accord Driver Side View Mirror ABS 00123'
  });
  assert.equal(onlyDescriptionSide.valid, false);
  assert.equal(onlyDescriptionSide.violations.some(item => item.checkId === 'side-validation'), true);
});

test('accepts structured driver and passenger door wording across common side variants', () => {
  for (const [verifiedSide, candidateSide] of [
    ['Drivers Door', 'Driver'],
    ["Driver's Door", 'Left'],
    ['Driver Side Front Door', 'LH'],
    ['Passengers Door', 'Passenger'],
    ["Passenger's Door", 'Right'],
    ['Passenger Side Front Door', 'RH']
  ]) {
    const inputs = baseInputs();
    inputs.sourceResolution.resolved.fields.side = resolvedField(verifiedSide);
    inputs.candidateTitle = `2011 Honda Accord ${candidateSide} Side View Mirror ABS MPN-9 K24A BAYA VIN J 00123`;
    const result = validateTitleOptimizationRuntimeCandidate(inputs);
    assert.equal(result.violations.some(item => item.checkId === 'side-validation'), false, `${verifiedSide} should support ${candidateSide}`);
  }
});

test('accepts verified Drivers Door and removes optional MPN from an over-limit candidate', () => {
  const inputs = baseInputs();
  inputs.sourceResolution.resolved.fields.side = resolvedField('Drivers Door');
  inputs.sourceResolution.resolved.fields.manufacturerPartNumber = resolvedField('935703X030YDA');
  inputs.sourceResolution.resolved.fields.sku = resolvedField('1588346', 'otherStructuredFields');
  inputs.sourceResolution.normalized.fields.sku = { value: '1588346' };
  inputs.candidateTitle = '2011-2013 Hyundai Elantra Front Driver Master Window Switch 935703X030YDA 1588346';

  const result = validateTitleOptimizationRuntimeCandidate(inputs);

  assert.equal(result.violations.some(item => item.checkId === 'side-validation'), false);
  assert.equal(result.validatedTitle.length <= 80, true);
  assert.doesNotMatch(result.validatedTitle, /935703X030YDA/);
  assert.equal(result.validatedTitle.endsWith('1588346'), true);
  assert.equal(result.corrections.some(item => item.checkId === 'length-80'), true);
});

test('handles restricted terms including never-introduce, authorization, noise, protected terms, and Long/Short Block', () => {
  const longBlock = validate({ candidateTitle: '2011 Honda Accord Long Block Side View Mirror ABS 00123' });
  assert.equal(longBlock.outcome, 'RETAIN_EXISTING_REQUIRED');
  assert.equal(longBlock.violations.some(item => item.relatedConfigIds.includes('rt-long')), true);

  const shortBlock = validate({ candidateTitle: '2011 Honda Accord Short Block Side View Mirror ABS 00123' });
  assert.equal(shortBlock.valid, false);
  assert.equal(shortBlock.violations.some(item => item.relatedConfigIds.includes('rt-short')), true);

  const authBlocked = validate({ candidateTitle: '2011 Honda Accord Complete Side View Mirror ABS 00123' });
  assert.equal(authBlocked.valid, false);
  assert.equal(authBlocked.violations.some(item => item.checkId === 'restricted-requires-authorization'), true);

  const authAllowed = validate({
    sourceResolution: {
      ...baseInputs().sourceResolution,
      resolved: {
        ...baseInputs().sourceResolution.resolved,
        fields: {
          ...baseInputs().sourceResolution.resolved.fields,
          authorization: resolvedField('Complete')
        }
      }
    },
    candidateTitle: '2011 Honda Accord Complete Side View Mirror ABS MPN-9 K24A BAYA VIN J 00123'
  });
  assert.equal(authAllowed.valid, true);

  const missingProtected = validate({ candidateTitle: '2011 Honda Accord Driver Side View Mirror 00123' });
  assert.equal(missingProtected.valid, false);
  assert.equal(missingProtected.violations.some(item => item.checkId === 'protected-term-preservation'), true);
});

test('preserves supported MPNs and removes unsupported optional MPN-like tokens', () => {
  const supported = validate({ candidateTitle: '2011 Honda Accord Side View Mirror MPN-9 ABS K24A BAYA VIN J 00123' });
  assert.equal(supported.valid, true);

  const unsupported = validate({ candidateTitle: '2011 Honda Accord Side View Mirror MPN-999 ABS 00123' });
  assert.equal(unsupported.valid, true);
  assert.doesNotMatch(unsupported.validatedTitle, /MPN-999/);
  assert.equal(unsupported.corrections.some(item => item.checkId === 'mpn-validation'), true);

  const hollanderOnly = validate({
    sourceResolution: {
      ...baseInputs().sourceResolution,
      resolved: {
        ...baseInputs().sourceResolution.resolved,
        fields: { ...baseInputs().sourceResolution.resolved.fields, manufacturerPartNumber: resolvedField(null) }
      }
    },
    candidateTitle: '2011 Honda Accord Side View Mirror 641-00641L ABS 00123'
  });
  assert.equal(hollanderOnly.valid, true);
  assert.doesNotMatch(hollanderOnly.validatedTitle, /641-00641L/);
  assert.equal(hollanderOnly.corrections.some(item => item.checkId === 'mpn-validation'), true);

  const authoritativeConflict = validate({
    sourceResolution: {
      ...baseInputs().sourceResolution,
      resolved: {
        ...baseInputs().sourceResolution.resolved,
        conflicts: [{ field: 'manufacturerPartNumber', values: ['MPN-9', 'MPN-10'] }]
      }
    },
    candidateTitle: '2011 Honda Accord Side View Mirror MPN-999 ABS 00123'
  });
  assert.equal(authoritativeConflict.valid, false);
  assert.equal(authoritativeConflict.violations.some(item => item.checkId === 'mpn-validation'), true);
});

test('detects unsupported identity changes without broad hardcoded detail checks', () => {
  const changedMake = validate({ candidateTitle: '2011 Toyota Accord Driver Side View Mirror ABS MPN-9 K24A BAYA VIN J 00123' });
  assert.equal(changedMake.valid, false);
  assert.equal(changedMake.violations.some(item => item.checkId === 'unsupported-information'), true);

  const cannotVerify = validate({ candidateTitle: '2011 Honda Accord Premium Driver Side View Mirror ABS MPN-9 K24A BAYA VIN J 00123' });
  assert.equal(cannotVerify.valid, true);
  assert.equal(cannotVerify.warnings.some(item => item.status === 'CANNOT_VERIFY'), true);
});

test('warns on obvious title structure mismatch without destructive rewrite', () => {
  const result = validate({ candidateTitle: 'Honda 00123 Accord 2011 Side View Mirror ABS MPN-9 K24A BAYA VIN J' });

  assert.equal(result.valid, true);
  assert.equal(result.warnings.some(item => item.checkId === 'title-structure'), true);
  assert.equal(result.validatedTitle, 'Honda Accord 2011 Side View Mirror ABS MPN-9 K24A BAYA VIN J 00123');
});

test('bypasses validation for manual override artifacts', () => {
  const result = validate({
    promptArtifact: { runtimeMode: 'authoritative', kind: 'title-generation-bypass', bypass: { reason: 'manual_override' } },
    sourceResolution: {
      ...baseInputs().sourceResolution,
      normalized: {
        ...baseInputs().sourceResolution.normalized,
        manualOverride: { active: true, status: { value: 'Manual Override' }, title: { value: 'Protected Manual Title' } }
      }
    },
    candidateTitle: 'Should Not Be Validated'
  });

  assert.equal(result.outcome, 'BYPASSED');
  assert.equal(result.valid, true);
  assert.equal(result.safeToContinue, true);
  assert.equal(result.validatedTitle, 'Should Not Be Validated');
  assert.deepEqual(result.corrections, []);
});

test('maps only approved flag reasons and remains deterministic and idempotent', () => {
  const inputs = baseInputs({
    candidateTitle: '2011 Honda Accord Driver Side View Mirror ABS MPN-9 K24A BAYA VIN J Critical Verified Fitment Cannot Drop 00123'
  });
  const first = validateTitleOptimizationRuntimeCandidate(inputs);
  const second = validateTitleOptimizationRuntimeCandidate(inputs);
  assert.deepEqual(second, first);
  assert.equal(first.suggestedReviewReasons.every(item => item.id), true);
  assert.equal(first.suggestedReviewReasons.some(item => item.reason === 'Cannot preserve essential fitment within 80 characters'), true);
  assert.equal(first.suggestedReviewReasons.some(item => item.reason === 'Arbitrary Runtime Reason'), false);

  const cleanup = validate({ candidateTitle: '  2011 Honda Accord A/C Side View Mirror OEM Part ABS 00123  ' });
  const idempotent = validate({ candidateTitle: cleanup.validatedTitle });
  assert.equal(idempotent.validatedTitle, cleanup.validatedTitle);
  assert.deepEqual(idempotent.corrections, []);
});

test('flags ambiguous model evidence instead of silently normalizing it', () => {
  const result = validate({
    sourceResolution: {
      ...baseInputs().sourceResolution,
      resolved: {
        ...baseInputs().sourceResolution.resolved,
        modelAmbiguity: {
          ambiguous: true,
          candidates: [
            { value: 'OUTBAKLEG', sources: ['itemSpecifics'] },
            { value: 'OUTBACK', sources: ['currentEbay'] },
            { value: 'LEGACY', sources: ['partFitment'] }
          ]
        }
      }
    },
    ruleResolution: {
      ...baseInputs().ruleResolution,
      flagReasons: [...baseInputs().ruleResolution.flagReasons, { id: 'flag-model', reason: 'Model cannot be normalized safely', enabled: true }]
    },
    candidateTitle: '2011 Honda Accord Driver Side View Mirror ABS MPN-9 K24A BAYA VIN J 00123'
  });
  assert.equal(result.outcome, 'FLAG');
  assert.equal(result.suggestedReviewReasons[0].reason, 'Model cannot be normalized safely');
  assert.equal(result.violations.some(item => item.checkId === 'model-ambiguity'), false);
});

test('accepts AI model normalization when all corroborated model names are preserved', () => {
  const inputs = baseInputs({
    candidateTitle: '2011 Honda Outback Legacy Driver Side View Mirror ABS MPN-9 K24A BAYA VIN J 00123'
  });
  inputs.sourceResolution.resolved.fields.model = resolvedField('OUTBAKLEG', 'itemSpecifics');
  inputs.sourceResolution.resolved.modelAmbiguity = {
    ambiguous: true,
    candidates: [
      { value: 'OUTBAKLEG', sources: ['itemSpecifics'] },
      { value: 'OUTBACK', sources: ['currentEbay'] },
      { value: 'LEGACY', sources: ['currentEbay', 'partFitment'] }
    ]
  };
  inputs.ruleResolution.flagReasons = [
    ...inputs.ruleResolution.flagReasons,
    { id: 'flag-model', reason: 'Model cannot be normalized safely', enabled: true }
  ];

  const result = validateTitleOptimizationRuntimeCandidate(inputs);

  assert.equal(result.suggestedReviewReasons.some(item => item.reason === 'Model cannot be normalized safely'), false);
  assert.equal(result.violations.some(item => item.checkId === 'unsupported-information'), false);
});

test('enforces AI category priority verification while preserving Prefix Rule authority', () => {
  const build = ({ title, details, decisions, evidence = 'Wiper Multifunction switch', prefix = false }) => {
    const inputs = baseInputs({ candidateTitle: title });
    inputs.ruleResolution.categoryRules = [{ rule: { id: 'cat-switch', categoryName: 'Switch', priorityDetails: details }, matchedBy: ['category'] }];
    inputs.ruleResolution.deterministicTitlePart = prefix ? { value: 'Wiper Turn Signal Multifunction Switch', source: 'prefixRule.specialReplacement', ruleId: 'prefix-629' } : null;
    inputs.ruleResolution.prefixRule = prefix ? { rule: { id: 'prefix-629', specialReplacement: 'Wiper Turn Signal Multifunction Switch', approvedPartTerms: [] } } : null;
    inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [{ source: 'Part Fitment', evidence }] } };
    inputs.categoryPriorityDetails = decisions;
    return validateTitleOptimizationRuntimeCandidate(inputs);
  };

  const all = build({
    title: '2011 Honda Accord Wiper Turn Signal Multifunction Switch ABS 00123',
    details: ['Wiper', 'Turn Signal', 'Multifunction'],
    evidence: 'Wiper Turn Signal Multifunction Switch',
    decisions: ['Wiper', 'Turn Signal', 'Multifunction'].map(detail => ({ detail, verified: true, source: 'Part Fitment', evidence: 'Wiper Turn Signal Multifunction Switch' }))
  });
  assert.equal(all.violations.some(item => item.checkId.startsWith('category-priority') || item.checkId === 'unverified-category-priority-detail'), false);

  const some = build({
    title: '2011 Honda Accord Wiper Multifunction Switch ABS 00123',
    details: ['Wiper', 'Turn Signal', 'Multifunction'],
    decisions: [
      { detail: 'Wiper', verified: true, source: 'Part Fitment', evidence: 'Wiper Multifunction switch' },
      { detail: 'Turn Signal', verified: false, source: null, evidence: null },
      { detail: 'Multifunction', verified: true, source: 'Part Fitment', evidence: 'Wiper Multifunction switch' }
    ]
  });
  assert.equal(some.violations.some(item => item.checkId === 'unverified-category-priority-detail'), false);

  const none = build({
    title: '2011 Honda Accord Column Switch ABS 00123',
    details: ['Wiper', 'Turn Signal', 'Multifunction'],
    decisions: ['Wiper', 'Turn Signal', 'Multifunction'].map(detail => ({ detail, verified: false, source: null, evidence: null }))
  });
  assert.equal(none.violations.some(item => item.checkId === 'unverified-category-priority-detail'), false);

  const unsupported = build({
    title: '2011 Honda Accord Turn Signal Column Switch ABS 00123',
    details: ['Turn Signal'],
    decisions: [{ detail: 'Turn Signal', verified: false, source: null, evidence: null }]
  });
  assert.equal(unsupported.violations.some(item => item.checkId === 'unverified-category-priority-detail'), true);

  const prefixAuthorized = build({
    title: '2011 Honda Accord Wiper Turn Signal Multifunction Switch ABS 00123',
    details: ['Wiper', 'Turn Signal', 'Multifunction'],
    decisions: ['Wiper', 'Turn Signal', 'Multifunction'].map(detail => ({ detail, verified: false, source: null, evidence: null })),
    prefix: true
  });
  assert.equal(prefixAuthorized.violations.some(item => item.checkId === 'unverified-category-priority-detail'), false);
});

test('accepts category detail verification backed by approved equivalent terminology evidence', () => {
  const inputs = baseInputs({ candidateTitle: '2011 Honda Accord Side View Mirror ABS 00123' });
  inputs.ruleResolution.categoryRules = [{ rule: { id: 'cat-mirror', priorityDetails: ['Side View Mirror'] }, matchedBy: ['category'] }];
  inputs.ruleResolution.terminologyRules = [{ id: 'term-mirror', sourceTerm: 'Door Mirror', replacementTerm: 'Side View Mirror', action: 'replace' }];
  inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [{ source: 'Item Specifics', evidence: 'Door Mirror' }] } };
  inputs.categoryPriorityDetails = [{ detail: 'Side View Mirror', verified: true, source: 'Item Specifics', evidence: 'Door Mirror' }];

  const result = validateTitleOptimizationRuntimeCandidate(inputs);
  assert.equal(result.violations.some(item => item.checkId === 'category-priority-verification'), false);
});

test('repairs a shortened category citation from the full cited trusted source', () => {
  const inputs = baseInputs({ candidateTitle: '2017-2020 BMW 430i Speedometer Base MPH 00123' });
  inputs.ruleResolution.categoryRules = [{ rule: { id: 'cat-cluster', priorityDetails: ['Speedometer'] }, matchedBy: ['category'] }];
  inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [{
    id: 'evidence-020',
    source: 'Part Fitment',
    evidence: '2017-2020 BMW 430i speedometer cluster, Base trim, MPH, without head-up display'
  }] } };
  inputs.categoryPriorityDetails = [{
    detail: 'Speedometer',
    verified: true,
    source: 'evidence-020',
    evidence: '2017-2020 BMW 430i cluster, Base trim, MPH, without head-up display'
  }];

  const result = validateTitleOptimizationRuntimeCandidate(inputs);

  assert.equal(result.violations.some(item => item.checkId === 'category-priority-verification'), false);
});

test('repairs category evidence attribution from another trusted source', () => {
  const inputs = baseInputs({ candidateTitle: '2017-2020 BMW 430i Speedometer Base MPH 00123' });
  inputs.ruleResolution.categoryRules = [{ rule: { id: 'cat-cluster', priorityDetails: ['Speedometer'] }, matchedBy: ['category'] }];
  inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [
    { id: 'evidence-020', source: 'Part Fitment', evidence: '2017-2020 BMW 430i cluster, Base trim, MPH' },
    { id: 'evidence-004', source: 'Existing Title', evidence: 'Speedometer Cluster Base MPH Fits 17-20 BMW 430i' }
  ] } };
  inputs.categoryPriorityDetails = [{ detail: 'Speedometer', verified: true, source: 'evidence-020', evidence: 'BMW 430i cluster' }];

  const result = validateTitleOptimizationRuntimeCandidate(inputs);

  assert.equal(result.violations.some(item => item.checkId === 'category-priority-verification'), false);
});

test('rejects category verification citing real but unrelated evidence across categories', () => {
  for (const [detail, evidence] of [
    ['Wiper', 'Column Switch Assembly with fog lamps'],
    ['Turn Signal', 'Switches & Controls'],
    ['LED', 'Headlight Assembly'],
    ['Retractor', 'Seat Belt'],
    ['Heated', 'Unheated mirror']
  ]) {
    const inputs = baseInputs({ candidateTitle: `2011 Honda Accord ${detail} Part ABS 00123` });
    inputs.ruleResolution.categoryRules = [{ rule: { priorityDetails: [detail] } }];
    inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [{ source: 'Item Specifics', evidence }] } };
    inputs.categoryPriorityDetails = [{ detail, verified: true, source: 'Item Specifics', evidence }];
    const result = validateTitleOptimizationRuntimeCandidate(inputs);
    assert.equal(result.violations.some(item => item.checkId === 'category-priority-verification'), true, detail);
  }
});

test('rejects category verification when the cited detail is explicitly absent', () => {
  const inputs = baseInputs({ candidateTitle: '2011 Honda Accord Heated Mirror ABS 00123' });
  inputs.ruleResolution.categoryRules = [{ rule: { priorityDetails: ['Heated'] } }];
  const evidence = 'Mirror without heated glass';
  inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [{ source: 'Part Fitment', evidence }] } };
  inputs.categoryPriorityDetails = [{ detail: 'Heated', verified: true, source: 'Part Fitment', evidence }];
  assert.equal(validateTitleOptimizationRuntimeCandidate(inputs).violations.some(item => item.checkId === 'category-priority-verification'), true);
});

test('rejects a used unverified category priority detail', () => {
  const inputs = baseInputs({ candidateTitle: '2011 Honda Accord Turn Signal Column Switch ABS 00123' });
  inputs.ruleResolution.categoryRules = [{ rule: { id: 'cat-switch', priorityDetails: ['Turn Signal'] }, matchedBy: ['category'] }];
  inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [{ source: 'Item Specifics', evidence: 'Column Switch' }] } };
  inputs.categoryPriorityDetails = [{ detail: 'Turn Signal', verified: false, source: 'Item Specifics', evidence: 'Column Switch' }];

  const result = validateTitleOptimizationRuntimeCandidate(inputs);
  assert.equal(result.violations.some(item => item.checkId === 'unverified-category-priority-detail'), true);
});

test('optional category metadata cannot force review when its detail is absent from the title', () => {
  const inputs = baseInputs({ candidateTitle: '2011 Honda Accord Mirror ABS 00123' });
  inputs.ruleResolution.categoryRules = [{ rule: { priorityDetails: ['Heated', 'Power Folding'] } }];
  inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [] } };
  inputs.categoryPriorityDetails = [{ detail: 'Heated', verified: true,
    source: 'missing-source', evidence: 'Heated' }];
  const result = validateTitleOptimizationRuntimeCandidate(inputs);
  assert.equal(result.violations.some(item => item.checkId === 'category-priority-verification'), false);
  inputs.candidateTitle = '2011 Honda Accord Heated Mirror ABS 00123';
  const used = validateTitleOptimizationRuntimeCandidate(inputs);
  assert.equal(used.violations.some(item => item.checkId === 'category-priority-verification'), true);
});

test('accepts configured synonym evidence for category details', () => {
  const inputs = baseInputs({ candidateTitle: '2011 Honda Accord Headlight ABS 00123' });
  inputs.ruleResolution.categoryRules = [{ rule: { priorityDetails: ['Headlight'] } }];
  inputs.ruleResolution.synonyms = [{ primaryTerm: 'Headlight', synonyms: ['Headlamp'], enabled: true }];
  inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [{ source: 'Item Specifics', evidence: 'Headlamp' }] } };
  inputs.categoryPriorityDetails = [{ detail: 'Headlight', verified: true, source: 'Item Specifics', evidence: 'Headlamp' }];
  assert.equal(validateTitleOptimizationRuntimeCandidate(inputs).violations.some(item => item.checkId === 'category-priority-verification'), false);
});

test('accepts actual Item Specific value as evidence for a configured field concept', () => {
  for (const [detail, value] of [['Color', 'Beige'], ['Material', 'Aluminum']]) {
    const inputs = baseInputs({ candidateTitle: `2011 Honda Accord Mirror ${value} ABS 00123` });
    inputs.ruleResolution.categoryRules = [{ rule: { priorityDetails: [detail] } }];
    inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [{
      id: `specific-${detail.toLowerCase()}`,
      source: `Item Specifics:${detail}`,
      evidence: value
    }] } };
    inputs.categoryPriorityDetails = [{
      detail,
      verified: true,
      source: `specific-${detail.toLowerCase()}`,
      evidence: value
    }];

    const result = validateTitleOptimizationRuntimeCandidate(inputs);

    assert.equal(result.violations.some(item => item.checkId === 'category-priority-verification'), false, detail);
  }
});

test('explicit Part Fitment supports side while a conflicting structured side remains authoritative', () => {
  const inputs = baseInputs({ candidateTitle: '2011 Honda Accord Driver Left Mirror ABS 00123' });
  inputs.sourceResolution.resolved.fields.side = { resolvedValue: null };
  inputs.sourceResolution.normalized.titleAuthority = { partFitment: { value: '2011 Honda Accord left mirror' } };
  assert.equal(validateTitleOptimizationRuntimeCandidate(inputs).violations.some(item => item.checkId === 'side-validation'), false);
  inputs.sourceResolution.resolved.fields.side.resolvedValue = 'Right';
  assert.equal(validateTitleOptimizationRuntimeCandidate(inputs).violations.some(item => item.checkId === 'side-validation'), true);
});

test('component importance is left to AI instead of a hardcoded validator list', () => {
  const inputs = baseInputs({ candidateTitle: '2011 Honda Accord Seat Belt ABS 00123' });
  inputs.sourceResolution.resolved.fields.componentType = resolvedField('Retractor');
  assert.equal(validateTitleOptimizationRuntimeCandidate(inputs).violations.some(item => item.checkId === 'detail-assessment'), false);
});

test('make validation requires all authoritative brand words and rejects shortened or unrelated makes', () => {
  const inputs = baseInputs({ candidateTitle: '2011 Chevrolet Truck Accord Mirror ABS 00123' });
  inputs.sourceResolution.resolved.fields.brandMake.resolvedValue = 'CHEVROLET TRUCK';
  assert.equal(validateTitleOptimizationRuntimeCandidate(inputs).violations.some(item => /change verified brandMake/.test(item.message)), false);
  inputs.candidateTitle = '2011 Chevrolet Accord Mirror ABS 00123';
  assert.equal(validateTitleOptimizationRuntimeCandidate(inputs).violations.some(item => /change verified brandMake/.test(item.message)), true);
  inputs.candidateTitle = '2011 Honda Accord Mirror ABS 00123';
  assert.equal(validateTitleOptimizationRuntimeCandidate(inputs).violations.some(item => /change verified brandMake/.test(item.message)), true);
});

test('AI can select cited side independently of Front placement while opposite side is rejected', () => {
  const inputs = baseInputs({ candidateTitle: '2011 Honda Accord Front Driver Left Mirror ABS 00123' });
  inputs.sourceResolution.resolved.fields.side.resolvedValue = 'Front';
  const evidence = 'Honda Accord front mirror driver side';
  inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [{ source: 'Part Fitment', evidence }] } };
  inputs.sideDecision = { side: 'Driver Left LH', placement: 'Front', source: 'Part Fitment', evidence };
  assert.equal(validateTitleOptimizationRuntimeCandidate(inputs).violations.some(item => item.checkId === 'side-validation'), false);
  inputs.sourceResolution.resolved.fields.side.resolvedValue = 'Right';
  assert.equal(validateTitleOptimizationRuntimeCandidate(inputs).violations.some(item => item.checkId === 'side-validation'), true);
});

test('side evidence accepts harmless citation wrappers consistently', () => {
  const inputs = baseInputs({ candidateTitle: '2011 Honda Accord Driver Left Mirror ABS 00123' });
  inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [
    { id: 'side-source', source: 'Current title', evidence: 'Driver Left LH' }
  ] } };
  inputs.sideDecision = { side: 'Driver Left', placement: null, source: 'side-source', evidence: '"Driver Left LH"' };
  assert.equal(validateTitleOptimizationRuntimeCandidate(inputs).violations.some(item => item.checkId === 'side-validation'), false);
});

test('side decision accepts multiple trusted citations for side and placement', () => {
  const inputs = baseInputs({ candidateTitle: '2011 Honda Accord Front Driver Mirror ABS 00123' });
  inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [
    { id: 'evidence-side', source: 'Item Specifics', evidence: 'Drivers Door' },
    { id: 'evidence-placement', source: 'Current title', evidence: 'Front' }
  ] } };
  inputs.sideDecision = {
    side: 'Driver',
    placement: 'Front',
    source: 'evidence-side;evidence-placement',
    evidence: 'Drivers Door; Front'
  };

  assert.equal(validateTitleOptimizationRuntimeCandidate(inputs).violations.some(item => item.checkId === 'side-validation'), false);
});

test('placement-only side labels do not create false side conflicts', () => {
  const inputs = baseInputs({ candidateTitle: '2011 Honda Accord Roof Center Console ABS 00123' });
  inputs.sourceResolution.resolved.fields.side.resolvedValue = null;
  inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [
    { id: 'placement-source', source: 'Current title', evidence: 'Roof Console Center' }
  ] } };
  inputs.sideDecision = {
    side: 'Center',
    placement: 'Roof Center',
    source: 'placement-source',
    evidence: 'Roof Console Center'
  };

  assert.equal(validateTitleOptimizationRuntimeCandidate(inputs).violations.some(item => item.checkId === 'side-validation'), false);
});

test('AI side decision cannot invent citations or drop its verified side', () => {
  const inputs = baseInputs({ candidateTitle: '2011 Honda Accord Mirror ABS 00123' });
  inputs.sourceResolution.resolved.fields.side.resolvedValue = null;
  const evidence = 'Honda Accord left mirror';
  inputs.promptArtifact.userPayload = { resolvedListing: { categoryPriorityEvidenceSources: [{ source: 'Part Fitment', evidence }] } };
  inputs.sideDecision = { side: 'Left', placement: null, source: 'Part Fitment', evidence };
  assert.equal(validateTitleOptimizationRuntimeCandidate(inputs).violations.some(item => /omits or changes/.test(item.message)), true);
  inputs.sideDecision.evidence = 'Honda Accord right mirror';
  assert.equal(validateTitleOptimizationRuntimeCandidate(inputs).violations.some(item => /lacks supporting/.test(item.message)), true);
});
