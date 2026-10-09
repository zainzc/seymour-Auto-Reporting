const test = require('node:test');
const assert = require('node:assert/strict');

const { runTitleOptimizationRuntime } = require('../src/services/titleOptimizationRuntimeService');

function aiLedDependencies(aiResult, overrides = {}) {
  return {
    loadSnapshot: async () => ({ metadata: { configurationVersion: 'v5' } }),
    resolveSource: () => ({ normalized: { recordId: 'rec-ai' }, resolved: { fields: {
      sku: { resolvedValue: '12345' }, title: { resolvedValue: 'Existing title 12345' }
    }, conflicts: [], missing: [] } }),
    resolveRules: () => ({ listingContext: { ipnPrefix: '641' }, flagReasons: [], systemRules: [] }),
    buildPrompt: () => ({ kind: 'prompt', userPayload: { resolvedListing: {
      titleFitmentCandidates: { eligibleCandidates: [] }
    } } }),
    executeAi: async () => aiResult,
    reviewTitleFitment: async () => ({ verdict: 'PASS', reason: 'The title matches the supplied application.', citedRowIds: [] }),
    logger: { info: () => {} },
    ...overrides
  };
}

test('AI Completed survives semantic code uncertainty after independent AI review', async () => {
  const result = await runTitleOptimizationRuntime({ dependencies: aiLedDependencies({
    generatedTitle: '2010-2012 Ford Fusion Starter Motor 12345', generatedDescription: 'Description',
    titleReviewStatus: 'Completed', vehicleDecision: { resolved: false }
  }) });
  assert.equal(result.output.reviewStatus, 'Completed');
  assert.equal(result.output.title, '2010-2012 Ford Fusion Starter Motor 12345');
  assert.doesNotMatch(result.output.reviewNotes, /Verified vehicle application/);
});

