const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAndResolveListing } = require('../src/services/titleOptimizationRuntimeSourceResolutionService');
const {
  RuntimeRuleResolutionError,
  resolveApplicableTitleOptimizationRules
} = require('../src/services/titleOptimizationRuntimeRuleResolutionService');

function section(items, extras = {}) {
  return { available: true, items, warnings: [], warningCount: 0, ...extras };
}

function baseSnapshot(overrides = {}) {
  const snapshot = {
    mode: 'shadow-only',
    runtimeReady: true,
    blockingSections: [],
    sections: {
      sourceFields: section([
        { id: 'source-existingTitle', logicalKey: 'existingTitle', sourceFieldName: 'Item Title', enabled: true },
        { id: 'source-sku', logicalKey: 'sku', sourceFieldName: 'SKU', enabled: true },
        { id: 'source-ipnPrefix', logicalKey: 'ipnPrefix', sourceFieldName: 'IPN', enabled: true },
        { id: 'source-brandMake', logicalKey: 'brandMake', sourceFieldName: 'C:Brand', enabled: true },
        { id: 'source-categoryPart', logicalKey: 'categoryPart', sourceFieldName: 'Category Name', enabled: true },
        { id: 'source-itemSpecifics', logicalKey: 'itemSpecifics', sourceFieldName: 'Item Specifics', enabled: true },
        { id: 'source-conditionsOptions', logicalKey: 'conditionsOptions', sourceFieldName: 'Conditions & Options', enabled: true }
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
        { id: 'term-20', sourceTerm: 'Auto', replacementTerm: 'Automatic', action: 'replace', condition: 'transmission-context', appliesTo: 'transmission', priority: 20, enabled: true },
        { id: 'term-disabled', sourceTerm: 'Disabled', replacementTerm: 'No', action: 'replace', condition: 'always', appliesTo: 'all', priority: 5, enabled: false },
        { id: 'term-deleted', sourceTerm: 'Deleted', replacementTerm: 'No', action: 'replace', condition: 'always', appliesTo: 'all', priority: 6, enabled: true, deletedAt: '2026-01-01T00:00:00.000Z' }
      ]),
      synonyms: section([
        { id: 'syn-10', primaryTerm: 'Side View Mirror', synonyms: ['Door Mirror'], condition: 'always', appliesTo: 'all', priority: 10, enabled: true },
        { id: 'syn-disabled', primaryTerm: 'Radio', synonyms: ['Stereo Receiver'], condition: 'always', appliesTo: 'all', priority: 20, enabled: false }
      ], { enabled: true }),
      prefixRules: section([
        { id: 'prefix-257', prefix: '257', approvedPartTerms: ['Speedometer', 'Instrument Cluster'], priority: 10, enabled: true },
        { id: 'prefix-0641', prefix: '0641', approvedPartTerms: ['Master Power Window Switch'], priority: 20, enabled: true },
        { id: 'prefix-disabled', prefix: '999', approvedPartTerms: ['Disabled'], priority: 30, enabled: false }
      ]),
      restrictedTerms: section([
        { id: 'client-v5-long-block', term: 'Long Block', ruleType: 'never-introduce', scope: 'engine', locked: true, priority: 10, enabled: true },
        { id: 'auth', term: 'Complete', ruleType: 'requires-authorization', scope: 'engine', priority: 20, enabled: true },
        { id: 'noise', term: 'OEM Part', ruleType: 'remove-noise', scope: 'all', priority: 30, enabled: true },
        { id: 'protect', term: 'ABS', ruleType: 'must-preserve', scope: 'all', priority: 40, enabled: true },
        { id: 'restricted-disabled', term: 'Disabled', ruleType: 'remove-noise', scope: 'all', priority: 50, enabled: false }
      ]),
      categoryRules: section([
        { id: 'cat-engine', categoryName: 'Engines', prefixRefs: [], seriesRefs: ['300 Series'], priorityDetails: ['Engine Code'], origin: 'client-v5', seedOrder: 1, enabled: true },
        { id: 'cat-trans', categoryName: 'Transmissions', prefixRefs: [], seriesRefs: ['400 Series'], priorityDetails: ['Transmission Code'], origin: 'client-v5', seedOrder: 2, enabled: true },
        { id: 'cat-mirror', categoryName: 'Mirrors', prefixRefs: [], seriesRefs: [], priorityDetails: ['Adjustment'], origin: 'client-v5', seedOrder: 3, enabled: true },
        { id: 'cat-prefix', categoryName: 'Window Switches', prefixRefs: ['0641'], seriesRefs: [], priorityDetails: ['Switch Type'], origin: 'custom', enabled: true },
        { id: 'cat-disabled', categoryName: 'Disabled', prefixRefs: ['0641'], seriesRefs: [], priorityDetails: ['Disabled'], origin: 'custom', enabled: false }
      ]),
      titleStructures: section([
        { id: 'structure-general', structureName: 'General', appliesTo: 'General / Default', segments: [{ key: 'part', label: 'Part', kind: 'field' }], origin: 'client-v5', seedOrder: 1, enabled: true },
        { id: 'structure-engine', structureName: 'Engines', appliesTo: 'Engines', segments: [{ key: 'engineSize', label: 'Size', kind: 'field' }], origin: 'client-v5', seedOrder: 2, enabled: true },
        { id: 'structure-trans', structureName: 'Transmissions', appliesTo: 'Transmissions', segments: [{ key: 'transmissionCode', label: 'Transmission Code', kind: 'field' }], origin: 'client-v5', seedOrder: 3, enabled: true },
        { id: 'structure-custom-mirror', structureName: 'Mirror Structure', appliesTo: 'Mirrors', segments: [{ key: 'side', label: 'Side', kind: 'field' }], origin: 'custom', enabled: true }
      ]),
      flagReasons: section([
        { id: 'flag-1', reason: 'Missing verified year', origin: 'client-v5', seedOrder: 1, required: true, enabled: true },
        { id: 'flag-2', reason: 'Conflicting source data', origin: 'client-v5', seedOrder: 2, required: true, enabled: true },
        { id: 'flag-custom', reason: 'Custom QA Reason', origin: 'custom', required: false, enabled: true },
        { id: 'flag-disabled', reason: 'Disabled Custom', origin: 'custom', required: false, enabled: false }
      ]),
      systemRules: section([
        { id: 'SR-01', title: 'Never Guess or Invent', order: 1, category: 'Safety', version: 'v5', locked: true },
        { id: 'SR-06', title: 'Prefix 257 #SKU Exception', order: 6, category: 'SKU', version: 'v5', locked: true },
        { id: 'SR-15', title: 'Final Validation', order: 15, category: 'Validation', version: 'v5', locked: true }
      ])
    },
    warnings: [],
    unavailableSections: [],
    ...overrides
  };
  return snapshot;
}

