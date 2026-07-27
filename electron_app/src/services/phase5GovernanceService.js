const crypto = require('crypto');

function normalizeText(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    return normalizeText(value[0]);
  }
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeComparableValue(value) {
  if (Array.isArray(value)) {
    return value.map(item => normalizeComparableValue(item)).filter(Boolean).join(',');
  }
  if (value && typeof value === 'object') {
    return normalizeText(value.id || value.name || value.label || value.value || '');
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return normalizeText(value);
}

function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = normalizeKey(value);
  if (!text) return defaultValue;
  if (['true', '1', 'yes', 'y', 'on', 'blocked', 'hold', 'held'].includes(text)) return true;
  if (['false', '0', 'no', 'n', 'off', 'none', 'clear'].includes(text)) return false;
  return defaultValue;
}

function getFieldValueByName(fields = {}, name = '') {
  if (!fields || typeof fields !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name];
  const target = normalizeKey(name);
  if (!target) return '';
  const key = Object.keys(fields).find(item => normalizeKey(item) === target);
  if (!key) return '';
  return fields[key];
}

function isManualOverrideForField(listingFields = {}, fieldName = '') {
  const globalCandidates = ['Manual Override', 'Manual Edit', 'Manual Edited'];
  for (const name of globalCandidates) {
    const value = getFieldValueByName(listingFields, name);
    if (parseBoolean(value, false)) return true;
  }

  const specificCandidates = [
    `${fieldName} Manual Override`,
    `${fieldName} Override`,
    `${fieldName} Locked`,
    `${fieldName} Manual`,
    `${fieldName} Edited`,
    `${fieldName} User Edited`
  ];
  for (const name of specificCandidates) {
    const value = getFieldValueByName(listingFields, name);
    if (parseBoolean(value, false)) return true;
  }

  return false;
}

function extractLinkedRecordIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (!item) return '';
        if (typeof item === 'string') return normalizeText(item);
        if (typeof item === 'object') return normalizeText(item.id || item.recordId || item.value || item.name || '');
        return '';
      })
      .filter(Boolean);
  }
  const single = normalizeText(value);
  return single ? [single] : [];
}

