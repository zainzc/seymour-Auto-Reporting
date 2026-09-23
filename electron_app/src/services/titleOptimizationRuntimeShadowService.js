const { normalizeAndResolveListing } = require('./titleOptimizationRuntimeSourceResolutionService');
const { resolveApplicableTitleOptimizationRules } = require('./titleOptimizationRuntimeRuleResolutionService');
const { buildTitleOptimizationRuntimePrompt } = require('./titleOptimizationRuntimePromptBuilderService');
const { validateTitleOptimizationRuntimeCandidate } = require('./titleOptimizationRuntimeValidatorService');
const { decideTitleOptimizationRuntimeResult } = require('./titleOptimizationRuntimeDecisionService');

const SHADOW_STATUSES = Object.freeze({
  DISABLED: 'DISABLED',
  COMPLETED: 'COMPLETED',
  BYPASSED: 'BYPASSED',
  CONFIG_SNAPSHOT_FAILURE: 'CONFIG_SNAPSHOT_FAILURE',
  SOURCE_RESOLUTION_FAILURE: 'SOURCE_RESOLUTION_FAILURE',
  RULE_RESOLUTION_FAILURE: 'RULE_RESOLUTION_FAILURE',
  PROMPT_BUILD_FAILURE: 'PROMPT_BUILD_FAILURE',
  AI_FAILURE: 'AI_FAILURE',
  AI_RESPONSE_PARSE_FAILURE: 'AI_RESPONSE_PARSE_FAILURE',
  VALIDATOR_FAILURE: 'VALIDATOR_FAILURE',
  DECISION_FAILURE: 'DECISION_FAILURE',
  COMPARISON_FAILURE: 'COMPARISON_FAILURE'
});

function normalizeText(value) {
  if (Array.isArray(value)) return normalizeText(value[0]);
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/\s+/g, ' ');
}

function normalizeTitle(value) {
  return normalizeText(value).toLocaleLowerCase('en-US');
}

function sanitizeError(error) {
  return normalizeText(error?.message || error || 'Unknown shadow execution error.')
    .replace(/api[-_\s]*key[-_\s]*[A-Za-z0-9._-]+/gi, '[redacted]')
    .replace(/sk-[A-Za-z0-9._-]+/g, '[redacted]');
}

function resolvedValue(sourceResolution = {}, key) {
  return normalizeText(sourceResolution?.resolved?.fields?.[key]?.resolvedValue);
}

