const AirtableService = require('./airtableService');
const AirtableSchemaService = require('./airtableSchemaService');
const {
  populateEbayItemSpecificsUrlsForRecords
} = require('./masterEbayItemSpecificsUrlService');
const { readSheetRows } = require('./phase2SheetsService');
const { chunkArray } = require('../utils/chunk');
const { getInventoryConfig, saveInventoryConfig } = require('../config/configStore');

const MIRROR_STATE_KEY = 'phase4MirrorState';
const EXCLUDED_PREFIXES = new Set(['900', '950', '999']);
const MANUFACTURER_PART_FIELD = 'C:Manufacturer Part Number';
const MASTER_EBAY_ITEM_SPECIFICS_FIELD = 'eBay Item Specifics';
const MANUFACTURER_LOCK_FIELD_CANDIDATES = [
  'Rule Type',
  'Population Rule',
  'Item Specific Rule',
  'Value Source',
  'Population Source'
];

function normalizeString(value) {
  return String(value || '').trim();
}

function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return defaultValue;
}

function emitProgress(progressCallback, payload = {}) {
  if (typeof progressCallback === 'function') {
    progressCallback(payload);
  }
}

function parsePrefix(value) {
  const match = normalizeString(value).match(/^(\d{3})/);
  return match ? match[1] : '';
}

function parseMasterPrefix(value) {
  const parsed = parseInt(normalizeString(value), 10);
  if (!Number.isFinite(parsed)) return '';
  return String(parsed).padStart(3, '0');
}