test('AI-led runtime log exposes the generator vehicle decision', async () => {
  let log = '';
  await runTitleOptimizationRuntime({ dependencies: aiLedDependencies({
    generatedTitle: '2010-2012 Ford Fusion Starter Motor 12345', titleReviewStatus: 'Completed',
    vehicleDecision: { resolved: true, make: 'Ford', model: 'Fusion', yearRange: '2010-2012',
      source: 'currentEbay' }
  }, { logger: { info: message => { log = message; } } }) });
  assert.match(log, /vehicleDecision=\{"resolved":true,"make":"Ford"/);
  assert.match(log, /fitmentReview=.*PASS/);
});

test('a compliant unchanged AI title is retained with a clear review note', async () => {
  const currentTitle = '2010 Ford Fusion Starter Motor 12345';
  let calls = 0;
  const result = await runTitleOptimizationRuntime({
    options: { enableIndependentAiReview: false },
    dependencies: aiLedDependencies({}, {
      resolveSource: () => ({ normalized: { recordId: 'rec-ai' }, resolved: { fields: {
        sku: { resolvedValue: '12345' }, title: { resolvedValue: currentTitle }
      }, conflicts: [], missing: [] } }),
      buildPrompt: () => ({ kind: 'prompt', userPayload: {
        existingTitle: { currentTitle }, resolvedListing: { titleFitmentCandidates: { eligibleCandidates: [] } }
      } }),
      executeAi: async () => {
        calls += 1;
        return { generatedTitle: currentTitle, titleReviewStatus: 'Completed',
          generatedDescription: 'Accurate product description.' };
      }
    })
  });

  assert.equal(calls, 1);
  assert.equal(result.output.title, currentTitle);
  assert.equal(result.output.reviewStatus, 'Completed');
  assert.match(result.output.reviewNotes, /existing title retained unchanged/i);
});

test('AI Needs Review is preserved without calling the independent reviewer', async () => {
  let reviews = 0;
  const result = await runTitleOptimizationRuntime({ dependencies: aiLedDependencies({
    generatedTitle: '2010-2012 Ford Fusion Starter Motor 12345', generatedDescription: 'Description',
    titleReviewStatus: 'Needs Review', titleReviewReason: 'Conflicting source data',
    titleReviewNotes: 'The supplied applications disagree.'
  }, { reviewTitleFitment: async () => { reviews += 1; return { verdict: 'PASS', reason: 'Safe', citedRowIds: [] }; } }) });
  assert.equal(reviews, 0);
  assert.equal(result.output.title, '2010-2012 Ford Fusion Starter Motor 12345');
  assert.equal(result.output.reviewStatus, 'Needs Review');
  assert.match(result.output.reviewNotes, /applications disagree/);
});

test('a side reversal is held before a retry can mark it Completed or write it into Item Title', async () => {
  let calls = 0;
  const proposedTitle = '2008 Infiniti G35 Seat Belt Buckle Driver Left 12345';
  const result = await runTitleOptimizationRuntime({
    options: { enableIndependentAiReview: false },
    dependencies: aiLedDependencies({}, {
      buildPrompt: () => ({ kind: 'prompt', userPayload: {
        existingTitle: { currentTitle: '2008 Infiniti G35 Seat Belt Buckle Passenger Right 12345' },
        resolvedListing: { titleFitmentCandidates: { eligibleCandidates: [] } }
      } }),
      executeAi: async () => {
        calls += 1;
        return {
          generatedTitle: proposedTitle,
          titleReviewStatus: 'Completed',
          materialRestrictions: [], restrictedTermDecisions: [], titleSegments: [],
          ruleSelfAudit: { structureFollowed: true, unresolvedSourceConflict: false, unsupportedClaim: false }
        };
      }
    })
  });

  assert.equal(calls, 1);
  assert.equal(result.output.reviewStatus, 'Needs Review');
  assert.equal(result.output.title, '');
  assert.equal(result.output.proposedTitle, proposedTitle);
  assert.match(result.output.reviewNotes, /side.*conflict|conflict.*side/i);
});

test('AI Completed is not downgraded by a material wording match', async () => {
  const proposedTitle = '2014 Power Side View Mirror 12345';
  const result = await runTitleOptimizationRuntime({
    options: { enableIndependentAiReview: false },
    dependencies: aiLedDependencies({}, {
      buildPrompt: () => ({ kind: 'prompt', userPayload: { resolvedListing: {
        titleFitmentCandidates: { eligibleCandidates: [{ id: 'title-fitment-001' }] }
      } } }),
      executeAi: async () => ({
        generatedTitle: proposedTitle, titleReviewStatus: 'Completed',
        materialRestrictions: [{ detail: 'Without heated glass', sourceRowIds: ['title-fitment-001'],
          material: true, titleTreatment: 'included' }],
        restrictedTermDecisions: [], titleSegments: [],
        ruleSelfAudit: { structureFollowed: true, unresolvedSourceConflict: false, unsupportedClaim: false }
      })
    })
  });

  assert.equal(result.output.reviewStatus, 'Completed');
  assert.equal(result.output.title, proposedTitle);
  assert.equal(result.output.proposedTitle, proposedTitle);
  assert.equal(result.attempts.length, 1);
});

test('diagnostic rule metadata does not trigger a retry or Needs Review', async () => {
  let calls = 0;
  const result = await runTitleOptimizationRuntime({
    options: { enableIndependentAiReview: false },
    dependencies: aiLedDependencies({}, {
      resolveRules: () => ({
        listingContext: { ipnPrefix: '641' },
        restrictedTerms: { rules: [{ id: 'oem', term: 'OEM Part', ruleType: 'remove-noise' }] },
        categoryRules: [], flagReasons: [], systemRules: []
      }),
      buildPrompt: () => ({ kind: 'prompt', userPayload: { resolvedListing: {
        categoryPriorityEvidenceSources: [],
        titleFitmentCandidates: { eligibleCandidates: [{ id: 'title-fitment-001' }] }
      } } }),
      executeAi: async () => {
        calls += 1;
        return {
          generatedTitle: '2010 Ford Fusion Starter Motor 12345', titleReviewStatus: 'Completed',
          materialRestrictions: [{ detail: 'Starter Motor', sourceRowIds: ['evidence-999'],
            material: true, titleTreatment: 'included' }],
          restrictedTermDecisions: [], titleSegments: [],
          ruleSelfAudit: { structureFollowed: false, unresolvedSourceConflict: false, unsupportedClaim: false }
        };
      }
    })
  });

  assert.equal(calls, 1);
  assert.equal(result.output.reviewStatus, 'Completed');
  assert.equal(result.output.title, '2010 Ford Fusion Starter Motor 12345');
  assert.equal(result.ruleDecision.checks.some(item => item.status === 'WARN'), true);
});

test('repairable AI Needs Review needs a corrected generator decision and final independent PASS', async () => {
  let generations = 0;
  let reviews = 0;
  const result = await runTitleOptimizationRuntime({ dependencies: aiLedDependencies({}, {
    executeAi: async ({ promptArtifact }) => {
      generations += 1;
      if (generations === 2) assert.match(promptArtifact.userPayload.correction.instruction, /Reconsider your original Needs Review/i);
      return { generatedTitle: '2010-2012 Ford Fusion Starter Motor 12345',
        titleReviewStatus: generations === 1 ? 'Needs Review' : 'Completed',
        titleReviewReason: generations === 1 ? 'Possible year mismatch' : 'completed' };
    },
    reviewTitleFitment: async () => { reviews += 1; return { verdict: 'PASS',
      reason: 'Vehicle and title are supported.', citedRowIds: [] }; }
  }) });
  assert.equal(generations, 2);
  assert.equal(reviews, 2);
  assert.equal(result.output.reviewStatus, 'Completed');
});

test('independent PASS alone cannot overturn an AI Needs Review', async () => {
  let reviews = 0;
  const result = await runTitleOptimizationRuntime({ dependencies: aiLedDependencies({}, {
    executeAi: async () => ({ generatedTitle: '2010-2012 Ford Fusion Starter Motor 12345',
      titleReviewStatus: 'Needs Review', titleReviewReason: 'Possible year mismatch' }),
    reviewTitleFitment: async () => { reviews += 1; return { verdict: 'PASS',
      reason: 'Fitment is supported.', citedRowIds: [] }; }
  }) });
  assert.equal(reviews, 1);
  assert.equal(result.output.reviewStatus, 'Needs Review');
  assert.equal(result.output.title, '2010-2012 Ford Fusion Starter Motor 12345');
});

test('mechanical SKU check normalizes the verified SKU exactly once at the end', async () => {
  const result = await runTitleOptimizationRuntime({ dependencies: aiLedDependencies({
    generatedTitle: '12345 2010-2012 Ford Fusion Starter Motor 12345',
    titleReviewStatus: 'Completed'
  }) });
  assert.equal(result.output.title, '2010-2012 Ford Fusion Starter Motor 12345');
});

test('overlength AI title is written as a Needs Review draft, not Completed', async () => {
  const longTitle = `${'Long descriptive automotive part name '.repeat(4)}12345`;
  const result = await runTitleOptimizationRuntime({ dependencies: aiLedDependencies({
    generatedTitle: longTitle, titleReviewStatus: 'Completed'
  }) });
  assert.equal(result.output.title, longTitle);
  assert.equal(result.output.reviewStatus, 'Needs Review');
});

test('missing verified SKU keeps the proposed Item Title as a Needs Review draft', async () => {
  const proposedTitle = '2010 Ford Fusion Starter Motor';
  const result = await runTitleOptimizationRuntime({
    options: { enableIndependentAiReview: false },
    dependencies: aiLedDependencies({ generatedTitle: proposedTitle, titleReviewStatus: 'Completed' }, {
      resolveSource: () => ({ normalized: { recordId: 'rec-ai' }, resolved: { fields: {
        title: { resolvedValue: 'Existing title' }
      }, conflicts: [], missing: ['sku'] } })
    })
  });

  assert.equal(result.output.reviewStatus, 'Needs Review');
  assert.equal(result.output.title, proposedTitle);
  assert.match(result.output.reviewNotes, /SKU/i);
});

test('mechanical correction does not ask AI to satisfy removed semantic code checks', async () => {
  let calls = 0;
  const result = await runTitleOptimizationRuntime({ dependencies: aiLedDependencies({}, {
    executeAi: async ({ promptArtifact }) => {
      calls += 1;
      if (calls === 2) {
        assert.match(promptArtifact.userPayload.correction.instruction, /80 characters/);
        assert.doesNotMatch(promptArtifact.userPayload.correction.instruction, /invented citation/i);
        return { generatedTitle: '2010 Ford Fusion Starter 12345', titleReviewStatus: 'Completed' };
      }
      return { generatedTitle: `${'Long descriptive automotive part name '.repeat(4)}12345`,
        titleReviewStatus: 'Completed' };
    }
  }) });
  assert.equal(calls, 2);
  assert.equal(result.output.reviewStatus, 'Completed');
});

test('independent AI review can still veto a generator-Completed title', async () => {
  const result = await runTitleOptimizationRuntime({ dependencies: aiLedDependencies({
    generatedTitle: '2010-2012 Ford Fusion Starter Motor 12345', titleReviewStatus: 'Completed'
  }, { reviewTitleFitment: async () => ({ verdict: 'REVIEW',
    reason: 'The selected years omit a required VIN restriction.', citedRowIds: [] }) }) });
  assert.equal(result.output.title, '2010-2012 Ford Fusion Starter Motor 12345');
  assert.equal(result.output.reviewStatus, 'Needs Review');
  assert.match(result.output.reviewNotes, /VIN restriction/);
});

test('disabled independent AI review uses the generator decision without calling the reviewer', async () => {
  let reviews = 0;
  const result = await runTitleOptimizationRuntime({
    options: { enableIndependentAiReview: false },
    dependencies: aiLedDependencies({
      generatedTitle: '2010-2012 Ford Fusion Starter Motor 12345',
      titleReviewStatus: 'Completed'
    }, {
      reviewTitleFitment: async () => {
        reviews += 1;
        return { verdict: 'REVIEW', reason: 'Reviewer veto.', citedRowIds: [] };
      }
    })
  });
  assert.equal(reviews, 0);
  assert.equal(result.output.title, '2010-2012 Ford Fusion Starter Motor 12345');
  assert.equal(result.output.reviewStatus, 'Completed');
});

test('disabled independent AI review preserves the generator Needs Review decision', async () => {
  let reviews = 0;
  const result = await runTitleOptimizationRuntime({
    options: { enableIndependentAiReview: false },
    dependencies: aiLedDependencies({
      generatedTitle: '2010-2012 Ford Fusion Starter Motor 12345',
      titleReviewStatus: 'Needs Review',
      titleReviewReason: 'Conflicting source data',
      titleReviewNotes: 'The supplied evidence remains materially ambiguous.'
    }, {
      reviewTitleFitment: async () => {
        reviews += 1;
        return { verdict: 'PASS', reason: 'Reviewer pass.', citedRowIds: [] };
      }
    })
  });
  assert.equal(reviews, 0);
  assert.equal(result.output.title, '2010-2012 Ford Fusion Starter Motor 12345');
  assert.equal(result.output.reviewStatus, 'Needs Review');
  assert.match(result.output.reviewNotes, /materially ambiguous/);
});

test('explicit restricted-term contract blocks an unauthorized AI-Completed title', async () => {
  const result = await runTitleOptimizationRuntime({
    options: { enableIndependentAiReview: false },
    dependencies: aiLedDependencies({
      generatedTitle: '2014 Honda Accord Complete Assembly 12345',
      titleReviewStatus: 'Completed',
      restrictedTermDecisions: [{
        term: 'Complete Assembly', used: true, authorized: false, source: null, evidence: null
      }],
      materialRestrictions: [],
      titleSegments: [{ key: 'part', value: '2014 Honda Accord Complete Assembly' }, { key: 'sku', value: '12345' }],
      ruleSelfAudit: {
        structureFollowed: true, unresolvedSourceConflict: false, unsupportedClaim: false, notes: 'Checked.'
      }
    }, {
      resolveRules: () => ({
        listingContext: { ipnPrefix: '300' },
        restrictedTerms: {
          rules: [{ id: 'restricted-complete', term: 'Complete Assembly', ruleType: 'requires-authorization' }],
          groups: { 'requires-authorization': [{ id: 'restricted-complete', term: 'Complete Assembly', ruleType: 'requires-authorization' }] }
        },
        flagReasons: [],
        systemRules: []
      }),
      buildPrompt: () => ({ kind: 'prompt', userPayload: { resolvedListing: {
        titleFitmentCandidates: { eligibleCandidates: [] },
        categoryPriorityEvidenceSources: [{
          id: 'evidence-001', source: 'Item Specifics',
          evidence: 'Complete Assembly', authorizesRestrictedTerms: false
        }]
      } } })
    })
  });

  assert.equal(result.output.title, '');
  assert.equal(result.output.proposedTitle, '2014 Honda Accord Complete Assembly 12345');
  assert.equal(result.output.reviewStatus, 'Needs Review');
  assert.match(result.output.reviewNotes, /Complete Assembly.*authorization/i);
});

test('explicit restricted-term contract accepts a cited authorization', async () => {
  const result = await runTitleOptimizationRuntime({
    options: { enableIndependentAiReview: false },
    dependencies: aiLedDependencies({
      generatedTitle: '2014 Honda Accord Complete Assembly 12345',
      titleReviewStatus: 'Completed',
      restrictedTermDecisions: [{
        term: 'Complete Assembly', used: true, authorized: true,
        source: 'evidence-001', evidence: 'Complete Assembly'
      }],
      materialRestrictions: [],
      titleSegments: [{ key: 'part', value: '2014 Honda Accord Complete Assembly' }, { key: 'sku', value: '12345' }],
      ruleSelfAudit: {
        structureFollowed: true, unresolvedSourceConflict: false, unsupportedClaim: false, notes: 'Checked.'
      }
    }, {
      resolveRules: () => ({
        listingContext: { ipnPrefix: '300' },
        restrictedTerms: {
          rules: [{ id: 'restricted-complete', term: 'Complete Assembly', ruleType: 'requires-authorization' }],
          groups: { 'requires-authorization': [{ id: 'restricted-complete', term: 'Complete Assembly', ruleType: 'requires-authorization' }] }
        },
        flagReasons: [],
        systemRules: []
      }),
      buildPrompt: () => ({ kind: 'prompt', userPayload: { resolvedListing: {
        titleFitmentCandidates: { eligibleCandidates: [] },
        categoryPriorityEvidenceSources: [{
          id: 'evidence-001', source: 'Manual Restricted Term Authorization',
          evidence: 'Complete Assembly', authorizesRestrictedTerms: true
        }]
      } } })
    })
  });

  assert.equal(result.output.reviewStatus, 'Completed');
  assert.equal(result.output.title, '2014 Honda Accord Complete Assembly 12345');
});

test('manual title override still bypasses generation and writes no replacement', async () => {
  let calls = 0;
  const result = await runTitleOptimizationRuntime({ dependencies: aiLedDependencies({}, {
    buildPrompt: () => ({ kind: 'title-generation-bypass', userPayload: {} }),
    executeAi: async () => { calls += 1; return {}; }
  }) });
  assert.equal(calls, 0);
  assert.equal(result.output.title, '');
  assert.equal(result.output.reviewStatus, 'Skipped - Manual Override');
});

test('Prefix 257 keeps the verified SKU once with a hash suffix', async () => {
  const result = await runTitleOptimizationRuntime({ dependencies: aiLedDependencies({
    generatedTitle: '2010 Ford Cluster 12345', titleReviewStatus: 'Completed'
  }, { resolveRules: () => ({ listingContext: { ipnPrefix: '257' }, flagReasons: [], systemRules: [] }) }) });
  assert.equal(result.output.title, '2010 Ford Cluster #12345');
});

function dependencies(overrides = {}) {
  const calls = [];
  return {
    loadSnapshot: async () => {
      calls.push('snapshot');
      return { runtimeReady: true, metadata: { configurationVersion: 'v5' } };
    },
    resolveSource: () => {
      calls.push('source');
      return { normalized: { recordId: 'rec-1' }, resolved: { fields: {}, conflicts: [], missing: [] } };
    },
    resolveRules: () => {
      calls.push('rules');
      return { runtimeReady: true, flagReasons: [], systemRules: [] };
    },
    buildPrompt: () => {
      calls.push('prompt');
      return { kind: 'prompt', metadata: { selectedStructureId: 'general' } };
    },
    executeAi: async () => {
      calls.push('ai');
      return {
        generatedTitle: '2010-2012 Subaru Outback Legacy Column Switch 00123',
        generatedDescription: 'Runtime description',
        shortDescription: 'Runtime short description',
        titleReviewStatus: 'Completed',
        titleReviewReason: 'completed',
        titleReviewNotes: 'Runtime accepted'
      };
    },
    reviewTitleFitment: async () => ({ verdict: 'PASS', reason: 'Final title preserves the cited application.', citedRowIds: [] }),
    validate: () => {
      calls.push('validate');
      return {
        outcome: 'PASS',
        validatedTitle: '2010-2012 Subaru Outback Legacy Column Switch 00123',
        corrections: [],
        violations: [],
        warnings: []
      };
    },
    decide: () => {
      calls.push('decide');
      return {
        decision: 'ACCEPT_CANDIDATE',
        finalTitle: '2010-2012 Subaru Outback Legacy Column Switch 00123',
        reviewRequired: false,
        reviewReason: null,
        reviewNotes: ''
      };
    },
    logger: { info: () => calls.push('log') },
    calls,
    ...overrides
  };
}

test('runtime corrects a rejected proposal once and revalidates before accepting', async () => {
  let aiCalls = 0;
  let validations = 0;
  const deps = dependencies({
    executeAi: async ({ promptArtifact }) => {
      aiCalls += 1;
      if (aiCalls === 2) assert.match(JSON.stringify(promptArtifact.userPayload.correction), /Missing Sedan/);
      return { generatedTitle: aiCalls === 1 ? 'Initial title' : 'Corrected Sedan title', titleReviewStatus: 'Completed' };
    },
    validate: ({ candidateTitle }) => { validations += 1; return { validatedTitle: candidateTitle, violations: [], warnings: [] }; },
    decide: ({ validationResult }) => ({
      decision: aiCalls === 1 ? 'RETAIN_EXISTING' : 'ACCEPT_CANDIDATE',
      finalTitle: aiCalls === 1 ? 'Existing title' : validationResult.validatedTitle,
      reviewRequired: aiCalls === 1,
      degradationChecks: aiCalls === 1 ? [{ status: 'FAIL', checkId: 'detail', message: 'Missing Sedan' }] : []
    })
  });
  const result = await runTitleOptimizationRuntime({ dependencies: deps });
  assert.equal(aiCalls, 2);
  assert.equal(validations, 2);
  assert.equal(result.output.title, 'Corrected Sedan title');
  assert.equal(result.attempts.length, 2);
});

test('independent fitment review keeps the reviewed proposal writable with a failed review status', async () => {
  const seen = [];
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    reviewTitleFitment: async input => {
      seen.push(input.title);
      return { verdict: 'REVIEW', reason: '2014-2015 requires VIN J; the title claims unrestricted fitment.',
        citedRowIds: ['title-fitment-002'], rowAssessments: [{ rowId: 'title-fitment-002',
          yearScope: '2014-2015', conditions: 'VIN J', titleCoverage: 'UNCLEAR',
          explanation: 'The restriction is not scoped to 2014-2015.' }] };
    },
    buildPrompt: () => ({ kind: 'prompt', userPayload: { resolvedListing: { titleFitmentCandidates: {
      eligibleCandidates: [{ id: 'title-fitment-002', evidence: '2014-2015 Nissan Rogue VIN J' }]
    } } } }),
    executeAi: async ({ promptArtifact }) => ({ generatedTitle: promptArtifact.userPayload.correction
      ? '2008-2015 Nissan Rogue Starter Motor 1591087'
      : '2008-2015 Nissan Rogue Starter Motor VIN J 1591087' }),
    validate: ({ candidateTitle }) => ({ outcome: 'PASS', validatedTitle: candidateTitle, violations: [], warnings: [] }),
    decide: ({ validationResult }) => ({ decision: 'ACCEPT_CANDIDATE', finalTitle: validationResult.validatedTitle,
      reviewRequired: false, degradationChecks: [] })
  }) });
  assert.equal(seen.length, 2);
  assert.equal(result.output.title, '2008-2015 Nissan Rogue Starter Motor 1591087');
  assert.equal(result.output.reviewStatus, 'Needs Review');
  assert.match(result.output.reviewNotes, /2014-2015 requires VIN J/);
});

