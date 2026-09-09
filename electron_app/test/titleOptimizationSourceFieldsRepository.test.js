const test = require('node:test');
const assert = require('node:assert/strict');

const REPOSITORY_PATH = '../src/services/titleOptimizationSourceFieldsRepository';

function schemaTables(fields = []) {
  return [{
    id: 'tbl-listings',
    name: 'eBay Listings (API)',
    fields
  }];
}

function requiredFields() {
  return [
    { id: 'fld-title', name: 'Title', type: 'singleLineText' },
    { id: 'fld-override', name: 'Title Override Status', type: 'singleSelect' },
    { id: 'fld-sku', name: 'SKU', type: 'singleLineText' },
    { id: 'fld-ipn', name: 'IPN', type: 'singleLineText' }
  ];
}

function harness(options = {}) {
  let stored = options.stored;
  let writes = 0;
  let calls = 0;
  const repo = require(REPOSITORY_PATH).createTitleOptimizationSourceFieldsRepository({
    getStored: () => stored,
    setStored: (value) => { stored = structuredClone(value); writes += 1; },
    getCredentials: () => ({ token: 'secret', baseId: 'app-base' }),
    listTables: async ({ maxAttempts }) => {
      calls += 1;
      assert.equal(maxAttempts, 1);
      if (options.error) throw options.error;
      return options.tables || schemaTables(requiredFields());
    },
    getActor: async () => 'user@example.com',
    now: () => '2026-09-09T10:00:00.000Z'
  });
  return { repo, getStored: () => stored, writes: () => writes, calls: () => calls };
}

test('first load fetches the exact listings table and persists seeded configuration', async () => {
  const h = harness();
  const result = await h.repo.load();

  assert.equal(result.table.name, 'eBay Listings (API)');
  assert.equal(result.fields.length, 4);
  assert.equal(result.mappings.length, 13);
  assert.equal(result.mappings.find((m) => m.logicalKey === 'sku').sourceFieldId, 'fld-sku');
  assert.equal(h.writes(), 1);
  assert.equal(h.getStored().mappings.length, 13);
});

test('reload restores saved mappings without reseeding or fetching Airtable', async () => {
  const saved = {
    version: 1,
    table: { id: 'tbl-listings', name: 'eBay Listings (API)' },
    fields: requiredFields(),
    mappings: [{ id: 'custom', logicalKey: 'customKey', displayName: 'Custom', isCustom: true, enabled: true }]
  };
  const h = harness({ stored: saved });
  const result = await h.repo.load();

  assert.equal(result.mappings.length, 1);
  assert.equal(result.mappings[0].logicalKey, 'customKey');
  assert.equal(h.calls(), 0);
  assert.equal(h.writes(), 0);
});

test('refresh preserves valid mappings and marks a removed source as missing', async () => {
  const saved = {
    version: 1,
    table: { id: 'tbl-listings', name: 'eBay Listings (API)' },
    fields: [...requiredFields(), { id: 'fld-brand', name: 'C:Brand', type: 'singleLineText' }],
    mappings: [{
      id: 'source-brandMake', logicalKey: 'brandMake', displayName: 'Brand / Make',
      sourceFieldId: 'fld-brand', sourceFieldName: 'C:Brand', sourceFieldType: 'singleLineText',
      enabled: true, protected: true, isCustom: false
    }]
  };
  const h = harness({ stored: saved, tables: schemaTables(requiredFields()) });
  const result = await h.repo.refreshFields();

  assert.equal(result.mappings[0].sourceFieldId, 'fld-brand');
  assert.equal(result.mappings[0].status, 'Source Missing');
  assert.equal(h.getStored().mappings[0].sourceFieldId, 'fld-brand');
});