function resolvedListing(snapshot, fields = {}) {
  return normalizeAndResolveListing({
    runtimeSnapshot: snapshot,
    listingRecord: {
      id: 'rec-1',
      fields: {
        'Item Title': 'Old Title',
        SKU: '00123',
        IPN: '0641-00641L',
        'C:Brand': 'Honda',
        'Category Name': 'Mirrors',
        'Conditions & Options': 'Power mirror 300 Series',
        'Item Specifics': JSON.stringify({ 'C:Part': 'Mirrors', Series: '300 Series' }),
        ...fields
      }
    },
    masterRecord: { fields: { 'Part Fitment': 'Fits 2011 Honda Accord' } },
    fields: ['title', 'brandMake', 'part', 'sku', 'year']
  });
}

test('selects applicable terminology, synonyms, prefix, restricted terms, category rules, title structure, flags, and system rules', () => {
  const snapshot = baseSnapshot();
  const listing = resolvedListing(snapshot);
  const result = resolveApplicableTitleOptimizationRules({ runtimeSnapshot: snapshot, listingResolution: listing });

  assert.equal(result.runtimeMode, 'shadow-only');
  assert.equal(result.runtimeReady, true);
  assert.equal(result.listingContext.recordId, 'rec-1');
  assert.equal(result.listingContext.ipnPrefix, '0641');
  assert.equal(result.listingContext.partFitmentTitleAuthority, undefined);

  assert.deepEqual(result.terminologyRules.map(entry => entry.id), ['term-10']);
  assert.deepEqual(result.synonyms.map(entry => entry.id), ['syn-10']);
  assert.equal(result.prefixRule.rule.id, 'prefix-0641');
  assert.equal(result.prefixRule.matchType, 'exact');
  assert.deepEqual(Object.keys(result.restrictedTerms.groups).sort(), ['must-preserve', 'remove-noise']);
  assert.deepEqual(result.categoryRules.map(entry => [entry.rule.id, entry.matchedBy]), [
    ['cat-engine', ['seriesRef']],
    ['cat-mirror', ['category']],
    ['cat-prefix', ['prefixRef']]
  ]);
  assert.equal(result.titleStructure.selected.id, 'structure-custom-mirror');
  assert.equal(result.titleStructure.reason, 'custom-applies-to');
  assert.deepEqual(result.flagReasons.map(entry => entry.id), ['flag-1', 'flag-2', 'flag-custom']);
  assert.deepEqual(result.systemRules.map(entry => entry.id), ['SR-01', 'SR-06', 'SR-15']);
});

test('global disabled synonyms, unknown prefix, and no category match remain non-blocking without hidden fallback', () => {
  const snapshot = baseSnapshot({
    sections: {
      ...baseSnapshot().sections,
      synonyms: section(baseSnapshot().sections.synonyms.items, { enabled: false })
    }
  });
  const listing = resolvedListing(snapshot, { IPN: '777-00001', 'Category Name': 'Unmapped Part', 'Item Specifics': '{}' });
  const result = resolveApplicableTitleOptimizationRules({ runtimeSnapshot: snapshot, listingResolution: listing });

  assert.deepEqual(result.synonyms, []);
  assert.equal(result.prefixRule, null);
  assert.match(result.warnings.find(item => item.code === 'NO_PREFIX_RULE').message, /777/);
  assert.deepEqual(result.categoryRules, []);
  assert.equal(result.titleStructure.selected.id, 'structure-general');
  assert.equal(result.titleStructure.fallback, true);
});

