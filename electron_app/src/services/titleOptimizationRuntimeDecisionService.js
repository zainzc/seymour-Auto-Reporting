const DECISIONS = Object.freeze({
  ACCEPT_CANDIDATE: 'ACCEPT_CANDIDATE',
  RETAIN_EXISTING: 'RETAIN_EXISTING',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  BYPASSED_MANUAL_OVERRIDE: 'BYPASSED_MANUAL_OVERRIDE',
  BLOCKED: 'BLOCKED'
});

const REVIEW_STATUS = Object.freeze({
  NOT_REQUIRED: 'not_required',
  NEEDS_REVIEW: 'needs_review',
  BLOCKED: 'blocked',
  MANUAL_OVERRIDE_BYPASS: 'manual_override_bypass'
});

const IDENTITY_FIELDS = Object.freeze([
  'sku',
  'year',
  'brandMake',
  'model',
  'side',
  // Other detail importance is supplied by the evidence-backed AI assessment.
]);

const MATERIAL_CONFLICT_FIELDS = Object.freeze([
  'sku',
  'year',
  'brandMake',
  'model',
  'side',
  'part',
  'engineDisplacement',
  'engineCode',
  'vin',
  'transmissionCode',
  'speedType',
  'drivetrain'
]);

const REVIEW_REASON_PRECEDENCE = Object.freeze([
  'Cannot preserve essential fitment within 80 characters',
  'Model cannot be normalized safely',
  'Conflicting source data',
  'Proposed title would degrade existing title',
  'Part identity uncertain',
  'Missing verified year'
]);

const { modelAmbiguityResolvedByCandidate } = require('./titleOptimizationRuntimeSourceResolutionService');
const { vehicleSourceResolution, applicationsCoverRange } = require('./titleOptimizationVehicleDecisionService');

function normalizeText(value) {
  if (Array.isArray(value)) return normalizeText(value[0]);
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/\s+/g, ' ');
}

function normalizeKey(value) {
  return normalizeText(value).toLocaleLowerCase('en-US');
}

function resolvedValue(sourceResolution = {}, key) {
  return normalizeText(sourceResolution?.resolved?.fields?.[key]?.resolvedValue);
}

function existingTitle(sourceResolution = {}) {
  return resolvedValue(sourceResolution, 'title') || normalizeText(sourceResolution?.normalized?.fields?.existingTitle?.value);
}

function manualOverrideTitle(sourceResolution = {}) {
  return normalizeText(sourceResolution?.normalized?.manualOverride?.title?.value) || existingTitle(sourceResolution);
}

function manualOverrideActive(sourceResolution = {}, promptArtifact = {}, validationResult = {}) {
  return Boolean(
    sourceResolution?.normalized?.manualOverride?.active ||
    promptArtifact?.kind === 'title-generation-bypass' ||
    validationResult?.outcome === 'BYPASSED'
  );
}

function manualOverrideReviewNote(sourceResolution = {}) {
  const status = normalizeText(sourceResolution?.normalized?.manualOverride?.canonicalStatus);
  if (status === 'Manually Approved') {
    return 'Title is manually approved; automated title generation was skipped.';
  }
  return 'Title is manually overridden; automated title generation was skipped.';
}

function titleContains(title, value) {
  const text = normalizeKey(title);
  const wanted = normalizeKey(value);
  return Boolean(text && wanted && text.includes(wanted));
}

function explicitYearRanges(title) {
  const ranges = [];
  for (const match of normalizeText(title).matchAll(/\b((?:19|20)?\d{2})\s*-\s*((?:19|20)?\d{2})\b/g)) {
    let start = Number(match[1]);
    let end = Number(match[2]);
    if (match[1].length === 2) start += start <= 30 ? 2000 : 1900;
    if (match[2].length === 2) end += end <= 30 ? 2000 : 1900;
    if (start <= end) ranges.push({ start, end, value: `${start}-${end}` });
  }
  return ranges;
}

function titleHasYearRange(title, range) {
  return explicitYearRanges(title).some(item => item.start === range.start && item.end === range.end);
}

