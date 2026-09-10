const crypto = require('crypto');

const LOGICAL_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;

const CORE_DEFINITIONS = [
  ['existingTitle', 'Existing Title', 'Current authoritative/eBay listing title used as the starting point and for no-degrade comparison.', 'Title', false],
  ['manualOverrideStatus', 'Manual Override Status', 'Indicates whether Seymour Auto manually approved or overrode the listing title.', 'Title Override Status', false],
  ['sku', 'SKU', 'Listing SKU available to title optimization when selected.', 'SKU', false],
  ['ipnPrefix', 'IPN / Prefix', 'IPN or Hollander interchange prefix used for approved prefix-specific rules.', 'IPN', false],
  ['fixedIpnValues', 'Fixed / Locked IPN Values', 'Locked or Fixed IPN-level values supplied by Airtable when available.', null, false],
  ['year', 'Structured Year', 'Verified structured vehicle year or year range when available.', null, false],
  ['brandMake', 'Brand / Make', 'Authoritative Brand/Make source such as C:Brand.', 'C:Brand', false],
  ['manufacturerPartNumber', 'Manufacturer Part Number', 'Verified manufacturer/OEM part number source such as C:Manufacturer Part Number.', 'C:Manufacturer Part Number', false],
  ['itemSpecifics', 'Item Specifics', 'Structured eBay/Airtable item-specific values containing verified listing attributes and fitment information.', 'Item Specifics', false],
  ['conditionsOptions', 'Conditions & Options', 'Approved Category Definitions / Conditions & Options data.', 'Conditions & Options', false],
  ['categoryPart', 'Category / Part', 'Authoritative category or verified part identity.', 'Category Name', false],
  ['currentEbayFields', 'Current eBay Listing Fields', 'Additional current eBay listing data available to the optimizer.', null, false],
  ['rawSourceTitle', 'Raw Hollander / Source Title', 'Original Hollander/source title used only as a lower-authority source.', 'Hollander Title', false]
];

function auditValues(audit = {}) {
  return {
    actor: String(audit.actor || 'system').trim() || 'system',
    now: audit.now || new Date().toISOString()
  };
}

function mappingId(logicalKey) {
  return `source-${logicalKey}`;
}

function uniqueExactField(fields, expectedName) {
  if (!expectedName) return null;
  const matches = (Array.isArray(fields) ? fields : []).filter((field) => field?.name === expectedName);
  return matches.length === 1 ? matches[0] : null;
}

function seedSourceMappings(fields = [], audit = {}) {
  const { actor, now } = auditValues(audit);
  return CORE_DEFINITIONS.map(([logicalKey, displayName, description, expectedName, required], index) => {
    const field = uniqueExactField(fields, expectedName);
    return {
      id: mappingId(logicalKey),
      logicalKey,
      displayName,
      description,
      sourceProvider: 'airtable',
      sourceFieldId: field?.id || null,
      sourceFieldName: field?.name || '',
      sourceFieldType: field?.type || '',
      required,
      enabled: true,
      protected: true,
      isCustom: false,
      sortOrder: index + 1,
      updatedAt: now,
      updatedBy: actor,
      deletedAt: null,
      deletedBy: null
    };
  });
}

function getMappingStatus(mapping, fields = []) {
  if (!mapping?.enabled) return 'Disabled';
  if (!mapping.sourceFieldId && !mapping.sourceFieldName) return 'Unmapped';
  const exists = fields.some((field) =>
    (mapping.sourceFieldId && field?.id === mapping.sourceFieldId) ||
    (!mapping.sourceFieldId && mapping.sourceFieldName && field?.name === mapping.sourceFieldName)
  );
  return exists ? 'Mapped' : 'Source Missing';
}

function validateMappingsForSave(mappings = [], fields = []) {
  const active = mappings.filter((mapping) => !mapping.deletedAt);
  const errors = [];
  for (const mapping of active.filter((entry) => entry.required)) {
    if (getMappingStatus(mapping, fields) !== 'Mapped') {
      errors.push({
        logicalKey: mapping.logicalKey,
        message: `${mapping.displayName || mapping.logicalKey} must be mapped to an available Airtable field.`
      });
    }
  }
  return errors;
}

function assertLogicalKey(logicalKey, mappings = [], ignoreId = null) {
  const key = String(logicalKey || '').trim();
  if (!LOGICAL_KEY_PATTERN.test(key)) {
    throw new Error('Logical Key must be a non-empty camelCase identifier without spaces.');
  }
  if (mappings.some((mapping) => mapping.id !== ignoreId && mapping.logicalKey === key)) {
    throw new Error(`Logical Key '${key}' already exists.`);
  }
  return key;
}