test('optional unavailable synonyms do not block, but required unavailable sections do', () => {
  const optionalSnapshot = baseSnapshot({
    unavailableSections: ['synonyms'],
    sections: {
      ...baseSnapshot().sections,
      synonyms: { name: 'synonyms', available: false, optional: true, items: [], error: 'down' }
    }
  });
  const optionalResult = resolveApplicableTitleOptimizationRules({
    runtimeSnapshot: optionalSnapshot,
    listingResolution: resolvedListing(baseSnapshot())
  });
  assert.deepEqual(optionalResult.synonyms, []);
  assert.equal(optionalResult.runtimeReady, true);

  const blockingSnapshot = baseSnapshot({
    runtimeReady: false,
    blockingSections: ['restrictedTerms'],
    sections: {
      ...baseSnapshot().sections,
      restrictedTerms: { name: 'restrictedTerms', available: false, optional: false, items: [], error: 'down' }
    }
  });
  assert.throws(
    () => resolveApplicableTitleOptimizationRules({ runtimeSnapshot: blockingSnapshot, listingResolution: resolvedListing(baseSnapshot()) }),
    (error) => error instanceof RuntimeRuleResolutionError && error.section === 'restrictedTerms'
  );
});

test('257 prefix exposes SR-06 context without implementing SKU rewriting or inferring category', () => {
  const snapshot = baseSnapshot();
  const listing = resolvedListing(snapshot, {
    IPN: '257-12345',
    'Category Name': 'Unmapped Part',
    'Item Specifics': '{}'
  });
  const result = resolveApplicableTitleOptimizationRules({ runtimeSnapshot: snapshot, listingResolution: listing });

  assert.equal(result.prefixRule.rule.id, 'prefix-257');
  assert.equal(result.prefixRule.normalizedPrefix, '257');
  assert.equal(result.prefixRule.systemRule.id, 'SR-06');
  assert.deepEqual(result.categoryRules, []);
  assert.equal(result.titleStructure.selected.id, 'structure-general');
});

test('engine and transmission structures are selected only from verified context and partFitment cannot classify', () => {
  const snapshot = baseSnapshot();
  const engine = resolveApplicableTitleOptimizationRules({
    runtimeSnapshot: snapshot,
    listingResolution: resolvedListing(snapshot, { 'Category Name': 'Engines', 'Item Specifics': JSON.stringify({ 'C:Part': 'Engines' }) })
  });
  assert.equal(engine.titleStructure.selected.id, 'structure-engine');
  assert.equal(engine.restrictedTerms.groups['never-introduce'][0].id, 'client-v5-long-block');

  const transmission = resolveApplicableTitleOptimizationRules({
    runtimeSnapshot: snapshot,
    listingResolution: resolvedListing(snapshot, { 'Category Name': 'Transmissions', 'Item Specifics': JSON.stringify({ 'C:Part': 'Transmissions' }) })
  });
  assert.equal(transmission.titleStructure.selected.id, 'structure-trans');
  assert.deepEqual(transmission.terminologyRules.map(rule => rule.id), ['term-10', 'term-20']);

  const fitmentOnly = resolveApplicableTitleOptimizationRules({
    runtimeSnapshot: snapshot,
    listingResolution: resolvedListing(snapshot, {
      'Category Name': '',
      'Item Specifics': '{}',
      'Conditions & Options': ''
    })
  });
  assert.equal(fitmentOnly.titleStructure.selected.id, 'structure-general');
});

test('missing valid General title structure is blocking and repeated execution is deterministic', () => {
  const snapshot = baseSnapshot({
    sections: {
      ...baseSnapshot().sections,
      titleStructures: section(baseSnapshot().sections.titleStructures.items.filter(item => item.id !== 'structure-general'))
    }
  });

  assert.throws(
    () => resolveApplicableTitleOptimizationRules({
      runtimeSnapshot: snapshot,
      listingResolution: resolvedListing(baseSnapshot(), {
        'Category Name': '',
        'Conditions & Options': '',
        'Item Specifics': '{}',
        IPN: '777-00001'
      })
    }),
    (error) => error instanceof RuntimeRuleResolutionError && error.section === 'titleStructures'
  );

  const deterministicSnapshot = baseSnapshot();
  const listing = resolvedListing(deterministicSnapshot);
  const first = resolveApplicableTitleOptimizationRules({ runtimeSnapshot: deterministicSnapshot, listingResolution: listing });
  const second = resolveApplicableTitleOptimizationRules({ runtimeSnapshot: deterministicSnapshot, listingResolution: listing });
  assert.deepEqual(second, first);
});
