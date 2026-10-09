const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAndResolveListing } = require('../src/services/titleOptimizationRuntimeSourceResolutionService');
const { resolveApplicableTitleOptimizationRules } = require('../src/services/titleOptimizationRuntimeRuleResolutionService');
const { buildTitleOptimizationRuntimePrompt } = require('../src/services/titleOptimizationRuntimePromptBuilderService');

function section(items, extras = {}) {
  return { available: true, items, warnings: [], warningCount: 0, ...extras };
}

function snapshot(overrides = {}) {
  const base = {
    mode: 'authoritative',
    runtimeReady: true,
    blockingSections: [],
    metadata: { configurationVersion: 'v5' },
    sections: {
      sourceFields: section([
        { id: 'source-existingTitle', logicalKey: 'existingTitle', sourceFieldName: 'Item Title', enabled: true },
        { id: 'source-manualOverrideStatus', logicalKey: 'manualOverrideStatus', sourceFieldName: 'Title Override Status', enabled: true },
        { id: 'source-manualOverrideTitle', logicalKey: 'manualOverrideTitle', sourceFieldName: 'Manual Override Title', enabled: true },
        { id: 'source-sku', logicalKey: 'sku', sourceFieldName: 'SKU', enabled: true },
        { id: 'source-ipnPrefix', logicalKey: 'ipnPrefix', sourceFieldName: 'IPN', enabled: true },
        { id: 'source-brandMake', logicalKey: 'brandMake', sourceFieldName: 'C:Brand', enabled: true },
        { id: 'source-categoryPart', logicalKey: 'categoryPart', sourceFieldName: 'Category Name', enabled: true },
        { id: 'source-itemSpecifics', logicalKey: 'itemSpecifics', sourceFieldName: 'Item Specifics', enabled: true },
        { id: 'source-conditionsOptions', logicalKey: 'conditionsOptions', sourceFieldName: 'Conditions & Options', enabled: true },
        { id: 'source-manufacturerPartNumber', logicalKey: 'manufacturerPartNumber', sourceFieldName: 'MPN', enabled: true }
      ]),
      sourcePriority: section([
        { key: 'manualOverride', priority: 1 },
        { key: 'lockedFixedIpn', priority: 2 },
        { key: 'itemSpecifics', priority: 3 },
        { key: 'categoryConditions', priority: 4 },
        { key: 'manufacturerPartNumber', priority: 5 },
        { key: 'brandMake', priority: 6 },
        { key: 'otherStructuredFields', priority: 7 },
        { key: 'currentEbay', priority: 8 },
        { key: 'rawHollander', priority: 9 }
      ]),
      terminologyRules: section([
        { id: 'term-10', sourceTerm: 'Door Mirror', replacementTerm: 'Side View Mirror', action: 'replace', condition: 'always', appliesTo: 'all', priority: 10, enabled: true },
        { id: 'term-disabled', sourceTerm: 'Disabled', replacementTerm: 'No', action: 'replace', condition: 'always', appliesTo: 'all', priority: 20, enabled: false }
      ]),
      synonyms: section([
        { id: 'syn-10', primaryTerm: 'Side View Mirror', synonyms: ['Door Mirror'], condition: 'always', appliesTo: 'all', priority: 10, enabled: true }
      ], { enabled: true }),
      prefixRules: section([
        { id: 'prefix-257', prefix: '257', approvedPartTerms: ['Speedometer', 'Instrument Cluster'], note: 'Use #SKU context only when confirmed.', priority: 10, enabled: true },
        { id: 'prefix-0641', prefix: '0641', approvedPartTerms: ['Master Power Window Switch'], priority: 20, enabled: true }
      ]),
      restrictedTerms: section([
        { id: 'client-v5-long-block', term: 'Long Block', ruleType: 'never-introduce', scope: 'engine', locked: true, priority: 10, enabled: true },
        { id: 'noise', term: 'OEM Part', ruleType: 'remove-noise', scope: 'all', priority: 20, enabled: true },
        { id: 'protect', term: 'ABS', ruleType: 'must-preserve', scope: 'all', priority: 30, enabled: true }
      ]),
      categoryRules: section([
        { id: 'cat-mirror', categoryName: 'Mirrors', prefixRefs: [], seriesRefs: [], priorityDetails: ['Adjustment', 'Type'], note: 'Use mirror adjustment only when verified.', origin: 'client-v5', seedOrder: 3, enabled: true },
        { id: 'cat-prefix', categoryName: 'Window Switches', prefixRefs: ['0641'], seriesRefs: [], priorityDetails: ['Switch Type'], note: 'Prefix matched switch context.', origin: 'custom', enabled: true }
      ]),
      titleStructures: section([
        { id: 'structure-general', structureName: 'General', appliesTo: 'General / Default', segments: [
          { key: 'yearOrRange', label: 'Year / Year Range', kind: 'field' },
          { key: 'part', label: 'Part', kind: 'field' },
          { key: 'sku', label: 'SKU', kind: 'field' }
        ], origin: 'client-v5', seedOrder: 1, enabled: true },
        { id: 'structure-engine', structureName: 'Engines', appliesTo: 'Engines', segments: [
          { key: 'engineLiteral', label: 'Engine', kind: 'literal' },
          { key: 'sku', label: 'SKU', kind: 'field' }
        ], origin: 'client-v5', seedOrder: 2, enabled: true },
        { id: 'structure-trans', structureName: 'Transmissions', appliesTo: 'Transmissions', segments: [
          { key: 'automaticTransmissionLiteral', label: 'Automatic Transmission', kind: 'literal' },
          { key: 'sku', label: 'SKU', kind: 'field' }
        ], origin: 'client-v5', seedOrder: 3, enabled: true },
        { id: 'structure-custom-mirror', structureName: 'Mirror Structure', appliesTo: 'Mirrors', segments: [
          { key: 'part', label: 'Part', kind: 'field' },
          { key: 'withLiteral', label: 'with', kind: 'literal' },
          { key: 'sku', label: 'SKU', kind: 'field' }
        ], origin: 'custom', enabled: true }
      ]),
      flagReasons: section([
        { id: 'flag-1', reason: 'Missing verified year', origin: 'client-v5', seedOrder: 1, required: true, enabled: true },
        { id: 'flag-2', reason: 'Conflicting source data', origin: 'client-v5', seedOrder: 2, required: true, enabled: true },
        { id: 'flag-custom', reason: 'Custom QA Reason', origin: 'custom', required: false, enabled: true }
      ]),
      systemRules: section([
        { id: 'SR-01', title: 'Never Guess or Invent', behavior: 'Never invent unsupported fitment or product information.', order: 1, category: 'Safety', version: 'v5', locked: true },
        { id: 'SR-05', title: 'SKU Exactly Once at End', behavior: 'SKU must appear exactly once. SKU belongs at the end.', order: 5, category: 'SKU', version: 'v5', locked: true },
        { id: 'SR-06', title: 'Prefix 257 #SKU Exception', behavior: '#SKU is valid for confirmed cluster/speedometer/gauge listings.', order: 6, category: 'SKU', version: 'v5', locked: true },
        { id: 'SR-07', title: '80 Character Maximum', behavior: 'Maximum title length: 80 characters. Never truncate a word.', order: 7, category: 'Length', version: 'v5', locked: true },
        { id: 'SR-14', title: 'No-Degrade / Idempotency', behavior: 'Do not replace an existing title if the proposal would be worse.', order: 14, category: 'Protection', version: 'v5', locked: true }
      ])
    },
    warnings: [],
    unavailableSections: [],
    ...overrides
  };
  return base;
}

