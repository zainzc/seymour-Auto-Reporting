const { normalizeAndResolveListing } = require('./titleOptimizationRuntimeSourceResolutionService');
const { resolveApplicableTitleOptimizationRules } = require('./titleOptimizationRuntimeRuleResolutionService');
const { buildTitleOptimizationRuntimePrompt } = require('./titleOptimizationRuntimePromptBuilderService');
const { validateTitleOptimizationRuntimeCandidate } = require('./titleOptimizationRuntimeValidatorService');
const { decideTitleOptimizationRuntimeResult } = require('./titleOptimizationRuntimeDecisionService');

const RUNTIME_STATUSES = Object.freeze({
  COMPLETED: 'COMPLETED',
  BYPASSED: 'BYPASSED',
  CONFIG_SNAPSHOT_FAILURE: 'CONFIG_SNAPSHOT_FAILURE',
  SOURCE_RESOLUTION_FAILURE: 'SOURCE_RESOLUTION_FAILURE',
  RULE_RESOLUTION_FAILURE: 'RULE_RESOLUTION_FAILURE',
  PROMPT_BUILD_FAILURE: 'PROMPT_BUILD_FAILURE',
  AI_FAILURE: 'AI_FAILURE',
  AI_RESPONSE_PARSE_FAILURE: 'AI_RESPONSE_PARSE_FAILURE',
  VALIDATOR_FAILURE: 'VALIDATOR_FAILURE',
  DECISION_FAILURE: 'DECISION_FAILURE'
});

