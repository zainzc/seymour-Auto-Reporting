const { loadEnv } = require('../config/loadEnv');
const { getInventoryConfig } = require('../config/configStore');
const AirtableService = require('./airtableService');
const AirtableSchemaService = require('./airtableSchemaService');
const { chunkArray } = require('../utils/chunk');

loadEnv();

const DEFAULT_SOURCE_TABLE = 'eBay Listings (API)';
const DEFAULT_SOURCE_BASE_ID = '';
const DEFAULT_DESTINATION_BASE_ID = '';
const TARGET_FIELD_NAME = 'C:Brand';
const SOURCE_ITEM_SPECIFICS_FIELD = 'Item Specifics';
const SOURCE_IPN_FIELDS = [
  'IPN (Interchange Part Number)',
  'c: partshunter203 ebay MOTORS interchange part number',
  'C: partshunter203 ebay MOTORS interchange part number',
  'IPN'
];
const SOURCE_CATEGORY_FIELDS = ['Category Name', 'eBay Category Name', 'eBay Category', 'Category'];
const BLOCKED_BRAND_VALUES = new Set(['does not apply', 'n/a', 'unknown']);

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeFieldKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeIpn(value) {
  return normalizeText(value).toUpperCase();
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = normalizeText(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_) {}
  return null;
}

function collectStrings(value, collector) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    const text = normalizeText(value);
    if (text) collector.push(text);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    collector.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, collector);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectStrings(item, collector);
    }
  }
}

function firstStringFromValue(value) {
  const strings = [];
  collectStrings(value, strings);
  return strings.length > 0 ? normalizeText(strings[0]) : '';
}

function extractBrandFromItemSpecifics(rawValue) {
  const parsed = parseJsonObject(rawValue);
  if (!parsed) return '';

  const brandKey = Object.keys(parsed).find(key => normalizeFieldKey(key) === 'brand');
  if (!brandKey) return '';

  const rawBrand = parsed[brandKey];
  if (Array.isArray(rawBrand)) {
    for (const item of rawBrand) {
      const candidate = firstStringFromValue(item);
      if (candidate) return candidate;
    }
    return '';
  }

  return firstStringFromValue(rawBrand);
}

function isBlockedBrand(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return true;
  return BLOCKED_BRAND_VALUES.has(normalized);
}

function parsePrefix(value) {
  const match = normalizeText(value).match(/^(\d{3})/);
  return match ? match[1] : '';
}

