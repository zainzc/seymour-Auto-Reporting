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
  const accepted = decision.decision === 'ACCEPT_CANDIDATE' && decision.reviewRequired !== true;
  const proposal = normalizeText(proposedTitle || aiResult.generatedTitle);
  const deterministicNotes = normalizeText(decision.reviewNotes) || failedCheckSummary(decision);
  return {
    title: accepted ? normalizeText(decision.finalTitle) : '',
    proposedTitle: proposal,
    description: normalizeText(aiResult.generatedDescription),
    shortDescription: normalizeText(aiResult.shortDescription),
    reviewStatus: bypassed ? 'Skipped - Manual Override' : accepted ? 'Completed' : 'Needs Review',
    reviewReason: bypassed ? normalizeText(decision.reviewReason) || 'manual_override' :
      accepted ? 'completed' : normalizeText(decision.reviewReason) || 'manual_review_required',
    reviewNotes: bypassed ? normalizeText(decision.reviewNotes) || 'Automated title generation was skipped.' :
      accepted ? acceptedReviewNotes(aiResult, decision) :
        [deterministicNotes, proposal ? `Proposed title: ${proposal}` : ''].filter(Boolean).join(' ')
  };
}

function acceptedReviewNotes(aiResult = {}, decision = {}) {
  const notes = [];
  const selected = aiResult.selectedTitleFacts && typeof aiResult.selectedTitleFacts === 'object'
    ? aiResult.selectedTitleFacts
    : null;
  if (selected) {
    const selectedFacts = [
      selected.yearRange,
      selected.make,
      selected.model,
      selected.side,
      selected.placement,
      selected.part
    ].map(normalizeText).filter(Boolean).join(' ');
    if (selectedFacts) notes.push(`Selected facts: ${selectedFacts}.`);
    const keyDetails = Array.isArray(selected.keyDetails)
      ? selected.keyDetails.map(normalizeText).filter(Boolean)
      : [];
    if (keyDetails.length) notes.push(`Kept key detail${keyDetails.length > 1 ? 's' : ''}: ${keyDetails.join(', ')}.`);
    if (normalizeText(selected.evidenceSummary)) notes.push(selected.evidenceSummary.endsWith('.')
      ? selected.evidenceSummary
      : `${selected.evidenceSummary}.`);
  }
  const vehicle = aiResult.vehicleDecision || {};
  const vehicleIdentity = [vehicle.yearRange, vehicle.make, vehicle.model].map(normalizeText).filter(Boolean).join(' ');
  if (vehicle.resolved === true && vehicleIdentity) {
    notes.push(`Verified vehicle application: ${vehicleIdentity}.`);
    const citedRows = normalizeText(vehicle.source).split(';').filter(Boolean).length;
    if (citedRows > 1) notes.push(`Combined ${citedRows} cited fitment rows into one supported range.`);
  }
  const side = aiResult.sideDecision || {};
  const placement = [side.placement, side.side].map(normalizeText).filter(Boolean).join(' ');
  if (placement) notes.push(`Verified placement: ${placement}.`);
  const details = (Array.isArray(aiResult.categoryPriorityDetails) ? aiResult.categoryPriorityDetails : [])
    .filter(item => item?.verified === true)
    .map(item => normalizeText(item.detail))
    .filter(detail => detail && !/missing|cannot|conflict|degrade|uncertain|review|too long/i.test(detail));
  if (details.length) notes.push(`Applied verified category detail${details.length > 1 ? 's' : ''}: ${details.join(', ')}.`);
  const removed = (Array.isArray(aiResult.removedTitleDetails) ? aiResult.removedTitleDetails : [])
    .filter(item => item?.safeToRemove === true)
    .map(item => normalizeText(item.detail))
    .filter(Boolean);
  if (removed.length) notes.push(`Safely omitted: ${removed.join(', ')}.`);
  if (!notes.length) notes.push('Generated title accepted after evidence and safety validation.');
  const finalTitle = normalizeText(decision.finalTitle);
  if (finalTitle) notes.push(`Final title: ${finalTitle}.`);
  return notes.join(' ');
}

function failedCheckSummary(decision = {}) {
  return (decision.degradationChecks || [])
    .filter(check => check?.status === 'FAIL')
    .map(check => [check.checkId, check.field, check.message].map(normalizeText).filter(Boolean).join(':'))
    .join(' | ');
}

