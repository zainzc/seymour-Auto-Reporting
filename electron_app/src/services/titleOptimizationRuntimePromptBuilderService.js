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
      'AI has selection priority for the Year / Year Range segment and must select the advertised application using the existing title and supplied evidence.',
      'A single structured year is evidence, not a mandatory final title year.',
      'Identify the supporting Part Fitment row IDs for the selected advertised application; the application reads their exact evidence from the supplied rows.',
      'If the evidence supports only one year, use that year.',
      'Ordinary compatibility rows for other vehicles, trims, or adjacent years are not automatically conflicts.',
      'Adjacent or overlapping rows for the same advertised make and model may support one continuous range when every year is covered.',
      'Evaluate every supplied Part Fitment row for the selected make and model before choosing the application. Do not select a narrower subset merely because it matches the donor year or existing title year.',
      'AI decides whether qualifiers across continuous rows are compatible. Combine all compatible rows; if a material qualifier conflict prevents one safe application, return vehicleDecision.resolved false and request review.',
      'Before combining rows, identify whether any material restriction applies to only part of a combined range. A combined title must preserve that restriction and must not imply unrestricted compatibility for every year.',
      'Request review only for a genuine contradiction or when no advertised application can be supported; never invent or bridge unsupported years.',
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
  for (const [field, value] of Object.entries(currentFields)) {
    if (/(?:notes?|remarks?|comments?)/i.test(field) && !/<(?:!doctype|html|div|table|script)\b/i.test(String(value || ''))) {
      add(`Current eBay Note:${field}`, value);
    }
  }
  const compactFields = Object.fromEntries(Object.entries(currentFields).filter(([, value]) =>
    typeof value !== 'string' || !/<(?:!doctype|html|div|table|script)\b/i.test(value)));
  add('Current eBay Fields', compactFields);
  return sources;
}