function buildInputs(fieldOverrides = {}, snapshotOverrides = {}) {
  const runtimeSnapshot = snapshot(snapshotOverrides);
  const listingResolution = normalizeAndResolveListing({
    runtimeSnapshot,
    listingRecord: {
      id: 'rec-1',
      fields: {
        'Item Title': '2011 Honda Door Mirror 00123',
        SKU: '00123',
        IPN: '0641-00641L',
        'C:Brand': 'Toyota',
        'Category Name': 'Mirrors',
        'Conditions & Options': 'Power door mirror',
        MPN: 'MPN-9',
        'Item Specifics': JSON.stringify({ 'C:Brand': 'Honda', 'C:Part': 'Mirrors', Series: '300 Series' }),
        ...fieldOverrides
      }
    },
    masterRecord: { fields: { 'Part Fitment': 'Fits 2011 Honda Accord from donor vehicle' } },
    fields: ['title', 'brandMake', 'part', 'manufacturerPartNumber', 'sku', 'year']
  });
  const applicableRules = resolveApplicableTitleOptimizationRules({ runtimeSnapshot, listingResolution });
  return { runtimeSnapshot, listingResolution, applicableRules };
}

test('builds deterministic prompt artifact with output contract and no giant prompt dependency', () => {
  const inputs = buildInputs();
  const first = buildTitleOptimizationRuntimePrompt({ ...inputs, phase74TitleRulesPrompt: 'GIANT PROMPT SHOULD NOT APPEAR' });
  const second = buildTitleOptimizationRuntimePrompt({ ...inputs, phase74TitleRulesPrompt: 'DIFFERENT GIANT PROMPT' });

  assert.deepEqual(second, first);
  assert.equal(first.runtimeMode, 'authoritative');
  assert.equal(first.metadata.configurationVersion, 'v5');
  assert.equal(first.metadata.selectedStructureId, 'structure-custom-mirror');
  assert.deepEqual(first.metadata.applicableTerminologyRuleIds, ['term-10']);
  assert.deepEqual(first.metadata.applicableSynonymRuleIds, ['syn-10']);
  assert.equal(first.metadata.prefixRuleId, 'prefix-0641');
  assert.deepEqual(first.metadata.categoryRuleIds, ['cat-mirror', 'cat-prefix']);
  assert.deepEqual(first.metadata.systemRuleIds, ['SR-01', 'SR-05', 'SR-06', 'SR-07', 'SR-14']);

  const text = `${first.systemMessage}\n${JSON.stringify(first.userPayload)}`;
  assert.doesNotMatch(text, /GIANT PROMPT|DIFFERENT GIANT PROMPT/);
  assert.match(text, /valid JSON only/i);
  for (const key of ['generatedTitle', 'generatedDescription', 'shortDescription', 'reasoningSummary', 'titleReviewStatus', 'titleReviewReason', 'titleReviewNotes']) {
    assert.match(text, new RegExp(key));
  }
  assert.match(text, /80 characters.*hard maximum/i);
  assert.match(text, /65 characters.*target/i);
  assert.match(text, /not.*minimum/i);
  assert.match(text, /AI has selection priority for the Year \/ Year Range segment/i);
  assert.match(text, /follow the selectedTitleStructure segments strictly/i);
  assert.match(text, /do not keep raw fitment wording/i);
  assert.doesNotMatch(text, /resolved authoritative year or yearRange/i);
  assert.doesNotMatch(text, /13-15/);
});

test('serializes resolved evidence, conflicts, title-authority partFitment, and no-degrade context', () => {
  const artifact = buildTitleOptimizationRuntimePrompt(buildInputs());
  const titlePolicy = artifact.userPayload.titlePolicy;
  const listing = artifact.userPayload.resolvedListing;

  assert.equal(listing.authoritativeValues.brandMake.value, 'Honda');
  assert.equal(listing.authoritativeValues.brandMake.source, 'itemSpecifics');
  assert.equal(listing.supportingAndConflictingEvidence.brandMake.conflicts[0].value, 'Toyota');
  assert.equal(listing.titleEvidence.partFitment.value, 'Fits 2011 Honda Accord from donor vehicle');
  assert.equal(listing.titleEvidence.partFitment.titleIdentityAllowed, true);
  assert.equal(listing.missing.includes('year'), false);
  assert.equal(artifact.userPayload.existingTitle.currentTitle, '2011 Honda Door Mirror 00123');
  assert.equal(artifact.userPayload.existingTitle.finalNoDegradeDecisionInThisPhase, false);
  assert.match(JSON.stringify(titlePolicy), /Part Fitment is title evidence/i);
});

test('AI payload prefers exact reuse only after checking the current title against all applicable rules', () => {
  const artifact = buildTitleOptimizationRuntimePrompt(buildInputs());
  const instructions = artifact.userPayload.titlePolicy.instructions.join(' ');

  assert.equal(artifact.userPayload.existingTitle.currentTitle, '2011 Honda Door Mirror 00123');
  assert.match(instructions, /assess the existing title before drafting a replacement/i);
  assert.match(instructions, /exactly unchanged/i);
  assert.match(instructions, /selectedTitleStructure/i);
  assert.match(instructions, /applicable.*UI rules/i);
  assert.match(instructions, /80.character.*SKU/i);
  assert.match(instructions, /do not rewrite.*cosmetic/i);
  assert.match(instructions, /rewrite.*only when/i);
});