function onlyLengthFailures(decision = {}) {
  const failures = (decision?.degradationChecks || []).filter(check => ['FAIL', 'BLOCK'].includes(check?.status));
  return failures.length > 0 && failures.every(check =>
    check?.checkId === 'phase-e:length-80' ||
    (check?.checkId === 'phase-e:final-invariant-recheck' && /80.?character/i.test(normalizeText(check.message)))
  );
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

  const fitmentSelection = promptArtifact?.userPayload?.resolvedListing?.titleFitmentCandidates || {};
  const blockingFitmentIssue = (fitmentSelection.sourceIssues || []).find(issue =>
    issue?.code === 'INVALID_FITMENT_DATE');
  if (blockingFitmentIssue) {
    const issueValue = normalizeText(blockingFitmentIssue.value);
    const issueEvidence = normalizeText(blockingFitmentIssue.evidence);
    const reviewNotes = `${normalizeText(blockingFitmentIssue.message)} Correct the source data before generating a title` +
      `${issueEvidence ? `; source evidence: ${issueEvidence}` : ''}.`;
    result.status = RUNTIME_STATUSES.COMPLETED;
    result.validation = {
      outcome: 'BLOCK',
      validatedTitle: '',
      violations: [{ checkId: 'invalid-fitment-date', message: reviewNotes }],
      warnings: []
    };
    result.decision = {
      decision: 'NEEDS_REVIEW',
      finalTitle: '',
      reviewRequired: true,
      reviewReason: 'Invalid Part Fitment date',
      reviewNotes,
      degradationChecks: [{ checkId: 'invalid-fitment-date', status: 'BLOCK', message: reviewNotes }]
    };
    result.output = writableOutput({}, result.decision, '');
    result.output.generationSkipped = true;
    logger.info?.(
      `[Phase7.4 Runtime] recordId='${result.listing.recordId || ''}' ipn='${result.listing.ipn || ''}' ` +
      `config='${result.configuration.version || ''}' status='${result.status}' ` +
      `acceptedTitle='' titleWriteAction='PRESERVE_ITEM_TITLE' ` +
      `fitmentResolution='${normalizeText(fitmentSelection.resolution)}' ` +
      `decision='NEEDS_REVIEW' reviewReason='Invalid Part Fitment date' ` +
      `failedChecks='invalid-fitment-date:${reviewNotes}' generationCalls=0 invalidValue='${issueValue}'`
    );
    return result;
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
      vehicleDecision: aiResult.vehicleDecision,
      safetyDecision: aiResult.safetyDecision
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
          instruction: 'Correct every listed failure using the original supplied evidence and rules. Audit the previous title against the selected Part Fitment application and current title. For an invented citation, return an exact supplied citation. For an unsupported year or year gap, select only continuously covered cited years. For a changed make or model, restore the advertised supported make and model. Add any missing selected vehicle identity. For a side failure, use only the authoritative cited side. Remove an unsupported optional MPN; do not choose between conflicting authoritative MPN values. Identify useful distinguishing qualifiers that were omitted, remove overlapping or repeated part-name wording first, then rebuild the title in the exact selectedTitleStructure order. Keep useful verified details whenever the result fits within 80 characters; remove optional redundant details only as needed to remain within 80 characters. Recount all characters including spaces and place the verified SKU exactly once at the end. Preserve a verifiedVehicleDecision and its citation when supplied. Check all failures again before returning; do not repeat the failed title unchanged. Return the complete original output contract. Do not invent facts. Mark only unresolved material uncertainty Needs Review.'
        }
      }
    };
    try {
      const correctedAi = await executeAi(correctionPrompt);
      if (!normalizeText(correctedAi?.generatedTitle)) throw new Error('Correction response missing generatedTitle.');
      const correctedValidation = (dependencies.validate || validateTitleOptimizationRuntimeCandidate)({
        snapshot, sourceResolution, ruleResolution, promptArtifact: correctionPrompt,
        candidateTitle: correctedAi.generatedTitle, categoryPriorityDetails: correctedAi.categoryPriorityDetails || [],
        sideDecision: correctedAi.sideDecision, vehicleDecision: correctedAi.vehicleDecision,
        safetyDecision: correctedAi.safetyDecision
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

  if (generationCalls < 3 && promptArtifact?.kind !== 'title-generation-bypass' && onlyLengthFailures(decision)) {
    const overLimitTitle = normalizeText(aiResult.generatedTitle);
    const compressionPrompt = {
      ...promptArtifact,
      userPayload: {
        ...promptArtifact.userPayload,
        correction: {
          previousTitle: overLimitTitle,
          verifiedVehicleDecision: validation?.vehicleVerification?.verified ? validation.vehicleVerification.decision : null,
          failures: (decision.degradationChecks || [])
            .filter(check => ['FAIL', 'BLOCK'].includes(check?.status))
            .map(check => ({ checkId: check.checkId, field: check.field, message: check.message })),
          instruction: `Compression-only correction. The previous title is ${overLimitTitle.length} characters and must be 80 characters or fewer including spaces and the final SKU. Return a different, shorter title. Preserve supported year/make/model, product identity, material fitment, side when verified, and SKU exactly once at the end. Remove only the least important redundant wording, duplicate concepts, optional generic descriptors, or optional MPN. Prefer concise equivalents such as removing a redundant Front when Driver Door already identifies placement, or removing Power when Master Window Switch remains accurate. Recount the complete title before returning JSON. Do not truncate words or invent facts.`
        }
      }
    };
    try {
      const compressedAi = await executeAi(compressionPrompt);
      if (!normalizeText(compressedAi?.generatedTitle)) throw new Error('Compression response missing generatedTitle.');
      const compressedValidation = (dependencies.validate || validateTitleOptimizationRuntimeCandidate)({
        snapshot, sourceResolution, ruleResolution, promptArtifact: compressionPrompt,
        candidateTitle: compressedAi.generatedTitle,
        categoryPriorityDetails: compressedAi.categoryPriorityDetails || [],
        sideDecision: compressedAi.sideDecision,
        vehicleDecision: compressedAi.vehicleDecision,
        safetyDecision: compressedAi.safetyDecision
      });
      const compressedDecision = (dependencies.decide || decideTitleOptimizationRuntimeResult)({
        snapshot, sourceResolution, ruleResolution, promptArtifact: compressionPrompt,
        validationResult: compressedValidation
      });
      aiResult = compressedAi;
      validation = compressedValidation;
      decision = compressedDecision;
      result.aiResult = aiResult;
      result.validation = validation;
      result.decision = decision;
      result.attempts.push(recordAttempt());
    } catch (error) {
      result.errors.push({ stage: 'COMPRESSION_FAILURE', message: sanitizeError(error) });
    }
  }

  result.status = decision?.decision === 'BYPASSED_MANUAL_OVERRIDE' ? RUNTIME_STATUSES.BYPASSED : RUNTIME_STATUSES.COMPLETED;
  const existingTitle = normalizeText(sourceResolution?.resolved?.fields?.title?.resolvedValue || sourceResolution?.normalized?.fields?.existingTitle?.value);
  const reviewProposal = [...result.attempts].reverse().find(attempt =>
    normalizeText(attempt.proposedTitle) && normalizeText(attempt.proposedTitle) !== existingTitle)?.proposedTitle || aiResult.generatedTitle;
  result.output = writableOutput(aiResult, decision, reviewProposal);
  const titleWriteAction = result.output.title ? 'WRITE_ITEM_TITLE' : 'PRESERVE_ITEM_TITLE';
  logger.info?.(
    `[Phase7.4 Runtime] recordId='${result.listing.recordId || ''}' ipn='${result.listing.ipn || ''}' ` +
      `config='${result.configuration.version || ''}' status='${result.status}' ` +
      `overrideStatus='${normalizeText(sourceResolution?.normalized?.manualOverride?.canonicalStatus)}' ` +
      `existingTitle='${existingTitle}' proposedTitle='${normalizeText(aiResult.generatedTitle)}' ` +
      `acceptedTitle='${result.output.title}' titleWriteAction='${titleWriteAction}' ` +
      `fitmentResolution='${normalizeText(fitmentSelection.resolution)}' ` +
      `fitmentApplications=${JSON.stringify(fitmentSelection.distinctApplications || [])} ` +
      `decision='${decision?.decision || ''}' reviewReason='${result.output.reviewReason}' ` +
      `failedChecks='${failedCheckSummary(decision)}' ` +
      `generationCalls=${generationCalls} ` +
      `sideDecision=${JSON.stringify(aiResult.sideDecision || null)} ` +
      `vehicleDecision=${JSON.stringify(validation.vehicleVerification || null)} ` +
      `safetyDecision=${JSON.stringify(validation.semanticSafety || null)} ` +
      `attempts=${JSON.stringify(result.attempts)} ` +
      `categoryPriorityDetails=${categoryPriorityDetailsSummary(aiResult)}`
  );
  return result;
}

module.exports = {
  RUNTIME_STATUSES,
  runTitleOptimizationRuntime
};