test('refresh follows a stable field ID across an Airtable rename and refreshes cached metadata', async () => {
  const saved = {
    version: 1,
    table: { id: 'tbl-listings', name: 'eBay Listings (API)' },
    fields: requiredFields(),
    mappings: [{
      id: 'source-sku', logicalKey: 'sku', displayName: 'SKU',
      sourceFieldId: 'fld-sku', sourceFieldName: 'Old SKU Name', sourceFieldType: 'number',
      enabled: true, required: true, protected: true, isCustom: false
    }]
  };
  const h = harness({ stored: saved });
  const result = await h.repo.refreshFields();

  assert.equal(result.mappings[0].status, 'Mapped');
  assert.equal(result.mappings[0].sourceFieldName, 'SKU');
  assert.equal(result.mappings[0].sourceFieldType, 'singleLineText');
});

test('failed refresh retains saved configuration and last-known schema', async () => {
  const saved = {
    version: 1,
    table: { id: 'tbl-listings', name: 'eBay Listings (API)' },
    fields: requiredFields(),
    mappings: [{ id: 'source-sku', logicalKey: 'sku', displayName: 'SKU', sourceFieldId: 'fld-sku', sourceFieldName: 'SKU', enabled: true }]
  };
  const h = harness({ stored: saved, error: Object.assign(new Error('Too many requests'), { status: 429 }) });

  await assert.rejects(h.repo.refreshFields(), (error) => {
    assert.match(error.message, /rate limit/i);
    assert.equal(error.current.fields.length, 4);
    return true;
  });
  assert.deepEqual(h.getStored(), saved);
  assert.equal(h.writes(), 0);
  assert.equal(h.calls(), 1);
});

test('refresh rejects a missing exact table or an empty table schema', async () => {
  await assert.rejects(harness({ tables: [{ id: 'other', name: 'Listings', fields: [] }] }).repo.refreshFields(), /eBay Listings/);
  await assert.rejects(harness({ tables: schemaTables([]) }).repo.refreshFields(), /no fields/i);
});

test('save is idempotent, validates mandatory mappings, and stamps audit fields', async () => {
  const h = harness();
  const loaded = await h.repo.load();
  const once = await h.repo.save(loaded.mappings);
  const twice = await h.repo.save(once.mappings);

  assert.equal(twice.mappings.length, 13);
  assert.equal(new Set(twice.mappings.map((m) => m.id)).size, 13);
  assert.equal(twice.updatedBy, 'user@example.com');

  const broken = twice.mappings.map((mapping) => mapping.logicalKey === 'ipnPrefix'
    ? { ...mapping, sourceFieldId: null, sourceFieldName: '' }
    : mapping);
  await assert.rejects(h.repo.save(broken), (error) => error.code === 'VALIDATION_ERROR');
});

test('normal queries omit soft-deleted records while restoration remains available', async () => {
  const h = harness();
  const loaded = await h.repo.load();
  const created = await h.repo.save([...loaded.mappings, {
    id: 'custom-paint', logicalKey: 'paintCode', displayName: 'Paint Code', description: '',
    sourceProvider: 'airtable', sourceFieldId: null, sourceFieldName: '', sourceFieldType: '',
    required: false, enabled: true, protected: false, isCustom: true, sortOrder: 14,
    updatedAt: null, updatedBy: null, deletedAt: null, deletedBy: null
  }]);
  assert.equal(created.mappings.length, 14);

  const afterDelete = await h.repo.softDelete('custom-paint');
  assert.equal(afterDelete.mappings.some((m) => m.id === 'custom-paint'), false);
  assert.equal(h.getStored().mappings.find((m) => m.id === 'custom-paint').deletedBy, 'user@example.com');

  const restored = await h.repo.restore('custom-paint');
  assert.equal(restored.mappings.some((m) => m.id === 'custom-paint'), true);
});

test('load quarantines malformed entries without reseeding over valid data', async () => {
  const h = harness({ stored: {
    version: 1, table: { id: 'tbl-listings', name: 'eBay Listings (API)' }, fields: requiredFields(),
    mappings: [
      { id: 'valid', logicalKey: 'paintCode', displayName: 'Paint Code', enabled: true, isCustom: true },
      { id: '', logicalKey: 'bad key' }
    ]
  } });
  const result = await h.repo.load();

  assert.equal(result.mappings.length, 1);
  assert.equal(result.quarantined.length, 1);
  assert.equal(h.calls(), 0);
});
