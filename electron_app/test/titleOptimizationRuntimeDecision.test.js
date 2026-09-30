const test = require('node:test');
const assert = require('node:assert/strict');

const { decideTitleOptimizationRuntimeResult } = require('../src/services/titleOptimizationRuntimeDecisionService');

function field(value, source = 'itemSpecifics', extras = {}) {
  return {
    resolvedValue: value,
    resolvedSource: source,
    missing: value === null || value === undefined || value === '',
    ...extras
  };
}

test('AI selected year range preserves a verified single year within the range', () => {
  const inputs = baseInputs();
  inputs.validationResult.validatedTitle = '2010-2012 Honda Accord Driver Side Mirror ABS K24A BAYA AWD 00123';
  const result = decideTitleOptimizationRuntimeResult(inputs);
  assert.equal(result.degradationChecks.some(item => item.field === 'year' && item.status === 'FAIL'), false);
});

function check(overrides = {}) {
  return {
    checkId: 'validator-check',
    status: 'FAIL',
    severity: 'error',
    message: 'validator finding',
    relatedConfigIds: [],
    suggestedFlagReason: null,
    ...overrides
  };
}

function baseInputs(overrides = {}) {
  const sourceResolution = {
    normalized: {
      manualOverride: { active: false, status: { value: '' }, title: { value: '' } },
      fields: {
        existingTitle: { value: '2011 Honda Accord Driver Side Mirror ABS K24A BAYA AWD 00123' },
        sku: { value: '00123' }
      }
    },
    resolved: {
      fields: {
        title: field('2011 Honda Accord Driver Side Mirror ABS K24A BAYA AWD 00123', 'currentEbay'),
        sku: field('00123', 'otherStructuredFields'),
        year: field('2011'),
        brandMake: field('Honda'),
        model: field('Accord'),
        side: field('Driver'),
        part: field('Side Mirror'),
        engineDisplacement: field('2.4L'),
        engineCode: field('K24A'),
        vin: field('VIN J'),
        transmissionCode: field('BAYA'),
        drivetrain: field('AWD'),
        speedType: field('Automatic'),
        manufacturerPartNumber: field('MPN-9')
      },
      conflicts: []
    }
  };
  const ruleResolution = {
    runtimeMode: 'authoritative',
    restrictedTerms: {
      groups: {
        'must-preserve': [{ id: 'rt-abs', term: 'ABS', ruleType: 'must-preserve' }]
      }
    },
    categoryRules: [
      { rule: { id: 'cat-engine', categoryName: 'Engines', priorityDetails: ['Engine Code', 'Transmission Code', 'Drivetrain'] }, matchedBy: ['category'] }
    ],
    flagReasons: [
      { id: 'flag-year', reason: 'Missing verified year', enabled: true },
      { id: 'flag-conflict', reason: 'Conflicting source data', enabled: true },
      { id: 'flag-fitment', reason: 'Cannot preserve essential fitment within 80 characters', enabled: true },
      { id: 'flag-degrade', reason: 'Proposed title would degrade existing title', enabled: true },
      { id: 'flag-part', reason: 'Part identity uncertain', enabled: true }
    ],
    systemRules: [
      { id: 'SR-05', title: 'SKU exactly once at end' },
      { id: 'SR-07', title: '80 character maximum' },
      { id: 'SR-14', title: 'No degrade' }
    ]
  };
  const validationResult = {
    runtimeMode: 'authoritative',
    outcome: 'PASS',
    originalCandidate: '2011 Honda Accord Driver Side Mirror ABS K24A BAYA AWD 00123',
    validatedTitle: '2011 Honda Accord Driver Side Mirror ABS K24A BAYA AWD 00123',
    valid: true,
    safeToContinue: true,
    changed: false,
    checks: [],
    corrections: [],
    violations: [],
    warnings: [],
    suggestedReviewReasons: []
  };
  return {
    snapshot: { runtimeMode: 'authoritative' },
    sourceResolution,
    ruleResolution,
    promptArtifact: { runtimeMode: 'authoritative', kind: 'prompt' },
    validationResult,
    ...overrides
  };
}

function decide(overrides = {}) {
  return decideTitleOptimizationRuntimeResult(baseInputs(overrides));
}

