const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RuntimeConfigurationError,
  normalizeListingEvidence,
  resolveSourcePriority,
  normalizeAndResolveListing
} = require('../src/services/titleOptimizationRuntimeSourceResolutionService');

function mapping(logicalKey, sourceFieldName, extras = {}) {
  return {
    id: `source-${logicalKey}`,
    logicalKey,
    displayName: logicalKey,
    sourceFieldName,
    enabled: true,
    deletedAt: null,
    sortOrder: 1,
    ...extras
  };
}

function snapshot(overrides = {}) {
  const mappings = [
    mapping('existingTitle', 'Item Title'),
    mapping('legacyTitle', 'Title', { isCustom: true }),
    mapping('manualOverrideStatus', 'Title Override Status'),
    mapping('manualOverrideTitle', 'Manual Override Title', { isCustom: true }),
    mapping('sku', 'SKU'),
    mapping('ipnPrefix', 'IPN'),
    mapping('brandMake', 'C:Brand'),
    mapping('categoryPart', 'Category Name'),
    mapping('itemSpecifics', 'Item Specifics - All C: values relevant to item'),
    mapping('conditionsOptions', 'Conditions & Options'),
    mapping('manufacturerPartNumber', 'C:Manufacturer Part Number'),
    mapping('rawSourceTitle', 'Hollander Title'),
    mapping('currentEbayFields', 'Current eBay Fields'),
    mapping('structuredYear', 'Structured Year', { isCustom: true }),
    mapping('customTrim', 'Trim Level', { isCustom: true })
  ];

  const rows = [
    { key: 'manualOverride', priority: 1 },
    { key: 'lockedFixedIpn', priority: 2 },
    { key: 'itemSpecifics', priority: 3 },
    { key: 'categoryConditions', priority: 4 },
    { key: 'manufacturerPartNumber', priority: 5 },
    { key: 'brandMake', priority: 6 },
    { key: 'otherStructuredFields', priority: 7 },
    { key: 'currentEbay', priority: 8 },
    { key: 'rawHollander', priority: 9 }
  ];

  return {
    mode: 'shadow-only',
    runtimeReady: true,
    blockingSections: [],
    sections: {
      sourceFields: { available: true, items: mappings },
      sourcePriority: { available: true, items: rows }
    },
    ...overrides
  };
}

function listing(fields = {}) {
  return {
    id: 'recListing',
    fields: {
      'Item Title': 'Old eBay Title',
      Title: 'Raw Hollander Toyota Mirror 1554743',
      'Title Override Status': '',
      'Manual Override Title': '',
      SKU: '00155',
      IPN: '0641-00641L',
      'C:Brand': 'Toyota',
      'Category Name': 'Door Mirror',
      'Conditions & Options': 'Driver side mirror',
      'C:Manufacturer Part Number': 'MPN-9',
      'Hollander Title': 'Toyota Mirror Hollander',
      'Structured Year': '2012',
      'Trim Level': 'LX',
      'Item Specifics - All C: values relevant to item': JSON.stringify({
        'C:Brand': 'Honda',
        'C:Part': 'Side View Mirror',
        'C:MPN': 'MPN-9'
      }),
      'Current eBay Fields': JSON.stringify({ Subtitle: 'Current listing note' }),
      ...fields
    }
  };
}

test('normalizes configured listing evidence without using partFitment as title authority', () => {
  const normalized = normalizeListingEvidence({
    runtimeSnapshot: snapshot(),
    listingRecord: listing(),
    masterRecord: { fields: { 'Part Fitment': 'Fits 2011 Toyota Camry front only' } }
  });

  assert.equal(normalized.runtimeReady, true);
  assert.equal(normalized.fields.existingTitle.value, 'Old eBay Title');
  assert.equal(normalized.fields.legacyTitle.value, 'Raw Hollander Toyota Mirror 1554743');
  assert.equal(normalized.fields.sku.value, '00155');
  assert.equal(normalized.fields.ipn.value, '0641-00641L');
  assert.equal(normalized.fields.ipnPrefix.value, '0641');
  assert.equal(normalized.fields.brandMake.value, 'Toyota');
  assert.equal(normalized.fields.categoryPart.value, 'Door Mirror');
  assert.equal(normalized.fields.manufacturerPartNumber.value, 'MPN-9');
  assert.equal(normalized.fields.customTrim.value, 'LX');
  assert.deepEqual(normalized.structured.itemSpecifics.value, {
    'C:Brand': 'Honda',
    'C:Part': 'Side View Mirror',
    'C:MPN': 'MPN-9'
  });
  assert.equal(normalized.descriptionOnly.partFitment.value, 'Fits 2011 Toyota Camry front only');
  assert.equal(normalized.titleAuthority.partFitment, undefined);
});

test('normalization marks optional blanks missing and ignores disabled or deleted mappings', () => {
  const base = snapshot();
  const sourceFields = {
    available: true,
    items: [
      mapping('sku', 'SKU'),
      mapping('brandMake', 'C:Brand', { enabled: false }),
      mapping('categoryPart', 'Category Name', { deletedAt: '2026-01-01T00:00:00.000Z' }),
      mapping('customPaintCode', 'Paint Code', { isCustom: true })
    ]
  };

  const normalized = normalizeListingEvidence({
    runtimeSnapshot: {
      ...base,
      sections: { ...base.sections, sourceFields }
    },
    listingRecord: listing({ SKU: '', 'Paint Code': '' })
  });

  assert.equal(normalized.fields.sku.missing, true);
  assert.equal(normalized.fields.brandMake, undefined);
  assert.equal(normalized.fields.categoryPart, undefined);
  assert.equal(normalized.fields.customPaintCode.missing, true);
});