function normalizeText(value) {
  if (Array.isArray(value)) return normalizeText(value[0]);
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function sanitizeError(error) {
  const text = normalizeText(error?.message || error || 'Unknown runtime failure');
  return text
    .replace(/(api[_-]?key|authorization|bearer|token|secret)\s*[:=]?\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 300);
}

function baseResult(listing = {}) {
  return {
    contractVersion: 1,
    runtimeMode: 'authoritative',
    authoritative: true,
    status: 'PENDING',
    listing: {
      recordId: listing.recordId || listing.listingRecord?.id || null,
      ipn: listing.ipn || null
    },
    configuration: { version: null },
    output: null,
    sourceResolution: null,
    ruleResolution: null,
    promptMetadata: null,
    aiResult: null,
    validation: null,
    decision: null,
    attempts: [],
    errors: []
  };
}

function fail(result, status, error) {
  result.status = status;
  result.errors.push({ stage: status, message: sanitizeError(error) });
  return result;
}

function writableOutput(aiResult = {}, decision = {}, proposedTitle = '') {
  const bypassed = decision.decision === 'BYPASSED_MANUAL_OVERRIDE';
  const needsReview = Boolean(decision.reviewRequired) || decision.decision === 'NEEDS_REVIEW' || decision.decision === 'RETAIN_EXISTING';
  return {
    title: !bypassed && needsReview && normalizeText(proposedTitle) ? normalizeText(proposedTitle) : normalizeText(decision.finalTitle),
    description: normalizeText(aiResult.generatedDescription),
    shortDescription: normalizeText(aiResult.shortDescription),
    reviewStatus: bypassed ? 'Skipped - Manual Override' : needsReview ? 'Needs Review' : normalizeText(aiResult.titleReviewStatus) || 'Completed',
    reviewReason: normalizeText(decision.reviewReason || aiResult.titleReviewReason) || (needsReview ? 'manual_review_required' : 'completed'),
    reviewNotes: [normalizeText(decision.reviewNotes || aiResult.titleReviewNotes || aiResult.reasoningSummary),
      !bypassed && needsReview && normalizeText(proposedTitle) ? 'Generated proposal saved to Item Title for review; validation did not approve it for publication.' : ''].filter(Boolean).join(' ')
  };
}

function failedCheckSummary(decision = {}) {
  return (decision.degradationChecks || [])
    .filter(check => check?.status === 'FAIL')
    .map(check => [check.checkId, check.field, check.message].map(normalizeText).filter(Boolean).join(':'))
    .join(' | ');
}

function categoryPriorityDetailsSummary(aiResult = {}) {
  const details = Array.isArray(aiResult.categoryPriorityDetails) ? aiResult.categoryPriorityDetails : [];
  return JSON.stringify(details.map(item => ({
    detail: normalizeText(item?.detail),
    verified: item?.verified === true,
    source: item?.source == null ? null : normalizeText(item.source),
    evidence: item?.evidence == null ? null : normalizeText(item.evidence)
  })));
}

async function runTitleOptimizationRuntime({ listing = {}, options = {}, dependencies = {} } = {}) {
  const result = baseResult(listing);
  const logger = dependencies.logger || console;
  let snapshot;
  let sourceResolution;
  let ruleResolution;
  let promptArtifact;
  let aiResult = {};
  let validation;
  let decision;
  let generationCalls = 0;
  const executeAi = async artifact => {
    generationCalls += 1;
    return dependencies.executeAi({ promptArtifact: artifact, listing, options });
  };

  try {
    if (typeof dependencies.loadSnapshot !== 'function') throw new Error('Runtime snapshot loader is not configured.');
    snapshot = await dependencies.loadSnapshot({ listing, options });
    result.configuration.version = snapshot?.metadata?.configurationVersion || null;
  } catch (error) {
    return fail(result, RUNTIME_STATUSES.CONFIG_SNAPSHOT_FAILURE, error);
  }

  try {
    sourceResolution = (dependencies.resolveSource || normalizeAndResolveListing)({
      runtimeSnapshot: snapshot,
      listingRecord: listing.listingRecord,
      masterRecord: listing.masterRecord,
      fields: options.fields || []
    });
    result.sourceResolution = sourceResolution;
  } catch (error) {
    return fail(result, RUNTIME_STATUSES.SOURCE_RESOLUTION_FAILURE, error);
  }

  try {
    ruleResolution = (dependencies.resolveRules || resolveApplicableTitleOptimizationRules)({
      runtimeSnapshot: snapshot,
      listingResolution: sourceResolution
    });
    result.ruleResolution = ruleResolution;
  } catch (error) {
    return fail(result, RUNTIME_STATUSES.RULE_RESOLUTION_FAILURE, error);
  }

  try {
    promptArtifact = (dependencies.buildPrompt || buildTitleOptimizationRuntimePrompt)({
      runtimeSnapshot: snapshot,
      listingResolution: sourceResolution,
      applicableRules: ruleResolution
    });
    result.promptMetadata = promptArtifact?.metadata || null;
  } catch (error) {
    return fail(result, RUNTIME_STATUSES.PROMPT_BUILD_FAILURE, error);
  }

  if (promptArtifact?.kind !== 'title-generation-bypass') {
    try {
      if (typeof dependencies.executeAi !== 'function') throw new Error('Runtime AI executor is not configured.');
      aiResult = await executeAi(promptArtifact);
      if (!normalizeText(aiResult?.generatedTitle)) throw new Error('Runtime AI response missing generatedTitle.');
      result.aiResult = aiResult;
    } catch (error) {
      const status = /missing generatedTitle|json|parse/i.test(String(error?.message || error))
        ? RUNTIME_STATUSES.AI_RESPONSE_PARSE_FAILURE
        : RUNTIME_STATUSES.AI_FAILURE;
      if (status !== RUNTIME_STATUSES.AI_RESPONSE_PARSE_FAILURE) return fail(result, status, error);
      try {
        aiResult = await executeAi({
          ...promptArtifact,
          userPayload: { ...promptArtifact.userPayload, correction: {
            instruction: 'The previous response could not be parsed or lacked generatedTitle. Return the complete required JSON contract, using only the original supplied evidence.'
          } }
        });
        if (!normalizeText(aiResult?.generatedTitle)) throw new Error('Runtime AI response missing generatedTitle.');
        result.aiResult = aiResult;
      } catch (retryError) {
        return fail(result, RUNTIME_STATUSES.AI_RESPONSE_PARSE_FAILURE, retryError);
      }
    }
  }

  try {
    validation = (dependencies.validate || validateTitleOptimizationRuntimeCandidate)({
      snapshot,
      sourceResolution,
      ruleResolution,
      promptArtifact,
      candidateTitle: aiResult.generatedTitle || '',
      categoryPriorityDetails: aiResult.categoryPriorityDetails || [],
      sideDecision: aiResult.sideDecision,
      vehicleDecision: aiResult.vehicleDecision
    });
    result.validation = validation;
  } catch (error) {
    return fail(result, RUNTIME_STATUSES.VALIDATOR_FAILURE, error);
  }

  try {
    decision = (dependencies.decide || decideTitleOptimizationRuntimeResult)({
      snapshot,
      sourceResolution,
      ruleResolution,
      promptArtifact,
      validationResult: validation
    });
    result.decision = decision;
  } catch (error) {
    return fail(result, RUNTIME_STATUSES.DECISION_FAILURE, error);
  }

  const recordAttempt = () => ({
    proposedTitle: normalizeText(aiResult.generatedTitle),
    finalTitle: decision?.finalTitle || '',
    decision: decision?.decision,
    failedChecks: failedCheckSummary(decision)
  });
  if (promptArtifact?.kind !== 'title-generation-bypass') result.attempts.push(recordAttempt());
  const failures = (decision?.degradationChecks || []).filter(check => ['FAIL', 'BLOCK'].includes(check?.status));
  if (generationCalls < 2 && promptArtifact?.kind !== 'title-generation-bypass' && failures.length && decision?.reviewRequired) {
    const correctionPrompt = {
      ...promptArtifact,
      userPayload: {
        ...promptArtifact.userPayload,
        correction: {
          previousTitle: normalizeText(aiResult.generatedTitle),
          verifiedVehicleDecision: validation?.vehicleVerification?.verified ? validation.vehicleVerification.decision : null,
          failures: failures.map(check => ({ checkId: check.checkId, field: check.field, message: check.message })),
          instruction: 'Correct every listed failure using the original supplied evidence and rules. Audit the previous title against the selected Part Fitment application and current title. Identify useful distinguishing qualifiers that were omitted, remove overlapping or repeated part-name wording first, then rebuild the title in the exact selectedTitleStructure order. Keep useful verified details whenever the result fits within 80 characters; remove details only when truly unnecessary or required by the hard limit. Recount all characters including spaces and final SKU. Preserve a verifiedVehicleDecision and its citation when supplied. Check all failures again before returning; do not repeat the failed title unchanged. Return the complete original output contract. Do not invent facts. Mark unresolved uncertainty Needs Review.'
        }
      }
    };
    try {
      const correctedAi = await executeAi(correctionPrompt);
      if (!normalizeText(correctedAi?.generatedTitle)) throw new Error('Correction response missing generatedTitle.');
      const correctedValidation = (dependencies.validate || validateTitleOptimizationRuntimeCandidate)({
        snapshot, sourceResolution, ruleResolution, promptArtifact: correctionPrompt,
        candidateTitle: correctedAi.generatedTitle, categoryPriorityDetails: correctedAi.categoryPriorityDetails || [],
        sideDecision: correctedAi.sideDecision, vehicleDecision: correctedAi.vehicleDecision
      });
      const correctedDecision = (dependencies.decide || decideTitleOptimizationRuntimeResult)({
        snapshot, sourceResolution, ruleResolution, promptArtifact: correctionPrompt, validationResult: correctedValidation
      });
      aiResult = correctedAi;
      validation = correctedValidation;
      decision = correctedDecision;
      result.aiResult = aiResult;
      result.validation = validation;
      result.decision = decision;
      result.attempts.push(recordAttempt());
    } catch (error) {
      result.errors.push({ stage: 'CORRECTION_FAILURE', message: sanitizeError(error) });
    }
  }

  result.status = decision?.decision === 'BYPASSED_MANUAL_OVERRIDE' ? RUNTIME_STATUSES.BYPASSED : RUNTIME_STATUSES.COMPLETED;
  const existingTitle = normalizeText(sourceResolution?.resolved?.fields?.title?.resolvedValue || sourceResolution?.normalized?.fields?.existingTitle?.value);
  const reviewProposal = [...result.attempts].reverse().find(attempt =>
    normalizeText(attempt.proposedTitle) && normalizeText(attempt.proposedTitle) !== existingTitle)?.proposedTitle || aiResult.generatedTitle;
  result.output = writableOutput(aiResult, decision, reviewProposal);
  logger.info?.(
    `[Phase7.4 Runtime] recordId='${result.listing.recordId || ''}' ipn='${result.listing.ipn || ''}' ` +
      `config='${result.configuration.version || ''}' status='${result.status}' ` +
      `overrideStatus='${normalizeText(sourceResolution?.normalized?.manualOverride?.canonicalStatus)}' ` +
      `proposedTitle='${normalizeText(aiResult.generatedTitle)}' finalTitle='${result.output.title}' ` +
      `decision='${decision?.decision || ''}' reviewReason='${result.output.reviewReason}' ` +
      `failedChecks='${failedCheckSummary(decision)}' ` +
      `generationCalls=${generationCalls} ` +
      `sideDecision=${JSON.stringify(aiResult.sideDecision || null)} ` +
      `vehicleDecision=${JSON.stringify(validation.vehicleVerification || null)} ` +
      `attempts=${JSON.stringify(result.attempts)} ` +
      `categoryPriorityDetails=${categoryPriorityDetailsSummary(aiResult)}`
  );
  return result;
}

module.exports = {
  RUNTIME_STATUSES,
  runTitleOptimizationRuntime
};
