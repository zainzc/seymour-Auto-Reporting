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
    aiMayOverrideWinner: field === 'year' || field === 'model'
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
      'Part Fitment is supplied title evidence and may be used for title year, make, model, side, and part identity when it is the best verified source.',
      'AI has selection priority for the Year / Year Range segment and must derive it from all supplied year evidence, including the current title, structured year evidence, and titleEvidence.partFitment.',
      'A single structured year is evidence, not a mandatory final title year.',
      'If Part Fitment provides one unambiguous applicable range that includes the structured year, use the complete range.',
      'If the evidence supports only one year, use that year.',
      'If evidence contains multiple conflicting or unrelated ranges, preserve the safest existing year information and return Needs Review; do not choose arbitrarily.',
      'Do not combine unrelated applications, expand beyond supplied evidence, shrink a supported range to one year, or invent years.',
      'AI may normalize compressed model identifiers when the current title or Part Fitment corroborates the clear model names; preserve all corroborated model names in the generated title.',
      'Follow the selectedTitleStructure segments strictly; use its field and literal segment order for the generated title.',
      'Normalize raw fitment wording into the selectedTitleStructure fields; do not keep raw fitment wording when the structure provides separate year, make, model, or part segments.',
      'Use deterministic source winners as authoritative except for the Year / Year Range segment and corroborated compressed-model normalization; lower-priority evidence is context only.',
      'Use deterministicTitlePart as the authoritative part when supplied; do not substitute a generic category part.',
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

function authoritativeValues(listingResolution = {}, applicableRules = {}) {
  const keys = ['title', 'brandMake', 'model', 'part', 'manufacturerPartNumber', 'side', 'sku', 'componentType', 'color', 'placement', 'keyFitmentDetail'];
  const out = {};
  for (const key of keys) {
    const value = resolvedField(listingResolution, key);
    if (value) out[key] = value;
  }
  return out;
}

function sourceEvidenceMap(listingResolution = {}) {
  const keys = ['title', 'brandMake', 'model', 'part', 'manufacturerPartNumber', 'side', 'year', 'sku', 'componentType', 'color', 'placement', 'keyFitmentDetail'];
  const out = {};
  for (const key of keys) out[key] = sourceEvidence(listingResolution, key);
  return out;
}

function titleEvidence(listingResolution = {}) {
  const partFitment = listingResolution?.normalized?.titleAuthority?.partFitment || {};
  return {
    partFitment: {
      value: partFitment.value || null,
      boundary: 'TITLE EVIDENCE',
      titleIdentityAllowed: true
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
  const authoritative = authoritativeValues(listingResolution, applicableRules);
  const evidence = sourceEvidenceMap(listingResolution);
  const titleEvidencePayload = titleEvidence(listingResolution);
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
      deterministicTitlePart: applicableRules.deterministicTitlePart || null,
      restrictedTerms: restricted,
      flagReasons: flags,
      instructions: bypass
        ? [
          'Manual title override is active; do not create a replacement title in this shadow artifact.',
          'Part Fitment remains available as verified title evidence for explanation only.'
        ]
        : [
          'Create a title candidate using the selected structure and supplied evidence only.',
          'Part Fitment is title evidence when it is the best verified source.',
          'Follow the selectedTitleStructure segments strictly.',
          'AI has priority to select the Year / Year Range segment from current title, structured year evidence, and titleEvidence.partFitment.',
          'Treat a single structured year as evidence. When one unambiguous applicable Part Fitment range includes the structured year, use the complete range.',
          'Use a single year only when the evidence supports only that year.',
          'For multiple conflicting or unrelated ranges, preserve the safest existing year information and return Needs Review instead of choosing arbitrarily.',
          'Do not combine unrelated applications, expand beyond supplied evidence, shrink a supported range to one year, or invent years.',
          'For compressed model identifiers, AI may normalize from current title and titleEvidence.partFitment only when the clear model names are corroborated; preserve all corroborated model names.',
          'Do not keep raw fitment wording in generatedTitle when the selected structure has separate fields for that information.'
        ]
    },
    outputContract: outputContract(),
    resolvedListing: {
      recordId: listingResolution?.normalized?.recordId || null,
      authoritativeValues: authoritative,
      missing: (listingResolution?.resolved?.missing || []).filter(field => field !== 'year' && field !== 'yearRange'),
      supportingAndConflictingEvidence: evidence,
      titleEvidence: titleEvidencePayload
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
      : 'Use the supplied authoritative non-year values, all supplied year evidence, and applicable rules to create a safe replacement title candidate.',
    'System Rules in the payload are mandatory.',
    '80 characters is the hard maximum; 65 characters is a target only, not a minimum.',
    'Part Fitment is allowed as verified title evidence.'
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
