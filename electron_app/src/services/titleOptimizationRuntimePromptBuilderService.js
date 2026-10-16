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
  'vehicleDecision',
  'materialRestrictions',
  'restrictedTermDecisions',
  'titleSegments',
  'ruleSelfAudit'
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
const { EVIDENCE_POLICY } = require('./titleOptimizationEvidencePolicy');

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
      priority: candidate.priority,
      derived: candidate.evidence?.derived === true,
      sourceFieldName: candidate.evidence?.sourceFieldName || null,
      role: candidate.evidence?.role || null,
      contentRole: candidate.evidence?.contentRole || 'listing-specific'
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
      optional: segment.optional === true,
      required: segment.optional !== true,
      omitIfUnavailable: segment.optional === true && segment.kind === 'field',
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
    matchEvidence: (entry.matchEvidence || []).map(item => ({ ...item })),
    priorityDetails: (entry.priorityDetails || entry.rule.priorityDetails || []).map(detail => ({
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
      'Evaluate the supplied Part Fitment rows and select the advertised application using evidencePolicy. A donor year alone cannot select or narrow compatibility.',
      'AI decides whether qualifiers across continuous rows are compatible. Preserve verified advertised coverage, distinguish alternative applications, and request review when that coverage and its material restrictions cannot fit truthfully within 80 characters.',
      'Request review only for a genuine contradiction or when no advertised application can be supported; never invent or bridge unsupported years.',
      'AI may normalize compressed model identifiers when the current title or Part Fitment corroborates the clear model names; preserve all corroborated model names in the generated title.',
      'Follow the selectedTitleStructure segments strictly; use its field and literal segment order for the generated title.',
      'Treat selectedTitleStructure segment optional=true as permission to omit only that segment when its value is unavailable, unsupported, unauthorized by applicable rules, or would displace more important verified fitment; required segments remain part of the configured pattern. Never invent a value to fill either kind of segment.',
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
    restrictedTermDecisionFields: ['term', 'used', 'evidenceVerified', 'source', 'evidence'],
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
    sources.push({
      id: `evidence-${String(sources.length + 1).padStart(3, '0')}`,
      source,
      evidence: text
    });
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
  add('Legacy Description Donor Note', listingResolution?.normalized?.titleAuthority?.legacyDonorNote?.value);
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
    .filter(item => item.source.startsWith('Current eBay Note:') || item.source === 'Legacy Description Donor Note')
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
    evidencePolicy: [...EVIDENCE_POLICY],
    sourcePriority: (runtimeSnapshot?.sections?.sourcePriority?.items || [])
      .filter(row => row.enabled !== false && !row.deletedAt).map(stripVolatile),
    titlePolicy: {
      systemRules: systems,
      titleLength: titleLengthPolicy(),
      skuGuidance: skuGuidance(applicableRules),
      selectedTitleStructure: selected,
      listingClassification: applicableRules.listingClassification || null,
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
          'First assess the existing title before drafting a replacement. Compare existingTitle.currentTitle with the supplied source evidence, material Part Fitment restrictions, source priority, all applicable UI rules (Terminology Rules, Synonyms, Prefix Rules, Restricted Terms, Category Rules, Title Structure, and System Rules), selectedTitleStructure, the 80-character limit, and SKU exactly once at the end. If the existing title already satisfies all mandatory requirements without losing a useful verified detail, return it exactly unchanged as generatedTitle with titleReviewStatus Completed and titleReviewReason Existing title retained - already compliant; explain in titleReviewNotes why the existing title already complied. Retaining the existing title must still produce a nonempty generatedDescription and shortDescription; do not skip description generation merely because no title rewrite was needed. Do not use Needs Review merely because no rewrite was needed. Do not rewrite a compliant title for cosmetic changes, stylistic variation, the 65-character target, or simply to demonstrate optimization. Rewrite only when an actual evidence or rule issue requires it; preserve all correct existing details and do not degrade the title.',
          'Before drafting generatedTitle, inspect every original clause in titleFitmentCandidates.sourceRows. Treat each clause as one application record: qualifiers within that clause apply together, while qualifiers in separate clauses describe separate alternatives and are not automatically cumulative. Select the advertised application, then compare the title it implies with the exact selected row evidence and each row year/variant scope. A qualifier may be omitted only when the resulting title does not imply compatibility beyond the selected evidence and does not mislead part selection. Compose a clear truthful year/make/model/part claim with genuinely scope-limiting details first, then optional enrichment. Do not shorten an accurate title merely to approach the 65-character target or assume a limiting qualifier is optional because the old title omits it.',
          'Compare the verified product identity in the existing title and source evidence with generatedTitle before declaring it Completed. Keep the specific part class and function; a broader related component is not an equivalent replacement. Preserve verified vehicle, year coverage, side, placement, and buyer-critical restrictions. If a replacement loses or changes one of these, repair it using the remaining character budget rather than accepting a degraded title. Retain the existing title only when the AI has checked that it satisfies all applicable UI rules and title structure; then return Completed, not Needs Review.',
          'Spend the 80-character budget on accurate fitment and product identity first. Include every required field segment and place its verified resolved value in the exact configured position. For optional segments, include a verified useful value when it fits and does not displace a more important detail; omit only when unavailable, unsupported, unauthorized by applicable rules, or necessary to preserve more important fitment or identity. Do not omit a verified Manufacturer Part Number merely because it is optional in another listing. Remove repeated category or part wording, synonyms, and generic filler first. Use a concise supported equivalent where available; never imply that a restricted application is unrestricted.',
          'Before finalizing generatedTitle, evaluate every candidate word or phrase in the context of this specific listing. Keep useful verified details when the title fits within 80 characters. Remove wording only when it is truly duplicated, redundant, filler, unnecessary for this listing, or must be removed to satisfy the 80-character maximum.',
          'Preserve any detail whose removal could change fitment, compatible vehicle/version, product identity, configuration, function, side, placement, appearance, or a buyer\'s ability to select the correct part. Do not rely on a fixed list of protected words.',
          'When the title would exceed 80 characters, remove the least important and most redundant wording first. Prefer repeated synonyms and duplicate concepts before any useful verified listing detail. Do not remove a useful detail merely to make the title shorter than 80 characters. If a safe title cannot fit, return Needs Review instead of silently removing an important detail.',
          'A claimed 80-character conflict must be based on an actual complete candidate after replacing redundant wording and optional enrichment with the verified material detail, not on an estimate or on the length of the existing title. Count spaces and final SKU. If a supported complete candidate fits, use it and return Completed. If source evidence itself is conflicting, name that conflict rather than calling it a character-limit problem.',
          'Final audit: compare every material vehicle, fitment, product, and side claim with its supporting evidence; check every title-level qualifier against each selected year and variant. Replace duplicate wording with useful verified details, then recount the title including spaces and final SKU and verify the selectedTitleStructure order.',
          'If the required structure and SKU leave available space below 80 characters, use the remaining characters for the highest-impact useful qualifiers from the selected application before optional generic descriptors.',
          'Treat generic Item Specifics Features as optional evidence, not an authoritative Key Fitment Detail. Include a feature in generatedTitle only when it materially identifies the actual part or compatible application. Promotional or convenience wording must not displace verified fitment, product identity, color, or an available manufacturer part number.',
          'Never wrap an evidence citation in quotation marks, apostrophes, backticks, or smart quotes. Return the exact source excerpt directly in every evidence field.',
          'Return vehicleDecision with resolved, make, model, yearRange, source and evidence. The application after Fits is advertised fitment; vehicle information before Fits is donor context. Otherwise identify the advertised model from supplied listing evidence. Select compatible eligibleCandidates under evidencePolicy and cite every selected row ID in source, separated by semicolons; evidence may be null because exact rows are retrieved by ID. AI_SELECTION_REQUIRED means text matching found no exact model match, not a confirmed identity conflict: use all supplied evidence and configured normalization rules to establish one unambiguous advertised identity or request review. Never switch to another compatible vehicle simply because a row exists. When no parsed candidates exist, cite approved source evidence; their absence alone is not a review reason. Include the selected vehicle application in generatedTitle.',
          'When combining fitment rows, use sourceRows to compare the original clauses, not only their combined evidence string. Identify restrictions that apply to only some selected years or variants. Material restrictions can include build dates, VIN splits, engine or transmission variants, body styles, trims, cab types, door counts, side, placement, and included or excluded components; this is an open set, not a fixed keyword list. Preserve a qualifier when its omission would broaden the title\'s implied fitment or mislead a buyer, and scope it only to the rows/years it limits.',
          'Scope restrictions to the years and variants they describe. Preserve verified advertised coverage under evidencePolicy; do not shorten a verified advertised range merely to fit or broaden a restricted application.',
          'A build-date cutoff or similar within-year restriction limits that year. Never turn a year supported only through a manufacture cutoff into an unrestricted full-year claim; state the supported cutoff concisely in generatedTitle or keep Needs Review if the supported application cannot be stated truthfully.',
          'If a material fitment qualifier is malformed, impossible, or internally inconsistent, do not silently correct, reinterpret, or omit it. Set vehicleDecision.resolved false and return Needs Review with a concise explanation. If the complete application and its material restriction cannot be represented accurately within 80 characters, return Needs Review instead of broadening compatibility or dropping the restriction.',
          'When the exact resolved brandMake value is present, put that exact value in the Make segment of titleSegments and keep the selected model in its own Model segment. Do not shorten, remove, reorder, or merge words from the authoritative make (including words such as Truck), and do not infer a make alias from fitment wording. Change the make wording only when an applicable configured Terminology Rule explicitly maps that exact make term. Use the same resolved make in vehicleDecision.make; if selected application evidence genuinely conflicts with it and the configured source priority cannot resolve the conflict, return Needs Review rather than silently changing the make.',
          'Part Fitment is title evidence when it is the best verified source. Qualifiers attached to the selected fitment application take priority over overlapping synonyms and repeated part-name wording.',
          'Evaluate resolvedListing.listingNoteEvidence as optional product evidence. Preserve a concise note detail when it materially changes fitment, configuration, function, or what is included with the item. Do not automatically include every note, and ignore administrative data, stock references, mileage, ordinary condition wording, or internal workflow text.',
          'AI selects side and placement independently from the supplied listing evidence. Front/Rear/Upper/Lower are placement; Left/Right/Driver/Passenger/LH/RH are side. They can coexist and do not conflict across dimensions.',
          'Return sideDecision with side, placement, source and evidence. Put the exact supporting categoryPriorityEvidenceSources id in source and cite a verbatim excerpt that explicitly supports the selected side. For no verified side return null side, source and evidence. Never infer side from part number, IPN or common automotive knowledge. Actual Left versus Right contradictions require review. Preserve a verified side in generatedTitle.',
          'Within this one request, draft the title and compare it with every selected original source row and applicable UI rule. If a supported qualifier is needed to keep the title\'s implied fitment accurate, revise generatedTitle before returning JSON; remove repeated wording and optional enrichment first. Return Needs Review only if the evidence leaves a genuine material ambiguity/conflict or no truthful title fits within 80 characters including SKU. If a qualifier can be safely omitted without broadening fitment or misleading part selection, use omitted-safe and give a concise reason. After any revision, recount the final title against the 80-character limit including spaces and final SKU, and verify configured Title Structure order. Return only the final title and final decision, never an intermediate draft. titleReviewStatus is the sole final title disposition; materialRestrictions explain that decision and must agree with it, but a detail entry by itself does not independently change the final status. For Completed, every genuinely limiting qualifier must be stated or explicitly classified omitted-safe with a reason. Correct any unsupported, contradictory, or meaning-changing wording before returning JSON.',
          'Return Needs Review only when the supplied evidence contains a genuine material conflict or ambiguity that cannot be resolved safely under the configured rules. Do not request review for harmless abbreviation, capitalization, equivalent terminology, removal of generic connector words, or omission of nonmaterial redundant wording.',
          'Use professional title capitalization throughout generatedTitle while preserving conventional uppercase abbreviations, identifiers, part numbers, and SKU formatting.',
          'Donor vehicle year/model describe where the part came from, not every compatible application. Keep them separate from advertised fitment. Do not treat other compatible vehicles in Part Fitment as conflicting listing identities or require every application in the title. Select the application supported by the current title and approved identity fields; flag an unresolved actual identity conflict.',
          'Follow the selectedTitleStructure segments strictly. Use its exact field and literal segment order as the pattern for this listing. Include every required segment; for optional=true segments, include the verified value when useful and safe, or omit it only when unavailable, unsupported, unauthorized by applicable rules, or necessary to preserve a more important material fitment or identity detail. Never omit a required segment merely for style or convenience.',
          'Use titleEvidence.partFitment to select rows matching the advertised application. Multiple rows do not require review merely because they contain other compatible vehicles, trims, body styles, or adjacent year segments.',
          'Treat a single structured year as identity context, not authority to narrow fitment. When titleFitmentCandidates.advertisedApplicationHint includes a yearRange, that range comes from the existing title Fits clause and describes advertised compatibility, not the donor vehicle. Preserve the full range in vehicleDecision and generatedTitle when cited rows for the same make/model continuously support it and its material qualifiers can be represented accurately. Never narrow it to a single structured or donor year, and never expand beyond continuously cited fitment. Keep year- or variant-specific restrictions scoped to only the years or variants they affect; do not apply a limited-year restriction to the whole range. If the advertised range is unsupported, use only the supported coverage and request review only for a genuine unresolved material conflict.',
          'A single donor year does not override compatible fitment years. Select the advertised application under evidencePolicy and explain any unresolved coverage conflict.',
          'Use titleEvidence.currentTitleYearFallback only when Part Fitment is unavailable. If the existing title supplies a supported advertised range in that case, preserve the range rather than silently narrowing it to the donor year. If the range is not supportable from supplied evidence, explain that specific uncertainty instead of marking a narrowed title Completed.',
          'Do not combine rows from different makes or models, expand beyond cited evidence, or bridge a gap between unsupported years. Qualifier differences matter only when they contradict the advertised item or would make the title inaccurate.',
          'Compare side and placement across the existing title and all supplied authoritative listing evidence. Do not infer a side from common usage. If reliable sources genuinely conflict and source priority cannot resolve the correct side, return Needs Review; otherwise use the supported side. The existing title is evidence to assess, not an automatic override.',
          'For compressed model identifiers, AI may normalize from current title and titleEvidence.partFitment only when the clear model names are corroborated; preserve all corroborated model names.',
          'Evaluate every Category Rule priority detail against categoryPriorityEvidenceSources and return one categoryPriorityDetails decision for each configured detail.',
          'Mark a Category Rule detail verified only when supplied trusted evidence supports it directly or through an applicable approved terminology rule or synonym.',
          'A citation must establish the specific detail, not merely the broad category or part identity. Generic category names do not verify specific features. Negated or absent features are not verified.',
          'The cited evidence must contain the detail or its applicable configured terminology/synonym equivalent. If wording cannot be corroborated through those approved equivalents, mark the detail unverified. Do not treat a Prefix Rule replacement as a listing-source citation; its authority is separate.',
          'For each verified Category Rule detail, put the exact supporting categoryPriorityEvidenceSources id in source and cite a verbatim evidence excerpt. Mark unsupported details unverified with null source and evidence.',
          'Use only verified Category Rule priority details in generatedTitle. Never infer or invent an unverified Category Rule detail.',
          'Category details are optional priorities: omit an unsupported optional detail without requesting review solely for its absence. Return only the exact configured detail names, each once; return an empty array when no Category Rule details are configured.',
          'Do not request review solely for an omitted optional detail, unused restricted term, citation format, or a cosmetic descriptor that does not change the buyer\'s product or fitment decision. Keep the selected UI structure and every material fitment restriction accurate.',
          'An applicable deterministic Prefix Rule replacement remains authoritative independently of Category Rule detail verification.',
          'Return materialRestrictions for applicable qualifiers that affect the selected application. For each entry, provide sourceRowIds using the exact IDs from sourceRows, a verbatim evidence excerpt from those rows, the exact year/variant scope in appliesTo, material, titleTreatment, and omissionReason (empty except for omitted-safe). When no parsed fitment row exists, cite the exact supporting categoryPriorityEvidenceSources evidence ID; never invent citations. Use null evidence only when supplied sources have no supporting excerpt. Use included when the final title states the qualifier or a concise supported equivalent; not-applicable-to-selected-application when it does not apply; omitted-safe only when omission does not broaden the title\'s implied compatibility or mislead part selection; needs-review only for a genuine unresolved material ambiguity/conflict or a qualifier that cannot be represented truthfully within 80 characters after optional wording is removed. Do not use needs-review merely to mean a detail was considered or is absent. Source presence alone does not make a detail restrictive, and a fixed keyword list must not decide materiality. The overall titleReviewStatus is the final disposition: Completed requires a truthful title and consistent restriction decisions; Needs Review requires a concise reason for the unresolved issue. Never use a detail-level flag alone to contradict that final decision. Description and notes do not repair missing title fitment. Mark nonmaterial details material=false.',
          'Do not justify an omission with general automotive or product knowledge; ground every qualifier decision and omitted-safe reason in the supplied selected source rows and configured UI rules. Do not justify omission with unsupported claims such as “this model has only one” or “all years have this feature.” Absence of a qualifier from a row is unknown, not proof that the qualifier applies or does not apply; do not claim a qualifier applies to every selected row unless each cited row supports it. Scope sourceRowIds and appliesTo to the exact rows, years, and variants that support the qualifier. If available evidence cannot resolve whether omitting it would materially change compatibility or buyer part selection, include it when it can be stated truthfully within 80 characters; otherwise return Needs Review. For a safely omitted nonmaterial detail, give only an evidence-grounded reason and make no unsupported universal claim.',
          'Return restrictedTermDecisions only for configured terms actually used in generatedTitle, using each exact configured term once. Never include a never-introduce or remove-noise term. The stored requires-authorization rule type is presented to users as AI Evidence Check: it does not require separate human approval. For each such term, inspect all supplied listing evidence, decide whether it confirms the claim for this item, and include it only when supported. Set evidenceVerified=true and cite the exact supplied categoryPriorityEvidenceSources ID plus a supporting excerpt; if unsupported, omit the term. A configured rule or an unsupported claim in the existing title is not proof by itself. Return an empty array when no restricted term is used.',
          'Return exactly one titleSegments entry for every required segment in selectedTitleStructure, using that segment key. An optional=true segment may be omitted from titleSegments or returned with an empty value when its value is unavailable, unsupported, unauthorized by applicable rules, or would displace more important verified fitment. For a supplied literal segment, return its configured label exactly. The runtime assembles generatedTitle from titleSegments in the configured order, inserts configured literals, and places the verified SKU exactly once at the end (even if the UI structure lists SKU elsewhere). Ensure generatedTitle contains exactly the composed segment wording and never put title wording outside titleSegments.',
          'Return ruleSelfAudit after finalizing: confirm structureFollowed, unresolvedSourceConflict, unsupportedClaim, and concise notes. In ruleSelfAudit notes, compare the existing title with the final generatedTitle for advertised year coverage, product identity, material restrictions, and applicable UI rules. Completed requires every applicable materialRestrictions entry to agree with the final title, not an earlier draft; safe omissions must be explicitly classified and explained, no unresolved needs-review restriction may remain, and all three safety booleans must indicate a safe result.',
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
      : 'Assess the existing title against supplied evidence and all applicable rules first; retain it exactly when compliant, otherwise create a safe corrected title.',
    'System Rules in the payload are mandatory.',
    'Apply evidencePolicy consistently when selecting facts, composing the title, and deciding review status.',
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