test('accepts safe candidates, different wording, verified enrichment, and optional reductions', () => {
  const safe = decide();
  assert.equal(safe.decision, 'ACCEPT_CANDIDATE');
  assert.equal(safe.finalTitle, safe.candidateTitle);
  assert.equal(safe.candidateAccepted, true);
  assert.equal(safe.reviewRequired, false);

  const wording = decide({
    validationResult: {
      ...baseInputs().validationResult,
      validatedTitle: '2011 Honda Accord ABS Driver Mirror K24A BAYA AWD 00123'
    }
  });
  assert.equal(wording.decision, 'ACCEPT_CANDIDATE');

  const enrichment = decide({
    validationResult: {
      ...baseInputs().validationResult,
      validatedTitle: '2011 Honda Accord Driver Side Mirror ABS K24A BAYA AWD VIN J 00123'
    }
  });
  assert.equal(enrichment.decision, 'ACCEPT_CANDIDATE');

  const optionalReduction = decide({
    validationResult: {
      ...baseInputs().validationResult,
      validatedTitle: '2011 Honda Accord Driver Side Mirror ABS K24A BAYA AWD 00123'
    },
    sourceResolution: {
      ...baseInputs().sourceResolution,
      resolved: {
        ...baseInputs().sourceResolution.resolved,
        fields: {
          ...baseInputs().sourceResolution.resolved.fields,
          manufacturerPartNumber: field('MPN-9')
        }
      }
    }
  });
  assert.equal(optionalReduction.decision, 'ACCEPT_CANDIDATE');
});

test('AI semantic approval owns no-degrade and source-conflict decisions', () => {
  const inputs = baseInputs();
  inputs.validationResult.validatedTitle = '2011 Honda Accord Driver Mirror 00123';
  inputs.validationResult.semanticSafety = {
    supplied: true,
    safeToPublish: true,
    reason: 'The shorter wording preserves the supported listing identity.',
    concerns: []
  };
  inputs.sourceResolution.resolved.conflicts = [{ field: 'brandMake', value: 'HONDA TRUCK' }];

  const result = decideTitleOptimizationRuntimeResult(inputs);

  assert.equal(result.decision, 'ACCEPT_CANDIDATE');
  assert.equal(result.reviewRequired, false);
  assert.equal(result.degradationChecks.some(item => item.checkId === 'critical-loss'), false);
  assert.equal(result.degradationChecks.some(item => item.checkId === 'material-source-conflict'), false);
});

test('AI semantic rejection requires review even when deterministic invariants pass', () => {
  const inputs = baseInputs();
  inputs.validationResult.semanticSafety = {
    supplied: true,
    safeToPublish: false,
    reason: 'The proposed title changes the advertised vehicle model.',
    concerns: ['Model mismatch']
  };

  const result = decideTitleOptimizationRuntimeResult(inputs);

  assert.equal(result.decision, 'NEEDS_REVIEW');
  assert.equal(result.reviewRequired, true);
  assert.match(result.reviewNotes, /changes the advertised vehicle model/i);
  assert.equal(result.degradationChecks.find(item => item.checkId === 'ai-semantic-safety').status, 'FAIL');
});

test('retains existing when candidate loses critical verified data preserved by existing title', () => {
  for (const [fieldName, candidate] of [
    ['sku', '2011 Honda Accord Driver Side Mirror ABS K24A BAYA AWD'],
    ['year', 'Honda Accord Driver Side Mirror ABS K24A BAYA AWD 00123'],
    ['brandMake', '2011 Accord Driver Side Mirror ABS K24A BAYA AWD 00123'],
    ['model', '2011 Honda Driver Side Mirror ABS K24A BAYA AWD 00123'],
    ['side', '2011 Honda Accord Side Mirror ABS K24A BAYA AWD 00123'],
    ['protected acronym', '2011 Honda Accord Driver Side Mirror K24A BAYA AWD 00123']
  ]) {
    const result = decide({
      validationResult: { ...baseInputs().validationResult, validatedTitle: candidate }
    });
    assert.equal(result.decision, 'RETAIN_EXISTING', fieldName);
    assert.equal(result.finalTitle, result.existingTitle);
    assert.equal(result.reviewRequired, true);
    assert.equal(result.reviewReason, 'Proposed title would degrade existing title');
    assert.equal(result.degradationChecks.some(item => item.status === 'FAIL'), true);
  }
});

