const test = require('node:test');
const assert = require('node:assert/strict');

const { runTitleOptimizationRuntime } = require('../src/services/titleOptimizationRuntimeService');

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

test('independent fitment review checks the final title and blocks a failed review', async () => {
  const seen = [];
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    reviewTitleFitment: async input => {
      seen.push(input.title);
      return { verdict: 'REVIEW', reason: '2014-2015 requires VIN J; the title claims unrestricted fitment.', citedRowIds: ['title-fitment-002'] };
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
  assert.equal(result.output.title, '');
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

test('fitment reviewer failure cannot write an accepted title', async () => {
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    reviewTitleFitment: async () => { throw new Error('review unavailable'); }
  }) });
  assert.equal(result.output.title, '');
  assert.equal(result.output.reviewStatus, 'Needs Review');
  assert.match(result.output.reviewNotes, /review unavailable/i);
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
  assert.equal(result.output.title, '');
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

test('failed correction preserves the original safe decision and stops after two calls', async () => {
  let aiCalls = 0;
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    executeAi: async () => { if (++aiCalls === 2) throw new Error('unavailable'); return { generatedTitle: 'Initial title' }; },
    decide: () => ({ decision: 'RETAIN_EXISTING', finalTitle: 'Existing safe title', reviewRequired: true, degradationChecks: [{ status: 'FAIL', message: 'Missing detail' }] })
  }) });
  assert.equal(aiCalls, 2);
  assert.equal(result.output.title, '');
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
  assert.equal(result.output.title, '');
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

test('needs review never exposes a writable title or inherits contradictory AI review text', async () => {
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

  assert.equal(result.output.title, '');
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
  assert.match(messages[0], /acceptedTitle=''/);
  assert.match(messages[0], /titleWriteAction='PRESERVE_ITEM_TITLE'/);
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
        source: 'title-fitment-001;title-fitment-002',
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