test('independent fitment review accepts a corrected title only after reviewing that exact title', async () => {
  const seen = [];
  let generationCalls = 0;
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    executeAi: async () => ({ generatedTitle: ++generationCalls === 1 ? 'Unsafe title 123' : 'Corrected title 123' }),
    reviewTitleFitment: async input => {
      seen.push(input.title);
      return { verdict: seen.length === 1 ? 'REVIEW' : 'PASS',
        reason: seen.length === 1 ? 'A material condition is missing.' : 'Condition is preserved.', citedRowIds: [] };
    },
    validate: ({ candidateTitle }) => ({ outcome: 'PASS', validatedTitle: candidateTitle, violations: [], warnings: [] }),
    decide: ({ validationResult }) => ({ decision: 'ACCEPT_CANDIDATE', finalTitle: validationResult.validatedTitle,
      reviewRequired: false, degradationChecks: [] })
  }) });
  assert.deepEqual(seen, ['Unsafe title 123', 'Corrected title 123']);
  assert.equal(result.output.title, 'Corrected title 123');
  assert.equal(result.output.reviewStatus, 'Completed');
});

test('overlength fitment correction is compressed and its exact result independently reviewed', async () => {
  let calls = 0;
  const reviewed = [];
  const longTitle = `2010-2012 Ford Fusion ${'Verified '.repeat(7)}Switch 12345`;
  const result = await runTitleOptimizationRuntime({ dependencies: aiLedDependencies({}, {
    executeAi: async ({ promptArtifact }) => {
      calls += 1;
      if (calls === 3) {
        assert.match(promptArtifact.userPayload.correction.instruction, /compression-only/i);
        assert.match(promptArtifact.userPayload.correction.fitmentReview.reason, /Sedan/);
        assert.equal(promptArtifact.userPayload.titleBudget.maximumCharactersBeforeSku, 74);
        assert.equal(promptArtifact.userPayload.titleBudget.previousTitleCharactersAfterSku, longTitle.length);
      }
      return { generatedTitle: calls === 1 ? '2010-2012 Ford Fusion Switch 12345'
        : calls === 2 ? longTitle : '2010-2012 Ford Fusion Sedan Switch 12345', titleReviewStatus: 'Completed' };
    },
    reviewTitleFitment: async input => {
      reviewed.push(input.title);
      return { verdict: reviewed.length === 1 ? 'REVIEW' : 'PASS',
        reason: reviewed.length === 1 ? 'Sedan must be preserved.' : 'Sedan restriction preserved.', citedRowIds: [] };
    }
  }) });
  assert.equal(calls, 3);
  assert.deepEqual(reviewed, ['2010-2012 Ford Fusion Switch 12345', '2010-2012 Ford Fusion Sedan Switch 12345']);
  assert.equal(result.output.reviewStatus, 'Completed');
});