test('rejects narrowing a continuously supported existing fitment range to the donor year', () => {
  const result = decide({
    sourceResolution: {
      ...baseInputs().sourceResolution,
      normalized: {
        ...baseInputs().sourceResolution.normalized,
        titleAuthority: {
          partFitment: { value: '2013-2015 Honda Accord Engine 2.4L VIN 1 Coupe Federal Emissions' }
        },
        fields: {
          ...baseInputs().sourceResolution.normalized.fields,
          existingTitle: { value: 'Engine 2.4L VIN 1 6th Digit Coupe Federal Emissions Fits 13-15 ACCORD 1585847' },
          sku: { value: '1585847' }
        }
      },
      resolved: {
        ...baseInputs().sourceResolution.resolved,
        fields: {
          ...baseInputs().sourceResolution.resolved.fields,
          title: field('Engine 2.4L VIN 1 6th Digit Coupe Federal Emissions Fits 13-15 ACCORD 1585847', 'currentEbay'),
          sku: field('1585847', 'otherStructuredFields'),
          year: field('2013'),
          brandMake: field('Honda'),
          model: field('Accord'),
          part: field('Engine'),
          engineDisplacement: field('2.4L'),
          vin: field('VIN 1')
        }
      }
    },
    validationResult: {
      ...baseInputs().validationResult,
      validatedTitle: '2013 Honda Accord Engine 2.4L VIN 1 Coupe Federal Emissions 1585847'
    }
  });

  assert.equal(result.decision, 'RETAIN_EXISTING');
  assert.equal(result.reviewRequired, true);
  assert.equal(result.finalTitle, 'Engine 2.4L VIN 1 6th Digit Coupe Federal Emissions Fits 13-15 ACCORD 1585847');
  assert.equal(result.degradationChecks.some(item => item.checkId === 'explicit-year-range-loss' && item.status === 'FAIL'), true);
});

test('critical data unavailable or not preserved by existing title is not required for candidate acceptance', () => {
  const inputs = baseInputs();
  const result = decide({
    sourceResolution: {
      ...inputs.sourceResolution,
      resolved: {
        ...inputs.sourceResolution.resolved,
        fields: {
          ...inputs.sourceResolution.resolved.fields,
          engineDisplacement: field(null)
        }
      }
    },
    validationResult: {
      ...inputs.validationResult,
      validatedTitle: '2011 Honda Accord Driver Side Mirror ABS K24A BAYA AWD 00123'
    }
  });

  assert.equal(result.decision, 'ACCEPT_CANDIDATE');
});

test('consumes Phase E unsupported additions and safety failures without revalidating them', () => {
  for (const validatorFinding of [
    check({ checkId: 'side-validation', message: 'unsupported Passenger Side introduced' }),
    check({ checkId: 'mpn-validation', message: 'unsupported MPN introduced' }),
    check({ checkId: 'restricted-requires-authorization', message: 'unauthorized descriptor introduced' }),
    check({ checkId: 'long-short-block-protection', message: 'Long Block introduced' }),
    check({ checkId: 'long-short-block-protection', message: 'Short Block introduced' }),
    check({ checkId: 'unsupported-information', message: 'unsupported Make/Model/year introduced' })
  ]) {
    const result = decide({
      validationResult: {
        ...baseInputs().validationResult,
        outcome: 'RETAIN_EXISTING_REQUIRED',
        valid: false,
        safeToContinue: false,
        violations: [validatorFinding],
        checks: [validatorFinding]
      }
    });
    assert.equal(result.decision, 'RETAIN_EXISTING', validatorFinding.message);
    assert.equal(result.reviewRequired, true);
    assert.equal(result.reviewReason, 'Proposed title would degrade existing title');
  }
});

test('maps Phase E outcomes to deterministic final decisions', () => {
  assert.equal(decide({ validationResult: { ...baseInputs().validationResult, outcome: 'PASS' } }).decision, 'ACCEPT_CANDIDATE');
  assert.equal(decide({ validationResult: { ...baseInputs().validationResult, outcome: 'CLEANUP', changed: true } }).decision, 'ACCEPT_CANDIDATE');
  assert.equal(decide({ validationResult: { ...baseInputs().validationResult, outcome: 'FLAG', warnings: [check({ status: 'CANNOT_VERIFY', severity: 'warning' })] } }).decision, 'NEEDS_REVIEW');
  assert.equal(decide({
    validationResult: {
      ...baseInputs().validationResult,
      outcome: 'RETAIN_EXISTING_REQUIRED',
      valid: false,
      safeToContinue: false,
      violations: [check()]
    }
  }).decision, 'RETAIN_EXISTING');
  assert.equal(decide({
    validationResult: {
      ...baseInputs().validationResult,
      outcome: 'BLOCK',
      valid: false,
      safeToContinue: false,
      validatedTitle: '',
      violations: [check({ checkId: 'blank-title', status: 'BLOCK' })]
    }
  }).decision, 'RETAIN_EXISTING');
});

