class RuntimeRuleResolutionError extends Error {
  constructor(section, message, details = {}) {
    super(message);
    this.name = 'RuntimeRuleResolutionError';
    this.section = section;
    this.details = details;
  }
}

const REQUIRED_SECTIONS = Object.freeze([
  'terminologyRules',
  'prefixRules',
  'restrictedTerms',
  'categoryRules',
  'titleStructures',
  'flagReasons',
  'systemRules'
]);

function normalizeText(value) {
  if (Array.isArray(value)) return normalizeText(value[0]);
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/\s+/g, ' ');
}

function normalizeKey(value) {
  return normalizeText(value).toLocaleLowerCase('en-US');
}

function section(snapshot = {}, name) {
  return snapshot?.sections?.[name] || null;
}

function assertSection(snapshot = {}, name, { optional = false } = {}) {
  const blocking = Array.isArray(snapshot.blockingSections) ? snapshot.blockingSections : [];
  const state = section(snapshot, name);
  if (!state || state.available === false || (!optional && snapshot.runtimeReady === false && blocking.includes(name))) {
    throw new RuntimeRuleResolutionError(name, `${name} configuration is not available for runtime rule resolution.`, {
      blockingSections: blocking,
      error: state?.error || null
    });
  }
  return state;
}

function enabledItems(snapshot, name, options = {}) {
  const state = assertSection(snapshot, name, options);
  return (Array.isArray(state.items) ? state.items : [])
    .filter(item => item && item.enabled !== false && !item.deletedAt);
}

function optionalEnabledItems(snapshot, name) {
  const state = section(snapshot, name);
  if (!state || state.available === false) return [];
  return (Array.isArray(state.items) ? state.items : [])
    .filter(item => item && item.enabled !== false && !item.deletedAt);
}

function resolvedField(listingResolution = {}, field) {
  const item = listingResolution?.resolved?.fields?.[field];
  return normalizeText(item?.resolvedValue);
}

function normalizedField(listingResolution = {}, field) {
  return normalizeText(listingResolution?.normalized?.fields?.[field]?.value);
}

function structuredValue(listingResolution = {}, key) {
  const itemSpecifics = listingResolution?.normalized?.structured?.itemSpecifics?.value || {};
  if (!itemSpecifics || typeof itemSpecifics !== 'object') return '';
  const target = normalizeKey(key);
  const match = Object.entries(itemSpecifics).find(([name]) => normalizeKey(name) === target);
  return normalizeText(match?.[1]);
}

function contextText(context = {}) {
  return [
    context.categoryPart,
    context.part,
    context.conditionsOptions,
    context.itemSpecificPart,
    context.series,
    context.make
  ].map(normalizeText).filter(Boolean).join(' ');
}

function titleEvidenceText(listingResolution = {}) {
  return normalizeText(listingResolution?.normalized?.titleAuthority?.partFitment?.value);
}

function resolveDeterministicTitlePart(prefixRule, listingResolution) {
  const evidence = titleEvidenceText(listingResolution);
  const prefix = prefixRule?.rule;
  if (prefix?.specialTrigger && prefix.specialReplacement && includesWord(evidence, prefix.specialTrigger)) {
    return {
      value: normalizeText(prefix.specialReplacement).replace(/\s*\/\s*/g, ' '),
      source: 'prefixRule.specialReplacement',
      ruleId: prefix.id,
      trigger: prefix.specialTrigger
    };
  }
  const approvedPart = (prefix?.approvedPartTerms || []).find(term => includesWord(evidence, term));
  if (approvedPart) return { value: normalizeText(approvedPart), source: 'prefixRule.approvedPartTerm', ruleId: prefix.id };
  return null;
}

function includesWord(text, word) {
  const source = normalizeKey(text);
  const target = normalizeKey(word);
  return Boolean(source && target && source.includes(target));
}

function isEngineContext(context) {
  return /\bengine|engines\b/i.test(contextText(context));
}

function isTransmissionContext(context) {
  return /\btransmission|transmissions\b/i.test(contextText(context));
}