test('fitment reviewer failure keeps the generated proposal writable with Needs Review', async () => {
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    reviewTitleFitment: async () => { throw new Error('review unavailable'); }
  }) });
  assert.equal(result.output.title, '2010-2012 Subaru Outback Legacy Column Switch 00123');
  assert.equal(result.output.reviewStatus, 'Needs Review');
  assert.match(result.output.reviewNotes, /review unavailable/i);
});

test('invalid reviewer structure gets one focused retry before requesting user review', async () => {
  let calls = 0;
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    reviewTitleFitment: async input => {
      calls += 1;
      if (calls === 1) return { verdict: 'PASS', reason: 'Looks safe.', citedRowIds: ['row-1'] };
      assert.match(input.reviewFeedback, /every selected row/);
      return { verdict: 'PASS', reason: 'The selected row is accurately represented.',
        citedRowIds: ['row-1'], rowAssessments: [{ rowId: 'row-1', yearScope: '2010-2012',
          conditions: 'none', titleCoverage: 'ACCURATE', explanation: 'Title covers the row.' }] };
    },
    buildPrompt: () => ({ kind: 'prompt', userPayload: { resolvedListing: { titleFitmentCandidates: {
      eligibleCandidates: [{ id: 'row-1', startYear: 2010, endYear: 2012,
        evidence: '2010-2012 Subaru Outback Legacy Column Switch' }]
    } } } })
  }) });
  assert.equal(calls, 2);
  assert.equal(result.output.reviewStatus, 'Completed');
});