test('manual protection bypass preserves title and returns status-specific review metadata', () => {
  for (const [canonicalStatus, expectedNote] of [
    ['Manually Approved', 'Title is manually approved; automated title generation was skipped.'],
    ['Manually Overridden', 'Title is manually overridden; automated title generation was skipped.']
  ]) {
    const result = decide({
      promptArtifact: { runtimeMode: 'authoritative', kind: 'title-generation-bypass', bypass: { reason: 'manual_override' } },
      sourceResolution: {
        ...baseInputs().sourceResolution,
        normalized: {
          ...baseInputs().sourceResolution.normalized,
          manualOverride: {
            active: true,
            canonicalStatus,
            status: { value: canonicalStatus },
            title: { value: 'Protected Manual Title' }
          }
        }
      },
      validationResult: {
        ...baseInputs().validationResult,
        outcome: 'BYPASSED',
        validatedTitle: 'Generated Replacement Should Be Ignored'
      }
    });

    assert.equal(result.decision, 'BYPASSED_MANUAL_OVERRIDE');
    assert.equal(result.finalTitle, 'Protected Manual Title');
    assert.equal(result.candidateAccepted, false);
    assert.equal(result.retainedExisting, true);
    assert.equal(result.reviewStatus, 'manual_override_bypass');
    assert.equal(result.reviewReason, 'manual_override');
    assert.equal(result.reviewNotes, expectedNote);
  }
});

test('classifies unverified category priority details as a no-degrade failure', () => {
  const finding = check({
    checkId: 'unverified-category-priority-detail',
    message: 'Candidate introduces an unverified Category Rule detail.'
  });
  const result = decide({
    validationResult: {
      ...baseInputs().validationResult,
      outcome: 'RETAIN_EXISTING_REQUIRED',
      valid: false,
      safeToContinue: false,
      violations: [finding],
      checks: [finding]
    }
  });

  assert.equal(result.decision, 'RETAIN_EXISTING');
  assert.equal(result.reviewReason, 'Proposed title would degrade existing title');
});

test('handles missing existing title and missing candidate without manufacturing fallbacks', () => {
  const noExistingSafe = decide({
    sourceResolution: {
      ...baseInputs().sourceResolution,
      normalized: { ...baseInputs().sourceResolution.normalized, fields: { sku: { value: '00123' } } },
      resolved: {
        ...baseInputs().sourceResolution.resolved,
        fields: { ...baseInputs().sourceResolution.resolved.fields, title: field(null) }
      }
    }
  });
  assert.equal(noExistingSafe.decision, 'ACCEPT_CANDIDATE');

  const existingBlankCandidate = decide({
    validationResult: {
      ...baseInputs().validationResult,
      outcome: 'BLOCK',
      valid: false,
      safeToContinue: false,
      validatedTitle: '',
      violations: [check({ checkId: 'blank-title', status: 'BLOCK' })]
    }
  });
  assert.equal(existingBlankCandidate.decision, 'RETAIN_EXISTING');
  assert.equal(existingBlankCandidate.finalTitle, existingBlankCandidate.existingTitle);

  const neither = decide({
    sourceResolution: {
      ...baseInputs().sourceResolution,
      normalized: { ...baseInputs().sourceResolution.normalized, fields: {} },
      resolved: {
        ...baseInputs().sourceResolution.resolved,
        fields: { ...baseInputs().sourceResolution.resolved.fields, title: field(null) }
      }
    },
    validationResult: {
      ...baseInputs().validationResult,
      outcome: 'BLOCK',
      valid: false,
      safeToContinue: false,
      validatedTitle: '',
      violations: [check({ checkId: 'blank-title', status: 'BLOCK' })]
    }
  });
  assert.equal(neither.decision, 'BLOCKED');
  assert.equal(neither.finalTitle, null);
});

