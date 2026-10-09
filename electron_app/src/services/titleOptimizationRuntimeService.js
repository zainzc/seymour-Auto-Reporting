const { normalizeAndResolveListing } = require('./titleOptimizationRuntimeSourceResolutionService');
const { resolveApplicableTitleOptimizationRules } = require('./titleOptimizationRuntimeRuleResolutionService');
const { buildTitleOptimizationRuntimePrompt } = require('./titleOptimizationRuntimePromptBuilderService');
const { buildFitmentReviewInput, checkedFitmentReview } = require('./titleOptimizationFitmentReviewService');
const { validateMechanicalTitle, decideAiTitle } = require('./titleOptimizationAiDecisionService');
const { validateTitleRuleContract } = require('./titleOptimizationRuleContractService');

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
    fitmentReview: null,
    ruleDecision: null,
    errors: []
  };
}

function fail(result, status, error) {
  result.status = status;
  result.errors.push({ stage: status, message: sanitizeError(error) });
  return result;
}

function writableOutput(aiResult = {}, decision = {}, proposedTitle = '', existingTitle = '') {
  const bypassed = decision.decision === 'BYPASSED_MANUAL_OVERRIDE';
  const accepted = decision.decision === 'ACCEPT_CANDIDATE' && decision.reviewRequired !== true;
  const proposal = normalizeText(proposedTitle || aiResult.generatedTitle);
  const unsafeProposal = (decision.degradationChecks || []).some(check => [
    'phase-e:existing-title-side-conflict',
    'phase-e:restricted-term-prohibited',
    'phase-e:restricted-term-authorization',
    'phase-e:restricted-term-preservation',
    'phase-e:unsupported-claim-self-audit'
  ].includes(check?.checkId));
  const reviewProposal = ['NEEDS_REVIEW', 'RETAIN_EXISTING'].includes(decision.decision) &&
    !unsafeProposal
    ? proposal
    : '';
  const deterministicNotes = normalizeText(decision.reviewNotes) || failedCheckSummary(decision);
  return {
    title: accepted ? normalizeText(decision.finalTitle) : reviewProposal,
    proposedTitle: proposal,
    description: normalizeText(aiResult.generatedDescription),
    shortDescription: normalizeText(aiResult.shortDescription),
    reviewStatus: bypassed ? 'Skipped - Manual Override' : accepted ? 'Completed' : 'Needs Review',
    reviewReason: bypassed ? normalizeText(decision.reviewReason) || 'manual_override' :
      accepted ? 'completed' : normalizeText(decision.reviewReason) || 'manual_review_required',
    reviewNotes: bypassed ? normalizeText(decision.reviewNotes) || 'Automated title generation was skipped.' :
      accepted ? acceptedReviewNotes(aiResult, decision, existingTitle) :
        [deterministicNotes, proposal ? `Proposed title: ${proposal}` : ''].filter(Boolean).join(' ')
  };
}

