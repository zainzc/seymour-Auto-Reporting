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
    mode: 'shadow-only',
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
  assert.equal(first.runtimeMode, 'shadow-only');
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
});

test('serializes resolved evidence, conflicts, description-only partFitment, and no-degrade context', () => {
  const artifact = buildTitleOptimizationRuntimePrompt(buildInputs());
  const titlePolicy = artifact.userPayload.titlePolicy;
  const listing = artifact.userPayload.resolvedListing;

  assert.equal(listing.authoritativeValues.brandMake.value, 'Honda');
  assert.equal(listing.authoritativeValues.brandMake.source, 'itemSpecifics');
  assert.equal(listing.supportingAndConflictingEvidence.brandMake.conflicts[0].value, 'Toyota');
  assert.equal(listing.descriptionOnly.partFitment.value, 'Fits 2011 Honda Accord from donor vehicle');
  assert.equal(listing.descriptionOnly.partFitment.titleIdentityAllowed, false);
  assert.equal(artifact.userPayload.existingTitle.currentTitle, '2011 Honda Door Mirror 00123');
  assert.equal(artifact.userPayload.existingTitle.finalNoDegradeDecisionInThisPhase, false);
  assert.match(JSON.stringify(titlePolicy), /Do not use description-only partFitment/i);
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
    'Title Override Status': 'Manual Override',
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
