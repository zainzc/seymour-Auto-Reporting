const OUTPUT_KEYS = Object.freeze([
  'generatedTitle',
  'generatedDescription',
  'shortDescription',
  'reasoningSummary',
  'titleReviewStatus',
  'titleReviewReason',
  'titleReviewNotes'
]);

const PROMPT_SECTION_ORDER = Object.freeze([
  'stablePolicy',
  'canonicalSystemRules',
  'outputContract',
  'resolvedListingData',
  'sourceEvidence',
  'selectedTitleStructure',
  'applicableTerminologyRules',
  'applicableSynonyms',
  'applicablePrefixRule',
  'applicableCategoryRules',
  'restrictedTerms',
  'approvedFlagReasons',
  'existingTitleNoDegradeContext',
  'descriptionBoundaryEvidence'
]);

function normalizeText(value) {
  if (Array.isArray(value)) return normalizeText(value[0]);
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/\s+/g, ' ');
}

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'deletedAt', 'deletedBy'].includes(key)) continue;
    out[key] = stripVolatile(value[key]);
  }
  return out;
}

function resolvedField(listingResolution = {}, field) {
  const item = listingResolution?.resolved?.fields?.[field];
  if (!item) return null;
  return {
    value: item.resolvedValue ?? null,
    source: item.resolvedSource || null,
    missing: Boolean(item.missing)
  };
}

function sourceEvidence(listingResolution = {}, field) {
  const item = listingResolution?.resolved?.fields?.[field];
  if (!item) return { candidates: [], conflicts: [] };
  return {
    candidates: (item.candidates || []).map(candidate => ({
      source: candidate.source,
      value: candidate.value,
      priority: candidate.priority
    })),
    conflicts: (item.conflicts || []).map(conflict => ({
      source: conflict.source,
      value: conflict.value,
      priority: conflict.priority
    })),
    deterministicWinner: item.resolvedSource || null,
    aiMayOverrideWinner: false
  };
}

function fieldValue(listingResolution = {}, key) {
  return normalizeText(listingResolution?.normalized?.fields?.[key]?.value);
}

function selectedStructure(applicableRules = {}) {
  const selected = applicableRules?.titleStructure?.selected;
  if (!selected) return null;
  return {
    id: selected.id,
    structureName: selected.structureName,
    appliesTo: selected.appliesTo,
    reason: applicableRules.titleStructure.reason,
    fallback: Boolean(applicableRules.titleStructure.fallback),
    segments: (selected.segments || []).map(segment => ({
      key: segment.key,
      label: segment.label,
      kind: segment.kind,
      omitIfUnavailable: segment.kind === 'field',
      doNotInventMissingValue: segment.kind === 'field'
    }))
  };
}

function terminologyRules(applicableRules = {}) {
  return (applicableRules.terminologyRules || []).map(rule => ({
    id: rule.id,
    sourceTerm: rule.sourceTerm,
    action: rule.action,
    replacementTerm: rule.replacementTerm ?? null,
    condition: rule.condition,
    appliesTo: rule.appliesTo
  }));
}

function synonymPolicy(applicableRules = {}) {
  const synonyms = applicableRules.synonyms || [];
  return {
    enabled: synonyms.length > 0,
    optional: true,
    neverOverrideSafetyOrFitment: true,
    rules: synonyms.map(rule => ({
      id: rule.id,
      primaryTerm: rule.primaryTerm,
      synonyms: [...(rule.synonyms || [])],
      condition: rule.condition,
      appliesTo: rule.appliesTo
    }))
  };
}

function prefixRule(applicableRules = {}) {
  const entry = applicableRules.prefixRule;
  if (!entry?.rule) return null;
  return {
    id: entry.rule.id,
    prefix: entry.rule.prefix,
    approvedPartTerms: [...(entry.rule.approvedPartTerms || [])],
    specialTrigger: entry.rule.specialTrigger || null,
    specialReplacement: entry.rule.specialReplacement || null,
    note: entry.rule.note || null,
    normalizedPrefix: entry.normalizedPrefix,
    matchType: entry.matchType,
    systemRule: entry.systemRule ? stripVolatile(entry.systemRule) : null,
    deterministicSkuRewriteInThisPhase: false
  };
}

function categoryRules(applicableRules = {}) {
  return (applicableRules.categoryRules || []).map(entry => ({
    id: entry.rule.id,
    categoryName: entry.rule.categoryName,
    matchedBy: [...entry.matchedBy],
    priorityDetails: [...(entry.rule.priorityDetails || [])],
    prefixRefs: [...(entry.rule.prefixRefs || [])],
    seriesRefs: [...(entry.rule.seriesRefs || [])],
    note: entry.rule.note || null
  }));
}

