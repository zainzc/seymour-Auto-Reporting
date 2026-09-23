const VALIDATION_ORDER = Object.freeze([
  'manual-override-bypass',
  'blank-and-basic-formatting',
  'restricted-unsafe-introductions',
  'source-identity-unsupported-information',
  'critical-fitment-preservation',
  'side-validation',
  'mpn-validation',
  'protected-term-preservation',
  'terminology-noise-cleanup',
  'ac-formatting',
  'duplicate-wording',
  'sku-normalization',
  'hash-sku-handling',
  'title-structure-check',
  'length-80-enforcement',
  'final-invariant-recheck'
]);

function normalizeText(value) {
  if (Array.isArray(value)) return normalizeText(value[0]);
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/\s+/g, ' ');
}

function normalizeKey(value) {
  return normalizeText(value).toLocaleLowerCase('en-US');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termRegex(term) {
  return new RegExp(`(^|[^A-Za-z0-9#])(${escapeRegExp(term)})(?=$|[^A-Za-z0-9])`, 'gi');
}

function includesTerm(text, term) {
  return termRegex(term).test(text);
}

function resolvedValue(sourceResolution = {}, key) {
  return normalizeText(sourceResolution?.resolved?.fields?.[key]?.resolvedValue);
}

function normalizedValue(sourceResolution = {}, key) {
  return normalizeText(sourceResolution?.normalized?.fields?.[key]?.value);
}

function structuredValue(sourceResolution = {}, key) {
  const values = sourceResolution?.normalized?.structured?.itemSpecifics?.value || {};
  const target = normalizeKey(key);
  const match = Object.entries(values).find(([name]) => normalizeKey(name) === target);
  return normalizeText(match?.[1]);
}

function allRestrictedRules(ruleResolution = {}) {
  const groups = ruleResolution?.restrictedTerms?.groups || {};
  return Object.values(groups).flat().filter(Boolean);
}

function restrictedByType(ruleResolution, type) {
  return allRestrictedRules(ruleResolution).filter(rule => normalizeKey(rule.ruleType) === normalizeKey(type));
}

function systemRuleId(ruleResolution, id) {
  return (ruleResolution?.systemRules || []).some(rule => rule.id === id) ? id : null;
}

function checkRecord({ checkId, systemRuleId: sr = null, status = 'PASS', severity = 'info', message, corrected = false, before = null, after = null, relatedConfigIds = [], suggestedFlagReason = null }) {
  return { checkId, systemRuleId: sr, status, severity, message, corrected, before, after, relatedConfigIds, suggestedFlagReason };
}

function approvedFlag(ruleResolution = {}, wanted) {
  const target = normalizeKey(wanted);
  const found = (ruleResolution.flagReasons || []).find(reason => reason?.enabled !== false && normalizeKey(reason.reason) === target);
  return found ? { id: found.id, reason: found.reason } : null;
}

function uniquePush(array, item) {
  if (!item) return;
  if (!array.some(existing => existing.id === item.id && existing.reason === item.reason)) array.push(item);
}

function replaceWithSpaces(title, regex) {
  return title.replace(regex, ' ').replace(/\s+/g, ' ').trim();
}

function removeTerm(title, term) {
  return replaceWithSpaces(title, termRegex(term));
}

function hasVerifiedAuthorization(sourceResolution, term) {
  const target = normalizeKey(term);
  const fields = sourceResolution?.resolved?.fields || {};
  return Object.entries(fields).some(([key, item]) => {
    if (!/authoriz|condition|option|descriptor|term/i.test(key)) return false;
    return normalizeKey(item?.resolvedValue).includes(target);
  });
}

function candidateHasDifferentIdentity(title, verified) {
  const lower = normalizeKey(title);
  const target = normalizeKey(verified);
  if (!target || lower.includes(target)) return false;
  const identityTokens = ['honda', 'toyota', 'ford', 'chevrolet', 'chevy', 'nissan', 'bmw', 'audi', 'accord', 'camry', 'civic'];
  const present = identityTokens.filter(token => lower.includes(token));
  return present.length > 0;
}

function skuPattern(sku) {
  return new RegExp(`(^|\\s)#?${escapeRegExp(sku)}(?=$|\\s)`, 'g');
}

function countSku(title, sku) {
  if (!sku) return 0;
  return (title.match(skuPattern(sku)) || []).length;
}

function removeSku(title, sku) {
  if (!sku) return title;
  return title.replace(skuPattern(sku), ' ').replace(/\s+/g, ' ').trim();
}

function skuSuffix(ruleResolution, sku) {
  const prefix = normalizeText(ruleResolution?.listingContext?.ipnPrefix || ruleResolution?.prefixRule?.normalizedPrefix);
  return prefix === '257' ? `#${sku}` : sku;
}

function wordTokens(value) {
  return normalizeText(value).split(/\s+/).filter(Boolean);
}

function titleContainsValue(title, value) {
  const text = normalizeKey(title);
  const wanted = normalizeKey(value);
  return Boolean(wanted && text.includes(wanted));
}

function detectUnsupportedSide(title, verifiedSide) {
  const sideTerms = ['driver', 'passenger', 'left', 'right', 'lh', 'rh'];
  const lower = normalizeKey(title);
  const present = sideTerms.filter(term => new RegExp(`\\b${term}\\b`, 'i').test(lower));
  if (!present.length) return null;
  const verified = normalizeKey(verifiedSide);
  if (!verified) return present[0];
  return present.find(term => !verified.includes(term) && !(term === 'driver' && verified.includes('left')) && !(term === 'passenger' && verified.includes('right'))) || null;
}

function detectMpnTokens(title, sourceResolution) {
  const verified = resolvedValue(sourceResolution, 'manufacturerPartNumber');
  const matches = [];
  for (const match of title.matchAll(/\b(?:MPN[-\s]?[A-Z0-9-]+|\d{3}-\d{5}[A-Z]?)\b/gi)) {
    const token = normalizeText(match[0]);
    if (!verified || normalizeKey(token) !== normalizeKey(verified)) matches.push(token);
  }
  return matches;
}

function cleanupDuplicateWords(title) {
  const tokens = wordTokens(title);
  const out = [];
  let changed = false;
  for (const token of tokens) {
    const previous = out[out.length - 1];
    if (previous && normalizeKey(previous) === normalizeKey(token)) {
      changed = true;
      continue;
    }
    out.push(token);
  }
  let cleaned = out.join(' ');
  for (const phrase of ['Side View Mirror']) {
    const repeated = new RegExp(`(${escapeRegExp(phrase)})(\\s+${escapeRegExp(phrase)})+`, 'gi');
    const next = cleaned.replace(repeated, phrase);
    if (next !== cleaned) changed = true;
    cleaned = next;
  }
  return { title: cleaned, changed };
}

function detectUnknownPremium(title, sourceResolution) {
  const known = [
    resolvedValue(sourceResolution, 'year'),
    resolvedValue(sourceResolution, 'brandMake'),
    resolvedValue(sourceResolution, 'model'),
    resolvedValue(sourceResolution, 'part'),
    resolvedValue(sourceResolution, 'side'),
    resolvedValue(sourceResolution, 'manufacturerPartNumber'),
    resolvedValue(sourceResolution, 'engineCode'),
    resolvedValue(sourceResolution, 'transmissionCode'),
    resolvedValue(sourceResolution, 'vin'),
    resolvedValue(sourceResolution, 'sku'),
    'ABS',
    'AC',
    'A/C'
  ].filter(Boolean).flatMap(wordTokens).map(normalizeKey);
  const knownSet = new Set(known);
  const unknown = wordTokens(title).filter(token => {
    const key = normalizeKey(token.replace(/^#/, ''));
    if (!key || knownSet.has(key)) return false;
    if (/^\d+$/.test(key)) return false;
    return ['premium'].includes(key);
  });
  return unknown;
}

function appendCheck(target, record, { corrections, violations, warnings }) {
  target.checks.push(record);
  if (record.corrected) corrections.push(record);
  if (record.status === 'FAIL' || record.status === 'BLOCK' || record.status === 'RETAIN_EXISTING_REQUIRED') violations.push(record);
  if (record.status === 'WARN' || record.status === 'CANNOT_VERIFY') warnings.push(record);
}

function validateTitleOptimizationRuntimeCandidate({ sourceResolution = {}, ruleResolution = {}, promptArtifact = {}, candidateTitle = '' } = {}) {
  const originalCandidate = candidateTitle === null || candidateTitle === undefined ? '' : String(candidateTitle);
  const checks = [];
  const corrections = [];
  const violations = [];
  const warnings = [];
  const suggestedReviewReasons = [];
  let title = originalCandidate;

  const resultBase = () => ({
    contractVersion: 1,
    runtimeMode: 'shadow-only',
    validationOrder: [...VALIDATION_ORDER],
    originalCandidate,
    validatedTitle: title,
    valid: true,
    safeToContinue: true,
    changed: title !== originalCandidate,
    outcome: 'PASS',
    checks,
    corrections,
    violations,
    warnings,
    suggestedReviewReasons
  });

  if (promptArtifact?.kind === 'title-generation-bypass' || sourceResolution?.normalized?.manualOverride?.active) {
    const out = resultBase();
    out.outcome = 'BYPASSED';
    out.checks.push(checkRecord({
      checkId: 'manual-override-bypass',
      status: 'BYPASSED',
      message: 'Manual override is active; generated title validation is bypassed.'
    }));
    return out;
  }

  const append = (record) => appendCheck({ checks }, record, { corrections, violations, warnings });

  const beforeFormat = title;
  title = normalizeText(title);
  if (title !== beforeFormat) {
    append(checkRecord({
      checkId: 'basic-formatting',
      status: 'CLEANUP',
      message: 'Trimmed outer whitespace and collapsed repeated spaces.',
      corrected: true,
      before: beforeFormat,
      after: title
    }));
  }
  if (!title) {
    append(checkRecord({
      checkId: 'blank-title',
      status: 'BLOCK',
      severity: 'error',
      message: 'Candidate title is blank after formatting cleanup.'
    }));
    const out = resultBase();
    out.valid = false;
    out.safeToContinue = false;
    out.outcome = 'BLOCK';
    return out;
  }

  for (const rule of restrictedByType(ruleResolution, 'never-introduce')) {
    if (!includesTerm(title, rule.term)) continue;
    append(checkRecord({
      checkId: /long block|short block/i.test(rule.term) ? 'long-short-block-protection' : 'restricted-never-introduce',
      systemRuleId: systemRuleId(ruleResolution, 'SR-01'),
      status: 'RETAIN_EXISTING_REQUIRED',
      severity: 'error',
      message: `${rule.term} cannot be introduced without approved verified support.`,
      relatedConfigIds: [rule.id]
    }));
  }

  for (const field of ['brandMake', 'model', 'year']) {
    const value = resolvedValue(sourceResolution, field);
    if (candidateHasDifferentIdentity(title, value)) {
      append(checkRecord({
        checkId: 'unsupported-information',
        systemRuleId: systemRuleId(ruleResolution, 'SR-01'),
        status: 'FAIL',
        severity: 'error',
        message: `Candidate appears to change verified ${field}.`,
        relatedConfigIds: []
      }));
    }
  }

  for (const field of ['engineCode', 'transmissionCode', 'vin']) {
    const value = resolvedValue(sourceResolution, field) || structuredValue(sourceResolution, field);
    if (value && !titleContainsValue(title, value)) {
      const flag = approvedFlag(ruleResolution, 'Proposed title would degrade existing title');
      uniquePush(suggestedReviewReasons, flag);
      append(checkRecord({
        checkId: 'critical-fitment-preservation',
        systemRuleId: systemRuleId(ruleResolution, 'SR-14'),
        status: 'RETAIN_EXISTING_REQUIRED',
        severity: 'error',
        message: `Candidate loses verified critical ${field}.`,
        suggestedFlagReason: flag,
        relatedConfigIds: (ruleResolution.categoryRules || []).map(entry => entry.rule?.id).filter(Boolean)
      }));
    }
  }

  const badSide = detectUnsupportedSide(title, resolvedValue(sourceResolution, 'side'));
  if (badSide) {
    append(checkRecord({
      checkId: 'side-validation',
      systemRuleId: systemRuleId(ruleResolution, 'SR-11'),
      status: 'RETAIN_EXISTING_REQUIRED',
      severity: 'error',
      message: `Candidate uses unsupported side '${badSide}'. Description-only fitment cannot authorize side.`,
      relatedConfigIds: []
    }));
  }

  const badMpn = detectMpnTokens(title, sourceResolution);
  if (badMpn.length) {
    append(checkRecord({
      checkId: 'mpn-validation',
      systemRuleId: systemRuleId(ruleResolution, 'SR-04'),
      status: 'RETAIN_EXISTING_REQUIRED',
      severity: 'error',
      message: `Candidate contains unsupported MPN/interchange-like value: ${badMpn.join(', ')}.`,
      relatedConfigIds: []
    }));
  }

  for (const rule of restrictedByType(ruleResolution, 'must-preserve')) {
    const verifiedInExisting = titleContainsValue(resolvedValue(sourceResolution, 'title') || normalizedValue(sourceResolution, 'existingTitle'), rule.term);
    if (verifiedInExisting && !includesTerm(title, rule.term)) {
      append(checkRecord({
        checkId: 'protected-term-preservation',
        systemRuleId: systemRuleId(ruleResolution, 'SR-03') || systemRuleId(ruleResolution, 'SR-14'),
        status: 'RETAIN_EXISTING_REQUIRED',
        severity: 'error',
        message: `Candidate omits protected verified term ${rule.term}.`,
        relatedConfigIds: [rule.id]
      }));
    }
  }

  for (const rule of restrictedByType(ruleResolution, 'requires-authorization')) {
    if (!includesTerm(title, rule.term)) continue;
    if (hasVerifiedAuthorization(sourceResolution, rule.term)) continue;
    append(checkRecord({
      checkId: 'restricted-requires-authorization',
      status: 'RETAIN_EXISTING_REQUIRED',
      severity: 'error',
      message: `${rule.term} requires separate verified authorization.`,
      relatedConfigIds: [rule.id]
    }));
  }

  for (const rule of restrictedByType(ruleResolution, 'remove-noise')) {
    if (!includesTerm(title, rule.term)) continue;
    const before = title;
    title = removeTerm(title, rule.term);
    append(checkRecord({
      checkId: 'remove-noise',
      status: 'CLEANUP',
      message: `Removed configured noise term ${rule.term}.`,
      corrected: true,
      before,
      after: title,
      relatedConfigIds: [rule.id]
    }));
  }

  if (/\bA\/C\b/i.test(title)) {
    const before = title;
    title = title.replace(/\bA\/C\b/gi, 'AC').replace(/\s+/g, ' ').trim();
    append(checkRecord({
      checkId: 'ac-formatting',
      systemRuleId: systemRuleId(ruleResolution, 'SR-09'),
      status: 'CLEANUP',
      message: 'Normalized Air Conditioning abbreviation from A/C to AC.',
      corrected: true,
      before,
      after: title
    }));
  }

  const duplicate = cleanupDuplicateWords(title);
  if (duplicate.changed) {
    const before = title;
    title = duplicate.title;
    append(checkRecord({
      checkId: 'duplicate-wording',
      status: 'CLEANUP',
      message: 'Removed conservative duplicate wording.',
      corrected: true,
      before,
      after: title
    }));
  }

  const sku = resolvedValue(sourceResolution, 'sku') || normalizedValue(sourceResolution, 'sku') || ruleResolution?.listingContext?.sku || '';
  if (sku) {
    const before = title;
    title = removeSku(title, sku);
    title = `${title} ${skuSuffix(ruleResolution, sku)}`.replace(/\s+/g, ' ').trim();
    if (title !== before || countSku(before, sku) !== 1 || !normalizeKey(before).endsWith(normalizeKey(sku))) {
      append(checkRecord({
        checkId: 'sku-exactly-once',
        systemRuleId: systemRuleId(ruleResolution, 'SR-05'),
        status: 'CLEANUP',
        message: 'Normalized verified SKU to appear exactly once at the end.',
        corrected: true,
        before,
        after: title
      }));
    }
    if (ruleResolution?.listingContext?.ipnPrefix === '257' || ruleResolution?.prefixRule?.normalizedPrefix === '257') {
      const beforeHash = before;
      append(checkRecord({
        checkId: 'hash-sku-257',
        systemRuleId: systemRuleId(ruleResolution, 'SR-06'),
        status: 'CLEANUP',
        message: 'Applied Prefix 257 #SKU exception for mileage-sensitive cluster/speedometer context.',
        corrected: title.endsWith(`#${sku}`) && !beforeHash.endsWith(`#${sku}`),
        before: beforeHash,
        after: title,
        relatedConfigIds: [ruleResolution?.prefixRule?.rule?.id].filter(Boolean)
      }));
    }
  } else {
    append(checkRecord({
      checkId: 'sku-missing-source',
      systemRuleId: systemRuleId(ruleResolution, 'SR-05'),
      status: 'WARN',
      severity: 'warning',
      message: 'Verified SKU source is missing; validator cannot invent SKU.'
    }));
  }

  const unknown = detectUnknownPremium(title, sourceResolution);
  if (unknown.length) {
    append(checkRecord({
      checkId: 'unsupported-information',
      status: 'CANNOT_VERIFY',
      severity: 'warning',
      message: `Candidate contains information that cannot be deterministically verified: ${unknown.join(', ')}.`
    }));
  }

  const segments = ruleResolution?.titleStructure?.selected?.segments || [];
  let previousIndex = -1;
  let mismatch = false;
  for (const segment of segments) {
    if (segment.kind !== 'field') continue;
    const value = resolvedValue(sourceResolution, segment.key);
    if (!value) continue;
    const index = normalizeKey(title).indexOf(normalizeKey(value));
    if (index >= 0 && previousIndex > index) mismatch = true;
    if (index >= 0) previousIndex = index;
  }
  if (mismatch) {
    append(checkRecord({
      checkId: 'title-structure',
      status: 'WARN',
      severity: 'warning',
      message: 'Candidate has an obvious ordering mismatch against the selected title structure; no destructive rewrite was applied.',
      relatedConfigIds: [ruleResolution?.titleStructure?.selected?.id].filter(Boolean)
    }));
  }

  if (title.length > 80) {
    const before = title;
    for (const value of [resolvedValue(sourceResolution, 'manufacturerPartNumber')]) {
      if (title.length <= 80) break;
      if (value) title = removeTerm(title, value);
    }
    if (sku) {
      title = removeSku(title, sku);
      title = `${title} ${skuSuffix(ruleResolution, sku)}`.replace(/\s+/g, ' ').trim();
    }
    if (title.length <= 80) {
      append(checkRecord({
        checkId: 'length-80',
        systemRuleId: systemRuleId(ruleResolution, 'SR-07'),
        status: 'CLEANUP',
        message: 'Reduced optional content to satisfy the 80-character hard maximum without mid-word truncation.',
        corrected: true,
        before,
        after: title
      }));
    } else {
      const flag = approvedFlag(ruleResolution, 'Cannot preserve essential fitment within 80 characters');
      uniquePush(suggestedReviewReasons, flag);
      append(checkRecord({
        checkId: 'length-80',
        systemRuleId: systemRuleId(ruleResolution, 'SR-07'),
        status: 'RETAIN_EXISTING_REQUIRED',
        severity: 'error',
        message: 'Candidate exceeds 80 characters and cannot be safely reduced without risking verified fitment.',
        before,
        after: title,
        suggestedFlagReason: flag
      }));
    }
  }

  if (sku && (countSku(title, sku) !== 1 || !(normalizeKey(title).endsWith(normalizeKey(sku)) || normalizeKey(title).endsWith(`#${normalizeKey(sku)}`)))) {
    append(checkRecord({
      checkId: 'final-invariant-recheck',
      systemRuleId: systemRuleId(ruleResolution, 'SR-05'),
      status: 'FAIL',
      severity: 'error',
      message: 'Final candidate failed SKU invariant recheck.'
    }));
  }
  if (title.length > 80) {
    append(checkRecord({
      checkId: 'final-invariant-recheck',
      systemRuleId: systemRuleId(ruleResolution, 'SR-07'),
      status: 'FAIL',
      severity: 'error',
      message: 'Final candidate failed 80-character invariant recheck.'
    }));
  }

  const out = resultBase();
  out.validatedTitle = title;
  out.changed = title !== originalCandidate;
  out.valid = violations.length === 0;
  out.safeToContinue = violations.length === 0;
  if (!out.valid) {
    out.outcome = violations.some(item => item.status === 'BLOCK') ? 'BLOCK' : 'RETAIN_EXISTING_REQUIRED';
  } else if (corrections.length) {
    out.outcome = 'CLEANUP';
  } else if (warnings.length) {
    out.outcome = 'FLAG';
  }
  return out;
}

module.exports = {
  VALIDATION_ORDER,
  validateTitleOptimizationRuntimeCandidate
};