test('sends title-year fallback and general AI redundancy instructions', () => {
  const inputs = buildInputs();
  inputs.listingResolution.normalized.titleAuthority = {
    partFitment: { value: null, titleAuthority: true },
    titleYearFallback: { value: '2013-2015', source: 'currentEbay', fallbackOnly: true },
    importantExistingTitleDetails: [
      { key: 'bodyStyle', value: 'Coupe', acceptedValues: ['Coupe'] },
      { key: 'emissions', value: 'Federal Emissions', acceptedValues: ['Federal Emissions', 'Federal'] }
    ]
  };

  const artifact = buildTitleOptimizationRuntimePrompt(inputs);
  const evidence = artifact.userPayload.resolvedListing.titleEvidence;
  const text = JSON.stringify(artifact.userPayload);

  assert.equal(evidence.partFitment.value, null);
  assert.equal(evidence.currentTitleYearFallback.value, '2013-2015');
  assert.equal(evidence.currentTitleYearFallback.useOnlyWhenPartFitmentUnavailable, true);
  assert.equal(evidence.importantExistingTitleDetails, undefined);
  assert.match(text, /Keep useful verified details when the title fits within 80 characters/);
  assert.match(text, /Do not rely on a fixed list of protected words/);
  assert.match(text, /exact field and literal segment order/);
  assert.match(text, /Final audit: compare every material vehicle, fitment, product, and side claim/);
  assert.match(text, /Replace duplicate wording with useful verified details/);
  assert.match(text, /recount the title including spaces and final SKU/);
  assert.match(text, /Never wrap an evidence citation in quotation marks/);
  assert.match(text, /remaining characters for the highest-impact useful qualifiers/);
  assert.equal(artifact.userPayload.outputContract.requiredJsonKeys.includes('detailAssessment'), false);
});

test('sends every resolved client-critical fitment field as authoritative evidence', () => {
  const inputs = buildInputs();
  const values = {
    engineDisplacement: '2.4L', engineCode: 'K24W1', transmissionCode: 'CVT2',
    drivetrain: 'FWD', transmissionSpeedType: '6-Speed', vinIdentifier: 'VIN 1',
    illumination: 'Illuminated', paintCode: 'NH731P', trim: 'EX-L', lightingTechnology: 'LED'
  };
  for (const [field, value] of Object.entries(values)) {
    inputs.listingResolution.resolved.fields[field] = {
      field, resolvedValue: value, resolvedSource: 'itemSpecifics', candidates: [], conflicts: [], missing: false
    };
  }

  const artifact = buildTitleOptimizationRuntimePrompt(inputs);
  for (const [field, value] of Object.entries(values)) {
    assert.equal(artifact.userPayload.resolvedListing.authoritativeValues[field].value, value);
    assert.equal(artifact.userPayload.resolvedListing.supportingAndConflictingEvidence[field].deterministicWinner, 'itemSpecifics');
  }
});

test('treats a structured single year as evidence while AI selects a supported fitment range', () => {
  const inputs = buildInputs();
  inputs.listingResolution.resolved.fields.year = {
    field: 'year',
    candidates: [{ source: 'otherStructuredFields', value: '2011', priority: 7 }],
    conflicts: [],
    resolvedValue: '2011',
    resolvedSource: 'otherStructuredFields',
    missing: false
  };

  const artifact = buildTitleOptimizationRuntimePrompt(inputs);
  const listing = artifact.userPayload.resolvedListing;
  const text = JSON.stringify(artifact.userPayload);

  assert.equal(listing.authoritativeValues.year, undefined);
  assert.equal(listing.supportingAndConflictingEvidence.year.deterministicWinner, 'otherStructuredFields');
  assert.equal(listing.supportingAndConflictingEvidence.year.aiMayOverrideWinner, true);
  assert.match(text, /single structured year is evidence/i);
  assert.match(text, /advertised application/i);
  assert.match(text, /cite.*supporting/i);
  assert.match(text, /adjacent/i);
  assert.match(text, /evaluate the supplied Part Fitment rows/i);
  assert.match(text, /donor year alone cannot select or narrow/i);
  assert.match(text, /restrictions that apply to only part of the combined range/i);
  assert.match(text, /do not drop verified advertised years/i);
  assert.match(text, /cite every selected row ID in source/i);
  assert.match(text, /build dates, VIN splits, engine or transmission variants, body styles, trims, cab types, door counts/i);
  assert.match(text, /malformed, impossible, or internally inconsistent/i);
  assert.match(text, /cannot be represented accurately within 80 characters/i);
  assert.match(text, /before drafting generatedTitle.*material restrictions/i);
  assert.match(text, /optional.*part number.*before.*fitment restriction/i);
  assert.equal(listing.titleFitmentCandidates.decisionPolicy.owner, 'AI');
  assert.deepEqual(listing.titleFitmentCandidates.decisionPolicy.allowedOutcomes, [
    'COMBINE_COMPATIBLE_CONTINUOUS_ROWS',
    'UNRESOLVED_MATERIAL_QUALIFIER_CONFLICT'
  ]);
  assert.match(text, /ordinary compatibility rows/i);
  assert.match(text, /genuine contradiction/i);
});

test('keeps distinct fitment applications ambiguous even when donor facts match one candidate', () => {
  const inputs = buildInputs();
  inputs.listingResolution.resolved.fields.year = {
    field: 'year', candidates: [], conflicts: [], resolvedValue: '2005',
    resolvedSource: 'otherStructuredFields', missing: false
  };
  inputs.listingResolution.resolved.fields.brandMake = {
    field: 'brandMake', candidates: [], conflicts: [], resolvedValue: 'Hyundai',
    resolvedSource: 'itemSpecifics', missing: false
  };
  inputs.listingResolution.resolved.fields.model = {
    field: 'model', candidates: [], conflicts: [], resolvedValue: 'Accent',
    resolvedSource: 'itemSpecifics', missing: false
  };
  inputs.listingResolution.normalized.titleAuthority.partFitment.value =
    'Fits 2001-2005 Hyundai Accent throttle body 1.6L DOHC; 2006 Hyundai Accent throttle body 1.6L DOHC Canada market hatchback 3-door; 2006 Hyundai Accent throttle body 1.6L DOHC Canada market hatchback 5-door';

  const artifact = buildTitleOptimizationRuntimePrompt(inputs);
  const selection = artifact.userPayload.resolvedListing.titleFitmentCandidates;

  assert.equal(selection.status, 'MULTIPLE_DISTINCT_APPLICATIONS');
  assert.equal(selection.resolution, 'AMBIGUOUS');
  assert.equal(selection.candidates.length, 2);
  assert.equal(selection.distinctApplications.length, 2);
  assert.equal(selection.candidates[0].id, 'title-fitment-001');
  assert.match(selection.candidates[0].evidence, /2001-2005 Hyundai Accent/);
  assert.match(JSON.stringify(selection.candidates), /2006 Hyundai Accent/);
  assert.match(selection.candidates[1].evidence, /hatchback 3-door/);
  assert.match(selection.candidates[1].evidence, /hatchback 5-door/);
  assert.deepEqual(selection.selectionFacts.appliedFilters, []);
});