function approvedFlagReasons(ruleResolution = {}) {
  return (ruleResolution.flagReasons || [])
    .filter(reason => reason && reason.enabled !== false && normalizeText(reason.reason))
    .map(reason => ({ id: reason.id, reason: reason.reason }));
}

function approvedReason(ruleResolution, wanted) {
  const target = normalizeKey(wanted);
  return approvedFlagReasons(ruleResolution).find(reason => normalizeKey(reason.reason) === target) || null;
}

function addReason(reasons, reason) {
  if (!reason) return;
  if (!reasons.some(item => item.id === reason.id && item.reason === reason.reason)) reasons.push(reason);
}

function sanitizeSuggestedReason(ruleResolution, suggested) {
  if (!suggested?.reason) return null;
  return approvedReason(ruleResolution, suggested.reason);
}

function primaryReason(reasons) {
  if (!reasons.length) return null;
  for (const wanted of REVIEW_REASON_PRECEDENCE) {
    const found = reasons.find(reason => normalizeKey(reason.reason) === normalizeKey(wanted));
    if (found) return found;
  }
  return [...reasons].sort((a, b) => normalizeText(a.reason).localeCompare(normalizeText(b.reason)) || normalizeText(a.id).localeCompare(normalizeText(b.id)))[0];
}

function protectedTerms(ruleResolution = {}) {
  const groups = ruleResolution?.restrictedTerms?.groups || {};
  return (groups['must-preserve'] || []).map(rule => ({
    field: `protected:${rule.term}`,
    value: rule.term,
    relatedConfigIds: [rule.id].filter(Boolean)
  }));
}

function degradationCheck({ checkId, status = 'PASS', severity = 'info', field = null, existingValue = null, candidateValue = null, evidence = null, relatedSystemRuleIds = [], relatedConfigIds = [], flagReason = null, message = '' }) {
  return { checkId, status, severity, field, existingValue, candidateValue, evidence, relatedSystemRuleIds, relatedConfigIds, flagReason, message };
}

function criticalLossChecks({ sourceResolution, ruleResolution, candidateTitle, existing }) {
  const checks = [];
  const degradeReason = approvedReason(ruleResolution, 'Proposed title would degrade existing title');
  for (const field of IDENTITY_FIELDS) {
    const value = resolvedValue(sourceResolution, field);
    if (!value) continue;
    if (!titleContains(existing, value)) continue;
    if (titleContains(candidateTitle, value)) continue;
    if (field === 'year' && /^\d{4}$/.test(value) && [...candidateTitle.matchAll(/\b((?:19|20)\d{2})\s*-\s*((?:19|20)\d{2})\b/g)]
      .some(match => Number(value) >= Number(match[1]) && Number(value) <= Number(match[2]))) continue;
    checks.push(degradationCheck({
      checkId: 'critical-loss',
      status: 'FAIL',
      severity: 'error',
      field,
      existingValue: value,
      candidateValue: null,
      evidence: 'Verified critical value was present in the authoritative existing title but missing from the validated candidate.',
      relatedSystemRuleIds: field === 'sku' ? ['SR-05', 'SR-14'] : ['SR-14'],
      flagReason: degradeReason,
      message: `Candidate lost verified ${field}.`
    }));
  }

  for (const term of protectedTerms(ruleResolution)) {
    if (!titleContains(existing, term.value)) continue;
    if (titleContains(candidateTitle, term.value)) continue;
    checks.push(degradationCheck({
      checkId: 'protected-term-loss',
      status: 'FAIL',
      severity: 'error',
      field: term.field,
      existingValue: term.value,
      candidateValue: null,
      evidence: 'Protected configured terminology was preserved in the existing title but missing from the candidate.',
      relatedSystemRuleIds: ['SR-14'],
      relatedConfigIds: term.relatedConfigIds,
      flagReason: degradeReason,
      message: `Candidate lost protected term ${term.value}.`
    }));
  }

  const partFitment = normalizeText(sourceResolution?.normalized?.titleAuthority?.partFitment?.value);
  const make = resolvedValue(sourceResolution, 'brandMake');
  const model = resolvedValue(sourceResolution, 'model');
  for (const range of explicitYearRanges(existing)) {
    if (!partFitment || !make || !model || titleHasYearRange(candidateTitle, range)) continue;
    if (!applicationsCoverRange(partFitment, make, model, range.start, range.end)) continue;
    checks.push(degradationCheck({
      checkId: 'explicit-year-range-loss',
      status: 'FAIL',
      severity: 'error',
      field: 'year',
      existingValue: range.value,
      candidateValue: explicitYearRanges(candidateTitle)[0]?.value || resolvedValue(sourceResolution, 'year') || null,
      evidence: 'Part Fitment continuously supports the complete year range advertised by the existing title.',
      relatedSystemRuleIds: ['SR-14'],
      flagReason: degradeReason,
      message: `Candidate narrowed verified fitment range ${range.value}.`
    }));
  }
  return checks;
}