test('a rejected fitment correction retains the review finding in Airtable notes', async () => {
  let generationCalls = 0;
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    executeAi: async () => ({ generatedTitle: ++generationCalls === 1 ? 'Initial title 123' : 'Still unsafe 123' }),
    reviewTitleFitment: async () => ({ verdict: 'REVIEW', reason: 'Later years require a build restriction.', citedRowIds: [] }),
    validate: ({ candidateTitle }) => ({ outcome: 'PASS', validatedTitle: candidateTitle, violations: [] }),
    decide: ({ validationResult }) => ({
      decision: generationCalls === 1 ? 'ACCEPT_CANDIDATE' : 'RETAIN_EXISTING',
      finalTitle: validationResult.validatedTitle,
      reviewRequired: generationCalls !== 1,
      reviewNotes: 'Correction did not meet title requirements.',
      degradationChecks: []
    })
  }) });
  assert.equal(result.output.title, 'Still unsafe 123');
  assert.match(result.output.reviewNotes, /Corrected title still requires review/);
  assert.match(result.output.reviewNotes, /Correction did not meet title requirements/);
  assert.match(result.output.reviewNotes, /Later years require a build restriction/);
});

test('correction tells AI to remove only redundant wording and preserves verified vehicle application', async () => {
  let calls = 0;
  const vehicleVerification = { verified: true, decision: { make: 'Ford', model: 'Fusion', yearRange: '2010-2012' } };
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    buildPrompt: () => ({ kind: 'prompt', userPayload: {} }),
    executeAi: async ({ promptArtifact }) => {
      if (++calls === 2) {
        assert.deepEqual(promptArtifact.userPayload.correction.verifiedVehicleDecision, vehicleVerification.decision);
        assert.match(promptArtifact.userPayload.correction.instruction, /selected Part Fitment application/);
        assert.match(promptArtifact.userPayload.correction.instruction, /overlapping or repeated part-name wording first/);
        assert.match(promptArtifact.userPayload.correction.instruction, /unsupported year/i);
        assert.match(promptArtifact.userPayload.correction.instruction, /make or model/i);
        assert.match(promptArtifact.userPayload.correction.instruction, /side/i);
        assert.match(promptArtifact.userPayload.correction.instruction, /80 characters/i);
      }
      return { generatedTitle: calls === 1 ? 'Ford Fusion VIN 3 123' : 'Ford Fusion VIN 3 8th Digit 123' };
    },
    validate: ({ candidateTitle }) => ({ validatedTitle: candidateTitle, vehicleVerification }),
    decide: ({ validationResult }) => ({ decision: calls === 1 ? 'RETAIN_EXISTING' : 'ACCEPT_CANDIDATE',
      finalTitle: validationResult.validatedTitle, reviewRequired: calls === 1,
      degradationChecks: calls === 1 ? [{ status: 'FAIL', message: 'Missing 8th Digit' }] : [] })
  }) });
  assert.equal(result.output.title, 'Ford Fusion VIN 3 8th Digit 123');
});

test('fitment correction reuses an already verified vehicle decision if the model omits it', async () => {
  const verifiedVehicle = { resolved: true, make: 'Chevrolet', model: 'Equinox',
    yearRange: '2010-2017', source: 'title-fitment-001',
    evidence: '2010-2017 Chevrolet Equinox 2.4L', reason: 'Cited fitment row.' };
  let calls = 0;
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    buildPrompt: () => ({ kind: 'prompt', userPayload: { resolvedListing: {
      titleFitmentCandidates: { eligibleCandidates: [{ id: 'title-fitment-001',
        startYear: 2010, endYear: 2017, evidence: verifiedVehicle.evidence }] }
    } } }),
    executeAi: async ({ promptArtifact }) => {
      calls += 1;
      if (calls === 2) assert.deepEqual(promptArtifact.userPayload.correction.verifiedVehicleDecision, verifiedVehicle);
      return { generatedTitle: calls === 1 ? '2010-2017 Chevrolet Equinox Starter 123' :
        '2010-2017 Chevrolet Equinox Starter 2.4L 123',
      vehicleDecision: calls === 1 ? verifiedVehicle : null };
    },
    validate: ({ candidateTitle, vehicleDecision }) => ({ outcome: 'PASS', validatedTitle: candidateTitle,
      vehicleVerification: { verified: vehicleDecision === verifiedVehicle, decision: vehicleDecision },
      violations: [], warnings: [] }),
    decide: ({ validationResult }) => ({ decision: 'ACCEPT_CANDIDATE',
      finalTitle: validationResult.validatedTitle, reviewRequired: false, degradationChecks: [] }),
    reviewTitleFitment: async input => ({ verdict: calls === 1 ? 'REVIEW' : 'PASS',
      reason: calls === 1 ? '2.4L is missing.' : '2.4L is present.', citedRowIds: ['title-fitment-001'],
      rowAssessments: [{ rowId: 'title-fitment-001', yearScope: '2010-2017', conditions: '2.4L',
        titleCoverage: calls === 1 ? 'OMITTED' : 'ACCURATE', explanation: 'Checked against fitment.' }] })
  }) });
  assert.equal(result.output.reviewStatus, 'Completed');
  assert.match(result.output.title, /2\.4L/);
});

test('failed correction preserves the original safe decision and stops after two calls', async () => {
  let aiCalls = 0;
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    executeAi: async () => { if (++aiCalls === 2) throw new Error('unavailable'); return { generatedTitle: 'Initial title' }; },
    decide: () => ({ decision: 'RETAIN_EXISTING', finalTitle: 'Existing safe title', reviewRequired: true, degradationChecks: [{ status: 'FAIL', message: 'Missing detail' }] })
  }) });
  assert.equal(aiCalls, 2);
  assert.equal(result.output.title, 'Initial title');
  assert.equal(result.output.proposedTitle, 'Initial title');
  assert.equal(result.output.reviewStatus, 'Needs Review');
  assert.match(result.output.reviewNotes, /Proposed title: Initial title/);
});

test('malformed first response gets one retry within the same two-call budget', async () => {
  let calls = 0;
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    executeAi: async () => ++calls === 1 ? {} : { generatedTitle: 'Corrected title' },
    decide: () => ({ decision: 'RETAIN_EXISTING', finalTitle: 'Safe title', reviewRequired: true, degradationChecks: [{ status: 'FAIL', message: 'Unresolved' }] })
  }) });
  assert.equal(calls, 2);
  assert.equal(result.output.title, 'Corrected title');
  assert.equal(result.output.proposedTitle, 'Corrected title');
  assert.match(result.output.reviewNotes, /Proposed title: Corrected title/);
});