test('keeps separate fitment candidates when trusted data cannot safely narrow them', () => {
  const inputs = buildInputs();
  inputs.listingResolution.resolved.fields.year = {
    field: 'year', candidates: [], conflicts: [], resolvedValue: null,
    resolvedSource: null, missing: true
  };
  inputs.listingResolution.normalized.titleAuthority.partFitment.value =
    'Fits 2001-2005 Hyundai Accent throttle body; 2006 Hyundai Accent hatchback 3-door';

  const selection = buildTitleOptimizationRuntimePrompt(inputs).userPayload.resolvedListing.titleFitmentCandidates;

  assert.equal(selection.status, 'MULTIPLE_DISTINCT_APPLICATIONS');
  assert.equal(selection.resolution, 'AMBIGUOUS');
  assert.equal(selection.candidates.length, 2);
  assert.notEqual(selection.candidates[0].id, selection.candidates[1].id);
});

test('newline-delimited fitment rows keep independent year-scoped evidence', () => {
  const inputs = buildInputs({ 'Item Title': '2014 Nissan Starter Fits 08-15 ROGUE 1234567' });
  inputs.listingResolution.normalized.fields.existingTitle.value =
    '2014 Nissan Starter Fits 08-15 ROGUE 1234567';
  inputs.listingResolution.normalized.titleAuthority.partFitment.value =
    '2008-2013 Nissan Rogue Starter\n2014-2015 Nissan Rogue Starter VIN J';
  const selection = buildTitleOptimizationRuntimePrompt(inputs).userPayload.resolvedListing.titleFitmentCandidates;
  assert.deepEqual(selection.eligibleCandidates.map(row => [row.startYear, row.endYear]), [
    [2008, 2013], [2014, 2015]
  ]);
});

test('restricts eligible fitment candidates to the application advertised after Fits', () => {
  const inputs = buildInputs({
    'Item Title': '2008 Jeep Liberty Starter Motor Fits 07-09 NITRO 04801292AC 1589513'
  });
  inputs.listingResolution.resolved.fields.year = {
    field: 'year', candidates: [], conflicts: [], resolvedValue: '2008',
    resolvedSource: 'otherStructuredFields', missing: false
  };
  inputs.listingResolution.resolved.fields.brandMake = {
    field: 'brandMake', candidates: [], conflicts: [], resolvedValue: 'Jeep',
    resolvedSource: 'itemSpecifics', missing: false
  };
  inputs.listingResolution.resolved.fields.model = {
    field: 'model', candidates: [], conflicts: [], resolvedValue: 'Liberty',
    resolvedSource: 'currentEbay', missing: false
  };
  inputs.listingResolution.normalized.fields.existingTitle.value =
    '2008 Jeep Liberty Starter Motor Fits 07-09 NITRO 04801292AC 1589513';
  inputs.listingResolution.normalized.titleAuthority.partFitment.value =
    '2007-2009 Dodge Nitro Starter Motor 3.7L; 2008-2012 Jeep Liberty Starter Motor 3.7L';

  const selection = buildTitleOptimizationRuntimePrompt(inputs).userPayload.resolvedListing.titleFitmentCandidates;

  assert.equal(selection.advertisedApplicationHint.modelText, 'NITRO');
  assert.equal(selection.selectionBasis, 'EXISTING_TITLE_FITS_APPLICATION');
  assert.equal(selection.eligibleCandidates.length, 1);
  assert.match(selection.eligibleCandidates[0].evidence, /Dodge Nitro/i);
  assert.doesNotMatch(selection.eligibleCandidates[0].evidence, /Jeep Liberty/i);
});

test('a title without Fits keeps its advertised model instead of switching to another compatible model', () => {
  const inputs = buildInputs({ 'Item Title': '1998-2005 Lexus GS300 Right Tail Light 1056292' });
  inputs.listingResolution.resolved.fields.model = {
    field: 'model', resolvedValue: 'GS300', resolvedSource: 'currentEbay', conflicts: [], missing: false
  };
  inputs.listingResolution.normalized.fields.existingTitle.value =
    '1998-2005 Lexus GS300 Right Tail Light 1056292';
  inputs.listingResolution.normalized.titleAuthority.partFitment.value =
    '1998-2005 Lexus GS300 right decklid tail light; 1998-2000 Lexus GS400 right decklid tail light';

  const selection = buildTitleOptimizationRuntimePrompt(inputs).userPayload.resolvedListing.titleFitmentCandidates;
  assert.equal(selection.selectionBasis, 'EXISTING_TITLE_MODEL_APPLICATION');
  assert.deepEqual(selection.eligibleCandidates.map(row => row.evidence), [
    '1998-2005 Lexus GS300 right decklid tail light'
  ]);
});

test('a no-Fits title identifies its unique advertised model even without a mapped model field', () => {
  const inputs = buildInputs({ 'Item Title': '1998-2005 Lexus GS300 Right Tail Light 1056292' });
  inputs.listingResolution.normalized.fields.existingTitle.value =
    '1998-2005 Lexus GS300 Right Tail Light 1056292';
  inputs.listingResolution.normalized.titleAuthority.partFitment.value =
    '1998-2005 Lexus GS300 right decklid tail light; 1998-2000 Lexus GS400 right decklid tail light';

  const selection = buildTitleOptimizationRuntimePrompt(inputs).userPayload.resolvedListing.titleFitmentCandidates;
  assert.equal(selection.selectionBasis, 'EXISTING_TITLE_MODEL_APPLICATION');
  assert.deepEqual(selection.eligibleCandidates.map(row => row.evidence), [
    '1998-2005 Lexus GS300 right decklid tail light'
  ]);
});

