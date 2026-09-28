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
  assert.equal(result.output.title, 'Initial title');
  assert.equal(result.output.reviewStatus, 'Needs Review');
});

test('malformed first response gets one retry within the same two-call budget', async () => {
  let calls = 0;
  const result = await runTitleOptimizationRuntime({ dependencies: dependencies({
    executeAi: async () => ++calls === 1 ? {} : { generatedTitle: 'Corrected title' },
    decide: () => ({ decision: 'RETAIN_EXISTING', finalTitle: 'Safe title', reviewRequired: true, degradationChecks: [{ status: 'FAIL', message: 'Unresolved' }] })
  }) });
  assert.equal(calls, 2);
  assert.equal(result.output.title, 'Corrected title');
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
  assert.match(messages[0], /finalTitle='2010-2012 Subaru Outback Legacy Column Switch 00123'/);
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
  assert.equal(result.output.reviewStatus, 'Skipped - Manual Override');
  assert.equal(result.output.reviewReason, 'manual_override');
  assert.equal(result.output.reviewNotes, 'Title is manually approved; automated title generation was skipped.');
  assert.match(messages[0], /overrideStatus='Manually Approved'/);
  assert.equal(deps.calls.includes('ai'), false);
});