function materialConflictChecks(sourceResolution = {}, ruleResolution = {}) {
  const checks = [];
  const conflictReason = approvedReason(ruleResolution, 'Conflicting source data');
  if (!conflictReason) return checks;
  const conflicts = Array.isArray(sourceResolution?.resolved?.conflicts) ? sourceResolution.resolved.conflicts : [];
  for (const conflict of conflicts) {
    if (!MATERIAL_CONFLICT_FIELDS.includes(conflict?.field)) continue;
    checks.push(degradationCheck({
      checkId: 'material-source-conflict',
      status: 'WARN',
      severity: 'warning',
      field: conflict.field,
      existingValue: conflict.resolvedValue || resolvedValue(sourceResolution, conflict.field) || null,
      candidateValue: null,
      evidence: 'Material title identity field has lower-priority conflicting source evidence.',
      flagReason: conflictReason,
      message: `Material source conflict for ${conflict.field}.`
    }));
  }
  return checks;
}

function validationFailureReasons(ruleResolution = {}, validationResult = {}) {
  const reasons = [];
  for (const suggested of validationResult.suggestedReviewReasons || []) {
    addReason(reasons, sanitizeSuggestedReason(ruleResolution, suggested));
  }
  const lengthFailure = (validationResult.violations || []).some(item => item?.checkId === 'length-80');
  if (lengthFailure) addReason(reasons, approvedReason(ruleResolution, 'Cannot preserve essential fitment within 80 characters'));
  const unsupported = (validationResult.violations || []).some(item => [
    'side-validation',
    'mpn-validation',
    'restricted-requires-authorization',
    'long-short-block-protection',
    'unsupported-information',
    'category-priority-verification',
    'unverified-category-priority-detail',
    'protected-term-preservation'
  ].includes(item?.checkId));
  if (unsupported) addReason(reasons, approvedReason(ruleResolution, 'Proposed title would degrade existing title'));
  return reasons;
}

function validationChecks(validationResult = {}, ruleResolution = {}) {
  const degradeReason = approvedReason(ruleResolution, 'Proposed title would degrade existing title');
  return (validationResult.violations || []).map(item => degradationCheck({
    checkId: `phase-e:${item.checkId || 'violation'}`,
    status: item.status === 'BLOCK' ? 'BLOCK' : 'FAIL',
    severity: item.severity || 'error',
    field: null,
    existingValue: null,
    candidateValue: validationResult.validatedTitle || null,
    evidence: 'Phase E validator safety finding.',
    relatedSystemRuleIds: [item.systemRuleId].filter(Boolean),
    relatedConfigIds: item.relatedConfigIds || [],
    flagReason: sanitizeSuggestedReason(ruleResolution, item.suggestedFlagReason) || degradeReason,
    message: item.message || 'Phase E validator reported a safety issue.'
  }));
}

function notesFromChecks(checks = []) {
  return checks
    .filter(item => item.status === 'FAIL' || item.status === 'BLOCK' || item.status === 'WARN')
    .map(item => item.message)
    .filter(Boolean)
    .join(' ');
}