test('a short model name does not automatically select a longer distinct model', () => {
  const inputs = buildInputs({ 'Item Title': '2002 Ford Explorer Left Tail Light 382223' });
  inputs.listingResolution.normalized.fields.existingTitle.value =
    '2002 Ford Explorer Left Tail Light 382223';
  inputs.listingResolution.normalized.titleAuthority.partFitment.value =
    '2001-2005 Ford Explorer Sport Trac left tail light; 2001-2005 Ford Taurus left tail light';

  const selection = buildTitleOptimizationRuntimePrompt(inputs).userPayload.resolvedListing.titleFitmentCandidates;
  assert.equal(selection.selectionBasis, 'AI_APPLICATION_SELECTION');
  assert.equal(selection.eligibleCandidates.length, 2);
});

test('an unmatched advertised model is left for AI assessment without discarding source rows', () => {
  const inputs = buildInputs({ 'Item Title': '1998-2005 Lexus GS300 Right Tail Light 1056292' });
  inputs.listingResolution.resolved.fields.model = {
    field: 'model', resolvedValue: 'GS300', resolvedSource: 'currentEbay', conflicts: [], missing: false
  };
  inputs.listingResolution.normalized.fields.existingTitle.value =
    '1998-2005 Lexus GS300 Right Tail Light 1056292';
  inputs.listingResolution.normalized.titleAuthority.partFitment.value =
    '1998-2000 Lexus GS400 right decklid tail light';

  const selection = buildTitleOptimizationRuntimePrompt(inputs).userPayload.resolvedListing.titleFitmentCandidates;
  assert.equal(selection.selectionBasis, 'EXISTING_TITLE_MODEL_APPLICATION_UNMATCHED');
  assert.equal(selection.resolution, 'AI_SELECTION_REQUIRED');
  assert.equal(selection.eligibleCandidates.length, 1);
});

test('advertised application selection supports alphanumeric and multiword models', () => {
  const inputs = buildInputs({
    'Item Title': '2011 Lexus IS250 Starter Motor Fits 06-17 LEXUS IS350 2810031071 1591344'
  });
  inputs.listingResolution.normalized.fields.existingTitle.value =
    '2011 Lexus IS250 Starter Motor Fits 06-17 LEXUS IS350 2810031071 1591344';
  inputs.listingResolution.normalized.titleAuthority.partFitment.value =
    '2006-2017 Lexus IS350 Starter Motor; 2006-2015 Lexus IS250 Starter Motor';

  const selection = buildTitleOptimizationRuntimePrompt(inputs).userPayload.resolvedListing.titleFitmentCandidates;

  assert.equal(selection.advertisedApplicationHint.modelText, 'LEXUS IS350');
  assert.deepEqual(selection.eligibleCandidates.map(item => item.evidence), [
    '2006-2017 Lexus IS350 Starter Motor'
  ]);
});

test('advertised multiword model does not match a different model sharing its last word', () => {
  const inputs = buildInputs({ 'Item Title': '2008 Ford Starter Fits 08-10 TAURUS X 1234567' });
  inputs.listingResolution.normalized.fields.existingTitle.value =
    '2008 Ford Starter Fits 08-10 TAURUS X 1234567';
  inputs.listingResolution.normalized.titleAuthority.partFitment.value =
    '2008-2010 Ford Taurus X Starter; 2008-2010 Ford Model X Starter';
  const selection = buildTitleOptimizationRuntimePrompt(inputs).userPayload.resolvedListing.titleFitmentCandidates;
  assert.deepEqual(selection.eligibleCandidates.map(item => item.evidence), [
    '2008-2010 Ford Taurus X Starter'
  ]);
});

test('advertised model matches equivalent letter-number spacing without matching other models', () => {
  const inputs = buildInputs({ 'Item Title': '2011 Mazda Cluster Fits 10-11 MAZDA3 1234567' });
  inputs.listingResolution.normalized.fields.existingTitle.value =
    '2011 Mazda Cluster Fits 10-11 MAZDA3 1234567';
  inputs.listingResolution.normalized.titleAuthority.partFitment.value =
    '2010-2011 Mazda 3 Instrument Cluster; 2010-2011 Mazda 6 Instrument Cluster';
  const selection = buildTitleOptimizationRuntimePrompt(inputs).userPayload.resolvedListing.titleFitmentCandidates;
  assert.deepEqual(selection.eligibleCandidates.map(row => row.evidence), [
    '2010-2011 Mazda 3 Instrument Cluster'
  ]);
});

test('advertised application matching ignores trailing product qualifiers', () => {
  const inputs = buildInputs({
    'Item Title': '2011 Hyundai Alternator Fits 11-13 SONATA 110A 373002G150 1589899'
  });
  inputs.listingResolution.normalized.fields.existingTitle.value =
    '2011 Hyundai Alternator Fits 11-13 SONATA 110A 373002G150 1589899';
  inputs.listingResolution.normalized.titleAuthority.partFitment.value =
    '2011-2013 Hyundai Sonata Alternator VIN C; 2011-2013 Hyundai Elantra Alternator';

  const selection = buildTitleOptimizationRuntimePrompt(inputs).userPayload.resolvedListing.titleFitmentCandidates;

  assert.equal(selection.advertisedApplicationHint.modelText, 'SONATA');
  assert.deepEqual(selection.eligibleCandidates.map(item => item.evidence), [
    '2011-2013 Hyundai Sonata Alternator VIN C'
  ]);
});

test('unmatched advertised application retains its hint while exposing rows for AI assessment', () => {
  const inputs = buildInputs({
    'Item Title': '2008 Jeep Liberty Starter Motor Fits 07-09 NITRO 1589513'
  });
  inputs.listingResolution.normalized.fields.existingTitle.value =
    '2008 Jeep Liberty Starter Motor Fits 07-09 NITRO 1589513';
  inputs.listingResolution.normalized.titleAuthority.partFitment.value =
    '2008-2012 Jeep Liberty Starter Motor 3.7L';

  const selection = buildTitleOptimizationRuntimePrompt(inputs).userPayload.resolvedListing.titleFitmentCandidates;

  assert.equal(selection.selectionBasis, 'EXISTING_TITLE_FITS_APPLICATION_UNMATCHED');
  assert.equal(selection.status, 'ADVERTISED_APPLICATION_REQUIRES_NORMALIZATION');
  assert.equal(selection.resolution, 'AI_SELECTION_REQUIRED');
  assert.equal(selection.advertisedApplicationHint.modelText, 'NITRO');
  assert.equal(selection.eligibleCandidates.length, 1);
});