test('invalid material fitment date stops before AI and returns a specific review reason', async () => {
  let aiCalls = 0;
  const messages = [];
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    buildPrompt: () => ({
      kind: 'prompt',
      metadata: {},
      userPayload: { resolvedListing: { titleFitmentCandidates: {
        resolution: 'AMBIGUOUS',
        distinctApplications: [],
        sourceIssues: [{
          code: 'INVALID_FITMENT_DATE',
          value: '09/31/04',
          evidence: '2005 Toyota Tundra master switch, built through 09/31/04',
          message: 'Part Fitment contains an invalid calendar date (09/31/04).'
        }]
      } } }
    }),
    executeAi: async () => { aiCalls += 1; return { generatedTitle: 'Unsafe title' }; },
    logger: { info: message => messages.push(message) }
  }) });

  assert.equal(aiCalls, 0);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.output.title, '');
  assert.equal(result.output.proposedTitle, '');
  assert.equal(result.output.reviewStatus, 'Needs Review');
  assert.equal(result.output.reviewReason, 'Invalid Part Fitment date');
  assert.equal(result.output.generationSkipped, true);
  assert.match(result.output.reviewNotes, /09\/31\/04/);
  assert.match(result.output.reviewNotes, /correct the source data/i);
  assert.equal(result.attempts.length, 0);
  assert.match(messages[0], /generationCalls=0/);
  assert.match(messages[0], /invalid-fitment-date/);
});

test('production validation also blocks an invalid fitment date before AI', async () => {
  let aiCalls = 0;
  const deps = dependencies({
    buildPrompt: () => ({ kind: 'prompt', userPayload: { resolvedListing: {
      titleFitmentCandidates: { sourceIssues: [{ code: 'INVALID_FITMENT_DATE', value: '09/31/04',
        evidence: 'built through 09/31/04', message: 'Invalid Part Fitment date.' }] }
    } } }),
    executeAi: async () => { aiCalls += 1; return { generatedTitle: 'Unsafe title' }; }
  });
  delete deps.validate;
  delete deps.decide;
  const result = await runTitleOptimizationRuntime({ dependencies: deps });
  assert.equal(aiCalls, 0);
  assert.equal(result.output.reviewStatus, 'Needs Review');
  assert.equal(result.output.reviewReason, 'Invalid Part Fitment date');
});

test('uses one focused compression call when the normal correction remains over 80 characters', async () => {
  let aiCalls = 0;
  const overLimit = '2003-2004 Honda Accord Master Power Window Switch Driver Front Door EX Coupe 1590671';
  const compressed = '2003-2004 Honda Accord Master Window Switch Driver Door EX Coupe 1590671';
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    buildPrompt: () => ({ kind: 'prompt', userPayload: {} }),
    executeAi: async ({ promptArtifact }) => {
      aiCalls += 1;
      if (aiCalls === 3) {
        assert.match(promptArtifact.userPayload.correction.instruction, /compression-only/i);
        assert.doesNotMatch(promptArtifact.userPayload.correction.instruction, /removing Power when/i);
        assert.match(promptArtifact.userPayload.correction.instruction, /Judge each phrase using this listing's evidence/i);
        assert.match(promptArtifact.userPayload.correction.instruction, /optional manufacturer part number/i);
        assert.match(promptArtifact.userPayload.correction.instruction, /84 characters/i);
        assert.match(promptArtifact.userPayload.correction.instruction, /80 characters or fewer/i);
        return { generatedTitle: compressed, generatedDescription: 'Description' };
      }
      return { generatedTitle: overLimit, generatedDescription: 'Description' };
    },
    validate: ({ candidateTitle }) => ({
      validatedTitle: candidateTitle,
      safeToContinue: candidateTitle.length <= 80,
      outcome: candidateTitle.length <= 80 ? 'PASS' : 'RETAIN_EXISTING_REQUIRED',
      violations: candidateTitle.length <= 80 ? [] : [{ checkId: 'length-80', status: 'RETAIN_EXISTING_REQUIRED', message: 'Candidate exceeds 80 characters.' }],
      warnings: []
    }),
    decide: ({ validationResult }) => ({
      decision: validationResult.safeToContinue ? 'ACCEPT_CANDIDATE' : 'RETAIN_EXISTING',
      finalTitle: validationResult.safeToContinue ? validationResult.validatedTitle : 'Existing title',
      reviewRequired: !validationResult.safeToContinue,
      degradationChecks: validationResult.safeToContinue ? [] : [{ checkId: 'phase-e:length-80', status: 'FAIL', message: 'Candidate exceeds 80 characters.' }]
    })
  }) });

  assert.equal(aiCalls, 3);
  assert.equal(result.output.title, compressed);
  assert.equal(result.output.reviewStatus, 'Completed');
  assert.equal(result.attempts.length, 3);
});

test('overlength retry offers an exact optional MPN-free candidate for AI approval', async () => {
  const longTitle = '2015-2016 Subaru Legacy Master Power Window Switch Driver Door 83071AL04A 1595206';
  const shorterTitle = '2015-2016 Subaru Legacy Master Power Window Switch Driver Door 1595206';
  let calls = 0;
  const result = await runTitleOptimizationRuntime({ dependencies: aiLedDependencies({}, {
    resolveSource: () => ({ normalized: { recordId: 'rec-mpn' }, resolved: { fields: {
      sku: { resolvedValue: '1595206' }, title: { resolvedValue: '2015 Subaru Legacy Switch 1595206' },
      manufacturerPartNumber: { resolvedValue: '83071AL04A' }
    } } }),
    executeAi: async ({ promptArtifact }) => {
      calls += 1;
      if (calls === 3) {
        assert.equal(promptArtifact.userPayload.correction.suggestedShorterTitle, shorterTitle);
        return { generatedTitle: shorterTitle, titleReviewStatus: 'Completed' };
      }
      return { generatedTitle: longTitle, titleReviewStatus: 'Completed' };
    }
  }) });
  assert.equal(result.output.reviewStatus, 'Completed');
  assert.equal(result.output.title, shorterTitle);
});

test('needs review exposes the generated title for writing without inheriting contradictory AI review text', async () => {
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    executeAi: async () => ({
      generatedTitle: 'Risky proposal 00123',
      titleReviewStatus: 'Completed',
      titleReviewReason: 'No issues identified',
      titleReviewNotes: 'Runtime accepted'
    }),
    decide: () => ({
      decision: 'NEEDS_REVIEW',
      finalTitle: 'Risky proposal 00123',
      reviewRequired: true,
      reviewReason: 'Multiple year ranges require review',
      reviewNotes: '2010-2012 Honda Accord | 2013 Honda Crosstour',
      degradationChecks: []
    })
  }) });

  assert.equal(result.output.title, 'Risky proposal 00123');
  assert.equal(result.output.proposedTitle, 'Risky proposal 00123');
  assert.equal(result.output.reviewStatus, 'Needs Review');
  assert.equal(result.output.reviewReason, 'Multiple year ranges require review');
  assert.doesNotMatch(result.output.reviewNotes, /Runtime accepted|No issues identified/);
});