function normalizeCategoryToken(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[\/,_]/g, ' ')
    .replace(/[()\[\]{}.:;+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function getRouteCategoryKey(tableName) {
  const match = normalizeText(tableName).match(/^\d{3}\s*-\s*(.+)$/);
  return normalizeCategoryToken(match ? match[1] : '');
}

function getFieldValueByName(fields = {}, name = '') {
  if (!fields || typeof fields !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name];
  const target = normalizeFieldKey(name);
  if (!target) return '';
  const key = Object.keys(fields).find(item => normalizeFieldKey(item) === target);
  if (!key) return '';
  return fields[key];
}

function firstNonEmptyField(fields = {}, candidates = []) {
  for (const name of Array.isArray(candidates) ? candidates : []) {
    const key = normalizeText(name);
    if (!key) continue;
    const value = normalizeText(getFieldValueByName(fields, key));
    if (value) return value;
  }
  return '';
}

function resolveListingIpn(fields = {}) {
  return normalizeIpn(firstNonEmptyField(fields, SOURCE_IPN_FIELDS));
}

function resolveSourceCategory(fields = {}) {
  return normalizeCategoryToken(firstNonEmptyField(fields, SOURCE_CATEGORY_FIELDS));
}

function isFixedLockValue(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return false;
  return text === 'f' || text === 'fixed (f)' || text === 'fixed';
}

function isFieldFixedLocked(rowFields = {}, fieldName = '') {
  const name = normalizeText(fieldName);
  if (!name) return false;
  const candidates = [
    `${name} Rule`,
    `${name} Rule Type`,
    `${name} Source`,
    'Rule Type',
    'Population Rule',
    'Item Specific Rule',
    'Value Source',
    'Population Source'
  ];
  for (const candidate of candidates) {
    const raw = getFieldValueByName(rowFields, candidate);
    if (isFixedLockValue(raw)) return true;
  }
  return false;
}

function buildFixedLockFields(tableFieldNames = new Set(), targetFieldName = '') {
  const updates = {};
  const setF = name => {
    if (tableFieldNames.has(name)) updates[name] = 'F';
  };
  const setFixedF = name => {
    if (tableFieldNames.has(name)) updates[name] = 'Fixed (F)';
  };

  const specificRule = `${targetFieldName} Rule`;
  const specificRuleType = `${targetFieldName} Rule Type`;
  const specificSource = `${targetFieldName} Source`;
  setF(specificRule);
  setF(specificRuleType);
  setFixedF(specificSource);

  setF('Rule Type');
  setF('Population Rule');
  setF('Item Specific Rule');
  setFixedF('Value Source');
  setFixedF('Population Source');

  return updates;
}

function hasFieldByNormalizedName(existingFields = new Set(), fieldName = '') {
  if (!(existingFields instanceof Set)) return false;
  const target = normalizeFieldKey(fieldName);
  if (!target) return false;
  for (const name of existingFields) {
    if (normalizeFieldKey(name) === target) return true;
  }
  return false;
}

function findFieldNameByNormalizedName(existingFields = new Set(), fieldName = '') {
  if (!(existingFields instanceof Set)) return '';
  const target = normalizeFieldKey(fieldName);
  if (!target) return '';
  for (const name of existingFields) {
    if (normalizeFieldKey(name) === target) return name;
  }
  return '';
}

function buildConfig(overrides = {}) {
  const phase2Config = getInventoryConfig('phase2Config') || {};
  const token = String(
    overrides.token ||
      process.env.AIRTABLE_TOKEN ||
      phase2Config.airtableToken ||
      ''
  ).trim();
  const sourceBaseId = String(
    overrides.sourceBaseId ||
      process.env.AIRTABLE_BASE_ID ||
      phase2Config.airtableBaseId ||
      ''
  ).trim();
  const destinationBaseId = String(
    overrides.destinationBaseId ||
      process.env.AIRTABLE_ITEM_SPECIFICS_BASE_ID ||
      process.env.ITEM_SPECIFICS_BASE_ID ||
      phase2Config.itemSpecificsBaseId ||
      ''
  ).trim();
  const sourceTableName = String(
    overrides.sourceTableName ||
      overrides.ebaySandboxTableName ||
      phase2Config.ebaySandboxTableName ||
      phase2Config.phase5ListingsTable ||
      process.env.EBAY_SANDBOX_TABLE_NAME ||
      DEFAULT_SOURCE_TABLE
  ).trim() || DEFAULT_SOURCE_TABLE;
  const dryRun =
    typeof overrides.dryRun === 'boolean'
      ? overrides.dryRun
      : String(process.env.EBAY_BRAND_PROPAGATION_DRY_RUN || '').toLowerCase() === 'true';

  return {
    token,
    sourceBaseId,
    destinationBaseId,
    sourceTableName,
    dryRun
  };
}

function chooseRouteForSourceRecord(routes = [], sourceCategory = '') {
  if (!Array.isArray(routes) || routes.length === 0) {
    return { route: null, ambiguous: false };
  }
  if (routes.length === 1) {
    return { route: routes[0], ambiguous: false };
  }

  const categoryToken = normalizeCategoryToken(sourceCategory);
  if (categoryToken) {
    const exactMatch = routes.find(route => route.categoryKey && route.categoryKey === categoryToken);
    if (exactMatch) {
      return { route: exactMatch, ambiguous: false };
    }
    const partialMatch = routes.find(route => route.categoryKey && categoryToken.includes(route.categoryKey));
    if (partialMatch) {
      return { route: partialMatch, ambiguous: false };
    }
    const reverseMatch = routes.find(route => route.categoryKey && route.categoryKey.includes(categoryToken));
    if (reverseMatch) {
      return { route: reverseMatch, ambiguous: false };
    }
  }

  return { route: null, ambiguous: true };
}

async function buildRoutingMap(schemaService) {
  const tables = await schemaService.listTables();
  const tablesByPrefix = new Map();
  const tablesById = new Map();

  for (const table of Array.isArray(tables) ? tables : []) {
    const tableName = normalizeText(table?.name);
    if (!/^\d{3}-/.test(tableName)) continue;
    const prefix = parsePrefix(tableName);
    if (!prefix) continue;
    const current = {
      tableId: normalizeText(table?.id),
      tableName,
      prefix,
      categoryKey: getRouteCategoryKey(tableName),
      fieldNames: new Set(
        (Array.isArray(table?.fields) ? table.fields : [])
          .map(field => normalizeText(field?.name))
          .filter(Boolean)
      )
    };
    if (!tablesByPrefix.has(prefix)) {
      tablesByPrefix.set(prefix, []);
    }
    tablesByPrefix.get(prefix).push(current);
    if (current.tableId) tablesById.set(current.tableId, current);
  }

  return {
    tablesByPrefix,
    tablesById
  };
}

async function patchTableRecords(itemService, tableId, updates = []) {
  let written = 0;
  const errors = [];
  for (const batch of chunkArray(Array.isArray(updates) ? updates : [], 10)) {
    if (batch.length === 0) continue;
    try {
      const data = await itemService.request('PATCH', `/${encodeURIComponent(tableId)}`, {
        data: {
          records: batch,
          typecast: true
        }
      });
      const records = Array.isArray(data?.records) ? data.records : [];
      written += records.length;
    } catch (error) {
      const message =
        error?.response?.data?.error?.message ||
        error?.response?.data?.error ||
        error?.message ||
        String(error);
      errors.push(`PATCH failed for table ${tableId} (batch=${batch.length}): ${message}`);
    }
  }

  return {
    written,
    errors
  };
}

async function runEbayBrandPropagation(options = {}, progressCallback = () => {}) {
  const config = buildConfig(options);
  const summary = {
    dryRun: Boolean(config.dryRun),
    sourceTableName: config.sourceTableName,
    sourceRowsScanned: 0,
    sourceRowsWithBrand: 0,
    sourceRowsSkippedBlankBrand: 0,
    sourceRowsSkippedBlockedBrand: 0,
    sourceRowsSkippedNoIpn: 0,
    sourceRowsSkippedNoRoute: 0,
    sourceRowsSkippedAmbiguousRoute: 0,
    destinationRowsScanned: 0,
    destinationRowsMatched: 0,
    destinationRowsSkippedMissingField: 0,
    destinationRowsSkippedExisting: 0,
    destinationRowsSkippedLocked: 0,
    destinationRowsSkippedMissingDestination: 0,
    destinationRowsSkippedDuplicateSource: 0,
    written: 0,
    errors: []
  };

  if (!config.token) {
    throw new Error('Brand propagation config missing AIRTABLE_TOKEN.');
  }
  if (!config.sourceBaseId) {
    throw new Error('Brand propagation config missing source AIRTABLE_BASE_ID.');
  }
  if (!config.destinationBaseId) {
    throw new Error('Brand propagation config missing item specifics base ID.');
  }

  const sourceService = new AirtableService({
    token: config.token,
    baseId: config.sourceBaseId
  });
  const destinationService = new AirtableService({
    token: config.token,
    baseId: config.destinationBaseId
  });
  const schemaService = new AirtableSchemaService({
    token: config.token,
    baseId: config.destinationBaseId
  });

  if (config.dryRun) {
    summary.message = 'Dry run enabled; Brand propagation skipped.';
    return summary;
  }

  if (typeof progressCallback === 'function') {
    progressCallback({
      stage: 'ebay_brand_propagation_start',
      percent: 5,
      counts: summary,
      message: `Brand propagation started for ${config.sourceTableName}...`
    });
  }

  const { tablesByPrefix } = await buildRoutingMap(schemaService);

  if (typeof progressCallback === 'function') {
    progressCallback({
      stage: 'ebay_brand_propagation_route_map',
      percent: 12,
      counts: summary,
      message: 'Routing map built for Item Specifics by Part Type tables.'
    });
  }

  const sourceSelectFields = [
    ...SOURCE_IPN_FIELDS,
    ...SOURCE_CATEGORY_FIELDS,
    SOURCE_ITEM_SPECIFICS_FIELD
  ];
  const sourceRows = await sourceService.fetchAllRecords(config.sourceTableName, sourceSelectFields);
  summary.sourceRowsScanned = sourceRows.length;

  const byRoute = new Map();
  for (const row of sourceRows) {
    const fields = row?.fields || {};
    const ipn = resolveListingIpn(fields);
    if (!ipn) {
      summary.sourceRowsSkippedNoIpn += 1;
      continue;
    }

    const brand = extractBrandFromItemSpecifics(getFieldValueByName(fields, SOURCE_ITEM_SPECIFICS_FIELD));
    if (!brand) {
      summary.sourceRowsSkippedBlankBrand += 1;
      continue;
    }
    if (isBlockedBrand(brand)) {
      summary.sourceRowsSkippedBlockedBrand += 1;
      continue;
    }
    summary.sourceRowsWithBrand += 1;

    const prefix = parsePrefix(ipn);
    if (!prefix) {
      summary.sourceRowsSkippedNoRoute += 1;
      continue;
    }

    const candidateRoutes = tablesByPrefix.get(prefix) || [];
    const sourceCategory = resolveSourceCategory(fields);
    const choice = chooseRouteForSourceRecord(candidateRoutes, sourceCategory);
    if (!choice.route) {
      if (choice.ambiguous && candidateRoutes.length > 1) {
        summary.sourceRowsSkippedAmbiguousRoute += 1;
      } else {
        summary.sourceRowsSkippedNoRoute += 1;
      }
      continue;
    }

    if (!byRoute.has(choice.route.tableId)) {
      byRoute.set(choice.route.tableId, {
        route: choice.route,
        rows: [],
        rowIdsSeen: new Set()
      });
    }

    byRoute.get(choice.route.tableId).rows.push({
      sourceRecordId: normalizeText(row?.id),
      ipn,
      brand,
      sourceCategory
    });
  }

  const routeEntries = Array.from(byRoute.values());
  let processedRoutes = 0;

  for (const entry of routeEntries) {
    const route = entry.route;
    processedRoutes += 1;
    const targetFieldName = findFieldNameByNormalizedName(route.fieldNames, TARGET_FIELD_NAME) || TARGET_FIELD_NAME;
    if (!hasFieldByNormalizedName(route.fieldNames, targetFieldName)) {
      summary.destinationRowsSkippedMissingField += entry.rows.length;
      continue;
    }

    const lockFields = buildFixedLockFields(route.fieldNames, targetFieldName);
    const selectFields = Array.from(
      new Set([
        findFieldNameByNormalizedName(route.fieldNames, 'IPN') || 'IPN',
        targetFieldName,
        ...Object.keys(lockFields)
      ])
    );
    const destinationRows = await destinationService.fetchAllRecords(route.tableName, selectFields);
    summary.destinationRowsScanned += destinationRows.length;
    const destinationByIpn = new Map();
    for (const destRow of destinationRows) {
      const destFields = destRow?.fields || {};
      const destIpn = normalizeIpn(getFieldValueByName(destFields, 'IPN'));
      if (!destIpn) continue;
      if (!destinationByIpn.has(destIpn)) {
        destinationByIpn.set(destIpn, destRow);
      }
    }

    const pendingUpdates = new Map();
    for (const sourceRow of entry.rows) {
      const destRow = destinationByIpn.get(sourceRow.ipn);
      if (!destRow) {
        summary.destinationRowsSkippedMissingDestination += 1;
        continue;
      }

      const destFields = destRow?.fields || {};
      const currentValue = normalizeText(getFieldValueByName(destFields, targetFieldName));
      if (currentValue) {
        summary.destinationRowsSkippedExisting += 1;
        continue;
      }

      if (isFieldFixedLocked(destFields, targetFieldName)) {
        summary.destinationRowsSkippedLocked += 1;
        continue;
      }

      if (pendingUpdates.has(destRow.id)) {
        summary.destinationRowsSkippedDuplicateSource += 1;
        continue;
      }

      pendingUpdates.set(destRow.id, {
        id: destRow.id,
        fields: {
          [targetFieldName]: sourceRow.brand,
          ...lockFields
        }
      });
      summary.destinationRowsMatched += 1;
    }

    if (pendingUpdates.size === 0) {
      if (typeof progressCallback === 'function') {
        progressCallback({
          stage: 'ebay_brand_propagation_route',
          percent: Math.min(95, 15 + Math.floor((processedRoutes / Math.max(routeEntries.length, 1)) * 70)),
          counts: summary,
          message: `Brand propagation processed ${route.tableName} with no writes.`
        });
      }
      continue;
    }

    const writeSummary = await patchTableRecords(destinationService, route.tableId, Array.from(pendingUpdates.values()));
    summary.written += writeSummary.written;
    if (Array.isArray(writeSummary.errors) && writeSummary.errors.length > 0) {
      summary.errors.push(...writeSummary.errors);
    }

    if (typeof progressCallback === 'function') {
      progressCallback({
        stage: 'ebay_brand_propagation_route',
        percent: Math.min(95, 15 + Math.floor((processedRoutes / Math.max(routeEntries.length, 1)) * 70)),
        counts: summary,
        message: `Brand propagation updated ${route.tableName}: written=${writeSummary.written}`
      });
    }
  }

  if (typeof progressCallback === 'function') {
    progressCallback({
      stage: 'ebay_brand_propagation_completed',
      percent: 100,
      counts: summary,
      message: `Brand propagation completed: scanned=${summary.sourceRowsScanned}, written=${summary.written}`
    });
  }

  return summary;
}

module.exports = {
  runEbayBrandPropagation
};