test('collapses equivalent duplicate fitment clauses into one unambiguous application', () => {
  const inputs = buildInputs();
  inputs.listingResolution.normalized.titleAuthority.partFitment.value =
    'Fits 2011-2014 Hyundai Sonata Sedan; 2011 - 2014 HYUNDAI SONATA sedan.';

  const selection = buildTitleOptimizationRuntimePrompt(inputs).userPayload.resolvedListing.titleFitmentCandidates;

  assert.equal(selection.status, 'ONE_DISTINCT_APPLICATION');
  assert.equal(selection.resolution, 'UNAMBIGUOUS');
  assert.equal(selection.candidates.length, 1);
  assert.equal(selection.distinctApplications.length, 1);
  assert.match(selection.candidates[0].evidence, /2011-2014 Hyundai Sonata Sedan/);
});

test('collapses same vehicle and year fitment variants into one title application', () => {
  const inputs = buildInputs();
  inputs.listingResolution.resolved.fields.year = {
    field: 'year', candidates: [], conflicts: [], resolvedValue: '2009',
    resolvedSource: 'otherStructuredFields', missing: false
  };
  inputs.listingResolution.resolved.fields.brandMake = {
    field: 'brandMake', candidates: [], conflicts: [], resolvedValue: 'Nissan',
    resolvedSource: 'itemSpecifics', missing: false
  };
  inputs.listingResolution.resolved.fields.model = {
    field: 'model', candidates: [], conflicts: [], resolvedValue: 'Altima',
    resolvedSource: 'itemSpecifics', missing: false
  };
  inputs.listingResolution.normalized.titleAuthority.partFitment.value =
    'Fits 2009 Nissan Altima Air Bag front center console Sedan Base; ' +
    '2009 Nissan Altima Air Bag front center console Sedan S; ' +
    '2009 Nissan Altima Air Bag front center console Sedan SE; ' +
    '2009 Nissan Altima Air Bag front center console Sedan SL';

  const selection = buildTitleOptimizationRuntimePrompt(inputs).userPayload.resolvedListing.titleFitmentCandidates;

  assert.equal(selection.status, 'ONE_DISTINCT_APPLICATION');
  assert.equal(selection.resolution, 'UNAMBIGUOUS');
  assert.equal(selection.candidates.length, 1);
  assert.equal(selection.candidates[0].startYear, 2009);
  assert.equal(selection.candidates[0].endYear, 2009);
  assert.equal(selection.candidates[0].variantEvidence.length, 4);
  assert.match(selection.candidates[0].evidence, /Sedan Base/);
  assert.match(selection.candidates[0].evidence, /Sedan SL/);
});

test('marks malformed fitment unavailable and requires another supplied source', () => {
  const inputs = buildInputs();
  inputs.listingResolution.normalized.titleAuthority.partFitment.value = 'Fits Hyundai Sonata, years unknown';

  const artifact = buildTitleOptimizationRuntimePrompt(inputs);
  const selection = artifact.userPayload.resolvedListing.titleFitmentCandidates;
  const instructions = JSON.stringify(artifact.userPayload.titlePolicy.instructions);

  assert.equal(selection.resolution, 'UNAVAILABLE');
  assert.deepEqual(selection.distinctApplications, []);
  assert.match(instructions, /cite approved source evidence/i);
});

test('reports impossible calendar dates as material fitment source issues', () => {
  const inputs = buildInputs();
  inputs.listingResolution.normalized.titleAuthority.partFitment.value =
    'Fits 2000-2003 Toyota Tundra master switch; ' +
    '2005 Toyota Tundra master switch, built through 09/31/04';

  const selection = buildTitleOptimizationRuntimePrompt(inputs)
    .userPayload.resolvedListing.titleFitmentCandidates;

  assert.deepEqual(selection.sourceIssues, [{
    code: 'INVALID_FITMENT_DATE',
    value: '09/31/04',
    evidence: '2005 Toyota Tundra master switch, built through 09/31/04',
    message: 'Part Fitment contains an invalid calendar date (09/31/04).'
  }]);
});

test('serializes selected structure, terminology, synonyms, prefix, categories, restricted terms, flags, and system rules only', () => {
  const artifact = buildTitleOptimizationRuntimePrompt(buildInputs());
  const policy = artifact.userPayload.titlePolicy;

  assert.deepEqual(policy.selectedTitleStructure.segments.map(segment => [segment.kind, segment.label]), [
    ['field', 'Part'],
    ['literal', 'with'],
    ['field', 'SKU']
  ]);
  assert.deepEqual(policy.terminologyRules.map(rule => rule.id), ['term-10']);
  assert.deepEqual(policy.synonyms.map(rule => rule.id), ['syn-10']);
  assert.equal(policy.synonymEnrichment.optional, true);
  assert.equal(policy.prefixRule.id, 'prefix-0641');
  assert.deepEqual(policy.categoryRules.map(entry => entry.id), ['cat-mirror', 'cat-prefix']);
  assert.deepEqual(Object.keys(policy.restrictedTerms.groups).sort(), ['must-preserve', 'remove-noise']);
  assert.deepEqual(policy.flagReasons.map(reason => reason.reason), ['Missing verified year', 'Conflicting source data', 'Custom QA Reason']);
  assert.deepEqual(policy.systemRules.map(rule => rule.id), ['SR-01', 'SR-05', 'SR-06', 'SR-07', 'SR-14']);
  assert.doesNotMatch(JSON.stringify(policy), /Disabled|term-disabled/);
  assert.equal(artifact.userPayload.outputContract.requiredJsonKeys.includes('safetyDecision'), false);
  assert.equal(artifact.userPayload.outputContract.requiredJsonKeys.includes('selectedTitleFacts'), false);
  assert.equal(artifact.userPayload.outputContract.requiredJsonKeys.includes('removedTitleDetails'), false);
  assert.match(JSON.stringify(policy.instructions), /Final audit: compare every material vehicle/i);
  assert.match(JSON.stringify(policy.instructions), /correct any unsupported, contradictory, or meaning-changing wording/i);
  assert.match(JSON.stringify(policy.instructions), /Needs Review only when/i);
  assert.match(JSON.stringify(policy.instructions), /included only when generatedTitle actually states/i);
  assert.doesNotMatch(JSON.stringify(policy.instructions), /optional_omission|claims array|safeToPublish/i);
});