function buildListingContext(listingResolution = {}) {
  const normalized = listingResolution.normalized || {};
  const categoryPart = resolvedField(listingResolution, 'part') || normalizedField(listingResolution, 'categoryPart');
  return {
    recordId: normalized.recordId || null,
    ipn: normalizedField(listingResolution, 'ipn'),
    ipnPrefix: normalizedField(listingResolution, 'ipnPrefix'),
    sku: resolvedField(listingResolution, 'sku') || normalizedField(listingResolution, 'sku'),
    make: resolvedField(listingResolution, 'brandMake') || normalizedField(listingResolution, 'brandMake'),
    categoryPart,
    part: categoryPart,
    itemSpecificPart: structuredValue(listingResolution, 'C:Part') || structuredValue(listingResolution, 'Part'),
    series: structuredValue(listingResolution, 'Series'),
    conditionsOptions: normalizedField(listingResolution, 'conditionsOptions')
  };
}

function terminologyApplies(rule, context) {
  if (!rule) return false;
  if (rule.appliesTo === 'transmission' || rule.condition === 'transmission-context') return isTransmissionContext(context);
  if (rule.condition === 'context-verified') return includesWord(contextText(context), rule.sourceTerm);
  return true;
}

function selectTerminologyRules(snapshot, context) {
  return enabledItems(snapshot, 'terminologyRules').filter(rule => terminologyApplies(rule, context));
}

function selectSynonyms(snapshot, context) {
  const state = section(snapshot, 'synonyms');
  if (!state || state.available === false || state.enabled === false) return [];
  return optionalEnabledItems(snapshot, 'synonyms').filter(rule => {
    if (rule.appliesTo === 'all' || !rule.appliesTo) return true;
    return includesWord(contextText(context), rule.appliesTo);
  });
}

function selectPrefixRule(snapshot, context, systemRules) {
  const prefix = normalizeText(context.ipnPrefix);
  if (!prefix) return null;
  const rule = enabledItems(snapshot, 'prefixRules').find(item => normalizeText(item.prefix) === prefix);
  if (!rule) return null;
  const systemRule = prefix === '257' ? systemRules.find(item => item.id === 'SR-06') || null : null;
  return {
    normalizedPrefix: prefix,
    matchType: 'exact',
    rule,
    systemRule
  };
}

function restrictedScopeApplies(rule, context) {
  if (rule.scope === 'all' || !rule.scope) return true;
  if (rule.scope === 'engine') return isEngineContext(context);
  return includesWord(contextText(context), rule.scope);
}

function selectRestrictedTerms(snapshot, context) {
  const groups = {};
  for (const rule of enabledItems(snapshot, 'restrictedTerms')) {
    if (!restrictedScopeApplies(rule, context)) continue;
    const key = rule.ruleType || 'other';
    if (!groups[key]) groups[key] = [];
    groups[key].push(rule);
  }
  return {
    rules: Object.values(groups).flat(),
    groups
  };
}

function exactListMatch(values = [], expected = '') {
  const target = normalizeKey(expected);
  return (Array.isArray(values) ? values : []).some(value => normalizeKey(value) === target);
}

function categoryRuleMatch(rule, context) {
  const matchedBy = [];
  if (normalizeKey(rule.categoryName) && (
    normalizeKey(rule.categoryName) === normalizeKey(context.categoryPart) ||
    normalizeKey(rule.categoryName) === normalizeKey(context.itemSpecificPart)
  )) {
    matchedBy.push('category');
  }
  if (context.ipnPrefix && exactListMatch(rule.prefixRefs, context.ipnPrefix)) matchedBy.push('prefixRef');
  if (context.series && exactListMatch(rule.seriesRefs, context.series)) matchedBy.push('seriesRef');
  return matchedBy;
}

function selectCategoryRules(snapshot, context) {
  return enabledItems(snapshot, 'categoryRules')
    .map(rule => ({ rule, matchedBy: categoryRuleMatch(rule, context) }))
    .filter(entry => entry.matchedBy.length > 0);
}