function restrictedTerms(applicableRules = {}) {
  const groups = applicableRules?.restrictedTerms?.groups || {};
  const out = {};
  for (const key of Object.keys(groups).sort()) {
    out[key] = groups[key].map(rule => ({
      id: rule.id,
      term: rule.term,
      ruleType: rule.ruleType,
      scope: rule.scope,
      locked: Boolean(rule.locked),
      note: rule.note || null
    }));
  }
  return { groups: out };
}

function flagReasons(applicableRules = {}) {
  return (applicableRules.flagReasons || []).map(reason => ({
    id: reason.id,
    reason: reason.reason,
    required: Boolean(reason.required),
    origin: reason.origin
  }));
}

function systemRules(applicableRules = {}) {
  return (applicableRules.systemRules || []).map(rule => ({
    id: rule.id,
    title: rule.title,
    category: rule.category,
    behavior: rule.behavior || null,
    order: rule.order,
    version: rule.version,
    locked: Boolean(rule.locked)
  }));
}

function stablePolicy() {
  return {
    summary: 'Use only supplied verified evidence and authoritative configuration to propose buyer-readable title JSON.',
    instructions: [
      'Use only supplied verified evidence; never invent unsupported facts.',
      'Accuracy and safety outrank enrichment, wording preferences, and title length targets.',
      'Obey the supplied canonical System Rules and applicable configuration.',
      'Do not use description-only partFitment to determine title year, make, model, side, or part identity.',
      'Use deterministic source winners as authoritative; lower-priority evidence is context only.',
      'Omit unavailable optional field segments instead of inventing values.',
      'A generated candidate must not degrade an already-better existing title; final enforcement happens later.',
      'Return valid JSON only using the supplied output contract.'
    ],
    promptBuilderDoesNotConsumeLegacyGiantPrompt: true
  };
}

function outputContract() {
  return {
    responseFormat: 'valid JSON only',
    requiredJsonKeys: [...OUTPUT_KEYS],
    titleReviewReasonMustUseApprovedVocabularyWhenPossible: true,
    arbitraryReviewReasonsAreNotAuthoritative: true
  };
}

function titleLengthPolicy() {
  return {
    hardMaximumCharacters: 80,
    generationTargetCharacters: 65,
    guidance: '80 characters is the hard maximum. 65 characters is a target only when enough verified useful information exists; shorter than 65 characters is not automatically an error.',
    noMinimumValidator: true
  };
}

function skuGuidance(applicableRules = {}) {
  const sr05 = (applicableRules.systemRules || []).find(rule => rule.id === 'SR-05') || null;
  const sr06 = (applicableRules.systemRules || []).find(rule => rule.id === 'SR-06') || applicableRules.prefixRule?.systemRule || null;
  return {
    summary: 'SKU exactly once at the end; applicable #SKU exception follows canonical SR-06.',
    skuSystemRule: sr05 ? stripVolatile(sr05) : null,
    hashSkuExceptionRule: sr06 ? stripVolatile(sr06) : null,
    deterministicRewriteInThisPhase: false
  };
}

function authoritativeValues(listingResolution = {}) {
  const keys = ['title', 'brandMake', 'part', 'manufacturerPartNumber', 'side', 'year', 'sku'];
  const out = {};
  for (const key of keys) {
    const value = resolvedField(listingResolution, key);
    if (value) out[key] = value;
  }
  return out;
}

function sourceEvidenceMap(listingResolution = {}) {
  const keys = ['title', 'brandMake', 'part', 'manufacturerPartNumber', 'side', 'year', 'sku'];
  const out = {};
  for (const key of keys) out[key] = sourceEvidence(listingResolution, key);
  return out;
}

function descriptionOnly(listingResolution = {}) {
  const partFitment = listingResolution?.normalized?.descriptionOnly?.partFitment || {};
  return {
    partFitment: {
      value: partFitment.value || null,
      boundary: 'DESCRIPTION ONLY',
      titleIdentityAllowed: false,
      forbiddenTitleUses: ['year', 'make', 'model', 'side', 'part identity']
    }
  };
}

function manualOverrideActive(listingResolution = {}) {
  return Boolean(listingResolution?.normalized?.manualOverride?.active);
}