test('normalization fails fast for unavailable, blocking, malformed, or required missing Source Fields', () => {
  assert.throws(
    () => normalizeListingEvidence({ runtimeSnapshot: snapshot({ runtimeReady: false, blockingSections: ['sourceFields'] }), listingRecord: listing() }),
    (error) => error instanceof RuntimeConfigurationError && error.section === 'sourceFields'
  );

  assert.throws(
    () => normalizeListingEvidence({
      runtimeSnapshot: {
        ...snapshot(),
        sections: { ...snapshot().sections, sourceFields: { available: false, items: [] } }
      },
      listingRecord: listing()
    }),
    /Source Fields configuration is unavailable/
  );

  assert.throws(
    () => normalizeListingEvidence({
      runtimeSnapshot: {
        ...snapshot(),
        sections: { ...snapshot().sections, sourceFields: { available: true, items: [{ id: 'broken' }] } }
      },
      listingRecord: listing()
    }),
    /Source Fields configuration is malformed/
  );

  assert.throws(
    () => normalizeListingEvidence({
      runtimeSnapshot: {
        ...snapshot(),
        sections: { ...snapshot().sections, sourceFields: { available: true, items: [mapping('sku', '', { required: true })] } }
      },
      listingRecord: listing()
    }),
    /Required Source Field mapping 'sku' is not mapped/
  );
});

test('priority resolution falls through blanks, selects highest authority, and preserves lower evidence', () => {
  const normalized = normalizeListingEvidence({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Manual Override Title': '',
      'C:Brand': 'Toyota',
      'Item Specifics - All C: values relevant to item': JSON.stringify({ 'C:Brand': 'Honda' }),
      'Hollander Title': 'Toyota Mirror'
    })
  });

  const resolved = resolveSourcePriority({
    runtimeSnapshot: snapshot(),
    normalizedListing: normalized,
    fields: ['brandMake']
  });

  assert.equal(resolved.fields.brandMake.resolvedValue, 'Honda');
  assert.equal(resolved.fields.brandMake.resolvedSource, 'itemSpecifics');
  assert.equal(resolved.fields.brandMake.conflict, true);
  assert.deepEqual(resolved.fields.brandMake.conflicts.map(item => item.value), ['Toyota']);
  assert.deepEqual(resolved.fields.brandMake.candidates.map(item => item.source), ['itemSpecifics', 'brandMake']);
});

test('priority resolution treats identical values as non-conflicting and no candidate as unresolved', () => {
  const normalized = normalizeListingEvidence({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'C:Brand': 'Honda',
      'Item Specifics - All C: values relevant to item': JSON.stringify({ 'C:Brand': 'Honda' }),
      'Conditions & Options': '',
      'Hollander Title': ''
    })
  });

  const resolved = resolveSourcePriority({
    runtimeSnapshot: snapshot(),
    normalizedListing: normalized,
    fields: ['brandMake', 'engineCode']
  });

  assert.equal(resolved.fields.brandMake.resolvedValue, 'Honda');
  assert.equal(resolved.fields.brandMake.conflict, false);
  assert.equal(resolved.fields.engineCode.missing, true);
  assert.equal(resolved.fields.engineCode.resolvedValue, null);
});

test('manual override evidence is normalized but does not change production control flow', () => {
  const combined = normalizeAndResolveListing({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Title Override Status': 'Manual Override',
      'Manual Override Title': 'Approved Manual Title'
    }),
    fields: ['title']
  });

  assert.equal(combined.normalized.manualOverride.status.value, 'Manual Override');
  assert.equal(combined.normalized.manualOverride.active, true);
  assert.equal(combined.resolved.fields.title.resolvedValue, 'Approved Manual Title');
  assert.equal(combined.resolved.fields.title.resolvedSource, 'manualOverride');
  assert.equal(combined.productionIntegration, false);
});

test('priority resolution fails for unavailable or malformed Source Priority without prompt fallback', () => {
  const normalized = normalizeListingEvidence({ runtimeSnapshot: snapshot(), listingRecord: listing() });

  assert.throws(
    () => resolveSourcePriority({
      runtimeSnapshot: {
        ...snapshot(),
        sections: { ...snapshot().sections, sourcePriority: { available: false, items: [] } }
      },
      normalizedListing: normalized,
      fields: ['brandMake']
    }),
    (error) => error instanceof RuntimeConfigurationError && error.section === 'sourcePriority'
  );

  assert.throws(
    () => resolveSourcePriority({
      runtimeSnapshot: {
        ...snapshot(),
        sections: { ...snapshot().sections, sourcePriority: { available: true, items: [{ key: 'manualOverride', priority: 1 }] } }
      },
      normalizedListing: normalized,
      fields: ['brandMake']
    }),
    /Source Priority configuration is malformed/
  );
});

test('normalization and resolution are deterministic across repeated execution', () => {
  const input = { runtimeSnapshot: snapshot(), listingRecord: listing(), fields: ['title', 'brandMake', 'part', 'sku'] };
  const first = normalizeAndResolveListing(input);
  const second = normalizeAndResolveListing(input);
  assert.deepEqual(second, first);
});
