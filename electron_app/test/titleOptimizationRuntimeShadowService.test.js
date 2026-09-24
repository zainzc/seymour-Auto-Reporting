const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compareTitleOptimizationShadowResult,
  runTitleOptimizationRuntimeShadow
} = require('../src/services/titleOptimizationRuntimeShadowService');

function baseLegacy(overrides = {}) {
  return {
    generatedTitle: '2011 Honda Accord Driver Mirror ABS 00123',
    generatedDescription: 'Legacy description',
    shortDescription: 'Legacy short',
    titleReviewStatus: 'Completed',
    titleReviewReason: 'completed',
    titleReviewNotes: 'Legacy accepted',
    ...overrides
  };
}

function baseListing(overrides = {}) {
  return {
    recordId: 'rec-1',
    ipn: '641-00641L',
    listingRecord: {
      id: 'rec-1',
      fields: {
        'IPN (Interchange Part Number)': '641-00641L',
        IPN: '641-00641L',
        SKU: '00123',
        Title: '2011 Honda Accord Driver Mirror ABS 00123',
        'Item Title': '',
        'Item Specifics - All C: values relevant to item': JSON.stringify({
          Year: '2011',
          'C:Brand': 'Honda',
          Model: 'Accord',
          Side: 'Driver',
          'C:Part': 'Mirror'
        })
      }
    },
    masterRecord: { fields: { 'Part Fitment': 'Fits 2011 Honda Accord' } },
    ...overrides
  };
}

function pipelineDeps(overrides = {}) {
  const calls = [];
  const deps = {
    loadSnapshot: async () => {
      calls.push('A');
      return { mode: 'shadow-only', runtimeReady: true, metadata: { configurationVersion: 'v5' } };
    },
    resolveSource: ({ runtimeSnapshot, listingRecord, masterRecord }) => {
      calls.push('B');
      return {
        runtimeSnapshot,
        listingRecord,
        masterRecord,
        normalized: {
          recordId: listingRecord.id,
          manualOverride: { active: false },
          fields: { ipn: { value: '641-00641L' }, sku: { value: '00123' } },
          descriptionOnly: { partFitment: { value: 'Fits 2011 Honda Accord' } }
        },
        resolved: {
          fields: {
            title: { resolvedValue: '2011 Honda Accord Driver Mirror ABS 00123', resolvedSource: 'currentEbay' },
            sku: { resolvedValue: '00123', resolvedSource: 'otherStructuredFields' },
            year: { resolvedValue: '2011', resolvedSource: 'itemSpecifics' },
            brandMake: { resolvedValue: 'Honda', resolvedSource: 'itemSpecifics' },
            model: { resolvedValue: 'Accord', resolvedSource: 'itemSpecifics' },
            side: { resolvedValue: 'Driver', resolvedSource: 'itemSpecifics' },
            part: { resolvedValue: 'Mirror', resolvedSource: 'itemSpecifics' }
          },
          conflicts: []
        }
      };
    },
    resolveRules: () => {
      calls.push('C');
      return {
        runtimeReady: true,
        listingContext: { ipn: '641-00641L', ipnPrefix: '641', sku: '00123' },
        titleStructure: { selected: { id: 'structure-general' } },
        restrictedTerms: { groups: { 'must-preserve': [{ id: 'rt-abs', term: 'ABS' }] } },
        flagReasons: [{ id: 'flag-degrade', reason: 'Proposed title would degrade existing title', enabled: true }],
        systemRules: []
      };
    },
    buildPrompt: () => {
      calls.push('D');
      return {
        contractVersion: 1,
        runtimeMode: 'shadow-only',
        kind: 'prompt',
        systemMessage: 'system',
        userPayload: { outputContract: { requiredJsonKeys: ['generatedTitle'] } },
        metadata: { selectedStructureId: 'structure-general' }
      };
    },
    executeAi: async () => {
      calls.push('AI');
      return {
        generatedTitle: '2011 Honda Accord Driver Mirror ABS 00123',
        generatedDescription: 'Shadow description',
        shortDescription: 'Shadow short',
        reasoningSummary: 'Shadow generated',
        titleReviewStatus: 'Completed',
        titleReviewReason: 'completed',
        titleReviewNotes: 'Shadow accepted'
      };
    },
    validate: () => {
      calls.push('E');
      return {
        outcome: 'PASS',
        valid: true,
        safeToContinue: true,
        originalCandidate: '2011 Honda Accord Driver Mirror ABS 00123',
        validatedTitle: '2011 Honda Accord Driver Mirror ABS 00123',
        corrections: [],
        violations: [],
        warnings: [],
        suggestedReviewReasons: []
      };
    },
    decide: () => {
      calls.push('F');
      return {
        decision: 'ACCEPT_CANDIDATE',
        finalTitle: '2011 Honda Accord Driver Mirror ABS 00123',
        candidateAccepted: true,
        retainedExisting: false,
        reviewRequired: false,
        reviewStatus: 'not_required',
        reviewReason: null,
        reviewNotes: '',
        degradationChecks: []
      };
    },
    logger: { info: () => calls.push('LOG'), warn: () => calls.push('WARN') },
    calls,
    ...overrides
  };
  return deps;
}