function createCustomMapping(input = {}, mappings = [], audit = {}) {
  const { actor, now } = auditValues(audit);
  const displayName = String(input.displayName || '').trim();
  if (!displayName) throw new Error('Display Name is required.');
  const logicalKey = assertLogicalKey(input.logicalKey, mappings);
  const nextSortOrder = mappings.reduce((max, mapping) => Math.max(max, Number(mapping.sortOrder) || 0), 0) + 1;
  return [...mappings, {
    id: `source-custom-${crypto.randomUUID()}`,
    logicalKey,
    displayName,
    description: String(input.description || '').trim(),
    sourceProvider: 'airtable',
    sourceFieldId: input.sourceFieldId || null,
    sourceFieldName: String(input.sourceFieldName || '').trim(),
    sourceFieldType: String(input.sourceFieldType || '').trim(),
    required: Boolean(input.required),
    enabled: input.enabled !== false,
    protected: false,
    isCustom: true,
    sortOrder: nextSortOrder,
    updatedAt: now,
    updatedBy: actor,
    deletedAt: null,
    deletedBy: null
  }];
}

function updateMapping(id, changes = {}, mappings = [], audit = {}) {
  const { actor, now } = auditValues(audit);
  const existing = mappings.find((mapping) => mapping.id === id);
  if (!existing) throw new Error('Source mapping was not found.');
  if (existing.protected && changes.logicalKey !== undefined && changes.logicalKey !== existing.logicalKey) {
    throw new Error('Cannot change a protected logical key.');
  }
  const logicalKey = changes.logicalKey === undefined
    ? existing.logicalKey
    : assertLogicalKey(changes.logicalKey, mappings, id);
  return mappings.map((mapping) => mapping.id === id ? {
    ...mapping,
    ...changes,
    logicalKey,
    id: mapping.id,
    protected: mapping.protected,
    isCustom: mapping.isCustom,
    updatedAt: now,
    updatedBy: actor
  } : mapping);
}

function softDeleteCustomMapping(id, mappings = [], audit = {}) {
  const target = mappings.find((mapping) => mapping.id === id);
  if (!target) throw new Error('Source mapping was not found.');
  if (target.protected || !target.isCustom) throw new Error('Core protected mappings cannot be deleted.');
  const { actor, now } = auditValues(audit);
  return mappings.map((mapping) => mapping.id === id ? {
    ...mapping, enabled: false, deletedAt: now, deletedBy: actor, updatedAt: now, updatedBy: actor
  } : mapping);
}

function restoreCustomMapping(id, mappings = [], audit = {}) {
  const target = mappings.find((mapping) => mapping.id === id);
  if (!target?.isCustom) throw new Error('Restorable custom source mapping was not found.');
  const { actor, now } = auditValues(audit);
  return mappings.map((mapping) => mapping.id === id ? {
    ...mapping, enabled: true, deletedAt: null, deletedBy: null, updatedAt: now, updatedBy: actor
  } : mapping);
}

function isValidStoredMapping(mapping) {
  return Boolean(
    mapping && typeof mapping === 'object' && String(mapping.id || '').trim() &&
    LOGICAL_KEY_PATTERN.test(String(mapping.logicalKey || '')) && String(mapping.displayName || '').trim()
  );
}

function validateAndHydrateConfiguration(raw = {}) {
  const input = Array.isArray(raw?.mappings) ? raw.mappings : [];
  const mappings = [];
  const quarantined = [];
  input.forEach((mapping, index) => {
    if (!isValidStoredMapping(mapping)) {
      quarantined.push({ index, id: mapping?.id || null, logicalKey: mapping?.logicalKey || null, reason: 'Malformed source mapping.' });
      return;
    }
    mappings.push({
      description: '', sourceProvider: 'airtable', sourceFieldId: null, sourceFieldName: '', sourceFieldType: '',
      required: false, enabled: true, protected: false, isCustom: true, sortOrder: index + 1,
      updatedAt: null, updatedBy: null, deletedAt: null, deletedBy: null,
      ...mapping
    });
  });
  return { ...raw, version: Number(raw?.version) || 1, mappings, quarantined };
}

function buildNormalizedTitleListingData(record = {}, mappings = []) {
  const source = record?.fields && typeof record.fields === 'object' ? record.fields : record;
  const normalized = {};
  const additionalFields = {};
  mappings.filter((mapping) => mapping.enabled && !mapping.deletedAt && (mapping.sourceFieldName || mapping.sourceFieldId))
    .forEach((mapping) => {
      const value = source?.[mapping.sourceFieldName];
      if (mapping.isCustom) additionalFields[mapping.logicalKey] = value;
      else normalized[mapping.logicalKey] = value;
    });
  if (Object.keys(additionalFields).length) normalized.additionalFields = additionalFields;
  return normalized;
}

module.exports = {
  CORE_DEFINITIONS,
  seedSourceMappings,
  getMappingStatus,
  validateMappingsForSave,
  createCustomMapping,
  updateMapping,
  softDeleteCustomMapping,
  restoreCustomMapping,
  validateAndHydrateConfiguration,
  buildNormalizedTitleListingData
};