function buildTitleOptimizationRuntimePrompt({ runtimeSnapshot = {}, listingResolution = {}, applicableRules = {} } = {}) {
  const bypass = manualOverrideActive(listingResolution);
  const systems = systemRules(applicableRules);
  const synonyms = synonymPolicy(applicableRules);
  const selected = selectedStructure(applicableRules);
  const prefix = prefixRule(applicableRules);
  const cats = categoryRules(applicableRules);
  const terms = terminologyRules(applicableRules);
  const restricted = restrictedTerms(applicableRules);
  const flags = flagReasons(applicableRules);
  const authoritative = authoritativeValues(listingResolution);
  const evidence = sourceEvidenceMap(listingResolution);
  const descriptionEvidence = descriptionOnly(listingResolution);
  const currentTitle = fieldValue(listingResolution, 'existingTitle') || authoritative.title?.value || null;

  const userPayload = {
    sectionOrder: [...PROMPT_SECTION_ORDER],
    stablePolicy: stablePolicy(),
    titlePolicy: {
      systemRules: systems,
      titleLength: titleLengthPolicy(),
      skuGuidance: skuGuidance(applicableRules),
      selectedTitleStructure: selected,
      terminologyRules: terms,
      synonymEnrichment: { enabled: synonyms.enabled, optional: true, neverOverrideSafetyOrFitment: true },
      synonyms: synonyms.rules,
      prefixRule: prefix,
      categoryRules: cats,
      restrictedTerms: restricted,
      flagReasons: flags,
      instructions: bypass
        ? [
          'Manual title override is active; do not create a replacement title in this shadow artifact.',
          'Do not use description-only partFitment for title identity.'
        ]
        : [
          'Create a title candidate using the selected structure and supplied evidence only.',
          'Do not use description-only partFitment for title identity.'
        ]
    },
    outputContract: outputContract(),
    resolvedListing: {
      recordId: listingResolution?.normalized?.recordId || null,
      authoritativeValues: authoritative,
      missing: listingResolution?.resolved?.missing || [],
      supportingAndConflictingEvidence: evidence,
      descriptionOnly: descriptionEvidence
    },
    existingTitle: {
      currentTitle,
      mustNotDegrade: true,
      finalNoDegradeDecisionInThisPhase: false
    },
    descriptionPolicy: {
      descriptionGenerationStillAllowed: true,
      preserveExistingPhase74DescriptionBehavior: true,
      titleOptimizationConfigPrimarilyGovernsTitle: true
    },
    warnings: applicableRules.warnings || [],
    unresolved: applicableRules.unresolved || []
  };

  const systemMessage = [
    'You are the future shadow-only config-driven Phase 7.4 title/description assistant.',
    'Return valid JSON only using the required output contract.',
    bypass
      ? 'Manual override is active: preserve title authority and do not create a replacement title.'
      : 'Use the supplied authoritative resolved values and applicable rules to create a safe replacement title candidate.',
    'System Rules in the payload are mandatory.',
    '80 characters is the hard maximum; 65 characters is a target only, not a minimum.',
    'Do not use description-only partFitment for title identity.'
  ].join(' ');

  return {
    contractVersion: 1,
    runtimeMode: 'shadow-only',
    kind: bypass ? 'title-generation-bypass' : 'prompt',
    systemMessage,
    userPayload,
    metadata: {
      configurationVersion: runtimeSnapshot?.metadata?.configurationVersion || null,
      selectedStructureId: selected?.id || null,
      applicableRuleCounts: {
        terminologyRules: terms.length,
        synonyms: synonyms.rules.length,
        categoryRules: cats.length,
        restrictedTerms: Object.values(restricted.groups).reduce((sum, group) => sum + group.length, 0),
        flagReasons: flags.length,
        systemRules: systems.length
      },
      applicableTerminologyRuleIds: terms.map(rule => rule.id),
      applicableSynonymRuleIds: synonyms.rules.map(rule => rule.id),
      prefixRuleId: prefix?.id || null,
      categoryRuleIds: cats.map(rule => rule.id),
      restrictedTermIds: Object.values(restricted.groups).flat().map(rule => rule.id),
      systemRuleIds: systems.map(rule => rule.id)
    },
    bypass: bypass ? {
      reason: 'manual_override',
      titleGenerationBypassed: true,
      manualOverrideStatus: listingResolution?.normalized?.manualOverride?.status?.value || null,
      manualOverrideTitle: listingResolution?.normalized?.manualOverride?.title?.value || null
    } : null
  };
}

module.exports = {
  OUTPUT_KEYS,
  PROMPT_SECTION_ORDER,
  buildTitleOptimizationRuntimePrompt
};