function countToken(title, token) {
  const clean = normalizeText(token).replace(/^#/, '');
  if (!clean) return 0;
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (normalizeText(title).match(new RegExp(`(^|\\s)#?${escaped}(?=$|\\s)`, 'gi')) || []).length;
}

function tokenAtEnd(title, token) {
  const clean = normalizeText(token).replace(/^#/, '');
  if (!clean) return false;
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\s#?${escaped}$`, 'i').test(` ${normalizeText(title)}`);
}

function compareField(title, value) {
  const expected = normalizeText(value);
  return {
    expected,
    present: expected ? normalizeTitle(title).includes(normalizeTitle(expected)) : null
  };
}

function protectedTerms(ruleResolution = {}) {
  const groups = ruleResolution?.restrictedTerms?.groups || {};
  return (groups['must-preserve'] || []).map(rule => normalizeText(rule.term)).filter(Boolean);
}

function restrictedTerms(ruleResolution = {}) {
  const groups = ruleResolution?.restrictedTerms?.groups || {};
  return Object.values(groups).flat().map(rule => normalizeText(rule.term)).filter(Boolean);
}

function compareTitleOptimizationShadowResult({ listing = {}, legacyResult = {}, sourceResolution = {}, ruleResolution = {}, shadowDecision = {}, shadowStatus = null } = {}) {
  const legacyTitle = normalizeText(legacyResult.generatedTitle || legacyResult.title || legacyResult.finalTitle);
  const shadowTitle = normalizeText(shadowDecision.finalTitle);
  const sku = resolvedValue(sourceResolution, 'sku');
  const exactTitleMatch = legacyTitle === shadowTitle;
  const normalizedTitleMatch = normalizeTitle(legacyTitle) === normalizeTitle(shadowTitle);
  const skuComparison = {
    sku,
    legacyCount: countToken(legacyTitle, sku),
    shadowCount: countToken(shadowTitle, sku),
    legacyAtEnd: tokenAtEnd(legacyTitle, sku),
    shadowAtEnd: tokenAtEnd(shadowTitle, sku)
  };
  const fields = {
    yearComparison: compareField(shadowTitle, resolvedValue(sourceResolution, 'year')),
    makeComparison: compareField(shadowTitle, resolvedValue(sourceResolution, 'brandMake')),
    modelComparison: compareField(shadowTitle, resolvedValue(sourceResolution, 'model')),
    partComparison: compareField(shadowTitle, resolvedValue(sourceResolution, 'part')),
    sideComparison: compareField(shadowTitle, resolvedValue(sourceResolution, 'side'))
  };
  const protectedTermComparison = protectedTerms(ruleResolution).map(term => ({
    term,
    legacyPresent: compareField(legacyTitle, term).present,
    shadowPresent: compareField(shadowTitle, term).present
  }));
  const restrictedTermComparison = restrictedTerms(ruleResolution).map(term => ({
    term,
    legacyPresent: compareField(legacyTitle, term).present,
    shadowPresent: compareField(shadowTitle, term).present
  }));
  const differences = [];
  if (!normalizedTitleMatch) differences.push('title_text');
  if (sku && (skuComparison.legacyCount !== skuComparison.shadowCount || skuComparison.legacyAtEnd !== skuComparison.shadowAtEnd)) {
    differences.push('sku');
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value.expected && value.present === false) differences.push(key.replace('Comparison', ''));
  }
  for (const item of protectedTermComparison) {
    if (item.legacyPresent && !item.shadowPresent) differences.push(`protected:${item.term}`);
  }

  const legacyReviewKey = normalizeText(legacyResult.titleReviewStatus).toLowerCase();
  const shadowReviewKey = normalizeText(shadowDecision.reviewStatus).toLowerCase();
  const compatibleReviewDisposition =
    legacyReviewKey === shadowReviewKey ||
    (legacyReviewKey === 'completed' && ['not_required', 'completed', ''].includes(shadowReviewKey));

  let riskLevel = 'SAFE_DIFFERENCE';
  if (shadowStatus && shadowStatus !== 'COMPLETED' && shadowStatus !== 'BYPASSED') riskLevel = 'SHADOW_FAILED';
  else if (normalizedTitleMatch && compatibleReviewDisposition) {
    riskLevel = 'MATCH';
  } else if (['RETAIN_EXISTING', 'BLOCKED', 'BYPASSED_MANUAL_OVERRIDE'].includes(shadowDecision.decision)) {
    riskLevel = shadowDecision.decision === 'BYPASSED_MANUAL_OVERRIDE' ? 'REVIEW_DIFFERENCE' : 'SAFETY_DIFFERENCE';
  } else if (shadowDecision.reviewRequired || shadowDecision.decision === 'NEEDS_REVIEW') {
    riskLevel = 'REVIEW_DIFFERENCE';
  }

  return {
    recordId: listing.recordId || null,
    ipn: listing.ipn || null,
    exactTitleMatch,
    normalizedTitleMatch,
    legacyLength: legacyTitle.length,
    shadowLength: shadowTitle.length,
    skuComparison,
    ...fields,
    protectedTermComparison,
    restrictedTermComparison,
    legacyReviewStatus: normalizeText(legacyResult.titleReviewStatus),
    shadowReviewStatus: normalizeText(shadowDecision.reviewStatus),
    legacyReviewReason: normalizeText(legacyResult.titleReviewReason),
    shadowReviewReason: normalizeText(shadowDecision.reviewReason),
    shadowDecision: shadowDecision.decision || null,
    differences,
    riskLevel
  };
}

function compactRuleSummary(ruleResolution = {}) {
  return {
    terminologyRuleIds: (ruleResolution.terminologyRules || []).map(rule => rule.id),
    synonymRuleIds: (ruleResolution.synonyms || []).map(rule => rule.id),
    prefixRuleId: ruleResolution.prefixRule?.rule?.id || null,
    categoryRuleIds: (ruleResolution.categoryRules || []).map(entry => entry.rule?.id).filter(Boolean),
    titleStructureId: ruleResolution.titleStructure?.selected?.id || null,
    flagReasonIds: (ruleResolution.flagReasons || []).map(reason => reason.id),
    systemRuleIds: (ruleResolution.systemRules || []).map(rule => rule.id)
  };
}

function baseResult({ shadowEnabled, listing, legacyResult }) {
  return {
    contractVersion: 1,
    runtimeMode: 'shadow-only',
    shadowEnabled: Boolean(shadowEnabled),
    status: shadowEnabled ? 'PENDING' : SHADOW_STATUSES.DISABLED,
    listing: {
      recordId: listing?.recordId || listing?.listingRecord?.id || null,
      ipn: listing?.ipn || null
    },
    configuration: { version: null },
    legacy: {
      authoritative: true,
      title: normalizeText(legacyResult?.generatedTitle || legacyResult?.title || legacyResult?.finalTitle),
      description: normalizeText(legacyResult?.generatedDescription),
      shortDescription: normalizeText(legacyResult?.shortDescription),
      reviewStatus: normalizeText(legacyResult?.titleReviewStatus),
      reviewReason: normalizeText(legacyResult?.titleReviewReason),
      reviewNotes: normalizeText(legacyResult?.titleReviewNotes)
    },
    shadow: {
      sourceResolution: null,
      ruleSummary: null,
      promptMetadata: null,
      aiResult: null,
      validation: null,
      decision: null
    },
    comparison: null,
    errors: [],
    warnings: []
  };
}

function fail(result, status, error) {
  result.status = status;
  result.errors.push({ stage: status, message: sanitizeError(error) });
  result.comparison = { riskLevel: 'SHADOW_FAILED', differences: ['shadow_failed'] };
  return result;
}

async function runTitleOptimizationRuntimeShadow({ shadowEnabled = false, listing = {}, legacyResult = {}, options = {}, dependencies = {} } = {}) {
  const result = baseResult({ shadowEnabled, listing, legacyResult });
  if (!shadowEnabled) return result;

  const logger = dependencies.logger || console;
  let snapshot;
  let sourceResolution;
  let ruleResolution;
  let promptArtifact;
  let aiResult;
  let validation;
  let decision;

  try {
    if (typeof dependencies.loadSnapshot !== 'function') throw new Error('Runtime snapshot loader is not configured.');
    snapshot = await dependencies.loadSnapshot({ listing, options });
    result.configuration.version = snapshot?.metadata?.configurationVersion || null;
  } catch (error) {
    return fail(result, SHADOW_STATUSES.CONFIG_SNAPSHOT_FAILURE, error);
  }

  try {
    sourceResolution = (dependencies.resolveSource || ((input) => normalizeAndResolveListing(input)))({
      runtimeSnapshot: snapshot,
      listingRecord: listing.listingRecord,
      masterRecord: listing.masterRecord,
      fields: options.fields || []
    });
    result.shadow.sourceResolution = {
      recordId: sourceResolution?.normalized?.recordId || listing.recordId || null,
      conflicts: sourceResolution?.resolved?.conflicts || [],
      missing: sourceResolution?.resolved?.missing || []
    };
  } catch (error) {
    return fail(result, SHADOW_STATUSES.SOURCE_RESOLUTION_FAILURE, error);
  }

  try {
    ruleResolution = (dependencies.resolveRules || ((input) => resolveApplicableTitleOptimizationRules(input)))({
      runtimeSnapshot: snapshot,
      listingResolution: sourceResolution
    });
    result.shadow.ruleSummary = compactRuleSummary(ruleResolution);
  } catch (error) {
    return fail(result, SHADOW_STATUSES.RULE_RESOLUTION_FAILURE, error);
  }

  try {
    promptArtifact = (dependencies.buildPrompt || ((input) => buildTitleOptimizationRuntimePrompt(input)))({
      runtimeSnapshot: snapshot,
      listingResolution: sourceResolution,
      applicableRules: ruleResolution
    });
    result.shadow.promptMetadata = promptArtifact?.metadata || null;
  } catch (error) {
    return fail(result, SHADOW_STATUSES.PROMPT_BUILD_FAILURE, error);
  }

  if (promptArtifact?.kind === 'title-generation-bypass') {
    aiResult = null;
  } else {
    try {
      if (typeof dependencies.executeAi !== 'function') throw new Error('Shadow AI executor is not configured.');
      aiResult = await dependencies.executeAi({ promptArtifact, listing, options });
      if (!normalizeText(aiResult?.generatedTitle)) throw new Error('Shadow AI response missing generatedTitle.');
      result.shadow.aiResult = {
        generatedTitle: normalizeText(aiResult.generatedTitle),
        generatedDescription: normalizeText(aiResult.generatedDescription),
        shortDescription: normalizeText(aiResult.shortDescription),
        titleReviewStatus: normalizeText(aiResult.titleReviewStatus),
        titleReviewReason: normalizeText(aiResult.titleReviewReason),
        titleReviewNotes: normalizeText(aiResult.titleReviewNotes)
      };
    } catch (error) {
      const status = /missing generatedTitle|json|parse/i.test(String(error?.message || error))
        ? SHADOW_STATUSES.AI_RESPONSE_PARSE_FAILURE
        : SHADOW_STATUSES.AI_FAILURE;
      return fail(result, status, error);
    }
  }

  try {
    validation = (dependencies.validate || ((input) => validateTitleOptimizationRuntimeCandidate(input)))({
      snapshot,
      sourceResolution,
      ruleResolution,
      promptArtifact,
      candidateTitle: aiResult?.generatedTitle || ''
    });
    result.shadow.validation = {
      outcome: validation?.outcome || null,
      validatedTitle: validation?.validatedTitle || null,
      corrections: validation?.corrections || [],
      violations: validation?.violations || [],
      warnings: validation?.warnings || []
    };
  } catch (error) {
    return fail(result, SHADOW_STATUSES.VALIDATOR_FAILURE, error);
  }

  try {
    decision = (dependencies.decide || ((input) => decideTitleOptimizationRuntimeResult(input)))({
      snapshot,
      sourceResolution,
      ruleResolution,
      promptArtifact,
      validationResult: validation
    });
    result.shadow.decision = decision;
  } catch (error) {
    return fail(result, SHADOW_STATUSES.DECISION_FAILURE, error);
  }

  try {
    const compare = dependencies.compare || compareTitleOptimizationShadowResult;
    result.comparison = compare({
      listing: result.listing,
      legacyResult,
      sourceResolution,
      ruleResolution,
      shadowDecision: decision
    });
  } catch (error) {
    return fail(result, SHADOW_STATUSES.COMPARISON_FAILURE, error);
  }

  result.status = decision?.decision === 'BYPASSED_MANUAL_OVERRIDE' ? SHADOW_STATUSES.BYPASSED : SHADOW_STATUSES.COMPLETED;
  logger.info?.(
    `[Phase7.4 Shadow] recordId='${result.listing.recordId || ''}' ipn='${result.listing.ipn || ''}' ` +
      `config='${result.configuration.version || ''}' status='${result.status}' ` +
      `legacyTitle='${result.legacy.title}' shadowFinalTitle='${normalizeText(decision?.finalTitle)}' ` +
      `risk='${result.comparison?.riskLevel || ''}' decision='${decision?.decision || ''}' reviewReason='${decision?.reviewReason || ''}'`
  );
  return result;
}

module.exports = {
  SHADOW_STATUSES,
  compareTitleOptimizationShadowResult,
  runTitleOptimizationRuntimeShadow
};
