const test = require('node:test');
const assert = require('node:assert/strict');

const SERVICE_PATH = '../src/services/titleOptimizationSourceFieldsService';

function fields() {
  return [
    { id: 'fld-title', name: 'Title', type: 'singleLineText' },
    { id: 'fld-override', name: 'Title Override Status', type: 'singleSelect' },
    { id: 'fld-sku', name: 'SKU', type: 'singleLineText' },
    { id: 'fld-ipn', name: 'IPN', type: 'singleLineText' },
    { id: 'fld-brand', name: 'C:Brand', type: 'singleLineText' },
    { id: 'fld-mpn', name: 'C:Manufacturer Part Number', type: 'singleLineText' },
    { id: 'fld-specifics', name: 'Item Specifics', type: 'multilineText' },
    { id: 'fld-options', name: 'Conditions & Options', type: 'multilineText' },
    { id: 'fld-category', name: 'Category Name', type: 'singleLineText' },
    { id: 'fld-hollander', name: 'Hollander Title', type: 'multilineText' },
    { id: 'fld-brand-duplicate', name: 'C:Brand', type: 'singleLineText' }
  ];
}

test('first-run seeding creates the approved core mappings without C:Model', () => {
  const { seedSourceMappings } = require(SERVICE_PATH);
  const seeded = seedSourceMappings(fields(), { actor: 'app-user', now: '2026-09-09T00:00:00.000Z' });

  assert.equal(seeded.length, 13);
  assert.deepEqual(seeded.slice(0, 4).map((mapping) => mapping.logicalKey), [
    'existingTitle', 'manualOverrideStatus', 'sku', 'ipnPrefix'
  ]);
  assert.equal(seeded.some((mapping) => mapping.logicalKey.toLowerCase().includes('model')), false);
  assert.equal(seeded.every((mapping) => mapping.protected && !mapping.isCustom), true);
  assert.equal(seeded.every((mapping) => mapping.required === false), true);
});

test('seeding maps only a unique exact case-sensitive field name', () => {
  const { seedSourceMappings } = require(SERVICE_PATH);
  const seeded = seedSourceMappings(fields(), { actor: 'app-user', now: '2026-09-09T00:00:00.000Z' });
  const byKey = Object.fromEntries(seeded.map((mapping) => [mapping.logicalKey, mapping]));

  assert.equal(byKey.existingTitle.sourceFieldId, 'fld-title');
  assert.equal(byKey.brandMake.sourceFieldId, null, 'duplicate exact matches are ambiguous');
  assert.equal(byKey.fixedIpnValues.sourceFieldId, null);
  assert.equal(byKey.year.sourceFieldId, null);
  assert.equal(byKey.currentEbayFields.sourceFieldId, null);

  const wrongCase = fields().map((field) => field.name === 'Title' ? { ...field, name: 'title' } : field);
  assert.equal(seedSourceMappings(wrongCase, {}).find((mapping) => mapping.logicalKey === 'existingTitle').sourceFieldId, null);
});

test('status distinguishes mapped, unmapped, missing, and disabled mappings', () => {
  const { getMappingStatus } = require(SERVICE_PATH);
  const available = [{ id: 'fld-title', name: 'Title', type: 'singleLineText' }];
  const base = { enabled: true, sourceFieldId: 'fld-title', sourceFieldName: 'Title' };

  assert.equal(getMappingStatus(base, available), 'Mapped');
  assert.equal(getMappingStatus({ ...base, sourceFieldId: null, sourceFieldName: '' }, available), 'Unmapped');
  assert.equal(getMappingStatus({ ...base, sourceFieldId: 'fld-gone' }, available), 'Source Missing');
  assert.equal(getMappingStatus({ ...base, enabled: false }, available), 'Disabled');
});

test('save validation requires only mappings explicitly marked required', () => {
  const { seedSourceMappings, validateMappingsForSave } = require(SERVICE_PATH);
  const schema = fields();
  const mappings = seedSourceMappings(schema, {});
  assert.deepEqual(validateMappingsForSave(mappings, schema), []);

  const broken = mappings.map((mapping) => mapping.logicalKey === 'sku'
    ? { ...mapping, required: true, sourceFieldId: null, sourceFieldName: '' }
    : mapping);
  assert.deepEqual(validateMappingsForSave(broken, schema), [
    { logicalKey: 'sku', message: 'SKU must be mapped to an available Airtable field.' }
  ]);
});