function parseCsvList(value) {
  if (Array.isArray(value)) {
    return value.map(item => normalizeText(item)).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map(item => normalizeText(item))
    .filter(Boolean);
}

function firstNonEmptyField(fields = {}, names = []) {
  for (const name of Array.isArray(names) ? names : []) {
    const key = normalizeText(name);
    if (!key) continue;
    const value = normalizeComparableValue(fields[key]);
    if (value) return value;
  }
  return '';
}

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function buildListingPayloadHash(fields = {}, hints = {}) {
  const includeFieldNames = parseCsvList(hints.includeFieldNames || []);
  const categoryIdField = normalizeText(hints.categoryIdField || '');
  const titleField = normalizeText(hints.titleField || '');
  const descriptionField = normalizeText(hints.descriptionField || '');
  const quantityField = normalizeText(hints.quantityField || '');
  const priceField = normalizeText(hints.priceField || '');
  const itemSpecificsField = normalizeText(hints.itemSpecificsField || '');

  const payload = {};

  if (includeFieldNames.length > 0) {
    for (const name of includeFieldNames) {
      payload[name] = normalizeComparableValue(fields[name]);
    }
  } else {
    payload.categoryId = categoryIdField ? normalizeComparableValue(fields[categoryIdField]) : '';
    payload.title = titleField ? normalizeComparableValue(fields[titleField]) : '';
    payload.description = descriptionField ? normalizeComparableValue(fields[descriptionField]) : '';
    payload.itemSpecifics = itemSpecificsField ? normalizeComparableValue(fields[itemSpecificsField]) : '';
    payload.quantity = quantityField ? normalizeComparableValue(fields[quantityField]) : '';
    payload.price = priceField ? normalizeComparableValue(fields[priceField]) : '';
  }

  const canonical = stableStringify(payload);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function detectFieldByAliases(fieldNames = [], aliases = []) {
  const lookup = new Map();
  for (const name of Array.isArray(fieldNames) ? fieldNames : []) {
    const key = normalizeKey(name);
    if (!key || lookup.has(key)) continue;
    lookup.set(key, name);
  }
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const key = normalizeKey(alias);
    if (lookup.has(key)) return lookup.get(key);
  }
  return '';
}

function detectRequiredFieldNames(fieldNames = [], options = {}) {
  const categoryIdField =
    normalizeText(options.categoryIdFieldName) ||
    detectFieldByAliases(fieldNames, ['eBay Category ID']);
  const titleField =
    normalizeText(options.titleFieldName) ||
    detectFieldByAliases(fieldNames, ['Item Title', 'AI Optimized Title', 'Product Title(New)', 'Product Title']);
  const descriptionField =
    normalizeText(options.descriptionFieldName) ||
    detectFieldByAliases(fieldNames, [
      'Item Description',
      'AI Description',
      'Buyer-visible Description',
      'c: partshunter203 ebay MOTORS e commerce description'
    ]);
  const itemSpecificsField =
    normalizeText(options.itemSpecificsFieldName) ||
    detectFieldByAliases(fieldNames, ['Item Specifics', 'Item Specific Values']);
  const ipnField =
    normalizeText(options.ipnFieldName) ||
    detectFieldByAliases(fieldNames, [
      'IPN (Interchange Part Number)',
      'Interchange Part Number',
      'IPN',
      'Inventory Number',
      'IP',
      'c: partshunter203 ebay MOTORS interchange part number',
      'C: partshunter203 ebay MOTORS interchange part number'
    ]);
  const itemIdField =
    normalizeText(options.itemIdFieldName) ||
    detectFieldByAliases(fieldNames, ['Item ID', 'ItemID', 'eBay Item ID', 'Ebay Item ID']);
  const batchLinkField =
    normalizeText(options.batchLinkFieldName) ||
    detectFieldByAliases(fieldNames, ['Batch', 'Batch Link', 'Listing Batches', 'Listing Batch']);
  const blockedField =
    normalizeText(options.blockedFieldName) ||
    detectFieldByAliases(fieldNames, ['Blocked', 'Is Blocked', 'Hold', 'Blocked Flag']);
  const exceptionField =
    normalizeText(options.exceptionFieldName) ||
    detectFieldByAliases(fieldNames, [
      'ClickUp Exception Status',
      'Exception Status',
      'Required Exception Status',
      'Exception Flag',
      'Has Exception'
    ]);
  const publishStatusField =
    normalizeText(options.publishStatusFieldName) ||
    detectFieldByAliases(fieldNames, ['Publish Status', 'Publishing Status']);
  const payloadHashField =
    normalizeText(options.payloadHashFieldName) ||
    detectFieldByAliases(fieldNames, ['Payload Hash']);
  const publishedAtField =
    normalizeText(options.publishedAtFieldName) ||
    detectFieldByAliases(fieldNames, ['Published At']);
  const publishRunIdField =
    normalizeText(options.publishRunIdFieldName) ||
    detectFieldByAliases(fieldNames, ['Publish Run ID']);

  return {
    categoryIdField,
    titleField,
    descriptionField,
    itemSpecificsField,
    ipnField,
    itemIdField,
    batchLinkField,
    blockedField,
    exceptionField,
    publishStatusField,
    payloadHashField,
    publishedAtField,
    publishRunIdField
  };
}

function getIpnPrefix(fields = {}, ipnFieldNames = []) {
  const ipn = firstNonEmptyField(fields, ipnFieldNames);
  if (!ipn) return '';
  const match = String(ipn).match(/^(\d{3})/);
  return match ? match[1] : '';
}

module.exports = {
  normalizeText,
  normalizeKey,
  normalizeComparableValue,
  parseBoolean,
  isManualOverrideForField,
  extractLinkedRecordIds,
  parseCsvList,
  detectRequiredFieldNames,
  firstNonEmptyField,
  getIpnPrefix,
  buildListingPayloadHash
};