test('omits synonym and prefix instructions when unavailable or unmatched without inventing fallback rules', () => {
  const inputs = buildInputs({ IPN: '777-00001' }, {
    sections: {
      ...snapshot().sections,
      synonyms: section(snapshot().sections.synonyms.items, { enabled: false })
    }
  });
  const artifact = buildTitleOptimizationRuntimePrompt(inputs);

  assert.equal(artifact.userPayload.titlePolicy.synonymEnrichment.enabled, false);
  assert.deepEqual(artifact.userPayload.titlePolicy.synonyms, []);
  assert.equal(artifact.userPayload.titlePolicy.prefixRule, null);
  assert.match(JSON.stringify(artifact.userPayload.warnings), /No matching Prefix Rule/);
});

test('includes 257 prefix rule with SR-06 context without deterministic SKU rewriting', () => {
  const artifact = buildTitleOptimizationRuntimePrompt(buildInputs({
    IPN: '257-12345',
    'Category Name': 'Unmapped',
    'Item Specifics': '{}'
  }));

  assert.equal(artifact.userPayload.titlePolicy.prefixRule.id, 'prefix-257');
  assert.equal(artifact.userPayload.titlePolicy.prefixRule.systemRule.id, 'SR-06');
  assert.equal(artifact.userPayload.titlePolicy.skuGuidance.deterministicRewriteInThisPhase, false);
  assert.match(JSON.stringify(artifact.userPayload.titlePolicy.skuGuidance), /SKU exactly once/i);
});

test('manual override returns title-generation bypass artifact while preserving description boundary', () => {
  const artifact = buildTitleOptimizationRuntimePrompt(buildInputs({
    'Title Override Status': 'Manually Approved',
    'Manual Override Title': 'Approved Manual Title'
  }));

  assert.equal(artifact.kind, 'title-generation-bypass');
  assert.equal(artifact.bypass.reason, 'manual_override');
  assert.equal(artifact.bypass.titleGenerationBypassed, true);
  assert.equal(artifact.userPayload.outputContract.requiredJsonKeys.includes('generatedDescription'), true);
  assert.equal(artifact.userPayload.descriptionPolicy.descriptionGenerationStillAllowed, true);
  assert.match(artifact.systemMessage, /do not create a replacement title/i);
  assert.doesNotMatch(artifact.systemMessage, /Use the supplied authoritative resolved values.*create a safe replacement title/i);
});

test('uses deterministic prefix replacement as the authoritative title part', () => {
  const runtimeSnapshot = snapshot({
    sections: {
      ...snapshot().sections,
      prefixRules: section([{
        id: 'prefix-629',
        prefix: '629',
        approvedPartTerms: ['Wiper Switch', 'Turn Signal Switch', 'Multifunction Switch'],
        specialTrigger: 'Column Switch',
        specialReplacement: 'Wiper / Turn Signal / Multifunction Switch',
        enabled: true
      }]),
      categoryRules: section([{
        id: 'cat-column',
        categoryName: 'Column Switch',
        prefixRefs: ['629'],
        seriesRefs: [],
        priorityDetails: ['Wiper / Turn Signal / Multifunction'],
        enabled: true
      }])
    }
  });
  const listingResolution = normalizeAndResolveListing({
    runtimeSnapshot,
    listingRecord: {
      id: 'rec-629',
      fields: {
        'Item Title': '2010-2012 Subaru Outback Column Switch Assembly 1459826',
        SKU: '1459826',
        IPN: '629-50937A',
        'C:Brand': 'Subaru',
        'Category Name': 'Switches & Controls',
        'Item Specifics': JSON.stringify({ 'C:Part': 'Column Switch Assembly' })
      }
    },
    masterRecord: { fields: { 'Part Fitment': 'Fits 2010-2012 Subaru Legacy Column Switch Assembly Outback, with fog lamps' } },
    fields: ['title', 'brandMake', 'model', 'part', 'year', 'yearRange', 'sku']
  });
  const applicableRules = resolveApplicableTitleOptimizationRules({ runtimeSnapshot, listingResolution });
  const artifact = buildTitleOptimizationRuntimePrompt({ runtimeSnapshot, listingResolution, applicableRules });

  assert.equal(applicableRules.deterministicTitlePart.value, 'Wiper Turn Signal Multifunction Switch');
  assert.equal(artifact.userPayload.resolvedListing.authoritativeValues.part.value, 'Column Switch Assembly');
  assert.equal(artifact.userPayload.resolvedListing.authoritativeValues.part.source, 'itemSpecifics');
  assert.equal(artifact.userPayload.titlePolicy.deterministicTitlePart.value, 'Wiper Turn Signal Multifunction Switch');
  assert.equal(artifact.userPayload.resolvedListing.authoritativeValues.yearRange, undefined);
  assert.equal(
    artifact.userPayload.resolvedListing.titleEvidence.partFitment.value,
    'Fits 2010-2012 Subaru Legacy Column Switch Assembly Outback, with fog lamps'
  );
});

test('keeps exact 629 model ambiguity reviewable without overriding source priority', () => {
  const inputs = buildInputs({
    'Item Title': '2010-2012 Subaru Outback Column Switch Assembly Station Wgn LEGACY 1459826',
    IPN: '629-50937A',
    'C:Brand': 'Subaru',
    'Category Name': 'Switches & Controls',
    'Item Specifics': JSON.stringify({ Model: 'OUTBAKLEG', 'C:Part': 'Column Switch Assembly' })
  }, {
    sections: {
      ...snapshot().sections,
      prefixRules: section([{
        id: 'prefix-629', prefix: '629', approvedPartTerms: ['Wiper Switch', 'Turn Signal Switch', 'Multifunction Switch'],
        specialTrigger: 'Column Switch', specialReplacement: 'Wiper / Turn Signal / Multifunction Switch', enabled: true
      }]),
      categoryRules: section([{ id: 'cat-column', categoryName: 'Column Switch', prefixRefs: ['629'], seriesRefs: [], priorityDetails: ['Wiper / Turn Signal / Multifunction'], enabled: true }]),
      flagReasons: section([
        ...snapshot().sections.flagReasons.items,
        { id: 'flag-model', reason: 'Model cannot be normalized safely', enabled: true }
      ])
    }
  });
  inputs.listingResolution.normalized.titleAuthority.partFitment.value = 'Fits 2010-2012 Subaru Legacy Column Switch Assembly Outback, with fog lamps';
  inputs.listingResolution.resolved.modelAmbiguity = {
    ambiguous: true,
    candidates: [{ value: 'OUTBAKLEG', sources: ['itemSpecifics'] }, { value: 'OUTBACK', sources: ['currentEbay'] }, { value: 'LEGACY', sources: ['currentEbay', 'partFitment'] }]
  };
  inputs.listingResolution.resolved.fields.model = { resolvedValue: 'OUTBAKLEG', resolvedSource: 'itemSpecifics', missing: false };
  const artifact = buildTitleOptimizationRuntimePrompt({
    ...inputs,
    applicableRules: {
      ...inputs.applicableRules,
      deterministicTitlePart: {
        value: 'Wiper Turn Signal Multifunction Switch',
        source: 'prefixRule.specialReplacement',
        ruleId: 'prefix-629'
      }
    }
  });

  assert.equal(artifact.userPayload.resolvedListing.authoritativeValues.model.value, 'OUTBAKLEG');
  assert.equal(artifact.userPayload.resolvedListing.supportingAndConflictingEvidence.model.aiMayOverrideWinner, true);
  assert.equal(artifact.userPayload.titlePolicy.deterministicTitlePart.value, 'Wiper Turn Signal Multifunction Switch');
  assert.equal(artifact.userPayload.resolvedListing.titleEvidence.partFitment.titleIdentityAllowed, true);
  assert.match(JSON.stringify(artifact.userPayload.titlePolicy), /compressed model identifiers/i);
  assert.match(JSON.stringify(artifact.userPayload.titlePolicy), /preserve all corroborated model names/i);
  assert.doesNotMatch(JSON.stringify(artifact.userPayload), /derive the best title|Choose the displayed title year/);
});