test('custom mapping lifecycle validates keys and soft-deletes without changing protected mappings', () => {
  const {
    seedSourceMappings,
    createCustomMapping,
    updateMapping,
    softDeleteCustomMapping,
    restoreCustomMapping
  } = require(SERVICE_PATH);
  const audit = { actor: 'gary@example.com', now: '2026-09-09T01:02:03.000Z' };
  const seeded = seedSourceMappings(fields(), audit);
  const created = createCustomMapping({
    displayName: 'Paint Code',
    logicalKey: 'paintCode',
    description: 'Verified paint code',
    sourceFieldId: 'fld-paint',
    sourceFieldName: 'C:Paint Code',
    sourceFieldType: 'singleLineText',
    required: false,
    enabled: true
  }, seeded, audit);

  const custom = created.find((mapping) => mapping.logicalKey === 'paintCode');
  assert.equal(custom.isCustom, true);
  assert.equal(custom.updatedBy, 'gary@example.com');
  assert.throws(() => createCustomMapping({ displayName: 'Bad', logicalKey: 'Paint Code' }, created, audit), /camelCase/);
  assert.throws(() => createCustomMapping({ displayName: 'Duplicate', logicalKey: 'paintCode' }, created, audit), /already exists/);
  assert.throws(() => updateMapping(seeded[0].id, { logicalKey: 'changed' }, seeded, audit), /protected logical key/);
  assert.throws(() => softDeleteCustomMapping(seeded[0].id, seeded, audit), /protected/);

  const optionalCore = updateMapping(seeded[0].id, { required: false }, seeded, audit);
  assert.equal(optionalCore[0].required, false);

  const edited = updateMapping(custom.id, { displayName: 'Exterior Paint Code', required: true }, created, audit);
  assert.equal(edited.find((mapping) => mapping.id === custom.id).required, true);
  const deleted = softDeleteCustomMapping(custom.id, edited, audit);
  assert.equal(deleted.find((mapping) => mapping.id === custom.id).deletedAt, audit.now);
  assert.equal(deleted.find((mapping) => mapping.id === custom.id).enabled, false);
  const restored = restoreCustomMapping(custom.id, deleted, audit);
  assert.equal(restored.find((mapping) => mapping.id === custom.id).deletedAt, null);
});

test('configuration hydration preserves valid entries and quarantines only malformed ones', () => {
  const { validateAndHydrateConfiguration } = require(SERVICE_PATH);
  const valid = {
    id: 'mapping-sku', logicalKey: 'sku', displayName: 'SKU', description: '',
    sourceProvider: 'airtable', sourceFieldId: 'fld-sku', sourceFieldName: 'SKU',
    sourceFieldType: 'singleLineText', required: true, enabled: true, protected: true,
    isCustom: false, sortOrder: 3, updatedAt: null, updatedBy: null, deletedAt: null, deletedBy: null
  };
  const result = validateAndHydrateConfiguration({ version: 1, mappings: [valid, { id: '', logicalKey: 'bad key' }] });

  assert.equal(result.mappings.length, 1);
  assert.equal(result.quarantined.length, 1);
  assert.equal(result.quarantined[0].index, 1);
});

test('normalization reads saved fields and groups custom values under additionalFields', () => {
  const { buildNormalizedTitleListingData } = require(SERVICE_PATH);
  const mappings = [
    { logicalKey: 'sku', sourceFieldId: 'fld-sku', sourceFieldName: 'SKU', enabled: true, isCustom: false },
    { logicalKey: 'paintCode', sourceFieldId: 'fld-paint', sourceFieldName: 'C:Paint Code', enabled: true, isCustom: true },
    { logicalKey: 'deleted', sourceFieldName: 'Deleted', enabled: false, isCustom: true }
  ];
  const normalized = buildNormalizedTitleListingData({ fields: { SKU: 'ABC-1', 'C:Paint Code': 'PXR' } }, mappings);

  assert.deepEqual(normalized, { sku: 'ABC-1', additionalFields: { paintCode: 'PXR' } });
});