function structureMatches(structure, context) {
  const applies = normalizeKey(structure.appliesTo || structure.structureName);
  if (!applies) return false;
  if (applies.includes('general')) return false;
  if (applies.includes('engine')) return isEngineContext(context);
  if (applies.includes('transmission')) return isTransmissionContext(context);
  return normalizeKey(context.categoryPart) === applies || normalizeKey(context.itemSpecificPart) === applies;
}

function selectTitleStructure(snapshot, context) {
  const structures = enabledItems(snapshot, 'titleStructures');
  const custom = structures.find(item => item.origin === 'custom' && structureMatches(item, context));
  if (custom) {
    return { selected: custom, reason: 'custom-applies-to', evidence: ['appliesTo'], fallback: false };
  }
  const seeded = structures.find(item => item.origin === 'client-v5' && structureMatches(item, context));
  if (seeded) {
    return { selected: seeded, reason: normalizeKey(seeded.structureName).includes('engine') ? 'verified-engine-context' : normalizeKey(seeded.structureName).includes('transmission') ? 'verified-transmission-context' : 'verified-context', evidence: ['appliesTo'], fallback: false };
  }
  const general = structures.find(item => normalizeKey(item.structureName) === 'general' || normalizeKey(item.appliesTo).includes('general'));
  if (!general) {
    throw new RuntimeRuleResolutionError('titleStructures', 'No valid General title structure is available for safe fallback.');
  }
  return { selected: general, reason: 'general-fallback', evidence: [], fallback: true };
}

function selectFlagReasons(snapshot) {
  return enabledItems(snapshot, 'flagReasons');
}

function selectSystemRules(snapshot) {
  return enabledItems(snapshot, 'systemRules');
}

function assertRequiredSections(snapshot) {
  const blocking = new Set(Array.isArray(snapshot.blockingSections) ? snapshot.blockingSections : []);
  for (const name of REQUIRED_SECTIONS) {
    const state = section(snapshot, name);
    if (!state || state.available === false || blocking.has(name)) {
      throw new RuntimeRuleResolutionError(name, `${name} configuration is blocking applicable rule resolution.`);
    }
  }
}

function resolveApplicableTitleOptimizationRules({ runtimeSnapshot, listingResolution } = {}) {
  assertRequiredSections(runtimeSnapshot);
  const context = buildListingContext(listingResolution);
  const warnings = [];
  const unresolved = [];
  const systemRules = selectSystemRules(runtimeSnapshot);
  const prefixRule = selectPrefixRule(runtimeSnapshot, context, systemRules);
  if (context.ipnPrefix && !prefixRule) {
    warnings.push({
      code: 'NO_PREFIX_RULE',
      severity: 'info',
      message: `No matching Prefix Rule for IPN prefix ${context.ipnPrefix}.`
    });
  }
  const categoryRules = selectCategoryRules(runtimeSnapshot, context);
  if (categoryRules.length > 1) {
    warnings.push({
      code: 'MULTIPLE_CATEGORY_RULES',
      severity: 'info',
      message: 'Multiple category rules matched; all matches are preserved.'
    });
  }
  const titleStructure = selectTitleStructure(runtimeSnapshot, context);
  const deterministicTitlePart = resolveDeterministicTitlePart(prefixRule, listingResolution);

  return {
    contractVersion: 1,
    runtimeMode: 'authoritative',
    runtimeReady: true,
    listingContext: context,
    terminologyRules: selectTerminologyRules(runtimeSnapshot, context),
    synonyms: selectSynonyms(runtimeSnapshot, context),
    prefixRule,
    restrictedTerms: selectRestrictedTerms(runtimeSnapshot, context),
    categoryRules,
    deterministicTitlePart,
    titleStructure,
    flagReasons: selectFlagReasons(runtimeSnapshot),
    systemRules,
    warnings,
    unresolved
  };
}

module.exports = {
  RuntimeRuleResolutionError,
  resolveApplicableTitleOptimizationRules
};
