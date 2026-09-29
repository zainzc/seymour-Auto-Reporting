const OUTPUT_KEYS = Object.freeze([
  'generatedTitle',
  'generatedDescription',
  'shortDescription',
  'reasoningSummary',
  'titleReviewStatus',
  'titleReviewReason',
  'titleReviewNotes',
  'categoryPriorityDetails',
  'sideDecision',
  'vehicleDecision'
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

const { selectTitleFitmentCandidates } = require('./titleOptimizationFitmentSelectionService');

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
    priorityDetails: (entry.rule.priorityDetails || []).map(detail => ({
      detail,
      verificationStatus: 'pending',
      instruction: 'Verify against categoryPriorityEvidenceSources before using this detail.'
    })),
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
      'AI has selection priority for the Year / Year Range segment, but must select from titleFitmentCandidates when candidates are supplied. Use currentTitleYearFallback only when no Part Fitment candidate is available.',
      'A single structured year is evidence, not a mandatory final title year.',
      'If titleFitmentCandidates provides one unambiguous applicable range that includes the structured year, use the complete range.',
      'If the evidence supports only one year, use that year.',
      'If evidence contains multiple conflicting or unrelated ranges, preserve the safest existing year information and return Needs Review; do not choose arbitrarily.',
      'Do not combine unrelated applications, expand beyond supplied evidence, shrink a supported range to one year, or invent years.',
      'AI may normalize compressed model identifiers when the current title or Part Fitment corroborates the clear model names; preserve all corroborated model names in the generated title.',
      'Follow the selectedTitleStructure segments strictly; use its field and literal segment order for the generated title.',
      'Normalize raw fitment wording into the selectedTitleStructure fields; do not keep raw fitment wording when the structure provides separate year, make, model, or part segments.',
      'Resolve make, model and year together using vehicleDecision and supplied application evidence. Other deterministic source winners remain authoritative.',
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
  const keys = [
    'title', 'brandMake', 'model', 'part', 'manufacturerPartNumber', 'side', 'sku',
    'componentType', 'color', 'placement', 'keyFitmentDetail', 'engineDisplacement',
    'engineCode', 'transmissionCode', 'drivetrain', 'transmissionSpeedType',
    'vinIdentifier', 'illumination', 'paintCode', 'trim', 'lightingTechnology'
  ];
  const out = {};
  for (const key of keys) {
    const value = resolvedField(listingResolution, key);
    if (value) out[key] = value;
  }
  return out;
}

function sourceEvidenceMap(listingResolution = {}) {
  const keys = [
    'title', 'brandMake', 'model', 'part', 'manufacturerPartNumber', 'side', 'year', 'sku',
    'componentType', 'color', 'placement', 'keyFitmentDetail', 'engineDisplacement',
    'engineCode', 'transmissionCode', 'drivetrain', 'transmissionSpeedType',
    'vinIdentifier', 'illumination', 'paintCode', 'trim', 'lightingTechnology'
  ];
  const out = {};
  for (const key of keys) out[key] = sourceEvidence(listingResolution, key);
  return out;
}

function titleEvidence(listingResolution = {}) {
  const partFitment = listingResolution?.normalized?.titleAuthority?.partFitment || {};
  const titleYearFallback = listingResolution?.normalized?.titleAuthority?.titleYearFallback || {};
  return {
    partFitment: {
      value: partFitment.value || null,
      boundary: 'TITLE EVIDENCE',
      titleIdentityAllowed: true
    },
    currentTitleYearFallback: {
      value: titleYearFallback.value || null,
      source: titleYearFallback.source || 'currentEbay',
      useOnlyWhenPartFitmentUnavailable: true
    }
  };
}

function categoryPriorityEvidenceSources(listingResolution = {}) {
  const sources = [];
  const add = (source, evidence) => {
    const text = typeof evidence === 'string' ? normalizeText(evidence) : evidence && typeof evidence === 'object' ? JSON.stringify(evidence) : '';
    if (!text || sources.some(item => item.source === source && item.evidence === text)) return;
    sources.push({ id: `evidence-${String(sources.length + 1).padStart(3, '0')}`, source, evidence: text });
  };
  for (const [field, resolved] of Object.entries(listingResolution?.resolved?.fields || {})) {
    if (resolved?.resolvedValue) add(`Resolved:${field}`, resolved.resolvedValue);
    for (const candidate of resolved?.candidates || []) add(`Source:${candidate.source}`, candidate.value);
  }
  add('Part Fitment', listingResolution?.normalized?.titleAuthority?.partFitment?.value);
  const itemSpecifics = listingResolution?.normalized?.structured?.itemSpecifics?.value || {};
  for (const [field, value] of Object.entries(itemSpecifics)) add(`Item Specifics:${field}`, value);
  add('Conditions & Options', listingResolution?.normalized?.fields?.conditionsOptions?.value);
  add('Current eBay Title', listingResolution?.normalized?.fields?.existingTitle?.value);
  const currentFields = listingResolution?.normalized?.structured?.currentEbayFields?.value || {};
  const compactFields = Object.fromEntries(Object.entries(currentFields).filter(([, value]) =>
    typeof value !== 'string' || !/<(?:!doctype|html|div|table|script)\b/i.test(value)));
  add('Current eBay Fields', compactFields);
  return sources;
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
  const evidenceSources = categoryPriorityEvidenceSources(listingResolution);
  const titleFitmentCandidates = selectTitleFitmentCandidates(listingResolution);
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
          'Before finalizing generatedTitle, evaluate every candidate word or phrase in the context of this specific listing. Keep useful verified details when the title fits within 80 characters. Remove wording only when it is truly duplicated, redundant, filler, unnecessary for this listing, or must be removed to satisfy the 80-character maximum.',
          'Preserve any detail whose removal could change fitment, compatible vehicle/version, product identity, configuration, function, side, placement, appearance, or a buyer\'s ability to select the correct part. Do not rely on a fixed list of protected words.',
          'When the title would exceed 80 characters, remove the least important and most redundant wording first. Prefer repeated synonyms and duplicate concepts before any useful verified listing detail. Do not remove a useful detail merely to make the title shorter than 80 characters. If a safe title cannot fit, return Needs Review instead of silently removing an important detail.',
          'Before returning JSON, perform a final title audit against the selected Part Fitment application and current title: identify every supplied qualifier that distinguishes compatibility, configuration, function, or product identity; confirm each useful qualifier is represented unless it is genuinely unnecessary for this listing.',
          'During that final audit, detect part-name words or phrases that express the same concept more than once. Keep the clearest configured or verified part wording and use the recovered characters for omitted distinguishing qualifiers.',
          'Rebuild generatedTitle after the audit, recount all characters including spaces and the final SKU, and verify the selectedTitleStructure order again. Do not return the first draft when redundant part wording remains while a useful distinguishing qualifier was omitted.',
          'If the required structure and SKU leave available space below 80 characters, use the remaining characters for the highest-impact useful qualifiers from the selected application before optional generic descriptors.',
          'Never wrap an evidence citation in quotation marks, apostrophes, backticks, or smart quotes. Return the exact source excerpt directly in every evidence field.',
          'Return vehicleDecision with resolved, make, model, yearRange, source and evidence. Use a titleFitmentCandidate only when titleFitmentCandidates.resolution is UNAMBIGUOUS, and then cite its exact id and evidence. When resolution is AMBIGUOUS or UNAVAILABLE, you must not choose or merge an application; set vehicleDecision.resolved false and request Needs Review. Trusted donor facts are diagnostic context and do not authorize discarding another distinct application. When Part Fitment is unavailable, another supplied evidence source may support the decision only when it establishes one unambiguous application. Include the verified make/model/year in generatedTitle.',
          'Preserve every word of the authoritative Brand/Make unless a complete cited vehicle application supports a different make/model/year selection. Only clean capitalization; do not arbitrarily strip make words or infer vehicle identities from external knowledge.',
          'Part Fitment is title evidence when it is the best verified source. Qualifiers attached to the selected fitment application take priority over overlapping synonyms and repeated part-name wording.',
          'AI selects side and placement independently from the supplied listing evidence. Front/Rear/Upper/Lower are placement; Left/Right/Driver/Passenger/LH/RH are side. They can coexist and do not conflict across dimensions.',
          'Return sideDecision with side, placement, source and evidence. Put the exact supporting categoryPriorityEvidenceSources id in source and cite a verbatim excerpt that explicitly supports the selected side. For no verified side return null side, source and evidence. Never infer side from part number, IPN or common automotive knowledge. Actual Left versus Right contradictions require review. Preserve a verified side in generatedTitle.',
          'Donor vehicle year/model describe where the part came from, not every compatible application. Keep them separate from advertised fitment. Do not treat other compatible vehicles in Part Fitment as conflicting listing identities or require every application in the title. Select the application supported by the current title and approved identity fields; flag an unresolved actual identity conflict.',
          'Follow the selectedTitleStructure segments strictly. Use its exact field and literal segment order as the required pattern for this listing, omitting only unavailable optional segments.',
          'Use the Year / Year Range from titleFitmentCandidates only when its resolution is UNAMBIGUOUS. Raw titleEvidence.partFitment is audit context and must not be used to construct, extend, merge, or choose among ambiguous title ranges. Otherwise use titleEvidence.currentTitleYearFallback and structured year evidence only when they establish one unambiguous application.',
          'Treat a single structured year as evidence. When one unambiguous eligible title fitment range includes the structured year, use that candidate\'s complete range.',
          'Use a single year only when the evidence supports only that year.',
          'For multiple conflicting or unrelated ranges, preserve the safest existing year information and return Needs Review instead of choosing arbitrarily.',
          'Do not combine unrelated applications, expand beyond supplied evidence, shrink a supported range to one year, or invent years. Adjacent year applications may be merged only when make, model, and every meaningful application qualifier are identical; if qualifiers differ, select one complete application and keep its own year range and qualifiers together.',
          'For compressed model identifiers, AI may normalize from current title and titleEvidence.partFitment only when the clear model names are corroborated; preserve all corroborated model names.',
          'Evaluate every Category Rule priority detail against categoryPriorityEvidenceSources and return one categoryPriorityDetails decision for each configured detail.',
          'Mark a Category Rule detail verified only when supplied trusted evidence supports it directly or through an applicable approved terminology rule or synonym.',
          'A citation must establish the specific detail, not merely the broad category or part identity. Generic category names do not verify specific features. Negated or absent features are not verified.',
          'The cited evidence must contain the detail or its applicable configured terminology/synonym equivalent. If wording cannot be corroborated through those approved equivalents, mark the detail unverified. Do not treat a Prefix Rule replacement as a listing-source citation; its authority is separate.',
          'For each verified Category Rule detail, put the exact supporting categoryPriorityEvidenceSources id in source and cite a verbatim evidence excerpt. Mark unsupported details unverified with null source and evidence.',
          'Use only verified Category Rule priority details in generatedTitle. Never infer or invent an unverified Category Rule detail.',
          'Category details are optional priorities: omit an unsupported optional detail without requesting review solely for its absence. Return only the exact configured detail names, each once; return an empty array when no Category Rule details are configured.',
          'An applicable deterministic Prefix Rule replacement remains authoritative independently of Category Rule detail verification.',
          'Do not keep raw fitment wording in generatedTitle when the selected structure has separate fields for that information.'
        ]
    },
    outputContract: outputContract(),
    resolvedListing: {
      recordId: listingResolution?.normalized?.recordId || null,
      authoritativeValues: authoritative,
      missing: (listingResolution?.resolved?.missing || []).filter(field => field !== 'year' && field !== 'yearRange'),
      supportingAndConflictingEvidence: evidence,
      titleEvidence: titleEvidencePayload,
      titleFitmentCandidates,
      categoryPriorityEvidenceSources: evidenceSources
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
    'You are the authoritative config-driven Phase 7.4 title/description assistant.',
    'Return valid JSON only using the required output contract.',
    bypass
      ? 'Manual override is active: preserve title authority and do not create a replacement title.'
      : 'Use an evidence-backed joint vehicleDecision for make/model/year and supplied authoritative remaining values and applicable rules to create a safe replacement title candidate.',
    'System Rules in the payload are mandatory.',
    '80 characters is the hard maximum; 65 characters is a target only, not a minimum.',
    'Part Fitment is allowed as verified title evidence.'
  ].join(' ');

  return {
    contractVersion: 1,
    runtimeMode: 'authoritative',
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