test('accepted output clears stale model review text', async () => {
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    executeAi: async () => ({
      generatedTitle: 'Accepted title 00123',
      titleReviewStatus: 'Needs Review',
      titleReviewReason: 'Conflicting source data',
      titleReviewNotes: 'Old warning'
    }),
    validate: () => ({ outcome: 'PASS', validatedTitle: 'Accepted title 00123', violations: [], warnings: [] }),
    decide: () => ({ decision: 'ACCEPT_CANDIDATE', finalTitle: 'Accepted title 00123', reviewRequired: false,
      reviewReason: null, reviewNotes: '', degradationChecks: [] })
  }) });

  assert.equal(result.output.title, 'Accepted title 00123');
  assert.equal(result.output.reviewStatus, 'Completed');
  assert.equal(result.output.reviewReason, 'completed');
  assert.equal(result.output.reviewNotes,
    'Generated title accepted after evidence and safety validation. Final title: Accepted title 00123.');
});

test('accepted output explains verified vehicle, side, and category decisions', async () => {
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    executeAi: async () => ({
      generatedTitle: '2007-2013 Suzuki SX4 Steering Column No Shaft 1448110',
      vehicleDecision: { resolved: true, make: 'Suzuki', model: 'SX4', yearRange: '2007-2013', source: 'fitment-1;fitment-2' },
      sideDecision: { side: 'Driver', placement: 'Front' },
      categoryPriorityDetails: [{ detail: 'Steering Column', verified: true }]
    }),
    validate: () => ({ outcome: 'PASS', validatedTitle: '2007-2013 Suzuki SX4 Steering Column No Shaft 1448110', violations: [], warnings: [] }),
    decide: () => ({ decision: 'ACCEPT_CANDIDATE', finalTitle: '2007-2013 Suzuki SX4 Steering Column No Shaft 1448110', reviewRequired: false,
      reviewReason: null, reviewNotes: '', degradationChecks: [] })
  }) });

  assert.match(result.output.reviewNotes, /Verified vehicle application: 2007-2013 Suzuki SX4/);
  assert.match(result.output.reviewNotes, /combined 2 cited fitment rows/i);
  assert.match(result.output.reviewNotes, /Verified placement: Front Driver/);
  assert.match(result.output.reviewNotes, /Applied verified category detail: Steering Column/);
});

test('authoritative runtime executes the configured pipeline and returns writable output', async () => {
  const deps = dependencies();
  const result = await runTitleOptimizationRuntime({
    listing: { recordId: 'rec-1', ipn: '629-50937A', listingRecord: { id: 'rec-1', fields: {} }, masterRecord: { fields: {} } },
    dependencies: deps
  });

  assert.deepEqual(deps.calls.filter(value => value !== 'log'), ['snapshot', 'source', 'rules', 'prompt', 'ai', 'validate', 'decide']);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.authoritative, true);
  assert.equal(result.output.title, '2010-2012 Subaru Outback Legacy Column Switch 00123');
  assert.equal(result.output.description, 'Runtime description');
  assert.equal(result.output.shortDescription, 'Runtime short description');
  assert.equal(result.output.reviewStatus, 'Completed');
});

test('runtime failure is authoritative and never requests a legacy fallback', async () => {
  const result = await runTitleOptimizationRuntime({
    listing: { recordId: 'rec-1', ipn: '629-50937A', listingRecord: { id: 'rec-1', fields: {} }, masterRecord: { fields: {} } },
    dependencies: dependencies({ loadSnapshot: async () => { throw new Error('snapshot unavailable secret-value'); } })
  });

  assert.equal(result.status, 'CONFIG_SNAPSHOT_FAILURE');
  assert.equal(result.authoritative, true);
  assert.equal(result.output, null);
  assert.equal(result.errors.length, 1);
  assert.doesNotMatch(JSON.stringify(result.errors), /secret-value/);
});

test('runtime log exposes the proposed title and failed no-degrade checks', async () => {
  const messages = [];
  const deps = dependencies({
    decide: () => ({
      decision: 'RETAIN_EXISTING',
      finalTitle: 'Existing safe title 00123',
      reviewRequired: true,
      reviewReason: 'Proposed title would degrade existing title',
      reviewNotes: '',
      degradationChecks: [
        { checkId: 'critical-data-loss', status: 'FAIL', field: 'model', message: 'Candidate lost verified model.' }
      ]
    }),
    logger: { info: message => messages.push(message) }
  });

  const result = await runTitleOptimizationRuntime({
    listing: { recordId: 'rec-1', ipn: '629-50937A', listingRecord: { id: 'rec-1', fields: {} }, masterRecord: { fields: {} } },
    dependencies: deps
  });

  assert.equal(result.decision.decision, 'RETAIN_EXISTING');
  assert.match(messages[0], /proposedTitle='2010-2012 Subaru Outback Legacy Column Switch 00123'/);
  assert.match(messages[0], /acceptedTitle='2010-2012 Subaru Outback Legacy Column Switch 00123'/);
  assert.match(messages[0], /titleWriteAction='WRITE_ITEM_TITLE'/);
  assert.match(messages[0], /failedChecks='critical-data-loss:model:Candidate lost verified model\.'/);
});

test('runtime log exposes category priority verification decisions and evidence', async () => {
  const messages = [];
  const deps = dependencies({
    executeAi: async () => ({
      generatedTitle: '2000-2006 Hyundai Accent Turn Signal Switch 1482657',
      generatedDescription: 'Runtime description',
      shortDescription: 'Runtime short description',
      titleReviewStatus: 'Completed',
      titleReviewReason: 'completed',
      titleReviewNotes: 'Runtime accepted',
      categoryPriorityDetails: [
        {
          detail: 'Turn Signal',
          verified: true,
          source: 'Part Fitment',
          evidence: 'Hyundai Accent turn signal'
        },
        {
          detail: 'Multifunction',
          verified: false,
          source: null,
          evidence: null
        }
      ]
    }),
    logger: { info: message => messages.push(message) }
  });

  await runTitleOptimizationRuntime({
    listing: { recordId: 'rec-2', ipn: '629-59774', listingRecord: { id: 'rec-2', fields: {} }, masterRecord: { fields: {} } },
    dependencies: deps
  });

  assert.match(messages[0], /categoryPriorityDetails=/);
  assert.match(messages[0], /"detail":"Turn Signal","verified":true,"source":"Part Fitment","evidence":"Hyundai Accent turn signal"/);
  assert.match(messages[0], /"detail":"Multifunction","verified":false,"source":null,"evidence":null/);
});

test('runtime exposes a compact rule decision for persisted diagnostics', async () => {
  const result = await runTitleOptimizationRuntime({
    options: { enableIndependentAiReview: false },
    dependencies: aiLedDependencies({
      generatedTitle: '2010-2012 Ford Fusion Starter Motor 12345',
      titleReviewStatus: 'Completed',
      materialRestrictions: [],
      restrictedTermDecisions: [],
      titleSegments: [{ key: 'part', value: '2010-2012 Ford Fusion Starter Motor' }, { key: 'sku', value: '12345' }],
      ruleSelfAudit: {
        structureFollowed: true, unresolvedSourceConflict: false, unsupportedClaim: false, notes: 'Checked.'
      }
    }, {
      resolveRules: () => ({
        listingContext: { ipnPrefix: '641' },
        listingClassification: { family: 'general', resolved: false, sources: [], conflicts: [], reason: 'no-specialized-family-evidence' },
        restrictedTerms: { rules: [], groups: {} },
        categoryRules: [],
        titleStructure: { selected: { id: 'structure-general', structureName: 'General', segments: [] }, reason: 'general-fallback' },
        flagReasons: [],
        systemRules: []
      })
    })
  });

  assert.equal(result.ruleDecision.classification.family, 'general');
  assert.equal(result.ruleDecision.selectedStructure.id, 'structure-general');
  assert.equal(result.ruleDecision.finalDisposition, 'ACCEPT_CANDIDATE');
  assert.deepEqual(result.ruleDecision.applicableRestrictedTerms, []);
  assert.doesNotMatch(JSON.stringify(result.ruleDecision), /<html|authorization|bearer/i);
});