test('shadow disabled does not execute runtime pipeline or extra AI call and returns legacy authority', async () => {
  const deps = pipelineDeps();
  const result = await runTitleOptimizationRuntimeShadow({
    shadowEnabled: false,
    listing: baseListing(),
    legacyResult: baseLegacy(),
    dependencies: deps
  });

  assert.equal(result.shadowEnabled, false);
  assert.equal(result.status, 'DISABLED');
  assert.deepEqual(deps.calls, []);
  assert.equal(result.legacy.authoritative, true);
  assert.equal(result.legacy.title, '2011 Honda Accord Driver Mirror ABS 00123');
});

test('shadow enabled runs A through F once with mock AI and keeps legacy result authoritative', async () => {
  const deps = pipelineDeps();
  const result = await runTitleOptimizationRuntimeShadow({
    shadowEnabled: true,
    listing: baseListing(),
    legacyResult: baseLegacy(),
    dependencies: deps
  });

  assert.deepEqual(deps.calls.filter(item => item !== 'LOG'), ['A', 'B', 'C', 'D', 'AI', 'E', 'F']);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.legacy.authoritative, true);
  assert.equal(result.legacy.title, '2011 Honda Accord Driver Mirror ABS 00123');
  assert.equal(result.shadow.decision.finalTitle, '2011 Honda Accord Driver Mirror ABS 00123');
  assert.equal(result.comparison.riskLevel, 'MATCH');
});

test('manual override bypass skips shadow AI and records bypass without failure', async () => {
  const deps = pipelineDeps({
    buildPrompt: () => {
      deps.calls.push('D');
      return {
        kind: 'title-generation-bypass',
        bypass: { reason: 'manual_override' },
        metadata: { selectedStructureId: 'structure-general' }
      };
    },
    decide: () => {
      deps.calls.push('F');
      return {
        decision: 'BYPASSED_MANUAL_OVERRIDE',
        finalTitle: 'Protected Manual Title',
        reviewStatus: 'manual_override_bypass',
        reviewReason: null,
        reviewNotes: '',
        degradationChecks: []
      };
    }
  });

  const result = await runTitleOptimizationRuntimeShadow({
    shadowEnabled: true,
    listing: baseListing(),
    legacyResult: baseLegacy(),
    dependencies: deps
  });

  assert.equal(deps.calls.includes('AI'), false);
  assert.equal(result.status, 'BYPASSED');
  assert.equal(result.shadow.aiResult, null);
  assert.equal(result.shadow.decision.decision, 'BYPASSED_MANUAL_OVERRIDE');
});