test('AI payload marks category details pending and supplies auditable evidence sources', () => {
  const inputs = buildInputs();
  const artifact = buildTitleOptimizationRuntimePrompt(inputs);
  const categoryDetails = artifact.userPayload.titlePolicy.categoryRules.flatMap(rule => rule.priorityDetails);
  const evidenceSources = artifact.userPayload.resolvedListing.categoryPriorityEvidenceSources;

  assert.equal(categoryDetails.every(item => item.verificationStatus === 'pending'), true);
  assert.equal(categoryDetails.every(item => typeof item.detail === 'string'), true);
  assert.equal(evidenceSources.some(item => item.source === 'Part Fitment'), true);
  assert.equal(evidenceSources.some(item => item.source.startsWith('Item Specifics:')), true);
  assert.equal(evidenceSources.every(item => /^evidence-\d{3}$/.test(item.id)), true);
  assert.equal(new Set(evidenceSources.map(item => item.id)).size, evidenceSources.length);
  assert.match(JSON.stringify(artifact.userPayload.titlePolicy.instructions), /only verified Category Rule priority details/i);
  assert.match(JSON.stringify(artifact.userPayload.outputContract), /categoryPriorityDetails/);
});

test('AI payload uses independently normalized category details and includes match provenance', () => {
  const inputs = buildInputs();
  const mirrorRule = inputs.applicableRules.categoryRules.find(entry => entry.rule.id === 'cat-mirror');
  mirrorRule.rule.priorityDetails = ['Wiper / Turn Signal / Multifunction'];
  mirrorRule.priorityDetails = ['Wiper', 'Turn Signal', 'Multifunction'];
  mirrorRule.matchEvidence = [{
    source: 'resolved-category-part',
    value: 'Mirrors',
    method: 'normalized-exact'
  }];

  const artifact = buildTitleOptimizationRuntimePrompt(inputs);
  const category = artifact.userPayload.titlePolicy.categoryRules.find(rule => rule.id === 'cat-mirror');

  assert.deepEqual(category.priorityDetails.map(item => item.detail), ['Wiper', 'Turn Signal', 'Multifunction']);
  assert.deepEqual(category.matchEvidence, mirrorRule.matchEvidence);
});

test('AI payload requires structured rule decisions from the same generation call', () => {
  const artifact = buildTitleOptimizationRuntimePrompt(buildInputs());
  const required = artifact.userPayload.outputContract.requiredJsonKeys;
  const instructions = JSON.stringify(artifact.userPayload.titlePolicy.instructions);

  assert.equal(artifact.userPayload.titlePolicy.listingClassification.family, 'general');
  for (const key of ['materialRestrictions', 'restrictedTermDecisions', 'titleSegments', 'ruleSelfAudit']) {
    assert.equal(required.includes(key), true, key);
  }
  assert.match(instructions, /materialRestrictions/);
  assert.match(instructions, /when no parsed fitment row exists.*evidence ID/i);
  assert.match(instructions, /restrictedTermDecisions/);
  assert.match(instructions, /ordinary listing evidence.*does not authorize/i);
  assert.match(instructions, /authorizesRestrictedTerms/i);
  assert.match(instructions, /only for configured terms actually used in generatedTitle/i);
  assert.doesNotMatch(instructions, /Return exactly one restrictedTermDecisions entry for every term/i);
  assert.match(instructions, /Do not request review solely for an omitted optional detail/i);
  assert.match(instructions, /explicit side.*existing title.*conflict/i);
  assert.match(instructions, /titleSegments/);
  assert.match(instructions, /ruleSelfAudit/);
});

test('exposes donor notes as optional material-detail evidence without making them mandatory', () => {
  const inputs = buildInputs();
  inputs.listingResolution.normalized.structured.currentEbayFields = {
    value: { donorNotes: 'W/ OUT STEERING SHAFT', donorStockNumber: '06947', donorYear: '2007' }
  };

  const artifact = buildTitleOptimizationRuntimePrompt(inputs);
  const listing = artifact.userPayload.resolvedListing;
  const text = JSON.stringify(artifact.userPayload.titlePolicy.instructions);

  assert.deepEqual(listing.listingNoteEvidence.map(item => item.evidence), ['W/ OUT STEERING SHAFT']);
  assert.equal(listing.listingNoteEvidence.some(item => /06947|2007/.test(item.evidence)), false);
  assert.match(text, /materially changes fitment, configuration, function, or what is included/i);
  assert.match(text, /Do not automatically include every note/i);
});

test('includes extracted legacy Description donor notes without sending legacy HTML', () => {
  const inputs = buildInputs();
  inputs.listingResolution.normalized.titleAuthority.legacyDonorNote = { value: 'TRUNK LATCH ACTUATOR' };
  const listing = buildTitleOptimizationRuntimePrompt(inputs).userPayload.resolvedListing;
  assert.deepEqual(listing.listingNoteEvidence.map(item => item.evidence), ['TRUNK LATCH ACTUATOR']);
  assert.equal(listing.categoryPriorityEvidenceSources.some(item =>
    item.source === 'Legacy Description Donor Note' && item.evidence === 'TRUNK LATCH ACTUATOR'), true);
});
