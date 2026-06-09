const { loadEnv } = require('../config/loadEnv');
const AirtableService = require('../services/airtableService');
const AirtableSchemaService = require('../services/airtableSchemaService');
const {
  loadRulesLogicFixedRuleSet,
  resolveRulesLogicTableName
} = require('../services/rulesLogicService');
const { chunkArray } = require('../utils/chunk');
const ElectronStore = require('electron-store').default;
const path = require('path');

loadEnv();

const DEFAULT_EBAY_LISTINGS_TABLE = 'eBay Listings (API)';
const LEGACY_EBAY_LISTINGS_TABLE = 'eBay Listings (API) (Mock)';
const DEFAULT_RULES_TABLE_NAME = 'Rule Logic';
const MASTER_LOAD_LOG_EVERY_ROWS = 5000;
const LISTING_C_SPECIFICS_FIELD = 'Item Specifics - All C: values relevant to item';
const EBAY_LISTING_IPN_FIELDS = [
  'IPN (Interchange Part Number)',
  'c: partshunter203 ebay MOTORS interchange part number',
  'C: partshunter203 ebay MOTORS interchange part number',
  'IPN'
];

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeFieldToken(value) {
  return normalizeText(value)
    .replace(/^C:\s*/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeListingsTableName(value = '') {
  const text = normalizeText(value);
  if (!text) return DEFAULT_EBAY_LISTINGS_TABLE;
  if (text.toLowerCase() === LEGACY_EBAY_LISTINGS_TABLE.toLowerCase()) {
    return DEFAULT_EBAY_LISTINGS_TABLE;
  }
  return text;
}

function parsePrefixFromIpn(ipn) {
  const match = normalizeText(ipn).toUpperCase().match(/^(\d{3})[\s.-]?/);
  return match ? match[1] : '';
}

function parseJsonObject(value) {
  if (!value && value !== 0) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  const text = normalizeText(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {
    return null;
  }
  return null;
}

function getFieldValueByName(fields = {}, candidates = []) {
  if (!fields || typeof fields !== 'object') return '';
  const names = Array.isArray(candidates) ? candidates : [candidates];
  for (const candidate of names) {
    const target = normalizeText(candidate).toLowerCase();
    if (!target) continue;
    const key = Object.keys(fields).find(item => normalizeText(item).toLowerCase() === target);
    if (!key) continue;
    const value = fields[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return value;
  }
  return '';
}

function normalizeCSpecificKey(value = '') {
  const text = normalizeText(value).replace(/\s+/g, ' ');
  if (!text) return '';
  const lower = text.toLowerCase();
  if (lower.startsWith('c:')) return lower;
  return `c: ${lower}`;
}

function parseListingCSpecificMap(fields = {}) {
  const parsed = parseJsonObject(fields[LISTING_C_SPECIFICS_FIELD]);
  const out = new Map();
  if (!parsed) return out;
  for (const [rawKey, rawValue] of Object.entries(parsed)) {
    const key = normalizeCSpecificKey(rawKey);
    const value = normalizeText(rawValue);
    if (!key || !value) continue;
    out.set(key, value);
  }
  return out;
}

function resolveListingIpnFromFields(fields = {}) {
  for (const key of EBAY_LISTING_IPN_FIELDS) {
    const direct = normalizeText(fields[key]).toUpperCase();
    if (direct) return direct;
  }
  const cSpecificMap = parseListingCSpecificMap(fields);
  return normalizeText(
    cSpecificMap.get('c: partshunter203 ebay motors interchange part number')
  ).toUpperCase();
}

function emitProgress(progressCallback, payload = {}) {
  if (typeof progressCallback === 'function') {
    progressCallback(payload);
  }
}

function parseArgs(argv = []) {
  const getArg = name =>
    argv.find(arg => arg.startsWith(`${name}=`))?.split('=').slice(1).join('=') || '';

  return {
    execute: argv.includes('--execute'),
    dryRun: !argv.includes('--execute'),
    ruleTypes: normalizeText(getArg('--rule-types') || 'F')
      .split(',')
      .map(item => normalizeText(item).toUpperCase())
      .filter(Boolean),
    rulesTableName: normalizeText(
      getArg('--rules-table') ||
        getArg('--rules-drive-file') ||
        process.env.PHASE4_RULES_TABLE ||
        process.env.PHASE4_RULES_DRIVE_FILE ||
        process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
        DEFAULT_RULES_TABLE_NAME
    ),
    globalDefaultsTable: normalizeText(
      getArg('--global-defaults-table') ||
        process.env.PHASE4_GLOBAL_DEFAULTS_TABLE ||
        DEFAULT_RULES_TABLE_NAME
    ),
    phase4DListingsTable: normalizeText(getArg('--phase4d-listings-table') || process.env.PHASE4D_LISTINGS_TABLE || ''),
    restrictToListingsPrefixIpns:
      normalizeText(
        getArg('--restrict-to-listing-prefix-ipns') ||
          process.env.PHASE4_RESTRICT_TO_LISTING_PREFIX_IPNS ||
          process.env.PHASE4B_RESTRICT_TO_LISTING_PREFIX_IPNS ||
          'true'
      ).toLowerCase() !== 'false',
    sampleLimit: Number(getArg('--sample-limit') || 30) || 30
  };
}

function loadPhaseConfigFromStore() {
  try {
    const cwd = path.join(process.env.APPDATA || '', 'electron demo');
    const store = new ElectronStore({
      cwd,
      name: 'config',
      encryptionKey: 'client-secret-key'
    });
    return store.get('inventoryWebhook.phase2Config') || {};
  } catch (error) {
    return {};
  }
}

function parsePrefixFromTableName(tableName) {
  const match = normalizeText(tableName).match(/^(\d{3})\s*-/);
  return match ? match[1] : '';
}

function isBlankCell(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return normalizeText(value) === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function formatAirtableError(error) {
  const status = error?.response?.status;
  const payload = error?.response?.data;
  const detail =
    payload?.error?.message ||
    payload?.error ||
    payload?.err ||
    payload?.message ||
    error?.message ||
    String(error);
  return status ? `HTTP ${status}: ${detail}` : String(detail);
}

class MergedPrefixRuleMap extends Map {
  constructor(allRules = new Map(), entries = []) {
    super(entries);
    this.allRules = allRules instanceof Map ? allRules : new Map();
  }

  get(prefix) {
    const merged = new Map(this.allRules);
    const specific = super.get(prefix);
    if (specific instanceof Map) {
      for (const [fieldName, value] of specific.entries()) {
        merged.set(fieldName, value);
      }
    }
    return merged.size > 0 ? merged : undefined;
  }
}

function buildFixedFieldValueMap(entries = new Map()) {
  const out = new Map();
  for (const [, ruleMeta] of entries instanceof Map ? entries.entries() : []) {
    const fieldName = normalizeText(ruleMeta?.fieldName || '');
    const fixedValue = normalizeText(ruleMeta?.value || '');
    if (!fieldName || !fixedValue) continue;
    if (!out.has(fieldName)) {
      out.set(fieldName, fixedValue);
    }
  }
  return out;
}

async function loadRulesFromAirtable(itemService, tableName, ruleTypes = ['F']) {
  const allowedRules = new Set(
    (Array.isArray(ruleTypes) ? ruleTypes : [ruleTypes])
      .map(item => normalizeText(item).toUpperCase())
      .filter(Boolean)
  );
  if (allowedRules.size > 0 && !allowedRules.has('F')) {
    return {
      byPrefix: new MergedPrefixRuleMap(),
      scannedRows: 0,
      loadedRules: 0,
      tableName: resolveRulesLogicTableName(tableName)
    };
  }

  const resolvedTableName = resolveRulesLogicTableName(tableName);
  const fixedRuleSet = await loadRulesLogicFixedRuleSet(itemService, resolvedTableName);
  const allRules = buildFixedFieldValueMap(fixedRuleSet.all);
  const prefixEntries = Array.from((fixedRuleSet.byPrefix || new Map()).entries()).map(([prefix, rules]) => [
    prefix,
    buildFixedFieldValueMap(rules)
  ]);

  return {
    byPrefix: new MergedPrefixRuleMap(allRules, prefixEntries),
    scannedRows: Number(fixedRuleSet.scannedRows || 0),
    loadedRules: Number(fixedRuleSet.loadedRules || 0),
    tableName: resolvedTableName
  };
}

async function fetchAllRecordsWithFallback(service, tableNameOrId, selectFields = []) {
  try {
    return await service.fetchAllRecords(tableNameOrId, selectFields);
  } catch (error) {
    if (error?.response?.status !== 422) throw error;
    return service.fetchAllRecords(tableNameOrId, []);
  }
}

async function fetchAllRecordsWithFallbackAndProgress(
  service,
  tableNameOrId,
  selectFields = [],
  onProgress = () => {}
) {
  async function fetchPaged(fields = []) {
    const records = [];
    let offset = null;
    let page = 0;
    do {
      const params = {};
      if (offset) params.offset = offset;
      if (fields.length > 0) params.fields = fields;
      const data = await service.request('GET', `/${encodeURIComponent(tableNameOrId)}`, { params });
      const batch = Array.isArray(data?.records) ? data.records : [];
      records.push(...batch);
      page += 1;
      onProgress({
        page,
        loaded: records.length,
        batchSize: batch.length,
        hasMore: Boolean(data?.offset)
      });
      offset = data?.offset || null;
    } while (offset);
    return records;
  }

  try {
    return await fetchPaged(selectFields);
  } catch (error) {
    if (error?.response?.status !== 422) throw error;
    return fetchPaged([]);
  }
}

async function patchTableRecords(itemService, tableId, updates = [], options = {}) {
  let updatedRecords = 0;
  const successfulRecordIds = [];
  const errors = [];
  const onBatchComplete = typeof options.onBatchComplete === 'function' ? options.onBatchComplete : () => {};
  const batches = chunkArray(updates, 10);
  const totalBatches = batches.length;
  let batchIndex = 0;

  for (const batch of batches) {
    batchIndex += 1;
    try {
      const data = await itemService.request('PATCH', `/${encodeURIComponent(tableId)}`, {
        data: { records: batch, typecast: true }
      });
      const rows = Array.isArray(data?.records) ? data.records : [];
      updatedRecords += rows.length;
      rows.forEach(row => {
        if (row?.id) successfulRecordIds.push(String(row.id));
      });
      onBatchComplete({
        index: batchIndex,
        total: totalBatches,
        mode: 'batch',
        requested: batch.length,
        updated: rows.length,
        errorsSoFar: errors.length
      });
    } catch (batchError) {
      if (batchError?.response?.status !== 422) throw batchError;
      let updatedInBatch = 0;
      for (const record of batch) {
        try {
          const single = await itemService.request('PATCH', `/${encodeURIComponent(tableId)}`, {
            data: { records: [record], typecast: true }
          });
          const rows = Array.isArray(single?.records) ? single.records : [];
          updatedRecords += rows.length;
          updatedInBatch += rows.length;
          rows.forEach(row => {
            if (row?.id) successfulRecordIds.push(String(row.id));
          });
        } catch (singleError) {
          errors.push(`${record?.id || 'unknown'} -> ${formatAirtableError(singleError)}`);
        }
      }
      onBatchComplete({
        index: batchIndex,
        total: totalBatches,
        mode: 'fallback_single',
        requested: batch.length,
        updated: updatedInBatch,
        errorsSoFar: errors.length
      });
    }
  }

  return {
    updatedRecords,
    successfulRecordIds,
    errors
  };
}

function isFixedRuleLabel(ruleValue) {
  const rule = normalizeText(ruleValue).toLowerCase();
  return rule.includes('(f)') && rule.includes('fixed');
}

async function loadGlobalDefaultsMap(itemService, tableName) {
  const rows = await fetchAllRecordsWithFallback(itemService, tableName, []);
  const map = new Map();
  for (const row of rows) {
    const fields = row?.fields || {};
    if (!isFixedRuleLabel(fields['Rule'])) continue;
    const itemSpecific = normalizeText(fields['Item Specific (eBay Download Only)']);
    const fixedValue = normalizeText(fields['(F) Value']);
    if (!itemSpecific || !fixedValue) continue;
    const token = normalizeFieldToken(itemSpecific);
    if (token && !map.has(token)) map.set(token, fixedValue);
  }
  return map;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPhase4RulesPopulate(args, progress => {
    const stage = String(progress?.stage || 'running');
    const message = normalizeText(progress?.message);
    if (message) {
      console.log(`[phase4-rules:${stage}] ${message}`);
    } else {
      console.log(`[phase4-rules:${stage}]`);
    }
  });
  console.log('=== Phase 4 Rules Populate Summary ===');
  console.log(JSON.stringify(result, null, 2));
}

async function runPhase4RulesPopulate(options = {}, progressCallback = () => {}) {
  const args = {
    ...parseArgs([]),
    ...options
  };
  const stored = loadPhaseConfigFromStore();
  args.rulesTableName = resolveRulesLogicTableName(args.rulesTableName, args.globalDefaultsTable);
  args.globalDefaultsTable = args.rulesTableName;

  const airtableToken = normalizeText(process.env.AIRTABLE_TOKEN || stored.airtableToken);
  const masterBaseId = normalizeText(process.env.AIRTABLE_BASE_ID || stored.airtableBaseId);
  const masterTable = normalizeText(
    process.env.AIRTABLE_MASTER_TABLE || stored.airtableMasterTable || 'Master Parts Table'
  );
  const listingsTable = normalizeListingsTableName(
    args.phase4DListingsTable ||
      process.env.PHASE4D_LISTINGS_TABLE ||
      stored.phase4DListingsTable ||
      DEFAULT_EBAY_LISTINGS_TABLE
  );
  const itemSpecificsBaseId = normalizeText(
    process.env.AIRTABLE_ITEM_SPECIFICS_BASE_ID ||
      process.env.ITEM_SPECIFICS_BASE_ID ||
      stored.itemSpecificsBaseId
  );
  const rulesLogicBaseId = normalizeText(
    process.env.AIRTABLE_RULES_LOGIC_BASE_ID ||
      process.env.RULES_LOGIC_BASE_ID ||
      stored.rulesLogicBaseId ||
      masterBaseId
  );

  if (!airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (!masterBaseId) throw new Error('Missing AIRTABLE_BASE_ID (Master base).');
  if (!itemSpecificsBaseId) {
    throw new Error('Missing item specifics base ID (AIRTABLE_ITEM_SPECIFICS_BASE_ID).');
  }
  if (!args.rulesTableName) {
    throw new Error('Missing rules table name. Provide --rules-table=<TABLE_NAME>.');
  }

  emitProgress(progressCallback, {
    stage: 'phase4rules_load_rules',
    percent: 10,
    message: 'Loading fixed F rules from Airtable Rules Logic table...'
  });

  let fixedRulesByPrefix;
  let logicRowsScanned = 0;
  let rulesSource = '';
  const rulesService = new AirtableService({
    token: airtableToken,
    baseId: rulesLogicBaseId
  });
  const { byPrefix, scannedRows } = await loadRulesFromAirtable(rulesService, args.rulesTableName, args.ruleTypes);
  fixedRulesByPrefix = byPrefix;
  logicRowsScanned = scannedRows;
  rulesSource = `airtable:${args.rulesTableName}`;
  emitProgress(progressCallback, {
    stage: 'phase4rules_load_rules',
    percent: 11,
    message: `Rules loaded from Airtable table '${args.rulesTableName}'.`
  });
  emitProgress(progressCallback, {
    stage: 'phase4rules_load_rules',
    percent: 12,
    message:
      `Rules Logic parsed from Airtable table '${args.rulesTableName}': ` +
      `prefixGroups=${fixedRulesByPrefix.size}, rows=${logicRowsScanned}, ruleTypes=${args.ruleTypes.join(',')}`
  });

  const schemaService = new AirtableSchemaService({
    token: airtableToken,
    baseId: itemSpecificsBaseId
  });
  const itemService = new AirtableService({
    token: airtableToken,
    baseId: itemSpecificsBaseId
  });
  const masterService = new AirtableService({
    token: airtableToken,
    baseId: masterBaseId,
    masterTable
  });
  const listingScopeByPrefix = new Map();
  let listingScopeRowsScanned = 0;
  let listingScopeIpns = 0;
  if (args.restrictToListingsPrefixIpns) {
    emitProgress(progressCallback, {
      stage: 'phase4rules_scan_tables',
      percent: 16,
      message: `Loading listing-driven IPN scope from '${listingsTable}'...`
    });
    let scopeLoaded = false;
    for (const service of [masterService, itemService]) {
      try {
        let lastListingScopeHeartbeatAt = Date.now();
        const listingRows = await fetchAllRecordsWithFallbackAndProgress(
          service,
          listingsTable,
          [...EBAY_LISTING_IPN_FIELDS, LISTING_C_SPECIFICS_FIELD],
          state => {
            const now = Date.now();
            if (!state?.hasMore || now - lastListingScopeHeartbeatAt >= 800) {
              lastListingScopeHeartbeatAt = now;
              emitProgress(progressCallback, {
                stage: 'phase4rules_scan_tables',
                percent: 16,
                message:
                  `Loading listing-driven IPN scope from '${listingsTable}'... ` +
                  `loaded=${Number(state?.loaded || 0)} rows (page ${Number(state?.page || 1)})`
              });
            }
          }
        );
        listingScopeRowsScanned = listingRows.length;
        for (const listingRow of listingRows) {
          const listingFields = listingRow?.fields || {};
          const ipn = resolveListingIpnFromFields(listingFields);
          const prefix = parsePrefixFromIpn(ipn);
          if (!ipn || !prefix) continue;
          if (!listingScopeByPrefix.has(prefix)) listingScopeByPrefix.set(prefix, new Set());
          listingScopeByPrefix.get(prefix).add(ipn);
        }
        listingScopeIpns = Array.from(listingScopeByPrefix.values()).reduce(
          (sum, set) => sum + Number(set?.size || 0),
          0
        );
        scopeLoaded = true;
        break;
      } catch (_) {
        continue;
      }
    }
    if (!scopeLoaded) {
      throw new Error(
        `Unable to build listing-driven IPN scope from '${listingsTable}'. ` +
          `Ensure eBay listings table is accessible in configured Airtable bases.`
      );
    }
    emitProgress(progressCallback, {
      stage: 'phase4rules_scan_tables',
      percent: 18,
      message:
        `Listing-driven IPN scope ready: prefixes=${listingScopeByPrefix.size}, ` +
        `ipns=${listingScopeIpns}, rowsScanned=${listingScopeRowsScanned}`
    });
  }
  emitProgress(progressCallback, {
    stage: 'phase4rules_scan_tables',
    percent: 18,
    message: `Using '${args.rulesTableName}' for both prefix-specific and global 'All' F rules.`
  });
  const globalDefaultsMap = new Map();
  emitProgress(progressCallback, {
    stage: 'phase4rules_scan_tables',
    percent: 19,
    message: 'Global defaults are already merged from the same Rules Logic table.'
  });

  emitProgress(progressCallback, {
    stage: 'phase4rules_scan_tables',
    percent: 19,
    message: `Loading master IPN set from '${masterTable}'...`
  });
  const preloadedMasterRows = Array.isArray(args.phase4SharedMasterRows)
    ? args.phase4SharedMasterRows
    : Array.isArray(args.preloadedMasterRows)
      ? args.preloadedMasterRows
      : null;
  const preloadedMasterIpnSet = args.phase4SharedMasterIpnSet instanceof Set
    ? args.phase4SharedMasterIpnSet
    : args.preloadedMasterIpnSet instanceof Set
      ? args.preloadedMasterIpnSet
      : null;
  let masterIpnSet;
  if (preloadedMasterIpnSet instanceof Set) {
    masterIpnSet = preloadedMasterIpnSet;
    emitProgress(progressCallback, {
      stage: 'phase4rules_scan_tables',
      percent: 19,
      message: `Using shared master IPN set cache: uniqueIpns=${masterIpnSet.size}`
    });
  } else if (Array.isArray(preloadedMasterRows)) {
    masterIpnSet = new Set(
      preloadedMasterRows.map(row => normalizeText(row?.fields?.IPN).toUpperCase()).filter(Boolean)
    );
    emitProgress(progressCallback, {
      stage: 'phase4rules_scan_tables',
      percent: 19,
      message: `Using shared master rows cache: rows=${preloadedMasterRows.length}, uniqueIpns=${masterIpnSet.size}`
    });
  } else {
    let nextMasterRowsLogAt = MASTER_LOAD_LOG_EVERY_ROWS;
    const masterRows = await fetchAllRecordsWithFallbackAndProgress(masterService, masterTable, ['IPN'], state => {
      const loaded = Number(state?.loaded || 0);
      const shouldEmit = !state?.hasMore || loaded >= nextMasterRowsLogAt;
      if (shouldEmit) {
        while (loaded >= nextMasterRowsLogAt) {
          nextMasterRowsLogAt += MASTER_LOAD_LOG_EVERY_ROWS;
        }
        emitProgress(progressCallback, {
          stage: 'phase4rules_scan_tables',
          percent: 19,
          message:
            `Loading master IPN set from '${masterTable}'... ` +
            `loaded=${loaded} rows (page ${Number(state?.page || 1)})`
        });
      }
    });
    masterIpnSet = new Set(
      masterRows.map(row => normalizeText(row?.fields?.IPN).toUpperCase()).filter(Boolean)
    );
  }
  emitProgress(progressCallback, {
    stage: 'phase4rules_scan_tables',
    percent: 20,
    message: `Master IPN set ready: uniqueIpns=${masterIpnSet.size}`
  });

  const tables = await schemaService.listTables();
  const totalRoutableTables = tables.filter(table => {
    const tableName = normalizeText(table?.name);
    const tableId = normalizeText(table?.id);
    const prefix = parsePrefixFromTableName(tableName);
    return Boolean(prefix && tableId);
  }).length;
  emitProgress(progressCallback, {
    stage: 'phase4rules_scan_tables',
    percent: 20,
    message: `Scanning Item Specific tables... total=${totalRoutableTables}`
  });
  const summary = {
    dryRun: args.dryRun,
    ruleTypes: args.ruleTypes,
    rulesSource,
    rulesTableName: args.rulesTableName || '',
    globalDefaultsTable: args.globalDefaultsTable,
    listingsTable,
    restrictToListingsPrefixIpns: Boolean(args.restrictToListingsPrefixIpns),
    listingsScopePrefixes: listingScopeByPrefix.size,
    listingsScopeIpns: listingScopeIpns,
    listingsScopeRowsScanned: listingScopeRowsScanned,
    globalDefaultsEntries: globalDefaultsMap.size,
    logicRowsScanned,
    tablesScanned: 0,
    tablesSkippedNoLogicPrefix: 0,
    skippedNoLogicPrefixSamples: [],
    rowsScanned: 0,
    rowsWithIPN: 0,
    rowsInListingsScope: 0,
    rowsSkippedNotInListingsScope: 0,
    masterPartsMissing: 0,
    fixedFieldsPlanned: 0,
    fixedFieldsUpdated: 0,
    fixedFieldsSkippedAlreadyFilled: 0,
    globalDefaultCellsPlanned: 0,
    globalDefaultAppliedSamples: [],
    fieldsMissingInTableSchema: 0,
    tablesSkippedNoListingsPrefixScope: 0,
    errors: [],
    perTable: []
  };

  const missingFieldSet = new Set();
  let processedRoutableTables = 0;

  for (const table of tables) {
    const tableName = normalizeText(table?.name);
    const tableId = normalizeText(table?.id);
    const prefix = parsePrefixFromTableName(tableName);
    const prefixListingScope = listingScopeByPrefix.get(prefix) || new Set();
    if (!prefix || !tableId) continue;
    processedRoutableTables += 1;
    if (
      processedRoutableTables === 1 ||
      processedRoutableTables % 10 === 0 ||
      processedRoutableTables === totalRoutableTables
    ) {
      const ratio = totalRoutableTables > 0 ? processedRoutableTables / totalRoutableTables : 1;
      const percent = Math.min(95, 35 + Math.floor(ratio * 60));
      emitProgress(progressCallback, {
        stage: 'phase4rules_scan_tables',
        percent,
        counts: summary,
        message: `Processing table ${processedRoutableTables}/${totalRoutableTables}: ${tableName}`
      });
    }

    summary.tablesScanned += 1;
    if (args.restrictToListingsPrefixIpns && prefixListingScope.size === 0) {
      summary.tablesSkippedNoListingsPrefixScope += 1;
      emitProgress(progressCallback, {
        stage: 'phase4rules_scan_tables',
        percent: Math.min(95, 35 + Math.floor((processedRoutableTables / Math.max(1, totalRoutableTables)) * 60)),
        counts: summary,
        message:
          `Skipping table ${processedRoutableTables}/${totalRoutableTables}: ${tableName} ` +
          `(prefix=${prefix}) -> no listing-scope IPNs`
      });
      continue;
    }
    const prefixRules = fixedRulesByPrefix.get(prefix);
    if (!prefixRules || prefixRules.size === 0) {
      summary.tablesSkippedNoLogicPrefix += 1;
      if (summary.skippedNoLogicPrefixSamples.length < args.sampleLimit) {
        summary.skippedNoLogicPrefixSamples.push(
          `[skip][no_logic_prefix] table='${tableName}' prefix='${prefix}' reason='prefix not found in Rules Logic F rules'`
        );
      }
      continue;
    }

    const fieldNames = new Set(
      (table?.fields || []).map(field => normalizeText(field?.name)).filter(Boolean)
    );
    const applicableFields = new Map();
    for (const [fieldName, fixedValue] of prefixRules.entries()) {
      if (fieldNames.has(fieldName)) {
        applicableFields.set(fieldName, {
          value: fixedValue,
          source: 'logic'
        });
      } else {
        missingFieldSet.add(`${tableName}::${fieldName}`);
      }
    }

    // Add global defaults for existing C:* fields that have no Logic fixed value.
    for (const fieldName of fieldNames) {
      if (!fieldName.startsWith('C:')) continue;
      if (applicableFields.has(fieldName)) continue;
      const token = normalizeFieldToken(fieldName);
      const defaultValue = normalizeText(globalDefaultsMap.get(token));
      if (!defaultValue) continue;
      applicableFields.set(fieldName, {
        value: defaultValue,
        source: 'global_default'
      });
    }
    if (applicableFields.size === 0) continue;

    const fetchFields = ['IPN', ...applicableFields.keys()];
    emitProgress(progressCallback, {
      stage: 'phase4rules_scan_tables',
      percent: Math.min(95, 35 + Math.floor((processedRoutableTables / Math.max(1, totalRoutableTables)) * 60)),
      counts: summary,
      message:
        `Fetching rows for table ${processedRoutableTables}/${totalRoutableTables}: ${tableName} ` +
        `(fields=${fetchFields.length}, prefix=${prefix})`
    });
    let lastTableFetchHeartbeatAt = Date.now();
    const rows = await fetchAllRecordsWithFallbackAndProgress(itemService, tableId, fetchFields, state => {
      const now = Date.now();
      if (!state?.hasMore || now - lastTableFetchHeartbeatAt >= 900) {
        lastTableFetchHeartbeatAt = now;
        emitProgress(progressCallback, {
          stage: 'phase4rules_scan_tables',
          percent: Math.min(95, 35 + Math.floor((processedRoutableTables / Math.max(1, totalRoutableTables)) * 60)),
          counts: summary,
          message:
            `Fetching rows for table ${processedRoutableTables}/${totalRoutableTables}: ${tableName} ` +
            `loaded=${Number(state?.loaded || 0)} rows (page ${Number(state?.page || 1)})`
        });
      }
    });
    summary.rowsScanned += rows.length;

    const updates = [];
    const cellCountByRecord = new Map();
    let tableRowsWithIpn = 0;
    let tablePlannedCells = 0;
    let tableSkippedFilled = 0;
    let tableMasterMissing = 0;
    let lastRowLoopHeartbeatAt = Date.now();

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const now = Date.now();
      if (
        rowIndex === 0 ||
        rowIndex + 1 === rows.length ||
        (rowIndex + 1) % 500 === 0 ||
        now - lastRowLoopHeartbeatAt >= 6000
      ) {
        lastRowLoopHeartbeatAt = now;
        emitProgress(progressCallback, {
          stage: 'phase4rules_scan_tables',
          percent: Math.min(95, 35 + Math.floor((processedRoutableTables / Math.max(1, totalRoutableTables)) * 60)),
          counts: summary,
          message:
            `Scanning rows ${rowIndex + 1}/${rows.length} in ${tableName} ` +
            `(plannedCells=${tablePlannedCells}, skippedFilled=${tableSkippedFilled}, masterMissing=${tableMasterMissing})`
        });
      }
      const fields = row?.fields || {};
      const ipn = normalizeText(fields.IPN).toUpperCase();
      if (!ipn) continue;

      summary.rowsWithIPN += 1;
      tableRowsWithIpn += 1;
      if (args.restrictToListingsPrefixIpns && !prefixListingScope.has(ipn)) {
        summary.rowsSkippedNotInListingsScope += 1;
        continue;
      }
      summary.rowsInListingsScope += 1;

      if (!masterIpnSet.has(ipn)) {
        summary.masterPartsMissing += 1;
        tableMasterMissing += 1;
        continue;
      }

      const updateFields = {};
      let recordPlannedCellCount = 0;
      for (const [fieldName, fixedMeta] of applicableFields.entries()) {
        const fixedValue = normalizeText(fixedMeta?.value);
        if (!fixedValue) continue;
        if (isBlankCell(fields[fieldName])) {
          updateFields[fieldName] = fixedValue;
          recordPlannedCellCount += 1;
          if (fixedMeta?.source === 'global_default') {
            summary.globalDefaultCellsPlanned += 1;
            if (summary.globalDefaultAppliedSamples.length < args.sampleLimit) {
              summary.globalDefaultAppliedSamples.push(
                `[global_default] table='${tableName}' field='${fieldName}' value='${fixedValue}' ipn='${ipn}'`
              );
            }
          }
        } else {
          summary.fixedFieldsSkippedAlreadyFilled += 1;
          tableSkippedFilled += 1;
        }
      }

      if (recordPlannedCellCount > 0) {
        updates.push({
          id: String(row.id),
          fields: updateFields
        });
        cellCountByRecord.set(String(row.id), recordPlannedCellCount);
        summary.fixedFieldsPlanned += recordPlannedCellCount;
        tablePlannedCells += recordPlannedCellCount;
      }
    }

    let updatedCells = 0;
    if (!args.dryRun && updates.length > 0) {
      emitProgress(progressCallback, {
        stage: 'phase4rules_scan_tables',
        percent: Math.min(95, 35 + Math.floor((processedRoutableTables / Math.max(1, totalRoutableTables)) * 60)),
        counts: summary,
        message:
          `Writing updates for ${tableName}: records=${updates.length}, plannedCells=${tablePlannedCells}`
      });
      const writeResult = await patchTableRecords(itemService, tableId, updates, {
        onBatchComplete: state => {
          emitProgress(progressCallback, {
            stage: 'phase4rules_scan_tables',
            percent: Math.min(95, 35 + Math.floor((processedRoutableTables / Math.max(1, totalRoutableTables)) * 60)),
            counts: summary,
            message:
              `Write batches ${tableName}: batch ${state?.index || 0}/${state?.total || 0} ` +
              `(mode=${state?.mode || 'batch'}, requested=${state?.requested || 0}, errorsSoFar=${state?.errorsSoFar || 0})`
          });
        }
      });
      writeResult.successfulRecordIds.forEach(recordId => {
        updatedCells += Number(cellCountByRecord.get(String(recordId)) || 0);
      });
      if (writeResult.errors.length > 0) {
        summary.errors.push(
          ...writeResult.errors.slice(0, 50).map(message => `${tableName}: ${message}`)
        );
      }
    }
    summary.fixedFieldsUpdated += updatedCells;

    if (
      tablePlannedCells > 0 ||
      tableMasterMissing > 0 ||
      tableSkippedFilled > 0
    ) {
      summary.perTable.push({
        tableName,
        prefix,
        rowsScanned: rows.length,
        rowsWithIPN: tableRowsWithIpn,
        masterPartsMissing: tableMasterMissing,
        applicableFixedFields: applicableFields.size,
        fixedFieldsPlanned: tablePlannedCells,
        fixedFieldsUpdated: updatedCells,
        fixedFieldsSkippedAlreadyFilled: tableSkippedFilled
      });
    }
    emitProgress(progressCallback, {
      stage: 'phase4rules_scan_tables',
      percent: Math.min(95, 35 + Math.floor((processedRoutableTables / Math.max(1, totalRoutableTables)) * 60)),
      counts: summary,
      message:
        `Completed table ${processedRoutableTables}/${totalRoutableTables}: ${tableName} ` +
        `(rows=${rows.length}, rowsWithIPN=${tableRowsWithIpn}, plannedCells=${tablePlannedCells}, updatedCells=${updatedCells}, masterMissing=${tableMasterMissing}, skippedFilled=${tableSkippedFilled})`
    });
  }

  summary.fieldsMissingInTableSchema = missingFieldSet.size;
  if (missingFieldSet.size > 0) {
    const samples = Array.from(missingFieldSet).slice(0, args.sampleLimit);
    summary.missingFieldSamples = samples;
  }
  if (summary.errors.length > args.sampleLimit) {
    summary.errors = summary.errors.slice(0, args.sampleLimit);
  }

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: summary,
    message:
      `Phase 4 rules populate completed (${args.dryRun ? 'dry run' : 'write run'}). ` +
      `${args.restrictToListingsPrefixIpns ? `Listing scope prefixes=${summary.listingsScopePrefixes || 0}, ipns=${summary.listingsScopeIpns || 0}, rowsInScope=${summary.rowsInListingsScope || 0}, scopeSkipped=${summary.rowsSkippedNotInListingsScope || 0}.` : ''}`
  });
  return summary;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Phase 4 rules populate failed: ${formatAirtableError(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  runPhase4RulesPopulate
};