function acceptedReviewNotes(aiResult = {}, decision = {}, existingTitle = '') {
  const notes = [];
  if (existingTitle && String(existingTitle).trim() === normalizeText(decision.finalTitle)) {
    notes.push('Existing title retained unchanged; AI found it meets the supplied evidence, applicable UI rules, and Title Structure.');
  }
  const vehicle = aiResult.vehicleDecision || {};
  const vehicleIdentity = [vehicle.yearRange, vehicle.make, vehicle.model].map(normalizeText).filter(Boolean).join(' ');
  if (vehicle.resolved === true && vehicleIdentity) {
    notes.push(`${decision.aiLed ? 'AI-reviewed' : 'Verified'} vehicle application: ${vehicleIdentity}.`);
    const citedRows = normalizeText(vehicle.source).split(';').filter(Boolean).length;
    if (citedRows > 1) notes.push(`Combined ${citedRows} cited fitment rows into one supported range.`);
  }
  const side = aiResult.sideDecision || {};
  const placement = [side.placement, side.side].map(normalizeText).filter(Boolean).join(' ');
  if (placement) notes.push(`${decision.aiLed ? 'AI-reviewed' : 'Verified'} placement: ${placement}.`);
  const details = (Array.isArray(aiResult.categoryPriorityDetails) ? aiResult.categoryPriorityDetails : [])
    .filter(item => item?.verified === true)
    .map(item => normalizeText(item.detail))
    .filter(detail => detail && !/missing|cannot|conflict|degrade|uncertain|review|too long/i.test(detail));
  if (details.length) notes.push(`Applied ${decision.aiLed ? 'AI-supported' : 'verified'} category detail${details.length > 1 ? 's' : ''}: ${details.join(', ')}.`);
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

function compactValue(value, maximum = 180) {
  return normalizeText(value).replace(/<[^>]+>/g, '').slice(0, maximum);
}

function buildRuleDecision({ sourceResolution = {}, ruleResolution = {}, validation = {}, decision = {}, aiResult = {} } = {}) {
  const classification = ruleResolution.listingClassification || null;
  const ignoredEvidence = Object.values(sourceResolution?.normalized?.derived || {})
    .filter(item => item?.contentRole === 'boilerplate')
    .map(item => ({
      logicalKey: item.logicalKey || null,
      sourceFieldName: compactValue(item.sourceFieldName) || null,
      reason: 'boilerplate'
    }));
  return {
    classification: classification ? {
      family: classification.family,
      resolved: classification.resolved === true,
      reason: classification.reason || null,
      sources: (classification.sources || []).map(item => ({
        type: item.type,
        value: compactValue(item.value),
        family: item.family
      })),
      conflicts: (classification.conflicts || []).map(item => ({
        type: item.type,
        value: compactValue(item.value),
        family: item.family
      }))
    } : null,
    ignoredEvidence,
    matchedCategoryRules: (ruleResolution.categoryRules || []).map(entry => ({
      id: entry.rule?.id || null,
      categoryName: entry.rule?.categoryName || null,
      matchedBy: entry.matchedBy || [],
      priorityDetails: entry.priorityDetails || entry.rule?.priorityDetails || []
    })),
    selectedStructure: ruleResolution.titleStructure?.selected ? {
      id: ruleResolution.titleStructure.selected.id,
      name: ruleResolution.titleStructure.selected.structureName,
      reason: ruleResolution.titleStructure.reason
    } : null,
    applicableRestrictedTerms: (ruleResolution.restrictedTerms?.rules || []).map(rule => ({
      id: rule.id || null,
      term: rule.term,
      ruleType: rule.ruleType,
      scope: rule.scope || null
    })),
    sourceConflicts: (sourceResolution?.resolved?.conflicts || []).map(conflict => ({
      field: conflict.field,
      winner: compactValue(conflict.resolvedValue),
      alternatives: (conflict.conflicts || []).map(item => ({
        source: item.source,
        value: compactValue(item.value)
      }))
    })),
    aiRuleDecisions: {
      categoryPriorityDetails: aiResult.categoryPriorityDetails || [],
      materialRestrictions: aiResult.materialRestrictions || [],
      restrictedTermDecisions: aiResult.restrictedTermDecisions || [],
      ruleSelfAudit: aiResult.ruleSelfAudit || null
    },
    checks: validation.ruleContract?.checks || validation.violations || [],
    finalDisposition: decision.decision || null,
    reviewReason: decision.reviewReason || null
  };
}

async function runTitleOptimizationRuntime({ listing = {}, options = {}, dependencies = {} } = {}) {
  const result = baseResult(listing);
  const logger = dependencies.logger || console;
  const independentAiReviewEnabled = options.enableIndependentAiReview !== false;
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
    const sku = normalizeText(sourceResolution?.resolved?.fields?.sku?.resolvedValue ||
      sourceResolution?.normalized?.fields?.sku?.value || ruleResolution?.listingContext?.sku).replace(/^#+/, '');
    const prefix = normalizeText(ruleResolution?.listingContext?.ipnPrefix || ruleResolution?.prefixRule?.normalizedPrefix);
    const suffix = sku ? `${prefix === '257' ? '#' : ''}${sku}` : '';
    const previousTitle = artifact?.userPayload?.correction?.previousTitle;
    const previousNormalized = previousTitle ? validateMechanicalTitle({ sourceResolution, ruleResolution,
      candidateTitle: previousTitle }).validatedTitle : null;
    return dependencies.executeAi({ promptArtifact: { ...artifact, userPayload: { ...artifact.userPayload,
      titleBudget: { maximumCharacters: 80, requiredSkuSuffix: suffix || null,
        maximumCharactersBeforeSku: suffix ? Math.max(0, 80 - suffix.length - 1) : null,
        previousTitleCharactersAfterSku: previousNormalized?.length ?? null,
        instruction: 'Compose within this budget including spaces and the final SKU. Preserve configured mandatory terms and material fitment; optional MPN and enrichment yield first.' }
    } }, listing, options });
  };
  const validateAiResult = (artifact, currentAiResult) => {
    const validationInputs = {
      snapshot,
      sourceResolution,
      ruleResolution,
      promptArtifact: artifact,
      candidateTitle: currentAiResult.generatedTitle || '',
      categoryPriorityDetails: currentAiResult.categoryPriorityDetails || [],
      sideDecision: currentAiResult.sideDecision,
      vehicleDecision: currentAiResult.vehicleDecision
    };
    const mechanical = (dependencies.validate || validateMechanicalTitle)(validationInputs);
    const contract = validateTitleRuleContract({
      aiResult: currentAiResult,
      sourceResolution,
      ruleResolution,
      promptArtifact: artifact,
      candidateTitle: mechanical.validatedTitle || validationInputs.candidateTitle
    });
    if (contract.passed) return { ...mechanical, ruleContract: contract };
    return {
      ...mechanical,
      outcome: 'RETAIN_EXISTING_REQUIRED',
      valid: false,
      safeToContinue: false,
      checks: [...(mechanical.checks || []), ...contract.checks],
      violations: [...(mechanical.violations || []), ...contract.violations],
      ruleContract: contract
    };
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
    validation = validateAiResult(promptArtifact, aiResult);
    result.validation = validation;
  } catch (error) {
    return fail(result, RUNTIME_STATUSES.VALIDATOR_FAILURE, error);
  }

  try {
    decision = (dependencies.decide || decideAiTitle)({
      snapshot,
      sourceResolution,
      ruleResolution,
      promptArtifact,
      validationResult: validation,
      aiResult
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
  const unretryableConflict = failures.some(check => [
    'phase-e:existing-title-side-conflict',
    'phase-e:source-conflict-self-audit'
  ].includes(check?.checkId));
  if (generationCalls < 2 && promptArtifact?.kind !== 'title-generation-bypass' && failures.length && decision?.reviewRequired &&
      !unretryableConflict &&
      normalizeText(aiResult.titleReviewStatus).toLowerCase() !== 'needs review') {
    const correctionPrompt = {
      ...promptArtifact,
      userPayload: {
        ...promptArtifact.userPayload,
        correction: {
          previousTitle: normalizeText(aiResult.generatedTitle),
          verifiedVehicleDecision: validation?.vehicleVerification?.verified ? validation.vehicleVerification.decision : null,
          failures: failures.map(check => ({ checkId: check.checkId, field: check.field, message: check.message })),
          instruction: dependencies.validate || dependencies.decide
            ? 'Correct every listed failure using the original supplied evidence and rules. Audit the previous title against the selected Part Fitment application and current title. For an invented citation, return an exact supplied citation. For an unsupported year or year gap, select only continuously covered cited years. For a changed make or model, restore the advertised supported make and model. Add any missing selected vehicle identity. For a side failure, use only the authoritative cited side. Remove an unsupported optional MPN; do not choose between conflicting authoritative MPN values. Identify useful distinguishing qualifiers that were omitted, remove overlapping or repeated part-name wording first, then rebuild the title in the exact selectedTitleStructure order. Keep useful verified details whenever the result fits within 80 characters; remove optional redundant details only as needed to remain within 80 characters. Recount all characters including spaces and place the verified SKU exactly once at the end. Preserve a verifiedVehicleDecision and its citation when supplied. Check all failures again before returning; do not repeat the failed title unchanged. Return the complete original output contract. Do not invent facts. Mark only unresolved material uncertainty Needs Review.'
            : 'Correct the listed title failures using only the original supplied evidence. Preserve the advertised vehicle, explicit side, material fitment, and configured title structure. If a material restriction is already stated in the title, report it as included; otherwise add it without losing a more important detail or mark Needs Review when it cannot fit. Remove any prohibited or unauthorized restricted term; return restrictedTermDecisions only for terms used in the corrected title. Cite supplied evidence IDs accurately, but do not change an otherwise safe title merely to repair citation formatting. Keep the complete title within 80 characters and place the verified SKU exactly once at the end. Remove repeated wording and optional MPN before material fitment. Never silently change an explicit side from the existing title. Return the complete JSON contract.'
        }
      }
    };
    try {
      const correctedAi = await executeAi(correctionPrompt);
      if (!normalizeText(correctedAi?.generatedTitle)) throw new Error('Correction response missing generatedTitle.');
      const correctedValidation = validateAiResult(correctionPrompt, correctedAi);
      const correctedDecision = (dependencies.decide || decideAiTitle)({
        snapshot, sourceResolution, ruleResolution, promptArtifact: correctionPrompt, validationResult: correctedValidation,
        aiResult: correctedAi
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

  let compressionAttempted = false;
  const compressIfNeeded = async (fitmentReview = null) => {
    if (compressionAttempted || generationCalls >= 4 || promptArtifact?.kind === 'title-generation-bypass' ||
        !onlyLengthFailures(decision)) return;
    compressionAttempted = true;
    const overLimitTitle = normalizeText(validation?.validatedTitle || aiResult.generatedTitle);
    const mpn = normalizeText(sourceResolution?.resolved?.fields?.manufacturerPartNumber?.resolvedValue);
    const sku = normalizeText(sourceResolution?.resolved?.fields?.sku?.resolvedValue);
    const mpnFreeTitle = mpn && !/\s/.test(mpn) && mpn.toLowerCase() !== sku.toLowerCase()
      ? overLimitTitle.split(' ').filter(token => token.toLowerCase() !== mpn.toLowerCase()).join(' ')
      : '';
    const suggestedShorterTitle = mpnFreeTitle && mpnFreeTitle !== overLimitTitle && mpnFreeTitle.length <= 80
      ? mpnFreeTitle : null;
    const compressionPrompt = {
      ...promptArtifact,
      userPayload: {
        ...promptArtifact.userPayload,
        correction: {
          previousTitle: overLimitTitle,
          fitmentReview,
          suggestedShorterTitle,
          verifiedVehicleDecision: validation?.vehicleVerification?.verified ? validation.vehicleVerification.decision : null,
          failures: (decision.degradationChecks || [])
            .filter(check => ['FAIL', 'BLOCK'].includes(check?.status))
            .map(check => ({ checkId: check.checkId, field: check.field, message: check.message })),
          instruction: `Compression-only correction. The previous title is ${overLimitTitle.length} characters and must be 80 characters or fewer including spaces and the final SKU. Return a different, shorter title. Preserve supported year/make/model, product identity, material fitment, side when verified, and SKU exactly once at the end. Judge each phrase using this listing's evidence; remove only wording that is genuinely redundant or optional here. If suggestedShorterTitle is provided, evaluate it against every applicable rule and fitment condition; use it only if truthful, otherwise produce a different safe title. First check whether an optional manufacturer part number can be omitted without violating the selected structure or an applicable mandatory rule; do not sacrifice a material fitment detail to keep an optional MPN. Do not assume that a product-function or placement word is expendable because it seems redundant in another listing. Recount the complete title before returning JSON. Do not truncate words or invent facts.`
        }
      }
    };
    try {
      const compressedAi = await executeAi(compressionPrompt);
      if (!normalizeText(compressedAi?.generatedTitle)) throw new Error('Compression response missing generatedTitle.');
      const compressedValidation = validateAiResult(compressionPrompt, compressedAi);
      const compressedDecision = (dependencies.decide || decideAiTitle)({
        snapshot, sourceResolution, ruleResolution, promptArtifact: compressionPrompt,
        validationResult: compressedValidation, aiResult: compressedAi
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
  };
  await compressIfNeeded();

  const accepted = () => decision?.decision === 'ACCEPT_CANDIDATE' && decision.reviewRequired !== true;
  const withFitmentReview = async (title = decision.finalTitle) => {
    if (typeof dependencies.reviewTitleFitment !== 'function') throw new Error('Fitment review service is unavailable.');
    const input = buildFitmentReviewInput({
      title, promptArtifact, vehicleDecision: aiResult.vehicleDecision
    });
    if (input.invalidSelectedRowIds.length) {
      throw new Error(`Invalid selected fitment citation: ${input.invalidSelectedRowIds.join(', ')}.`);
    }
    let reviewFeedback = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await dependencies.reviewTitleFitment({ ...input, listing, options, reviewFeedback });
        return checkedFitmentReview(response, input);
      } catch (error) {
        if (attempt === 1) throw error;
        const expectedScopes = input.selectedRows.map(row => {
          const years = Number.isInteger(row.startYear) && Number.isInteger(row.endYear)
            ? row.startYear === row.endYear ? String(row.startYear) : `${row.startYear}-${row.endYear}`
            : 'use the supplied row evidence';
          return `${row.id}: ${years}`;
        }).join('; ');
        reviewFeedback = `Previous review was invalid: ${sanitizeError(error)}. Reassess every selected row using its own source years (${expectedScopes}) and return the complete required response.`;
      }
    }
  };
  const requireFitmentReview = (reason, citedRowIds = []) => {
    const detail = normalizeText(reason) || 'Fitment review could not confirm the final title.';
    result.fitmentReview = { verdict: 'REVIEW', reason: detail, citedRowIds };
    decision = {
      ...decision,
      decision: 'NEEDS_REVIEW',
      reviewRequired: true,
      reviewReason: 'Fitment claim requires review',
      reviewNotes: detail,
      degradationChecks: [...(decision?.degradationChecks || []), {
        checkId: 'ai-fitment-review', status: 'FAIL', message: detail
      }]
    };
    result.decision = decision;
  };
  const repairableAiReview = independentAiReviewEnabled && !accepted() && promptArtifact?.kind !== 'title-generation-bypass' &&
    generationCalls < 2 && normalizeText(aiResult.titleReviewStatus).toLowerCase() === 'needs review' &&
    !/conflicting source data/i.test(normalizeText(aiResult.titleReviewReason)) &&
    !(validation?.violations || []).length && normalizeText(validation?.validatedTitle);
  if (repairableAiReview) {
    try {
      const preliminaryReview = await withFitmentReview(validation.validatedTitle);
      result.fitmentReview = preliminaryReview;
      if (preliminaryReview.verdict === 'PASS') {
        const reconsideredAi = await executeAi({ ...promptArtifact,
          userPayload: { ...promptArtifact.userPayload, correction: {
            previousTitle: normalizeText(validation.validatedTitle),
            originalReviewReason: normalizeText(aiResult.titleReviewReason),
            originalReviewNotes: normalizeText(aiResult.titleReviewNotes),
            independentReview: preliminaryReview,
            instruction: 'Reconsider your original Needs Review using the supplied evidence and independent review. Address your own specific concern directly; the independent PASS alone does not prove it is resolved. Return Completed only if you can now support the complete final title under every applicable rule. Otherwise keep Needs Review with a precise remaining reason. Do not weaken fitment, product identity, or other material details merely to obtain Completed. Return the complete original output contract.'
          } } });
        if (!normalizeText(reconsideredAi?.generatedTitle)) throw new Error('Review recovery returned no title.');
        const reconsideredValidation = validateAiResult(promptArtifact, reconsideredAi);
        const reconsideredDecision = (dependencies.decide || decideAiTitle)({
          snapshot, sourceResolution, ruleResolution, promptArtifact,
          validationResult: reconsideredValidation, aiResult: reconsideredAi
        });
        aiResult = reconsideredAi;
        validation = reconsideredValidation;
        decision = reconsideredDecision;
        result.aiResult = aiResult;
        result.validation = validation;
        result.decision = decision;
        result.attempts.push(recordAttempt());
        await compressIfNeeded(preliminaryReview);
      }
    } catch (error) {
      result.errors.push({ stage: 'REVIEW_RECOVERY_FAILURE', message: sanitizeError(error) });
    }
  }
  if (independentAiReviewEnabled && accepted() && promptArtifact?.kind !== 'title-generation-bypass') {
    let review;
    try {
      review = await withFitmentReview();
      result.fitmentReview = review;
    } catch (error) {
      requireFitmentReview(`Independent fitment review failed: ${sanitizeError(error)}`);
    }
    if (review?.verdict === 'REVIEW') {
      const reviewReason = review.reason;
      try {
        const verifiedVehicleDecision = validation?.vehicleVerification?.verified
          ? validation.vehicleVerification.decision : null;
        const correctedAi = await executeAi({
          ...promptArtifact,
          userPayload: { ...promptArtifact.userPayload, correction: {
            previousTitle: normalizeText(decision.finalTitle),
            fitmentReview: review,
            verifiedVehicleDecision,
            instruction: 'An independent review found a material fitment problem in the final title. Correct the cited problem using the original listing evidence and configured title structure. Keep the vehicle advertised in the current title; another compatible make or model is not an automatic replacement. A condition that applies only to some years must not be applied to every year or omitted so that restricted years appear unrestricted. Check every title-level restriction against each selected year and variant. Keep the advertised application and all required restrictions truthful. Remove optional MPN, repeated part terms, and filler before a material fitment condition. Preserve the supplied verifiedVehicleDecision and its exact citation when the corrected title keeps that same application. If no accurate title fits within 80 characters, return Needs Review with a precise explanation. Do not remove a material restriction merely to pass review. Return the complete original output contract.'
          } }
        });
        if (!normalizeText(correctedAi?.generatedTitle)) throw new Error('Fitment correction returned no title.');
        if (!correctedAi.vehicleDecision && verifiedVehicleDecision) {
          correctedAi.vehicleDecision = verifiedVehicleDecision;
        }
        const correctedValidation = validateAiResult(promptArtifact, correctedAi);
        const correctedDecision = (dependencies.decide || decideAiTitle)({
          snapshot, sourceResolution, ruleResolution, promptArtifact, validationResult: correctedValidation,
          aiResult: correctedAi
        });
        aiResult = correctedAi;
        validation = correctedValidation;
        decision = correctedDecision;
        result.aiResult = aiResult;
        result.validation = validation;
        result.decision = decision;
        result.attempts.push(recordAttempt());
        await compressIfNeeded(review);
        if (accepted()) {
          const secondReview = await withFitmentReview();
          result.fitmentReview = secondReview;
          if (secondReview.verdict === 'REVIEW') requireFitmentReview(secondReview.reason, secondReview.citedRowIds);
        }
      } catch (error) {
        result.errors.push({ stage: 'FITMENT_REVIEW_CORRECTION_FAILURE', message: sanitizeError(error) });
        requireFitmentReview(`Independent fitment review could not accept the title: ${sanitizeError(error)}`);
      }
      if (!accepted() && result.fitmentReview === review) {
        const correctedReason = normalizeText(decision.reviewNotes);
        requireFitmentReview(correctedReason
          ? `Corrected title still requires review: ${correctedReason} Earlier title finding: ${reviewReason}`
          : `Corrected title still requires review. Earlier title finding: ${reviewReason}`, review.citedRowIds);
      }
    }
  }

  result.status = decision?.decision === 'BYPASSED_MANUAL_OVERRIDE' ? RUNTIME_STATUSES.BYPASSED : RUNTIME_STATUSES.COMPLETED;
  const existingTitle = normalizeText(sourceResolution?.resolved?.fields?.title?.resolvedValue || sourceResolution?.normalized?.fields?.existingTitle?.value);
  const reviewProposal = normalizeText(aiResult.generatedTitle);
  result.output = writableOutput(aiResult, decision, reviewProposal,
    promptArtifact?.userPayload?.existingTitle?.currentTitle || existingTitle);
  result.ruleDecision = buildRuleDecision({ sourceResolution, ruleResolution, validation, decision, aiResult });
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
      `fitmentReview=${JSON.stringify(result.fitmentReview)} ` +
      `sideDecision=${JSON.stringify(aiResult.sideDecision || null)} ` +
      `vehicleDecision=${JSON.stringify(validation.vehicleVerification || aiResult.vehicleDecision || null)} ` +
      `attempts=${JSON.stringify(result.attempts)} ` +
      `categoryPriorityDetails=${categoryPriorityDetailsSummary(aiResult)} ` +
      `ruleDecision=${JSON.stringify(result.ruleDecision)}`
  );
  return result;
}

module.exports = {
  RUNTIME_STATUSES,
  runTitleOptimizationRuntime
};