function listingNoteEvidence(evidenceSources = []) {
  return evidenceSources
    .filter(item => item.source.startsWith('Current eBay Note:'))
    .map(item => ({ id: item.id, source: item.source, evidence: item.evidence, required: false }));
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
          'Before drafting generatedTitle, identify the advertised application and the material restrictions in each selected fitment row, including which years and variants each restriction covers. Compose the shortest truthful year/make/model/part claim with those restrictions first; only then add optional enrichment. Do not write a broad range and assume a qualifier is optional merely because the current title omits it.',
          'Spend the 80-character budget on accurate fitment and product identity first. Remove an optional manufacturer part number, repeated category or part wording, synonyms, and generic filler before removing any fitment restriction. Use a concise supported equivalent where available; never imply that a restricted application is unrestricted.',
          'Before finalizing generatedTitle, evaluate every candidate word or phrase in the context of this specific listing. Keep useful verified details when the title fits within 80 characters. Remove wording only when it is truly duplicated, redundant, filler, unnecessary for this listing, or must be removed to satisfy the 80-character maximum.',
          'Preserve any detail whose removal could change fitment, compatible vehicle/version, product identity, configuration, function, side, placement, appearance, or a buyer\'s ability to select the correct part. Do not rely on a fixed list of protected words.',
          'When the title would exceed 80 characters, remove the least important and most redundant wording first. Prefer repeated synonyms and duplicate concepts before any useful verified listing detail. Do not remove a useful detail merely to make the title shorter than 80 characters. If a safe title cannot fit, return Needs Review instead of silently removing an important detail.',
          'Before returning JSON, perform a final title audit against the selected Part Fitment application and current title: identify every supplied qualifier that distinguishes compatibility, configuration, function, or product identity; confirm each useful qualifier is represented unless it is genuinely unnecessary for this listing.',
          'During that final audit, detect part-name words or phrases that express the same concept more than once. Keep the clearest configured or verified part wording and use the recovered characters for omitted distinguishing qualifiers.',
          'Rebuild generatedTitle after the audit, recount all characters including spaces and the final SKU, and verify the selectedTitleStructure order again. Do not return the first draft when redundant part wording remains while a useful distinguishing qualifier was omitted.',
          'If the required structure and SKU leave available space below 80 characters, use the remaining characters for the highest-impact useful qualifiers from the selected application before optional generic descriptors.',
          'Never wrap an evidence citation in quotation marks, apostrophes, backticks, or smart quotes. Return the exact source excerpt directly in every evidence field.',
          'Return vehicleDecision with resolved, make, model, yearRange, source and evidence. When titleFitmentCandidates.selectionBasis is EXISTING_TITLE_FITS_APPLICATION, the application written after Fits is the advertised application; vehicle information before Fits is donor context. When selectionBasis is EXISTING_TITLE_MODEL_APPLICATION, the existing title identifies the advertised model even without Fits. In either case only titleFitmentCandidates.eligibleCandidates may establish title vehicle identity; do not switch to another compatible model merely because it appears in Part Fitment. Evaluate every eligible row for the advertised make and model; donor year does not authorize selecting another candidate or narrowing the range. AI owns the qualifier decision: combine every continuous eligible row whose qualifiers are compatible, or set resolved false and request review when a material qualifier conflict prevents one safe application. Also set resolved false when no supplied evidence supports the advertised application. Put every combined eligible titleFitmentCandidate ID in source, separated by semicolons; trusted row evidence is retrieved from those IDs, so evidence may be null rather than a reconstructed quotation. When no parsed fitment candidates exist, cite an exact approved source excerpt in evidence. Include the selected make, model, and complete year or continuous year range in generatedTitle.',
          'When combining fitment rows, compare qualifiers row by row and identify restrictions that apply to only part of the combined range. Material restrictions include, but are not limited to, build dates, VIN splits, engine or transmission variants, body styles, trims, cab types, door counts, side, placement, and included or excluded components. Preserve every applicable material range-specific restriction in generatedTitle; never present a restricted year as universally compatible.',
          'If a material fitment qualifier is malformed, impossible, or internally inconsistent, do not silently correct, reinterpret, or omit it. Set vehicleDecision.resolved false and return Needs Review with a concise explanation. If the complete application and its material restriction cannot be represented accurately within 80 characters, return Needs Review instead of broadening compatibility or dropping the restriction.',
          'Preserve every word of the authoritative Brand/Make unless a complete cited vehicle application supports a different make/model/year selection. Only clean capitalization; do not arbitrarily strip make words or infer vehicle identities from external knowledge.',
          'Part Fitment is title evidence when it is the best verified source. Qualifiers attached to the selected fitment application take priority over overlapping synonyms and repeated part-name wording.',
          'Evaluate resolvedListing.listingNoteEvidence as optional product evidence. Preserve a concise note detail when it materially changes fitment, configuration, function, or what is included with the item. Do not automatically include every note, and ignore administrative data, stock references, mileage, ordinary condition wording, or internal workflow text.',
          'AI selects side and placement independently from the supplied listing evidence. Front/Rear/Upper/Lower are placement; Left/Right/Driver/Passenger/LH/RH are side. They can coexist and do not conflict across dimensions.',
          'Return sideDecision with side, placement, source and evidence. Put the exact supporting categoryPriorityEvidenceSources id in source and cite a verbatim excerpt that explicitly supports the selected side. For no verified side return null side, source and evidence. Never infer side from part number, IPN or common automotive knowledge. Actual Left versus Right contradictions require review. Preserve a verified side in generatedTitle.',
          'Before returning JSON, internally review the complete final title against all supplied evidence and every applicable configured rule. Check each word and qualifier for support, preserve meaning across approved abbreviations and equivalent terminology, and ensure no positive/negative meaning, side, vehicle identity, fitment restriction, product identity, configuration, function, technology, or included/excluded feature was invented or reversed.',
          'If that internal review finds unsupported, contradictory, duplicated, or meaning-changing wording, rebuild the title before returning it. Remove a supplied detail only when it is redundant, lower-value, or necessary to meet the 80-character maximum and its removal does not change fitment, identity, configuration, function, or buyer selection.',
          'Return Needs Review only when the supplied evidence contains a genuine material conflict or ambiguity that cannot be resolved safely under the configured rules. Do not request review for harmless abbreviation, capitalization, equivalent terminology, removal of generic connector words, or omission of nonmaterial redundant wording.',
          'Use professional title capitalization throughout generatedTitle while preserving conventional uppercase abbreviations, identifiers, part numbers, and SKU formatting.',
          'Donor vehicle year/model describe where the part came from, not every compatible application. Keep them separate from advertised fitment. Do not treat other compatible vehicles in Part Fitment as conflicting listing identities or require every application in the title. Select the application supported by the current title and approved identity fields; flag an unresolved actual identity conflict.',
          'Follow the selectedTitleStructure segments strictly. Use its exact field and literal segment order as the required pattern for this listing, omitting only unavailable optional segments.',
          'Use titleEvidence.partFitment to select rows matching the advertised application. Multiple rows do not require review merely because they contain other compatible vehicles, trims, body styles, or adjacent year segments.',
          'Treat a single structured year as evidence for vehicle identity, not as authority to narrow fitment. Use the existing title to identify the advertised make and model, evaluate all of their supplied rows, and merge cited adjacent or overlapping rows when AI finds their qualifiers compatible.',
          'Use a single year only when the evidence supports only that year.',
          'Do not combine rows from different makes or models, expand beyond cited evidence, or bridge a gap between unsupported years. Qualifier differences matter only when they contradict the advertised item or would make the title inaccurate.',
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
      categoryPriorityEvidenceSources: evidenceSources,
      listingNoteEvidence: listingNoteEvidence(evidenceSources)
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