test('runtime does not pass or log removed semantic audit metadata', async () => {
  const messages = [];
  let receivedSafetyDecision = null;
  const safetyDecision = {
    safeToPublish: true,
    reason: 'Equivalent brand wording preserves the supported vehicle identity.',
    concerns: []
  };
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    executeAi: async () => ({ generatedTitle: '2011 Ford E350 Window Switch 00123', safetyDecision }),
    validate: inputs => {
      receivedSafetyDecision = inputs.safetyDecision;
      return {
        outcome: 'PASS',
        validatedTitle: inputs.candidateTitle,
        safeToContinue: true,
        violations: [],
        warnings: [],
        semanticSafety: { supplied: true, ...inputs.safetyDecision }
      };
    },
    decide: ({ validationResult }) => ({
      decision: 'ACCEPT_CANDIDATE', finalTitle: validationResult.validatedTitle,
      reviewRequired: false, degradationChecks: []
    }),
    logger: { info: message => messages.push(message) }
  }) });

  assert.equal(receivedSafetyDecision, undefined);
  assert.equal(result.output.reviewStatus, 'Completed');
  assert.doesNotMatch(messages[0], /safetyDecision=/);
  assert.doesNotMatch(messages[0], /Equivalent brand wording/);
});

test('runtime review notes use retained vehicle decisions without removed audit metadata', async () => {
  const selectedTitleFacts = {
    yearRange: '2007-2012',
    make: 'Nissan',
    model: 'Altima',
    part: 'Door Switch',
    side: 'Driver',
    placement: 'Front',
    keyDetails: ['Lock And Window'],
    evidenceSummary: 'Selected facts are supported by title and fitment evidence.'
  };
  const removedTitleDetails = [
    { detail: 'Fits', reason: 'Raw fitment connector word is not part of the title structure.', safeToRemove: true }
  ];
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    executeAi: async () => ({
      generatedTitle: '2007-2012 Nissan Altima Driver Front Door Switch Lock Window 1375500',
      generatedDescription: 'Description',
      selectedTitleFacts,
      removedTitleDetails,
      vehicleDecision: {
        resolved: true,
        make: 'Nissan',
        model: 'Altima',
        yearRange: '2007-2012',
        source: 'partFitment',
        evidence: '2007 Nissan Altima driver front door switch; 2008-2012 Nissan Altima driver front door switch',
        reason: 'Continuous application.'
      },
      safetyDecision: {
        safeToPublish: true,
        reason: 'All material title claims are supported.',
        concerns: [],
        claims: [{ titleClaim: 'Driver Front Door Switch', dimension: 'product_identity', status: 'supported', evidence: 'Driver Front Door Switch', material: true }]
      }
    }),
    validate: inputs => ({
      outcome: 'PASS',
      validatedTitle: inputs.candidateTitle,
      safeToContinue: true,
      violations: [],
      warnings: [],
      semanticSafety: { supplied: true, ...inputs.safetyDecision }
    }),
    decide: ({ validationResult }) => ({
      decision: 'ACCEPT_CANDIDATE',
      finalTitle: validationResult.validatedTitle,
      reviewRequired: false,
      degradationChecks: []
    })
  }) });

  assert.equal(result.output.reviewStatus, 'Completed');
  assert.match(result.output.reviewNotes, /Verified vehicle application: 2007-2012 Nissan Altima/);
  assert.doesNotMatch(result.output.reviewNotes, /Selected facts|Kept key detail|Safely omitted/);
  assert.doesNotMatch(result.output.reviewNotes, /deterministic validation/i);
});

test('legacy semantic audit metadata does not trigger a correction call', async () => {
  let aiCalls = 0;
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    executeAi: async () => {
      aiCalls += 1;
      return aiCalls === 1 ? {
        generatedTitle: 'Wrong semantic title 00123',
        generatedDescription: 'Description',
        safetyDecision: {
          safeToPublish: false,
          reason: 'A material title claim contradicts supplied evidence.',
          concerns: ['Vehicle identity contradiction'],
          claims: [{ titleClaim: 'Wrong vehicle', dimension: 'vehicle_identity', status: 'contradictory', evidence: 'Correct vehicle', material: true }]
        }
      } : {
        generatedTitle: 'Correct semantic title 00123',
        generatedDescription: 'Description',
        safetyDecision: {
          safeToPublish: true,
          reason: 'All material claims are supported.',
          concerns: [],
          claims: [{ titleClaim: 'Correct vehicle', dimension: 'vehicle_identity', status: 'supported', evidence: 'Correct vehicle', material: true }]
        }
      };
    },
    validate: ({ candidateTitle }) => ({
      outcome: 'PASS', validatedTitle: candidateTitle, safeToContinue: true,
      violations: [], warnings: []
    }),
    decide: ({ validationResult }) => ({
      decision: 'ACCEPT_CANDIDATE', finalTitle: validationResult.validatedTitle,
      reviewRequired: false, degradationChecks: []
    })
  }) });

  assert.equal(aiCalls, 1);
  assert.equal(result.output.title, 'Wrong semantic title 00123');
  assert.equal(result.output.reviewStatus, 'Completed');
});

test('runtime log identifies the canonical title override status', async () => {
  const messages = [];
  const deps = dependencies({
    resolveSource: () => ({
      normalized: {
        recordId: 'rec-1',
        manualOverride: { active: true, canonicalStatus: 'Manually Approved' }
      },
      resolved: { fields: {}, conflicts: [], missing: [] }
    }),
    buildPrompt: () => ({ kind: 'title-generation-bypass', metadata: {} }),
    validate: () => ({ outcome: 'BYPASSED', validatedTitle: '', violations: [], warnings: [] }),
    decide: () => ({
      decision: 'BYPASSED_MANUAL_OVERRIDE',
      finalTitle: 'Existing approved title',
      reviewRequired: true,
      reviewReason: 'manual_override',
      reviewNotes: 'Title is manually approved; automated title generation was skipped.',
      degradationChecks: []
    }),
    logger: { info: message => messages.push(message) }
  });

  const result = await runTitleOptimizationRuntime({
    listing: { recordId: 'rec-1', ipn: '629-50937A', listingRecord: { id: 'rec-1', fields: {} } },
    dependencies: deps
  });

  assert.equal(result.status, 'BYPASSED');
  assert.equal(result.output.title, '');
  assert.equal(result.output.reviewStatus, 'Skipped - Manual Override');
  assert.equal(result.output.reviewReason, 'manual_override');
  assert.equal(result.output.reviewNotes, 'Title is manually approved; automated title generation was skipped.');
  assert.match(messages[0], /overrideStatus='Manually Approved'/);
  assert.equal(deps.calls.includes('ai'), false);
});