function isPublishableTitle(title) {
  return Boolean(normalizeText(title)) && normalizeText(title).length <= 80;
}

function baseResult({ sourceResolution, validationResult }) {
  const candidateTitle = normalizeText(validationResult?.validatedTitle);
  const existing = existingTitle(sourceResolution);
  return {
    contractVersion: 1,
    runtimeMode: 'authoritative',
    decision: DECISIONS.BLOCKED,
    finalTitle: null,
    candidateTitle,
    existingTitle: existing || null,
    candidateAccepted: false,
    retainedExisting: false,
    reviewRequired: true,
    reviewStatus: REVIEW_STATUS.BLOCKED,
    reviewReason: null,
    reviewNotes: '',
    degradationChecks: [],
    reasons: [],
    warnings: [],
    metadata: {
      existingTitlePresent: Boolean(existing),
      candidateTitlePresent: Boolean(candidateTitle),
      existingTitlePublishable: isPublishableTitle(existing),
      phaseEOutcome: validationResult?.outcome || null
    }
  };
}

function finish(result, decision, reasons = []) {
  result.decision = decision;
  result.candidateAccepted = decision === DECISIONS.ACCEPT_CANDIDATE || decision === DECISIONS.NEEDS_REVIEW;
  result.retainedExisting = decision === DECISIONS.RETAIN_EXISTING || decision === DECISIONS.BYPASSED_MANUAL_OVERRIDE;
  result.reviewRequired = decision !== DECISIONS.ACCEPT_CANDIDATE;
  result.reviewStatus =
    decision === DECISIONS.ACCEPT_CANDIDATE ? REVIEW_STATUS.NOT_REQUIRED :
      decision === DECISIONS.BYPASSED_MANUAL_OVERRIDE ? REVIEW_STATUS.MANUAL_OVERRIDE_BYPASS :
        decision === DECISIONS.BLOCKED ? REVIEW_STATUS.BLOCKED :
          REVIEW_STATUS.NEEDS_REVIEW;
  result.reasons = reasons;
  const primary = primaryReason(reasons);
  result.reviewReason = primary?.reason || null;
  result.reviewNotes = notesFromChecks(result.degradationChecks);
  return result;
}