test('shadow failures are isolated and preserve successful legacy result', async () => {
  const stages = [
    ['CONFIG_SNAPSHOT_FAILURE', { loadSnapshot: async () => { throw new Error('snapshot broke'); } }],
    ['SOURCE_RESOLUTION_FAILURE', { resolveSource: () => { throw new Error('source broke'); } }],
    ['RULE_RESOLUTION_FAILURE', { resolveRules: () => { throw new Error('rules broke'); } }],
    ['PROMPT_BUILD_FAILURE', { buildPrompt: () => { throw new Error('prompt broke'); } }],
    ['AI_FAILURE', { executeAi: async () => { throw new Error('provider timeout api-key-secret'); } }],
    ['AI_RESPONSE_PARSE_FAILURE', { executeAi: async () => ({ generatedDescription: 'no title' }) }],
    ['VALIDATOR_FAILURE', { validate: () => { throw new Error('validator broke'); } }],
    ['DECISION_FAILURE', { decide: () => { throw new Error('decision broke'); } }],
    ['COMPARISON_FAILURE', { compare: () => { throw new Error('comparison broke'); } }]
  ];

  for (const [status, override] of stages) {
    const result = await runTitleOptimizationRuntimeShadow({
      shadowEnabled: true,
      listing: baseListing(),
      legacyResult: baseLegacy(),
      dependencies: pipelineDeps(override)
    });
    assert.equal(result.status, status);
    assert.equal(result.legacy.authoritative, true);
    assert.equal(result.errors.length, 1);
    assert.doesNotMatch(JSON.stringify(result.errors), /api-key-secret/);
    assert.equal(result.comparison.riskLevel, 'SHADOW_FAILED');
  }
});

test('comparison is deterministic and factual without a quality score', () => {
  const common = {
    listing: { recordId: 'rec-1', ipn: '641-00641L' },
    sourceResolution: {
      resolved: {
        fields: {
          sku: { resolvedValue: '00123' },
          year: { resolvedValue: '2011' },
          brandMake: { resolvedValue: 'Honda' },
          model: { resolvedValue: 'Accord' },
          part: { resolvedValue: 'Mirror' },
          side: { resolvedValue: 'Driver' }
        }
      }
    },
    ruleResolution: { restrictedTerms: { groups: { 'must-preserve': [{ term: 'ABS' }] } } }
  };

  const match = compareTitleOptimizationShadowResult({
    ...common,
    legacyResult: baseLegacy(),
    shadowDecision: { decision: 'ACCEPT_CANDIDATE', finalTitle: '2011 Honda Accord Driver Mirror ABS 00123', reviewStatus: 'not_required' }
  });
  assert.equal(match.riskLevel, 'MATCH');
  assert.equal(Object.prototype.hasOwnProperty.call(match, 'qualityScore'), false);

  const safe = compareTitleOptimizationShadowResult({
    ...common,
    legacyResult: baseLegacy(),
    shadowDecision: { decision: 'ACCEPT_CANDIDATE', finalTitle: '2011 Honda Accord ABS Driver Mirror 00123', reviewStatus: 'not_required' }
  });
  assert.equal(safe.riskLevel, 'SAFE_DIFFERENCE');

  const review = compareTitleOptimizationShadowResult({
    ...common,
    legacyResult: baseLegacy(),
    shadowDecision: { decision: 'NEEDS_REVIEW', finalTitle: '2011 Honda Accord Driver Mirror ABS 00123', reviewStatus: 'needs_review', reviewReason: 'Conflicting source data' }
  });
  assert.equal(review.riskLevel, 'REVIEW_DIFFERENCE');

  const safety = compareTitleOptimizationShadowResult({
    ...common,
    legacyResult: baseLegacy(),
    shadowDecision: { decision: 'RETAIN_EXISTING', finalTitle: '2011 Honda Accord Driver Mirror ABS 00123', reviewStatus: 'needs_review' }
  });
  assert.equal(safety.riskLevel, 'SAFETY_DIFFERENCE');
});