test('80-character failure retains usable existing title and marks overlength existing as review-only reference', () => {
  const lengthFailure = check({
    checkId: 'length-80',
    systemRuleId: 'SR-07',
    status: 'RETAIN_EXISTING_REQUIRED',
    suggestedFlagReason: { id: 'flag-fitment', reason: 'Cannot preserve essential fitment within 80 characters' },
    message: 'cannot preserve essential fitment within 80 characters'
  });
  const result = decide({
    validationResult: {
      ...baseInputs().validationResult,
      outcome: 'RETAIN_EXISTING_REQUIRED',
      valid: false,
      safeToContinue: false,
      violations: [lengthFailure],
      suggestedReviewReasons: [lengthFailure.suggestedFlagReason]
    }
  });
  assert.equal(result.decision, 'RETAIN_EXISTING');
  assert.equal(result.reviewReason, 'Cannot preserve essential fitment within 80 characters');

  const longExisting = `${'Verified '.repeat(12)}00123`;
  const over = decide({
    sourceResolution: {
      ...baseInputs().sourceResolution,
      normalized: { ...baseInputs().sourceResolution.normalized, fields: { existingTitle: { value: longExisting }, sku: { value: '00123' } } },
      resolved: {
        ...baseInputs().sourceResolution.resolved,
        fields: { ...baseInputs().sourceResolution.resolved.fields, title: field(longExisting, 'currentEbay') }
      }
    },
    validationResult: {
      ...baseInputs().validationResult,
      outcome: 'RETAIN_EXISTING_REQUIRED',
      valid: false,
      safeToContinue: false,
      violations: [lengthFailure],
      suggestedReviewReasons: [lengthFailure.suggestedFlagReason]
    }
  });
  assert.equal(over.finalTitle, longExisting);
  assert.equal(over.metadata.existingTitlePublishable, false);
  assert.equal(over.reviewRequired, true);
});

test('uses only approved flag reasons with deterministic precedence', () => {
  const result = decide({
    validationResult: {
      ...baseInputs().validationResult,
      outcome: 'RETAIN_EXISTING_REQUIRED',
      valid: false,
      safeToContinue: false,
      violations: [check({ checkId: 'length-80' }), check({ checkId: 'unsupported-information' })],
      suggestedReviewReasons: [
        { id: 'flag-fitment', reason: 'Cannot preserve essential fitment within 80 characters' },
        { id: 'not-approved', reason: 'Arbitrary AI reason' }
      ]
    }
  });

  assert.equal(result.reviewReason, 'Cannot preserve essential fitment within 80 characters');
  assert.equal(result.reasons.some(reason => reason.reason === 'Arbitrary AI reason'), false);
});

test('handles source conflicts conservatively without rejecting irrelevant lower-priority conflicts', () => {
  const irrelevant = decide({
    sourceResolution: {
      ...baseInputs().sourceResolution,
      resolved: {
        ...baseInputs().sourceResolution.resolved,
        conflicts: [{ field: 'color', conflicts: [{ value: 'Blue' }] }]
      }
    }
  });
  assert.equal(irrelevant.decision, 'ACCEPT_CANDIDATE');

  const material = decide({
    sourceResolution: {
      ...baseInputs().sourceResolution,
      resolved: {
        ...baseInputs().sourceResolution.resolved,
        conflicts: [{ field: 'brandMake', resolvedValue: 'Honda', conflicts: [{ value: 'Toyota' }] }]
      }
    }
  });
  assert.equal(material.decision, 'NEEDS_REVIEW');
  assert.equal(material.reviewReason, 'Conflicting source data');
});

test('accepts AI-normalized model names corroborated by current title and Part Fitment', () => {
  const inputs = baseInputs();
  const title = '2011 Honda Outback Legacy Driver Side Mirror ABS K24A BAYA AWD 00123';
  inputs.sourceResolution.normalized.fields.existingTitle = { value: title };
  inputs.sourceResolution.resolved.fields.title = field(title, 'currentEbay');
  inputs.sourceResolution.resolved.fields.model = field('OUTBAKLEG', 'itemSpecifics');
  inputs.sourceResolution.resolved.modelAmbiguity = {
    ambiguous: true,
    candidates: [
      { value: 'OUTBAKLEG', sources: ['itemSpecifics'] },
      { value: 'OUTBACK', sources: ['currentEbay'] },
      { value: 'LEGACY', sources: ['currentEbay', 'partFitment'] }
    ]
  };
  inputs.ruleResolution.flagReasons.push({ id: 'flag-model', reason: 'Model cannot be normalized safely', enabled: true });
  inputs.validationResult.validatedTitle = title;

  const result = decideTitleOptimizationRuntimeResult(inputs);

  assert.equal(result.decision, 'ACCEPT_CANDIDATE');
  assert.equal(result.reviewRequired, false);
});

test('is deterministic and does not mutate Phase A/B/C/D/E inputs', () => {
  const inputs = baseInputs({
    validationResult: {
      ...baseInputs().validationResult,
      outcome: 'FLAG',
      warnings: [check({ status: 'CANNOT_VERIFY', severity: 'warning' })]
    }
  });
  const before = JSON.stringify(inputs);
  const first = decideTitleOptimizationRuntimeResult(inputs);
  const second = decideTitleOptimizationRuntimeResult(inputs);

  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(inputs), before);
});
