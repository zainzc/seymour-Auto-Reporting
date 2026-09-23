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
    runtimeMode: 'shadow-only',
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
      { id: 'flag-conflict', reason: 'Conflicting source data', enabled: true },
      { id: 'flag-fitment', reason: 'Cannot preserve essential fitment within 80 characters', enabled: true },
      { id: 'flag-degrade', reason: 'Proposed title would degrade existing title', enabled: true }
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
    runtimeMode: 'shadow-only',
    kind: 'prompt',
    metadata: { selectedStructureId: 'structure-general' }
  };
  return {
    snapshot: { runtimeMode: 'shadow-only' },
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

test('validates MPN support and does not treat Hollander numbers as MPN', () => {
  const supported = validate({ candidateTitle: '2011 Honda Accord Side View Mirror MPN-9 ABS K24A BAYA VIN J 00123' });
  assert.equal(supported.valid, true);

  const unsupported = validate({ candidateTitle: '2011 Honda Accord Side View Mirror MPN-999 ABS 00123' });
  assert.equal(unsupported.valid, false);
  assert.equal(unsupported.violations.some(item => item.checkId === 'mpn-validation'), true);

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
  assert.equal(hollanderOnly.valid, false);
  assert.equal(hollanderOnly.violations.some(item => item.checkId === 'mpn-validation'), true);
});

test('detects critical fitment loss and unsupported identity changes without broad hallucination checks', () => {
  const engineLoss = validate({ candidateTitle: '2011 Honda Accord Driver Side View Mirror ABS MPN-9 BAYA VIN J 00123' });
  assert.equal(engineLoss.valid, false);
  assert.equal(engineLoss.violations.some(item => item.checkId === 'critical-fitment-preservation'), true);

  const transmissionLoss = validate({ candidateTitle: '2011 Honda Accord Driver Side View Mirror ABS MPN-9 K24A VIN J 00123' });
  assert.equal(transmissionLoss.valid, false);
  assert.equal(transmissionLoss.violations.some(item => item.message.includes('transmissionCode')), true);

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
    promptArtifact: { runtimeMode: 'shadow-only', kind: 'title-generation-bypass', bypass: { reason: 'manual_override' } },
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