function normalizeCategoryToken(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[\/,_]/g, ' ')
    .replace(/[()\[\]{}.:;+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function addCategoryTokens(tokens, value) {
  if (!(tokens instanceof Set)) return;
  const raw = normalizeString(value);
  if (!raw) return;
  const add = text => {
    const token = normalizeCategoryToken(text);
    if (token) tokens.add(token);
  };
  add(raw);
  raw
    .split(/[|,;/]+/)
    .map(item => normalizeString(item))
    .filter(Boolean)
    .forEach(add);
}

function readLinkedRecordIds(fields = {}, candidates = []) {
  for (const name of candidates) {
    const key = normalizeString(name);
    if (!key) continue;
    const raw = fields?.[key];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    return raw
      .map(item => {
        if (!item) return '';
        if (typeof item === 'string') return normalizeString(item);
        if (typeof item === 'object') return normalizeString(item.id || item.recordId || '');
        return '';
      })
      .filter(Boolean);
  }
  return [];
}

function extractEbayCategoryLeaf(value) {
  const raw = normalizeString(value);
  if (!raw) return '';
  const parts = raw
    .split('»')
    .map(item => normalizeString(item))
    .filter(Boolean);
  if (parts.length > 0) return parts[parts.length - 1];
  return raw;
}

function buildCategoryDefinitionLookup(categoryRecords = []) {
  const byId = new Map();
  for (const record of categoryRecords) {
    const id = normalizeString(record?.id);
    if (!id) continue;
    const fields = record?.fields || {};
    const prefix = parseMasterPrefix(fields['IPN Prefix']);
    const tokens = new Set();
    addCategoryTokens(tokens, fields['Category Identifier / Conditions & Options']);
    addCategoryTokens(tokens, fields['Category Identifier']);
    addCategoryTokens(tokens, fields['Conditions & Options']);
    if (tokens.size === 0) {
      const ebayCategoryLeaf = extractEbayCategoryLeaf(
        fields['eBay Category Name'] || fields['eBay Category'] || fields['eBay Category Path']
      );
      addCategoryTokens(tokens, ebayCategoryLeaf);
    }
    byId.set(id, {
      prefix,
      tokens
    });
  }
  return byId;
}

function resolveIdentifierTokensForPrefix(linkedIds = [], categoryLookup = new Map(), prefix = '') {
  const resolved = new Set();
  for (const recordId of linkedIds) {
    const entry = categoryLookup.get(recordId);
    if (!entry) continue;
    if (entry.prefix && prefix && entry.prefix !== prefix) continue;
    for (const token of entry.tokens || []) {
      if (token) resolved.add(token);
    }
  }
  return resolved;
}

function getRouteCategoryKey(tableName) {
  const match = normalizeString(tableName).match(/^\d{3}\s*-\s*(.+)$/);
  return normalizeCategoryToken(match ? match[1] : '');
}

function findRouteByIdentifierTokens(routes = [], categoryIdentifierTokens = new Set()) {
  const candidates = Array.isArray(routes) ? routes : [];
  const tokens = categoryIdentifierTokens instanceof Set
    ? [...categoryIdentifierTokens].filter(token => token && token.length >= 2)
    : [];
  if (candidates.length === 0 || tokens.length === 0) {
    return {
      status: 'missing',
      matches: []
    };
  }

  const exactMatches = candidates.filter(route =>
    tokens.includes(normalizeString(route?.categoryKey))
  );
  if (exactMatches.length === 1) {
    return {
      status: 'ok',
      matches: exactMatches,
      route: exactMatches[0],
      matchType: 'exact'
    };
  }
  if (exactMatches.length > 1) {
    return {
      status: 'ambiguous',
      matches: exactMatches
    };
  }

  const containedMatches = candidates.filter(route => {
    const routeKey = normalizeString(route?.categoryKey);
    if (!routeKey) return false;
    return tokens.some(token => routeKey.includes(token) || token.includes(routeKey));
  });
  if (containedMatches.length === 1) {
    return {
      status: 'ok',
      matches: containedMatches,
      route: containedMatches[0],
      matchType: 'contains'
    };
  }
  if (containedMatches.length > 1) {
    return {
      status: 'ambiguous',
      matches: containedMatches
    };
  }

  return {
    status: 'missing',
    matches: []
  };
}

function classifyRoutingFailure(failureGroups, type, payload = {}) {
  if (!failureGroups || !type) return;
  if (!failureGroups[type]) {
    failureGroups[type] = new Map();
  }

  if (type === 'ambiguousDuplicatePrefix') {
    const key = `${payload.prefix || ''}::${payload.categoryName || ''}`;
    if (!failureGroups[type].has(key)) {
      failureGroups[type].set(key, {
        prefix: payload.prefix || '',
        categoryName: payload.categoryName || '',
        candidateTables: Array.isArray(payload.candidateTables) ? payload.candidateTables : [],
        count: 0
      });
    }
    failureGroups[type].get(key).count += 1;
    return;
  }

  const prefix = payload.prefix || '';
  failureGroups[type].set(prefix, (failureGroups[type].get(prefix) || 0) + 1);
}

function flushRoutingFailureGroups(summary, failureGroups) {
  if (!summary || !failureGroups) return;
  const missing = failureGroups.missingPrefixTable || new Map();
  const blank = failureGroups.blankCategoryForDuplicatePrefix || new Map();
  const ambiguous = failureGroups.ambiguousDuplicatePrefix || new Map();

  for (const [prefix, count] of missing.entries()) {
    addError(summary, `[routing][missingPrefixTable] prefix=${prefix} count=${count}`);
  }
  for (const [prefix, count] of blank.entries()) {
    addError(summary, `[routing][blankCategoryForDuplicatePrefix] prefix=${prefix} count=${count}`);
  }
  for (const item of ambiguous.values()) {
    addError(
      summary,
      `[routing][ambiguousDuplicatePrefix] prefix=${item.prefix} categoryName='${item.categoryName}' count=${item.count} candidates=${item.candidateTables.join(' | ')}`
    );
  }

  summary.routingFailureGroups = {
    missingPrefixTable: Object.fromEntries(missing.entries()),
    blankCategoryForDuplicatePrefix: Object.fromEntries(blank.entries()),
    ambiguousDuplicatePrefix: [...ambiguous.values()]
  };
}

function isExcludedPrefix(prefix) {
  return EXCLUDED_PREFIXES.has(normalizeString(prefix));
}

function buildPhase4Config(options = {}) {
  const phase2Config = getInventoryConfig('phase2Config') || {};
  const phase4Config = getInventoryConfig('phase4Config') || {};
  const merged = {
    ...phase2Config,
    ...phase4Config,
    ...options
  };

  return {
    airtableToken: normalizeString(merged.airtableToken || process.env.AIRTABLE_TOKEN),
    masterBaseId: normalizeString(merged.airtableBaseId || process.env.AIRTABLE_BASE_ID),
    masterTable: normalizeString(merged.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table'),
    categoryTable: normalizeString(merged.airtableCategoryTable || process.env.AIRTABLE_CATEGORY_TABLE || 'Category Definitions'),
    itemSpecificsBaseId: normalizeString(
      merged.itemSpecificsBaseId ||
        process.env.AIRTABLE_ITEM_SPECIFICS_BASE_ID ||
        process.env.ITEM_SPECIFICS_BASE_ID ||
        getInventoryConfig('itemSpecificsBaseId')
    ),
    incrementalEnabled: parseBoolean(
      typeof merged.phase4IncrementalEnabled !== 'undefined'
        ? merged.phase4IncrementalEnabled
        : process.env.PHASE4_INCREMENTAL_ENABLED,
      true
    ),
    dryRun: parseBoolean(
      typeof merged.phase4DryRun !== 'undefined' ? merged.phase4DryRun : process.env.PHASE4_DRY_RUN,
      false
    ),
    sampleLimit: Number(merged.phase4SampleLimit || process.env.PHASE4_SAMPLE_LIMIT || 25) || 25,
    sheetId: normalizeString(merged.sheetId || process.env.GOOGLE_SHEET_ID || getInventoryConfig('spreadsheetId')),
    tabName: normalizeString(merged.tabName || process.env.GOOGLE_TAB_NAME || getInventoryConfig('worksheetName')),
    authContext: normalizeString(merged.authContext || 'inventory') || 'inventory'
  };
}

function buildSummary(sampleLimit = 25) {
  return {
    masterRecordsScanned: 0,
    masterRecordsEligible: 0,
    routingFailures: 0,
    routingFailureSamples: [],
    tablesTouched: 0,
    ipnRowsAlreadyPresent: 0,
    ipnRowsCreated: 0,
    ipnRowsPlanned: 0,
    manufacturerRefsMapped: 0,
    manufacturerValuesPlanned: 0,
    manufacturerValuesWritten: 0,
    manufacturerValuesSkippedExisting: 0,
    errors: [],
    runMode: 'full_scan',
    lastMirrorRunAt: '',
    sampleLimit,
    dryRun: false
  };
}

function appendSample(list, value, limit) {
  if (!Array.isArray(list) || list.length >= limit) return;
  list.push(value);
}

function addError(summary, message) {
  if (!message) return;
  if (summary.errors.length < 200) {
    summary.errors.push(message);
  }
}

function normalizeIpn(value) {
  return normalizeString(value).toUpperCase();
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

async function patchTableRecords(itemService, tableId, updates = [], options = {}) {
  let written = 0;
  const errors = [];
  const successfulRecordIds = [];
  const batches = chunkArray(updates, 10);
  let batchIndex = 0;
  for (const batch of batches) {
    batchIndex += 1;
    try {
      const data = await itemService.request('PATCH', `/${encodeURIComponent(tableId)}`, {
        data: {
          records: batch,
          typecast: true
        }
      });
      const records = Array.isArray(data?.records) ? data.records : [];
      written += records.length;
      records.forEach(record => {
        const id = normalizeString(record?.id);
        if (id) successfulRecordIds.push(id);
      });
    } catch (error) {
      const message =
        error?.response?.data?.error?.message ||
        error?.response?.data?.error ||
        error?.message ||
        String(error);
      errors.push(`PATCH failed for table ${tableId} (batch=${batch.length}): ${message}`);
    } finally {
      if (typeof options.onBatchComplete === 'function') {
        options.onBatchComplete({
          tableId,
          index: batchIndex,
          total: batches.length,
          requested: batch.length,
          writtenSoFar: written,
          errorsSoFar: errors.length
        });
      }
    }
  }

  return {
    written,
    errors,
    successfulRecordIds
  };
}

async function fetchTableRecordsWithProgress(itemService, tableId, selectFields = [], onPage = null) {
  const records = [];
  let offset = null;
  let page = 0;
  do {
    const params = {};
    if (offset) params.offset = offset;
    if (Array.isArray(selectFields) && selectFields.length > 0) params.fields = selectFields;
    const data = await itemService.request('GET', `/${encodeURIComponent(tableId)}`, { params });
    const batch = Array.isArray(data?.records) ? data.records : [];
    records.push(...batch);
    page += 1;
    if (typeof onPage === 'function') {
      onPage({
        page,
        loaded: records.length,
        pageSize: batch.length,
        hasMore: Boolean(data?.offset)
      });
    }
    offset = data?.offset || null;
  } while (offset);
  return records;
}

async function loadReferenceNumberByIpn(config, progressCallback, summary) {
  const map = new Map();
  if (!config.sheetId || !config.tabName) {
    return map;
  }

  emitProgress(progressCallback, {
    stage: 'phase4_load_sheet',
    percent: 18,
    counts: summary,
    message: 'Loading source sheet for ReferenceNumber mapping...'
  });

  const values = await readSheetRows(config.sheetId, config.tabName, config.authContext || 'inventory');
  if (!Array.isArray(values) || values.length === 0) {
    return map;
  }

  const headers = (values[0] || []).map(value => normalizeString(value).toLowerCase());
  const ipnIndex = headers.findIndex(name =>
    ['inventorynumber', 'inventory number', 'inventorynu', 'ipn'].includes(name)
  );
  const referenceIndex = headers.findIndex(name =>
    ['referencenumber', 'reference number', 'manufacturerpartnumber', 'manufacturer part number'].includes(name)
  );

  if (ipnIndex < 0 || referenceIndex < 0) {
    addError(
      summary,
      'ReferenceNumber mapping skipped: source sheet is missing InventoryNumber or ReferenceNumber columns.'
    );
    return map;
  }

  for (let i = 1; i < values.length; i += 1) {
    const row = values[i] || [];
    const ipn = normalizeIpn(row[ipnIndex]);
    if (!ipn) continue;
    if (isExcludedPrefix(parseMasterPrefix(ipn))) continue;

    const referenceNumber = normalizeString(row[referenceIndex]);
    if (!referenceNumber) continue;
    if (!map.has(ipn)) {
      map.set(ipn, referenceNumber);
    }
  }

  return map;
}

function detectIncrementalField(masterTableSchema = {}) {
  const fields = Array.isArray(masterTableSchema?.fields) ? masterTableSchema.fields : [];
  const byType = type => fields.filter(field => normalizeString(field?.type) === type);

  const lastModifiedCandidates = byType('lastModifiedTime');
  if (lastModifiedCandidates.length > 0) {
    const preferred =
      lastModifiedCandidates.find(field =>
        normalizeString(field?.name).toLowerCase().includes('last')
      ) || lastModifiedCandidates[0];
    return { name: normalizeString(preferred?.name), type: 'lastModifiedTime' };
  }

  const createdCandidates = byType('createdTime');
  if (createdCandidates.length > 0) {
    const preferred =
      createdCandidates.find(field =>
        normalizeString(field?.name).toLowerCase().includes('created')
      ) || createdCandidates[0];
    return { name: normalizeString(preferred?.name), type: 'createdTime' };
  }

  return null;
}

function buildIncrementalFormula(fieldName, sinceIso) {
  const safeField = String(fieldName || '').replace(/}/g, '\\}');
  const safeIso = String(sinceIso || '').replace(/"/g, '\\"');
  if (!safeField || !safeIso) return '';
  return `IS_AFTER({${safeField}}, "${safeIso}")`;
}

async function fetchMasterRecords(
  airtableService,
  tableName,
  selectFields = [],
  filterByFormula = '',
  onPage = null
) {
  const records = [];
  let offset = null;
  let page = 0;
  do {
    const params = {};
    if (offset) params.offset = offset;
    if (selectFields.length > 0) params.fields = selectFields;
    if (filterByFormula) params.filterByFormula = filterByFormula;

    const data = await airtableService.request('GET', `/${encodeURIComponent(tableName)}`, { params });
    records.push(...(data?.records || []));
    page += 1;
    if (typeof onPage === 'function') {
      onPage({
        page,
        loaded: records.length,
        pageSize: Array.isArray(data?.records) ? data.records.length : 0
      });
    }
    offset = data?.offset || null;
  } while (offset);
  return records;
}

async function buildRoutingMap(itemSchemaService) {
  const tables = await itemSchemaService.listTables();
  const tablesByPrefix = new Map();
  const tablesById = new Map();
  const duplicatePrefixes = [];

  for (const table of tables) {
    const tableName = normalizeString(table?.name);
    if (!/^\d{3}-/.test(tableName)) continue;
    const prefix = parsePrefix(tableName);
    if (!prefix) continue;
    const current = {
      tableId: normalizeString(table?.id),
      tableName,
      prefix,
      categoryKey: getRouteCategoryKey(tableName),
      fieldNames: new Set(
        (Array.isArray(table?.fields) ? table.fields : [])
          .map(field => normalizeString(field?.name))
          .filter(Boolean)
      )
    };
    if (!tablesByPrefix.has(prefix)) {
      tablesByPrefix.set(prefix, []);
    }
    tablesByPrefix.get(prefix).push(current);
    if (current.tableId) tablesById.set(current.tableId, current);
  }

  for (const [prefix, routes] of tablesByPrefix.entries()) {
    if (routes.length <= 1) continue;
    duplicatePrefixes.push({
      prefix,
      tables: routes.map(route => route.tableName)
    });
  }

  return {
    tablesByPrefix,
    tablesById,
    duplicatePrefixes
  };
}

async function runPhase4Mirroring(options = {}, progressCallback = () => {}) {
  const config = buildPhase4Config(options);
  const summary = buildSummary(config.sampleLimit);
  summary.dryRun = Boolean(config.dryRun);
  const startedAt = new Date().toISOString();
  const state = getInventoryConfig(MIRROR_STATE_KEY) || {};
  const lastMirrorRunAt = normalizeString(state?.lastMirrorRunAt);

  if (!config.airtableToken) {
    throw new Error('Phase 4 config missing AIRTABLE_TOKEN.');
  }
  if (!config.masterBaseId) {
    throw new Error('Phase 4 config missing master base ID (AIRTABLE_BASE_ID).');
  }
  if (!config.itemSpecificsBaseId) {
    throw new Error(
      'Phase 4 config missing item specifics base ID (AIRTABLE_ITEM_SPECIFICS_BASE_ID / ITEM_SPECIFICS_BASE_ID).'
    );
  }

  const masterService = new AirtableService({
    token: config.airtableToken,
    baseId: config.masterBaseId,
    masterTable: config.masterTable
  });
  const itemService = new AirtableService({
    token: config.airtableToken,
    baseId: config.itemSpecificsBaseId
  });
  const itemSchemaService = new AirtableSchemaService({
    token: config.airtableToken,
    baseId: config.itemSpecificsBaseId
  });

  emitProgress(progressCallback, {
    stage: 'phase4_route_map',
    percent: 10,
    counts: summary,
    message: 'Building routing map from Item Specifics base schema...'
  });
  const { tablesByPrefix, tablesById, duplicatePrefixes } = await buildRoutingMap(itemSchemaService);

  let categoryDefinitionLookup = new Map();
  let categoryLinkFieldName = '';
  if (duplicatePrefixes.length > 0) {
    emitProgress(progressCallback, {
      stage: 'phase4_route_map',
      percent: 15,
      counts: summary,
      message: `Loading Category Definitions for duplicate-prefix routing (${duplicatePrefixes.length} prefixes)...`
    });
    try {
      categoryLinkFieldName = await masterService.resolveMasterCategoryLinkFieldName();
      const categoryRecords = await masterService.fetchAllRecords(config.categoryTable, []);
      categoryDefinitionLookup = buildCategoryDefinitionLookup(categoryRecords);
    } catch (error) {
      addError(summary, `Category Definitions fallback unavailable: ${error.message}`);
    }
  }

  emitProgress(progressCallback, {
    stage: 'phase4_load_master',
    percent: 20,
    counts: summary,
    message: 'Loading Master Parts records...'
  });

  const selectFields = [
    'IPN',
    'IPN Prefix',
    MASTER_EBAY_ITEM_SPECIFICS_FIELD,
    'Category Name',
    'Category Definitions Link',
    'Category Definitions',
    'Categories'
  ];
  if (categoryLinkFieldName && !selectFields.includes(categoryLinkFieldName)) {
    selectFields.push(categoryLinkFieldName);
  }

  let masterRecords = [];
  let runMode = 'full_scan';
  const preloadedMasterRows = Array.isArray(options.phase4SharedMasterRows)
    ? options.phase4SharedMasterRows
    : null;
  if (preloadedMasterRows) {
    runMode = 'shared_master_cache';
    masterRecords = preloadedMasterRows;
    emitProgress(progressCallback, {
      stage: 'phase4_load_master',
      percent: 20,
      counts: summary,
      message: `Using shared Master Parts context cache: rows=${masterRecords.length}.`
    });
  }
  let lastLoadProgressCount = 0;
  const reportMasterLoadProgress = ({ page = 0, loaded = 0 } = {}) => {
    // Keep logs useful without flooding: first page + every 1000 loaded.
    if (page !== 1 && loaded - lastLoadProgressCount < 1000) return;
    lastLoadProgressCount = loaded;
    emitProgress(progressCallback, {
      stage: 'phase4_load_master',
      percent: 20,
      counts: summary,
      message: `Loading Master Parts records... loaded=${loaded} (pages=${page})`
    });
  };

  if (!preloadedMasterRows && config.incrementalEnabled && lastMirrorRunAt) {
    try {
      const masterTables = await masterService.getSchemaTables();
      const masterSchema = masterService.findSchemaTable(masterTables, '', config.masterTable);
      const incrementalField = detectIncrementalField(masterSchema);
      if (incrementalField?.name) {
        const formula = buildIncrementalFormula(incrementalField.name, lastMirrorRunAt);
        masterRecords = await fetchMasterRecords(
          masterService,
          config.masterTable,
          selectFields,
          formula,
          reportMasterLoadProgress
        );
        runMode = `incremental_${incrementalField.type}`;
      }
    } catch (error) {
      addError(summary, `Incremental read unavailable; fallback to full scan: ${error.message}`);
      masterRecords = [];
      runMode = 'full_scan';
    }
  }

  if (!preloadedMasterRows && masterRecords.length === 0 && runMode === 'full_scan') {
    try {
      masterRecords = await fetchMasterRecords(
        masterService,
        config.masterTable,
        selectFields,
        '',
        reportMasterLoadProgress
      );
    } catch (error) {
      addError(
        summary,
        `Field-limited master fetch failed; retrying full field scan: ${error.message}`
      );
      masterRecords = await fetchMasterRecords(
        masterService,
        config.masterTable,
        [],
        '',
        reportMasterLoadProgress
      );
    }
  } else if (!preloadedMasterRows && masterRecords.length === 0 && runMode.startsWith('incremental')) {
    // For ReferenceNumber -> C:Manufacturer Part Number backfill, always continue with full scan.
    runMode = 'full_scan';
    emitProgress(progressCallback, {
      stage: 'phase4_load_master',
      percent: 20,
      counts: summary,
      message: 'Incremental scan returned no rows; running full scan to keep backfill in sync.'
    });
    try {
      masterRecords = await fetchMasterRecords(
        masterService,
        config.masterTable,
        selectFields,
        '',
        reportMasterLoadProgress
      );
    } catch (error) {
      addError(
        summary,
        `Field-limited master fetch failed; retrying full field scan: ${error.message}`
      );
      masterRecords = await fetchMasterRecords(
        masterService,
        config.masterTable,
        [],
        '',
        reportMasterLoadProgress
      );
    }
  }

  summary.runMode = runMode;
  summary.masterRecordsScanned = masterRecords.length;
  emitProgress(progressCallback, {
    stage: 'phase4_load_master',
    percent: 22,
    counts: summary,
    message: `Loaded Master Parts records: ${masterRecords.length}`
  });

  const ebayItemSpecificsUrlSummary = await populateEbayItemSpecificsUrlsForRecords(masterRecords, {
    airtableToken: config.airtableToken,
    airtableBaseId: config.masterBaseId,
    airtableMasterTable: config.masterTable,
    itemSpecificsBaseId: config.itemSpecificsBaseId,
    targetFieldName: MASTER_EBAY_ITEM_SPECIFICS_FIELD,
    sampleLimit: config.sampleLimit,
    dryRun: config.dryRun,
    masterService,
    categoryLinkFieldName
  }, progress => {
    emitProgress(progressCallback, {
      stage: progress?.stage || 'phase4_master_urls',
      percent:
        progress?.stage === 'master_item_specifics_url_completed'
          ? 38
          : progress?.stage === 'master_item_specifics_url_write'
            ? 34
            : 30,
      counts: summary,
      message:
        normalizeString(progress?.message) ||
        `Populating Master Parts '${MASTER_EBAY_ITEM_SPECIFICS_FIELD}' URLs...`
    });
  });
  summary.ebayItemSpecificsUrl = ebayItemSpecificsUrlSummary;
  summary.ebayItemSpecificsUrlsPlanned = Number(ebayItemSpecificsUrlSummary?.recordsPlanned || 0);
  summary.ebayItemSpecificsUrlsUpdated = Number(ebayItemSpecificsUrlSummary?.recordsUpdated || 0);
  summary.ebayItemSpecificsUrlsSkippedExisting = Number(ebayItemSpecificsUrlSummary?.skippedAlreadyPopulated || 0);
  summary.ebayItemSpecificsUrlsSkippedNoMatch = Number(ebayItemSpecificsUrlSummary?.skippedNoMatchingTable || 0);
  summary.ebayItemSpecificsUrlsSkippedAmbiguous = Number(ebayItemSpecificsUrlSummary?.skippedAmbiguousTable || 0);
  (ebayItemSpecificsUrlSummary?.errors || []).forEach(message => addError(summary, message));

  emitProgress(progressCallback, {
    stage: 'phase4_plan',
    percent: 40,
    counts: summary,
    message: `Routing ${masterRecords.length} master records to item-specific tables...`
  });

  const referenceNumberByIpn = await loadReferenceNumberByIpn(config, progressCallback, summary);
  summary.manufacturerRefsMapped = referenceNumberByIpn.size;

  const desiredByTable = new Map();
  const ipnToTable = new Map();
  const desiredReferenceByIpn = new Map();
  const routingFailureGroups = {
    missingPrefixTable: new Map(),
    blankCategoryForDuplicatePrefix: new Map(),
    ambiguousDuplicatePrefix: new Map()
  };

  const unresolvedByPrefix = [];
  const assignDestination = (ipn, prefix, destinationTableId, referenceNumber = '') => {
    const existingRoute = ipnToTable.get(ipn);
    if (existingRoute && existingRoute !== destinationTableId) {
      summary.routingFailures += 1;
      appendSample(
        summary.routingFailureSamples,
        {
          ipn,
          prefix,
          reason: 'conflicting_destination_tables'
        },
        summary.sampleLimit
      );
      return false;
    }
    ipnToTable.set(ipn, destinationTableId);
    if (!desiredByTable.has(destinationTableId)) {
      desiredByTable.set(destinationTableId, new Set());
    }
    desiredByTable.get(destinationTableId).add(ipn);
    const normalizedReference = normalizeString(referenceNumber);
    if (normalizedReference && !desiredReferenceByIpn.has(ipn)) {
      desiredReferenceByIpn.set(ipn, normalizedReference);
    }
    return true;
  };

  for (const record of masterRecords) {
    const fields = record?.fields || {};
    const ipn = normalizeString(fields.IPN).toUpperCase();
    const prefix = parseMasterPrefix(fields['IPN Prefix']);

    if (!ipn) continue;
    if (!prefix || isExcludedPrefix(prefix)) continue;

    summary.masterRecordsEligible += 1;
    const prefixRoutes = tablesByPrefix.get(prefix) || [];
    if (prefixRoutes.length === 0) {
      summary.routingFailures += 1;
      classifyRoutingFailure(routingFailureGroups, 'missingPrefixTable', { prefix });
      appendSample(
        summary.routingFailureSamples,
        {
          ipn,
          prefix,
          reason: 'missing_prefix_table'
        },
        summary.sampleLimit
      );
      continue;
    }

    if (prefixRoutes.length === 1) {
      assignDestination(ipn, prefix, prefixRoutes[0].tableId, referenceNumberByIpn.get(ipn) || '');
      continue;
    }

    const categoryIdentifierTokens = resolveIdentifierTokensForPrefix(
      readLinkedRecordIds(
        fields,
        [
          categoryLinkFieldName,
          'Category Definitions Link',
          'Category Definitions',
          'Categories'
        ]
      ),
      categoryDefinitionLookup,
      prefix
    );

    unresolvedByPrefix.push({
      ipn,
      prefix,
      categoryName: normalizeString(fields['Category Name']),
      categoryIdentifierTokens,
      routes: prefixRoutes
    });
  }

  for (const item of unresolvedByPrefix) {
    const { ipn, prefix, categoryName, categoryIdentifierTokens, routes } = item;
    const hasResolvedIdentifier =
      categoryIdentifierTokens && categoryIdentifierTokens.size > 0;

    if (!hasResolvedIdentifier) {
      summary.routingFailures += 1;
      classifyRoutingFailure(routingFailureGroups, 'blankCategoryForDuplicatePrefix', { prefix });
      appendSample(
        summary.routingFailureSamples,
        {
          ipn,
          prefix,
          reason: 'missing_resolved_ebay_category_name_for_duplicate_prefix'
        },
        summary.sampleLimit
      );
      continue;
    }

    const identifierMatch = findRouteByIdentifierTokens(routes, categoryIdentifierTokens);
    if (identifierMatch.status === 'ok' && identifierMatch.route) {
      assignDestination(ipn, prefix, identifierMatch.route.tableId, referenceNumberByIpn.get(ipn) || '');
      continue;
    }

    summary.routingFailures += 1;
    classifyRoutingFailure(routingFailureGroups, 'ambiguousDuplicatePrefix', {
      prefix,
      categoryName: categoryName || [...categoryIdentifierTokens].join(' | '),
      candidateTables: (identifierMatch.matches && identifierMatch.matches.length > 0
        ? identifierMatch.matches
        : routes
      ).map(route => route.tableName)
    });
    appendSample(
      summary.routingFailureSamples,
      {
        ipn,
        prefix,
        reason: identifierMatch.status === 'ambiguous'
          ? 'ambiguous_duplicate_prefix'
          : 'no_matching_identifier_table_for_duplicate_prefix'
      },
      summary.sampleLimit
    );
  }

  flushRoutingFailureGroups(summary, routingFailureGroups);
  summary.tablesTouched = desiredByTable.size;

  emitProgress(progressCallback, {
    stage: 'phase4_mirror',
    percent: 60,
    counts: summary,
    message: `Mirroring IPNs across ${summary.tablesTouched} destination tables...`
  });

  let tableIndex = 0;
  const totalTables = Math.max(desiredByTable.size, 1);
  for (const [tableId, desiredIpnsSet] of desiredByTable.entries()) {
    tableIndex += 1;
    const desiredIpns = [...desiredIpnsSet];
    if (desiredIpns.length === 0) continue;

    try {
      const tableMeta = tablesById.get(tableId);
      const tableFieldNames = tableMeta?.fieldNames instanceof Set ? tableMeta.fieldNames : new Set();
      const supportsManufacturerField = tableFieldNames.has(MANUFACTURER_PART_FIELD);
      const fetchFields = ['IPN'];
      if (supportsManufacturerField) {
        fetchFields.push(MANUFACTURER_PART_FIELD);
      }
      MANUFACTURER_LOCK_FIELD_CANDIDATES.forEach(fieldName => {
        if (tableFieldNames.has(fieldName)) fetchFields.push(fieldName);
      });
      emitProgress(progressCallback, {
        stage: 'phase4_mirror',
        percent: 60 + Math.floor((tableIndex / totalTables) * 35),
        counts: summary,
        message:
          `Table ${tableIndex}/${totalTables}: loading existing item-specific rows ` +
          `(fields=${[...new Set(fetchFields)].length})...`
      });
      const existingRecords = await fetchTableRecordsWithProgress(
        itemService,
        tableId,
        [...new Set(fetchFields)],
        pageState => {
          emitProgress(progressCallback, {
            stage: 'phase4_mirror',
            percent: 60 + Math.floor((tableIndex / totalTables) * 35),
            counts: summary,
            message:
              `Table ${tableIndex}/${totalTables}: loaded existing rows=${pageState.loaded} ` +
              `(page=${pageState.page})`
          });
        }
      );
      const existingByIpn = new Map();
      existingRecords.forEach(record => {
        const ipn = normalizeIpn(record?.fields?.IPN);
        if (!ipn || existingByIpn.has(ipn)) return;
        existingByIpn.set(ipn, record);
      });

      const missing = [];
      for (const ipn of desiredIpns) {
        if (existingByIpn.has(ipn)) {
          summary.ipnRowsAlreadyPresent += 1;
        } else {
          missing.push(ipn);
        }
      }

      if (config.dryRun) {
        summary.ipnRowsPlanned += missing.length;
        if (supportsManufacturerField) {
          for (const ipn of desiredIpns) {
            const referenceNumber = normalizeString(desiredReferenceByIpn.get(ipn));
            if (!referenceNumber) continue;
            const existing = existingByIpn.get(ipn);
            if (!existing) {
              summary.manufacturerValuesPlanned += 1;
              continue;
            }
            const currentValue = normalizeString(existing?.fields?.[MANUFACTURER_PART_FIELD]);
            if (currentValue) {
              summary.manufacturerValuesSkippedExisting += 1;
              continue;
            }
            summary.manufacturerValuesPlanned += 1;
          }
        }
      } else {
        emitProgress(progressCallback, {
          stage: 'phase4_mirror',
          percent: 60 + Math.floor((tableIndex / totalTables) * 35),
          counts: summary,
          message:
            `Table ${tableIndex}/${totalTables}: creating missing IPN rows ` +
            `(missing=${missing.length})...`
        });
        let createBatchIndex = 0;
        const totalCreateBatches = Math.max(1, Math.ceil(missing.length / 10));
        for (const batch of chunkArray(missing, 10)) {
          createBatchIndex += 1;
          const records = batch.map(ipn => ({
            fields: (() => {
              const fields = { IPN: ipn };
              if (supportsManufacturerField) {
                const referenceNumber = normalizeString(desiredReferenceByIpn.get(ipn));
                if (referenceNumber) {
                  fields[MANUFACTURER_PART_FIELD] = referenceNumber;
                  const lockFields = buildFixedLockFields(tableFieldNames, MANUFACTURER_PART_FIELD);
                  Object.assign(fields, lockFields);
                  summary.manufacturerValuesPlanned += 1;
                }
              }
              return fields;
            })()
          }));
          await itemService.request('POST', `/${encodeURIComponent(tableId)}`, {
            data: {
              records,
              typecast: true
            }
          });
          summary.ipnRowsCreated += batch.length;
          emitProgress(progressCallback, {
            stage: 'phase4_mirror',
            percent: 60 + Math.floor((tableIndex / totalTables) * 35),
            counts: summary,
            message:
              `Table ${tableIndex}/${totalTables}: create batch ${createBatchIndex}/${totalCreateBatches} ` +
              `(createdSoFar=${summary.ipnRowsCreated})`
          });
        }

        if (supportsManufacturerField) {
          const manufacturerUpdates = [];
          for (const ipn of desiredIpns) {
            const existing = existingByIpn.get(ipn);
            if (!existing) continue;
            const referenceNumber = normalizeString(desiredReferenceByIpn.get(ipn));
            if (!referenceNumber) continue;

            const currentValue = normalizeString(existing?.fields?.[MANUFACTURER_PART_FIELD]);
            if (currentValue) {
              summary.manufacturerValuesSkippedExisting += 1;
              continue;
            }

            const fields = {
              [MANUFACTURER_PART_FIELD]: referenceNumber,
              ...buildFixedLockFields(tableFieldNames, MANUFACTURER_PART_FIELD)
            };
            manufacturerUpdates.push({
              id: String(existing.id),
              fields
            });
          }

          if (manufacturerUpdates.length > 0) {
            summary.manufacturerValuesPlanned += manufacturerUpdates.length;
            emitProgress(progressCallback, {
              stage: 'phase4_mirror',
              percent: 60 + Math.floor((tableIndex / totalTables) * 35),
              counts: summary,
              message:
                `Table ${tableIndex}/${totalTables}: writing Manufacturer Part Number updates ` +
                `(records=${manufacturerUpdates.length})...`
            });
            const result = await patchTableRecords(itemService, tableId, manufacturerUpdates, {
              onBatchComplete: batchState => {
                emitProgress(progressCallback, {
                  stage: 'phase4_mirror',
                  percent: 60 + Math.floor((tableIndex / totalTables) * 35),
                  counts: summary,
                  message:
                    `Table ${tableIndex}/${totalTables}: MPN update batch ${batchState.index}/${batchState.total} ` +
                    `(writtenSoFar=${batchState.writtenSoFar}, errors=${batchState.errorsSoFar})`
                });
              }
            });
            summary.manufacturerValuesWritten += result.written;
            (result.errors || []).forEach(message => addError(summary, message));
          }
        }
      }
    } catch (error) {
      addError(summary, `Mirror failed for table ${tableId}: ${error.message}`);
    }

    emitProgress(progressCallback, {
      stage: 'phase4_mirror',
      percent: 60 + Math.floor((tableIndex / totalTables) * 35),
      counts: summary,
      message:
        `Processed table ${tableIndex}/${totalTables} ` +
        `(created=${summary.ipnRowsCreated}, planned=${summary.ipnRowsPlanned}, existing=${summary.ipnRowsAlreadyPresent}, ` +
        `mpnWritten=${summary.manufacturerValuesWritten}, mpnPlanned=${summary.manufacturerValuesPlanned}).`
    });
  }

  summary.lastMirrorRunAt = startedAt;
  if (!config.dryRun) {
    saveInventoryConfig(MIRROR_STATE_KEY, {
      lastMirrorRunAt: startedAt,
      lastRunStatus: summary.errors.length > 0 ? 'completed_with_errors' : 'success',
      runMode: summary.runMode,
      masterRecordsScanned: summary.masterRecordsScanned,
      masterRecordsEligible: summary.masterRecordsEligible,
      routingFailures: summary.routingFailures,
      tablesTouched: summary.tablesTouched,
      ipnRowsAlreadyPresent: summary.ipnRowsAlreadyPresent,
      ipnRowsCreated: summary.ipnRowsCreated,
      ipnRowsPlanned: summary.ipnRowsPlanned,
      manufacturerRefsMapped: summary.manufacturerRefsMapped,
      manufacturerValuesPlanned: summary.manufacturerValuesPlanned,
      manufacturerValuesWritten: summary.manufacturerValuesWritten,
      manufacturerValuesSkippedExisting: summary.manufacturerValuesSkippedExisting,
      errorCount: summary.errors.length
    });
  }

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: summary,
    message: config.dryRun
      ? 'Phase 4 dry-run completed (no Airtable writes performed).'
      : 'Phase 4 mirroring completed.'
  });

  return summary;
}

module.exports = {
  MIRROR_STATE_KEY,
  buildPhase4Config,
  runPhase4Mirroring
};