function decideTitleOptimizationRuntimeResult({ sourceResolution = {}, ruleResolution = {}, promptArtifact = {}, validationResult = {} } = {}) {
  sourceResolution = vehicleSourceResolution(sourceResolution, validationResult.vehicleVerification);
  const result = baseResult({ sourceResolution, validationResult });
  const reasons = [];
  const existing = result.existingTitle;
  const candidate = result.candidateTitle;

  if (manualOverrideActive(sourceResolution, promptArtifact, validationResult)) {
    result.finalTitle = manualOverrideTitle(sourceResolution) || existing || candidate || null;
    result.degradationChecks.push(degradationCheck({
      checkId: 'manual-override-bypass',
      status: 'BYPASSED',
      severity: 'info',
      message: 'Manual override is active; generated candidate is not selected.'
    }));
    const bypassResult = finish(result, DECISIONS.BYPASSED_MANUAL_OVERRIDE, reasons);
    bypassResult.reviewReason = 'manual_override';
    bypassResult.reviewNotes = manualOverrideReviewNote(sourceResolution);
    return bypassResult;
  }

  const phaseEOutcome = validationResult.outcome || (validationResult.valid === false ? 'BLOCK' : 'PASS');
  const phaseEChecks = validationChecks(validationResult, ruleResolution);
  result.degradationChecks.push(...phaseEChecks);
  for (const reason of validationFailureReasons(ruleResolution, validationResult)) addReason(reasons, reason);

  if (!candidate) {
    result.degradationChecks.push(degradationCheck({
      checkId: 'missing-candidate',
      status: existing ? 'FAIL' : 'BLOCK',
      severity: 'error',
      message: existing ? 'Validated candidate title is missing; retaining existing title.' : 'Neither candidate nor existing title is available.'
    }));
    if (existing) {
      result.finalTitle = existing;
      addReason(reasons, approvedReason(ruleResolution, 'Proposed title would degrade existing title'));
      return finish(result, DECISIONS.RETAIN_EXISTING, reasons);
    }
    result.finalTitle = null;
    return finish(result, DECISIONS.BLOCKED, reasons);
  }

  if (phaseEOutcome === 'BLOCK') {
    if (existing) {
      result.finalTitle = existing;
      return finish(result, DECISIONS.RETAIN_EXISTING, reasons);
    }
    result.finalTitle = null;
    return finish(result, DECISIONS.BLOCKED, reasons);
  }

  if (phaseEOutcome === 'RETAIN_EXISTING_REQUIRED' || validationResult.safeToContinue === false) {
    if (existing) {
      result.finalTitle = existing;
      return finish(result, DECISIONS.RETAIN_EXISTING, reasons);
    }
    result.finalTitle = null;
    return finish(result, DECISIONS.BLOCKED, reasons);
  }

  const semanticSafety = validationResult.semanticSafety || {};
  if (semanticSafety.supplied && semanticSafety.safeToPublish === false) {
    result.degradationChecks.push(degradationCheck({
      checkId: 'ai-semantic-safety',
      status: 'FAIL',
      severity: 'error',
      candidateValue: candidate,
      evidence: semanticSafety.concerns || [],
      message: semanticSafety.reason || 'AI semantic safety review found a material title risk.'
    }));
    result.finalTitle = candidate;
    return finish(result, DECISIONS.NEEDS_REVIEW, reasons);
  }

  const aiOwnsSemantics = semanticSafety.supplied && semanticSafety.safeToPublish === true;
  const comparisonChecks = existing && !aiOwnsSemantics
    ? criticalLossChecks({ sourceResolution, ruleResolution, candidateTitle: candidate, existing })
    : [];
  result.degradationChecks.push(...comparisonChecks);
  if (comparisonChecks.some(item => item.status === 'FAIL')) {
    addReason(reasons, approvedReason(ruleResolution, 'Proposed title would degrade existing title'));
    result.finalTitle = existing;
    return finish(result, DECISIONS.RETAIN_EXISTING, reasons);
  }

  const conflictChecks = aiOwnsSemantics ? [] : materialConflictChecks(sourceResolution, ruleResolution);
  result.degradationChecks.push(...conflictChecks);
  if (conflictChecks.length) addReason(reasons, approvedReason(ruleResolution, 'Conflicting source data'));

  if (phaseEOutcome === 'FLAG') {
    for (const reason of (validationResult.suggestedReviewReasons || [])) addReason(reasons, sanitizeSuggestedReason(ruleResolution, reason));
    result.finalTitle = candidate;
    return finish(result, DECISIONS.NEEDS_REVIEW, reasons);
  }

  if (conflictChecks.length) {
    result.finalTitle = candidate;
    return finish(result, DECISIONS.NEEDS_REVIEW, reasons);
  }

  if (
    !aiOwnsSemantics && sourceResolution?.resolved?.modelAmbiguity?.ambiguous &&
    !modelAmbiguityResolvedByCandidate(sourceResolution, candidate)
  ) {
    const modelReason = approvedReason(ruleResolution, 'Model cannot be normalized safely');
    addReason(reasons, modelReason);
    result.degradationChecks.push(degradationCheck({
      checkId: 'model-ambiguity',
      status: 'WARN',
      severity: 'warning',
      field: 'model',
      candidateValue: candidate,
      evidence: sourceResolution.resolved.modelAmbiguity.candidates,
      flagReason: modelReason,
      message: 'Model evidence remains ambiguous; candidate requires review.'
    }));
    result.finalTitle = candidate;
    return finish(result, DECISIONS.NEEDS_REVIEW, reasons);
  }

  result.finalTitle = candidate;
  return finish(result, DECISIONS.ACCEPT_CANDIDATE, reasons);
}

module.exports = {
  DECISIONS,
  REVIEW_STATUS,
  REVIEW_REASON_PRECEDENCE,
  decideTitleOptimizationRuntimeResult
};
