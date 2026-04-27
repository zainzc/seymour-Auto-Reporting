const { loadEnv } = require('../config/loadEnv');
const AirtableService = require('../services/airtableService');
const AirtableSchemaService = require('../services/airtableSchemaService');
const ClickUpService = require('../services/clickupService');
const Phase4AiEvaluatorService = require('../services/phase4AiEvaluatorService');
const { chunkArray } = require('../utils/chunk');
const oauth2Service = require('../services/oauth2Service');
const { google } = require('googleapis');
const ElectronStore = require('electron-store').default;
const ExcelJS = require('exceljs');
const path = require('path');
const { asIdentitySet, isPublishedIdentity } = require('../services/phase5IdentityService');
const { isManualOverrideForField: isManualOverrideFromGovernance } = require('../services/phase5GovernanceService');

loadEnv();

const LOW_CONFIDENCE_THRESHOLD = 0.75;
const DEFAULT_PHASE4B_DETERMINED_STATUS = 'Value Determined';
const DEFAULT_PHASE4B_COMPLETED_STATUS = 'Completed / Closed';
const DEFAULT_EBAY_LISTINGS_TABLE = 'eBay Listings (API)';
const LEGACY_EBAY_LISTINGS_TABLE = 'eBay Listings (API) (Mock)';
const EBAY_LISTING_TITLE_FIELD = 'Title';
const EBAY_LISTING_CONDITIONS_FIELD = 'Conditions & Options';
const EBAY_LISTING_IPN_FIELD = 'IPN (Interchange Part Number)';
const EBAY_LISTING_IPN_FIELDS = [
  EBAY_LISTING_IPN_FIELD,
  'c: partshunter203 ebay MOTORS interchange part number',
  'C: partshunter203 ebay MOTORS interchange part number',
  'IPN'
];
const EBAY_LISTING_RECORD_KEY_FIELD = 'SKU';
const EBAY_LISTING_LOOKUP_KEY_FIELDS = [
  ...EBAY_LISTING_IPN_FIELDS,
  'SKU',
  'sku',
  'Item ID',
  'eBay Item ID',
  'Ebay Item ID',
  'Record Key'
];
const EBAY_LISTING_DESCRIPTION_FIELDS = [
  'Description',
  'Full listing description HTML',
  'Listing Description',
  'Item Description',
  'Product Description',
  'c: partshunter203 ebay MOTORS description'
];

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeIpn(value) {
  return normalizeText(value).toUpperCase();
}

function parseIpnSet(value) {
  const text = String(value || '');
  if (!text.trim()) return new Set();
  return new Set(
    text
      .split(/[\n,;|]+/)
      .map(item => normalizeIpn(item))
      .filter(Boolean)
  );
}

function normalizeListingsTableName(value = '') {
  const text = normalizeText(value);
  if (!text) return DEFAULT_EBAY_LISTINGS_TABLE;
  if (text.toLowerCase() === LEGACY_EBAY_LISTINGS_TABLE.toLowerCase()) {
    return DEFAULT_EBAY_LISTINGS_TABLE;
  }
  return text;
}

function getFieldValueByName(fields = {}, name = '') {
  if (!fields || typeof fields !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name];
  const target = normalizeText(name).toLowerCase();
  if (!target) return '';
  const key = Object.keys(fields).find(item => normalizeText(item).toLowerCase() === target);
  if (!key) return '';
  return fields[key];
}

function firstNonEmptyField(fields = {}, names = []) {
  for (const name of names) {
    const value = normalizeText(getFieldValueByName(fields, name));
    if (value) return value;
  }
  return '';
}

function enforceAllowedValue(candidateValue, allowedValues = []) {
  const value = normalizeText(candidateValue);
  if (!value) return '';
  if (!Array.isArray(allowedValues) || allowedValues.length === 0) return value;
  return allowedValues.includes(value) ? value : '';
}

function resolveListingIpn(fields = {}) {
  return normalizeIpn(firstNonEmptyField(fields, EBAY_LISTING_IPN_FIELDS));
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCharCode(n) : '';
    });
}

function htmlToText(html) {
  const raw = String(html || '');
  if (!raw) return '';
  const text = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(text)
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractStrictFitmentBlock(descriptionHtml = '') {
  const html = String(descriptionHtml || '');
  if (!html.trim()) {
    return { status: 'missing_structure', rawFitmentText: '' };
  }

  const headingRegex = /<([a-z0-9]+)\b[^>]*class=["'][^"']*\bd_heading1\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;
  const targetHeadingText = 'This Part Will Fit These Makes And Models With These Options';
  let headingMatch;
  while ((headingMatch = headingRegex.exec(html)) !== null) {
    const headingText = htmlToText(headingMatch[2]);
    if (headingText !== targetHeadingText) continue;

    const restHtml = html.slice(headingRegex.lastIndex);
    const siblingRegex =
      /^\s*(?:<!--[\s\S]*?-->\s*)*<([a-z0-9]+)\b[^>]*class=["'][^"']*\bp1\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i;
    const sibling = restHtml.match(siblingRegex);
    if (!sibling) {
      return { status: 'missing_structure', rawFitmentText: '' };
    }

    const rawFitmentText = htmlToText(sibling[2]);
    if (!rawFitmentText) {
      return { status: 'empty_block', rawFitmentText: '' };
    }
    return { status: 'found', rawFitmentText };
  }

  return { status: 'missing_structure', rawFitmentText: '' };
}

function escapeAirtableFormulaValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildEbayLookupFormula(ipn) {
  const safe = escapeAirtableFormulaValue(ipn);
  const clauses = EBAY_LISTING_LOOKUP_KEY_FIELDS.map(fieldName => `{${fieldName}}="${safe}"`);
  return `OR(${clauses.join(',')})`;
}

async function queryEbayRows(service, tableName, formula, selectFields = []) {
  const params = {
    filterByFormula: formula,
    maxRecords: 10
  };
  if (Array.isArray(selectFields) && selectFields.length > 0) {
    params.fields = selectFields;
  }
  try {
    const data = await service.request('GET', `/${encodeURIComponent(tableName)}`, { params });
    return Array.isArray(data?.records) ? data.records : [];
  } catch (error) {
    if (error?.response?.status === 422 && params.fields) {
      const fallback = await service.request('GET', `/${encodeURIComponent(tableName)}`, {
        params: { filterByFormula: formula, maxRecords: 10 }
      });
      return Array.isArray(fallback?.records) ? fallback.records : [];
    }
    throw error;
  }
}

async function fetchEbayContextByIpn(service, tableName, ipn) {
  const key = normalizeIpn(ipn);
  if (!key) return null;

  const selectFields = [
    ...EBAY_LISTING_LOOKUP_KEY_FIELDS,
    EBAY_LISTING_TITLE_FIELD,
    'Product Title',
    'Product Title(New)',
    EBAY_LISTING_CONDITIONS_FIELD,
    'c: partshunter203 ebay MOTORS conditions & options',
    'Listing Conditions and Options',
    ...EBAY_LISTING_DESCRIPTION_FIELDS
  ];

  const formulas = [];
  const safe = escapeAirtableFormulaValue(key);
  for (const fieldName of EBAY_LISTING_LOOKUP_KEY_FIELDS) {
    formulas.push(`{${fieldName}}="${safe}"`);
  }
  formulas.push(buildEbayLookupFormula(key));

  for (const formula of formulas) {
    let records = [];
    try {
      records = await queryEbayRows(service, tableName, formula, selectFields);
    } catch (error) {
      if (error?.response?.status === 422) continue;
      throw error;
    }
    if (!records.length) continue;

    for (const row of records) {
      const fields = row?.fields || {};
      const productTitle = firstNonEmptyField(fields, [
        EBAY_LISTING_TITLE_FIELD,
        'Product Title',
        'Product Title(New)',
        'Listing Title'
      ]);
      const listingConditionsAndOptions = firstNonEmptyField(fields, [
        EBAY_LISTING_CONDITIONS_FIELD,
        'c: partshunter203 ebay MOTORS conditions & options',
        'Listing Conditions and Options'
      ]);
      const listingDescriptionRaw = firstNonEmptyField(fields, [
        ...EBAY_LISTING_DESCRIPTION_FIELDS
      ]);
      const extraction = extractStrictFitmentBlock(listingDescriptionRaw);
      const listingDescription = extraction.status === 'found' ? `Fitment:\n${extraction.rawFitmentText}` : '';
      if (!productTitle && !listingConditionsAndOptions && !listingDescription) continue;
      return {
        productTitle,
        listingConditionsAndOptions,
        listingDescription
      };
    }
  }
  return null;
}

function isBlankCell(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return normalizeText(value) === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
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

function isDotNumberIpn(ipn) {
  return /^\d{3}\./.test(normalizeText(ipn).toUpperCase());
}

function parsePrefixFromTableName(tableName) {
  const match = normalizeText(tableName).match(/^(\d{3})\s*-/);
  return match ? match[1] : '';
}

function emitProgress(progressCallback, payload = {}) {
  if (typeof progressCallback === 'function') {
    progressCallback(payload);
  }
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

function truncateText(value, maxLength = 180) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function classifyAiError(error) {
  const status = Number(error?.response?.status || 0);
  if (Number.isFinite(status) && status > 0) return `http_${status}`;
  const code = normalizeText(error?.code || '').toLowerCase();
  if (code.includes('etimedout') || code.includes('timeout') || code.includes('econnaborted')) {
    return 'timeout';
  }
  if (code.includes('enotfound') || code.includes('econnreset') || code.includes('eai_again')) {
    return 'network';
  }
  const message = normalizeText(error?.message || '').toLowerCase();
  if (message.includes('rate limit') || message.includes('too many requests')) return 'rate_limit';
  if (message.includes('timeout')) return 'timeout';
  if (message.includes('network') || message.includes('socket')) return 'network';
  return 'unknown';
}

function formatAiErrorShort(error) {
  const status = Number(error?.response?.status || 0);
  const detail =
    error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    error?.message ||
    String(error);
  const text = truncateText(detail, 200);
  return status > 0 ? `HTTP ${status}: ${text}` : text;
}

function incrementCounter(mapObj, key) {
  const bucket = normalizeText(key) || 'unknown';
  mapObj[bucket] = Number(mapObj[bucket] || 0) + 1;
}

function formatTopErrorStats(mapObj = {}, top = 3) {
  const rows = Object.entries(mapObj)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, top)
    .map(([k, v]) => `${k}:${v}`);
  return rows.join(', ');
}

function parseArgs(argv = []) {
  const getArg = name =>
    argv.find(arg => arg.startsWith(`${name}=`))?.split('=').slice(1).join('=') || '';

  return {
    execute: argv.includes('--execute'),
    dryRun: !argv.includes('--execute'),
    ruleTypes: ['VF', 'VMF'],
    authContext: normalizeText(getArg('--auth-context') || process.env.PHASE4_GOOGLE_AUTH_CONTEXT || 'inventory'),
    rulesDriveFile: normalizeText(
      getArg('--rules-drive-file') ||
        process.env.PHASE4_RULES_DRIVE_FILE ||
        process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
        ''
    ),
    logicSheetName: normalizeText(getArg('--logic-sheet') || process.env.PHASE4_LOGIC_SHEET || 'Logic'),
    sampleLimit: Number(getArg('--sample-limit') || 20) || 20,
    aiConcurrency: Math.max(
      1,
      Number(getArg('--ai-concurrency') || process.env.PHASE4B_AI_CONCURRENCY || 4) || 4
    ),
    aiIpnBatchSize: Math.max(
      1,
      Math.min(
        300,
        Number(getArg('--ai-ipn-batch-size') || process.env.PHASE4_AI_IPN_BATCH_SIZE || 250) || 250
      )
    ),
    aiTimeoutMs: Math.max(
      5000,
      Number(getArg('--ai-timeout-ms') || process.env.PHASE4B_AI_TIMEOUT_MS || 20000) || 20000
    ),
    aiMaxAttempts: Math.max(
      1,
      Number(getArg('--ai-max-attempts') || process.env.PHASE4B_AI_MAX_ATTEMPTS || 2) || 2
    ),
    testTableName: normalizeText(
      getArg('--test-table-name') || process.env.PHASE4B_TEST_TABLE_NAME || ''
    ),
    phase4BTestIpn: normalizeText(
      getArg('--test-ipn') || process.env.PHASE4B_TEST_IPN || ''
    ),
    phase4DTestIpn: normalizeText(
      getArg('--phase4d-test-ipn') || process.env.PHASE4D_TEST_IPN || ''
    ),
    testMaxTables: Math.max(
      0,
      Number(getArg('--test-max-tables') || process.env.PHASE4B_TEST_MAX_TABLES || 0) || 0
    ),
    promptCacheEnabled:
      normalizeText(getArg('--prompt-cache-enabled') || process.env.PHASE4B_PROMPT_CACHE_ENABLED || 'true')
        .toLowerCase() !== 'false',
    promptCacheKey: normalizeText(
      getArg('--prompt-cache-key') ||
        process.env.PHASE4B_PROMPT_CACHE_KEY ||
        process.env.OPENAI_PROMPT_CACHE_KEY ||
        'phase4blite_v1'
    ),
    openaiApiKey: normalizeText(getArg('--openai-api-key') || process.env.OPENAI_API_KEY || ''),
    openaiModel: normalizeText(getArg('--openai-model') || process.env.OPENAI_MODEL || 'gpt-5.4-mini'),
    openaiBaseUrl: normalizeText(getArg('--openai-base-url') || process.env.OPENAI_BASE_URL || ''),
    phase4BClickupListId: normalizeText(
      getArg('--phase4b-clickup-list-id') || process.env.PHASE4B_CLICKUP_LIST_ID || ''
    ),
    clickupOpenStatus: normalizeText(getArg('--clickup-open-status') || process.env.PHASE4B_CLICKUP_OPEN_STATUS || 'To Do')
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

function extractDriveFileId(input) {
  const text = normalizeText(input);
  if (!text) return '';
  if (/^[a-zA-Z0-9_-]{20,}$/.test(text)) return text;
  const dMatch = text.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (dMatch?.[1]) return dMatch[1];
  const idMatch = text.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (idMatch?.[1]) return idMatch[1];
  return '';
}

async function loadWorkbookFromDrive(fileOrUrl, authContext = 'inventory') {
  const fileId = extractDriveFileId(fileOrUrl);
  if (!fileId) {
    throw new Error('Invalid Google Drive file ID/URL for rules workbook.');
  }
  if (!oauth2Service.isAuthenticated(authContext)) {
    throw new Error(`Google account is not connected for auth context '${authContext}'.`);
  }

  const auth = oauth2Service.getAuthenticatedClient(authContext);
  const drive = google.drive({ version: 'v3', auth });
  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );

  const wb = new ExcelJS.Workbook();
  const buffer = Buffer.from(response.data);
  await wb.xlsx.load(buffer);
  return { workbook: wb, fileId };
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

function parseAllowedValues(raw) {
  const text = normalizeText(raw);
  if (!text) return [];
  return text
    .split(/[\n|;,]+/)
    .map(item => normalizeText(item))
    .filter(Boolean);
}

function parseLogicWorksheet(ws, sheetName, allowedRules = ['VF', 'VMF']) {
  if (!ws) {
    throw new Error(`Rules sheet '${sheetName}' not found.`);
  }

  const header = ws.getRow(1).values.slice(1).map(value => normalizeText(value).toLowerCase());
  const idxPrefix = header.indexOf('ipn prefix');
  const idxField = header.indexOf('item specific');
  const idxRule = header.indexOf('rule');
  const idxAllowed = header.findIndex(name => name.includes('allowed') || name.includes('valid value'));
  const idxFormat = header.findIndex(name => name.includes('format'));

  if (idxPrefix < 0 || idxField < 0 || idxRule < 0) {
    throw new Error(`Rules sheet '${sheetName}' missing required columns.`);
  }

  const byPrefix = new Map();
  let scannedRows = 0;

  const allowed = new Set((allowedRules || []).map(value => normalizeText(value).toUpperCase()).filter(Boolean));
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r).values.slice(1);
    const prefix = normalizeText(row[idxPrefix]);
    const fieldName = normalizeText(row[idxField]);
    const rule = normalizeText(row[idxRule]).toUpperCase();
    if (!prefix && !fieldName && !rule) continue;
    scannedRows += 1;
    if (!allowed.has(rule)) continue;
    if (!/^\d{3}$/.test(prefix)) continue;
    if (!fieldName.startsWith('C:')) continue;

    const allowedRaw =
      (idxAllowed >= 0 ? row[idxAllowed] : '') || (idxFormat >= 0 ? row[idxFormat] : '');
    const allowedValues = parseAllowedValues(allowedRaw);

    if (!byPrefix.has(prefix)) byPrefix.set(prefix, new Map());
    if (!byPrefix.get(prefix).has(fieldName)) {
      byPrefix.get(prefix).set(fieldName, {
        ruleType: rule,
        allowedValues
      });
    }
  }

  return {
    byPrefix,
    scannedRows
  };
}

async function processWithConcurrency(items = [], concurrency = 4, handler = async () => {}, onProgress = () => {}) {
  const total = items.length;
  if (total === 0) return;
  const limit = Math.max(1, Math.min(concurrency, total));
  let cursor = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      const item = items[index];
      await handler(item, index);
      completed += 1;
      onProgress(completed, total, item, index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
}

function extractMasterPartsContext(fields = {}) {
  const context = {};
  const keys = Object.keys(fields || {});
  for (const key of keys) {
    const name = normalizeText(key);
    if (!name) continue;
    if (name.toLowerCase() === 'ipn') continue;

    const value = fields[name];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      const text = value.map(item => normalizeText(item)).filter(Boolean).join(', ');
      if (text) context[name] = text;
      continue;
    }
    if (typeof value === 'object') continue;

    const text = normalizeText(value);
    if (!text) continue;
    context[name] = text;
  }

  return context;
}

function summarizeContext(context = {}, maxPairs = 12) {
  const pairs = Object.entries(context).slice(0, maxPairs);
  return pairs.map(([k, v]) => `${k}: ${v}`).join('\n');
}

function parseTaskDescriptionLine(description = '', label = '') {
  const safeLabel = String(label || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!safeLabel) return '';
  const regex = new RegExp(`(?:^|\\n)\\s*${safeLabel}:\\s*([^\\n\\r]+)`, 'i');
  const match = String(description || '').match(regex);
  return normalizeText(match?.[1] || '');
}

function parsePhase4BTaskMetadata(task = {}) {
  const description = String(task?.description || '');
  return {
    taskId: normalizeText(task?.id),
    taskKey: parseTaskDescriptionLine(description, 'TaskKey'),
    ipn: parseTaskDescriptionLine(description, 'IPN'),
    prefix: parseTaskDescriptionLine(description, 'Prefix'),
    tableName: parseTaskDescriptionLine(description, 'Table'),
    recordId: parseTaskDescriptionLine(description, 'ItemSpecificRecordID'),
    fieldName: parseTaskDescriptionLine(description, 'Field')
  };
}

function extractFinalValueFromTask(task = {}) {
  const customFieldCandidates = [
    'Final Value',
    'Value Determined',
    'Determined Value',
    'Resolved Value',
    'Research Value',
    'Manual Value'
  ];
  for (const candidate of customFieldCandidates) {
    const value = normalizeText(ClickUpService.extractCustomFieldText(task, candidate));
    if (value) return value;
  }

  const description = String(task?.description || '');
  const descriptionCandidates = [
    'Final Value',
    'Value Determined',
    'Determined Value',
    'Resolved Value',
    'Research Value',
    'Manual Value'
  ];
  for (const label of descriptionCandidates) {
    const value = parseTaskDescriptionLine(description, label);
    if (value) return value;
  }

  return '';
}

function resolvePreferredClosedStatus(listData = {}, preferred = DEFAULT_PHASE4B_COMPLETED_STATUS) {
  const statuses = Array.isArray(listData?.statuses) ? listData.statuses : [];
  const preferredText = normalizeText(preferred).toLowerCase();
  if (preferredText) {
    const exact = statuses.find(
      status => normalizeText(status?.status).toLowerCase() === preferredText
    );
    if (exact?.status) return String(exact.status);
  }

  const closed = statuses.find(
    status => normalizeText(status?.type).toLowerCase() === 'closed'
  );
  if (closed?.status) return String(closed.status);

  const byName = statuses.find(status => {
    const text = normalizeText(status?.status).toLowerCase();
    return text.includes('completed') || text.includes('closed') || text.includes('done');
  });
  if (byName?.status) return String(byName.status);

  return '';
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

async function runVmfDeterminedWriteback(itemService, clickupService, summary, options = {}) {
  if (!clickupService) return;
  const dryRun = Boolean(options.dryRun);
  const sampleLimit = Number(options.sampleLimit || 20);
  const determinedStatus = normalizeText(options.determinedStatus || DEFAULT_PHASE4B_DETERMINED_STATUS);
  const preferredCompletedStatus = normalizeText(options.completedStatus || DEFAULT_PHASE4B_COMPLETED_STATUS);
  const targetIpn = normalizeIpn(options.targetIpn || '');
  const tablesByName = options.tablesByName || new Map();
  const tableFieldsByName = options.tableFieldsByName || new Map();

  const determinedTasks = await clickupService.fetchTasksByStatuses([determinedStatus], {
    includeClosed: false,
    subtasks: false
  });
  const scopedTasks = targetIpn
    ? determinedTasks.filter(task => normalizeIpn(parsePhase4BTaskMetadata(task)?.ipn) === targetIpn)
    : determinedTasks;
  summary.vmfDeterminedTasksFound = scopedTasks.length;
  if (scopedTasks.length === 0) return;

  const closeStatus = dryRun ? '' : resolvePreferredClosedStatus(await clickupService.getList(), preferredCompletedStatus);
  if (!dryRun && !closeStatus) {
    summary.errors.push('Phase4B writeback: unable to resolve a closed/completed status in ClickUp list.');
  }

  for (const task of scopedTasks) {
    summary.vmfDeterminedTasksProcessed += 1;
    const meta = parsePhase4BTaskMetadata(task);
    const finalValue = extractFinalValueFromTask(task);
    if (!meta.tableName || !meta.recordId || !meta.fieldName) {
      summary.vmfDeterminedTasksMissingMeta += 1;
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`Phase4B writeback skipped task ${meta.taskId || 'unknown'}: missing metadata (table/record/field).`);
      }
      continue;
    }
    if (!finalValue) {
      summary.vmfDeterminedTasksMissingValue += 1;
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`Phase4B writeback skipped task ${meta.taskId || 'unknown'}: missing final researched value.`);
      }
      continue;
    }

    const tableId = tablesByName.get(meta.tableName.toLowerCase()) || '';
    if (!tableId) {
      summary.vmfDeterminedWritebackFailed += 1;
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`Phase4B writeback failed task ${meta.taskId || 'unknown'}: table '${meta.tableName}' not found.`);
      }
      continue;
    }

    const tableFieldNames = tableFieldsByName.get(meta.tableName.toLowerCase()) || new Set();
    const lockFields = buildFixedLockFields(tableFieldNames, meta.fieldName);
    const updateFields = {
      [meta.fieldName]: finalValue,
      ...lockFields
    };
    if (Object.keys(lockFields).length > 0) {
      summary.vmfDeterminedFixedLocked += 1;
    }

    if (!dryRun) {
      const writeResult = await patchTableRecords(itemService, tableId, [{ id: meta.recordId, fields: updateFields }]);
      if (writeResult.updatedRecords <= 0 || writeResult.errors.length > 0) {
        summary.vmfDeterminedWritebackFailed += 1;
        if (summary.errors.length < sampleLimit) {
          const err = writeResult.errors[0] || 'unknown Airtable writeback error';
          summary.errors.push(`Phase4B writeback failed task ${meta.taskId || 'unknown'}: ${err}`);
        }
        continue;
      }
    }

    summary.vmfDeterminedWritebackSucceeded += 1;
    if (dryRun) {
      summary.vmfDeterminedTasksClosed += 1;
      continue;
    }

    if (closeStatus) {
      try {
        await clickupService.updateTaskStatus(meta.taskId, closeStatus);
        summary.vmfDeterminedTasksClosed += 1;
      } catch (error) {
        summary.vmfDeterminedTaskCloseFailed += 1;
        if (summary.errors.length < sampleLimit) {
          summary.errors.push(`Phase4B close failed task ${meta.taskId || 'unknown'}: ${error.message}`);
        }
      }
    } else {
      summary.vmfDeterminedTaskCloseFailed += 1;
    }
  }
}

function buildVmfTaskKey({ ipn, prefix, fieldName }) {
  return `phase=4B|rule=VMF|ipn=${normalizeIpn(ipn)}|prefix=${normalizeText(prefix)}|field=${normalizeText(fieldName)}`;
}

function extractTaskKeyFromTask(task = {}) {
  const description = String(task?.description || '');
  const match = description.match(/(?:^|\n)\s*TaskKey:\s*([^\n\r]+)/i);
  return normalizeText(match?.[1] || '');
}

function buildVmfTaskPayload(task = {}, openStatus = '') {
  const name = `[Phase4][VMF] ${task.ipn} | ${task.fieldName} | ${task.prefix}`;
  const description = [
    'Phase: 4B-lite',
    'RuleType: VMF',
    `TaskKey: ${task.taskKey}`,
    `IPN: ${task.ipn}`,
    `Prefix: ${task.prefix}`,
    `Table: ${task.tableName}`,
    `ItemSpecificRecordID: ${task.recordId || ''}`,
    `Field: ${task.fieldName}`,
    `Confidence: ${Number.isFinite(task.confidence) ? task.confidence.toFixed(2) : '0.00'}`,
    `CandidateValue: ${normalizeText(task.candidateValue) || 'n/a'}`,
    `Reason: ${normalizeText(task.reason) || 'low confidence'}`,
    '',
    'Master Parts Context:',
    task.contextSummary || 'n/a'
  ].join('\n');

  return {
    name,
    description,
    status: normalizeText(openStatus)
  };
}

async function patchTableRecords(itemService, tableId, updates = []) {
  let updatedRecords = 0;
  const successfulRecordIds = [];
  const errors = [];

  for (const batch of chunkArray(updates, 10)) {
    try {
      const data = await itemService.request('PATCH', `/${encodeURIComponent(tableId)}`, {
        data: { records: batch, typecast: true }
      });
      const rows = Array.isArray(data?.records) ? data.records : [];
      updatedRecords += rows.length;
      rows.forEach(row => {
        if (row?.id) successfulRecordIds.push(String(row.id));
      });
    } catch (batchError) {
      if (batchError?.response?.status !== 422) throw batchError;
      for (const record of batch) {
        try {
          const single = await itemService.request('PATCH', `/${encodeURIComponent(tableId)}`, {
            data: { records: [record], typecast: true }
          });
          const rows = Array.isArray(single?.records) ? single.records : [];
          updatedRecords += rows.length;
          rows.forEach(row => {
            if (row?.id) successfulRecordIds.push(String(row.id));
          });
        } catch (singleError) {
          errors.push(`${record?.id || 'unknown'} -> ${formatAirtableError(singleError)}`);
        }
      }
    }
  }

  return {
    updatedRecords,
    successfulRecordIds,
    errors
  };
}

async function upsertVmfLowConfidenceTasks(clickupService, summary, tasks = [], options = {}) {
  const dryRun = Boolean(options.dryRun);
  const sampleLimit = Number(options.sampleLimit || 20);
  const openStatus = normalizeText(options.openStatus || 'To Do');
  const progressCallback = options.progressCallback;

  if (!clickupService || tasks.length === 0) return;

  const openTasks = await clickupService.fetchTasksByStatuses([], {
    includeClosed: false,
    subtasks: false
  });
  const existingMap = new Map();
  for (const task of openTasks) {
    const taskKey = extractTaskKeyFromTask(task);
    if (!taskKey || existingMap.has(taskKey)) continue;
    existingMap.set(taskKey, task);
  }

  emitProgress(progressCallback, {
    stage: 'phase4blite_scan_tables',
    percent: 97,
    counts: summary,
    message:
      `VMF task upsert started: total=${tasks.length}, existingOpen=${existingMap.size}, mode=${dryRun ? 'dry-run' : 'write'}`
  });

  let processed = 0;
  for (const item of tasks) {
    processed += 1;
    const payload = buildVmfTaskPayload(item, openStatus);
    const existing = existingMap.get(item.taskKey);
    if (!existing) {
      if (dryRun) {
        summary.vmfLowConfidenceTasksCreated += 1;
      } else {
        try {
          await clickupService.request('POST', `/list/${clickupService.listId}/task`, {
            data: payload.status
              ? {
                  name: payload.name,
                  description: payload.description,
                  status: payload.status
                }
              : {
                  name: payload.name,
                  description: payload.description
                }
          });
          summary.vmfLowConfidenceTasksCreated += 1;
        } catch (error) {
          if (error?.response?.status === 400 && payload.status) {
            await clickupService.request('POST', `/list/${clickupService.listId}/task`, {
              data: {
                name: payload.name,
                description: payload.description
              }
            });
            summary.vmfLowConfidenceTasksCreated += 1;
          } else {
            summary.errors.push(`ClickUp create failed for ${item.ipn}/${item.fieldName}: ${error.message}`);
          }
        }
      }
      if (summary.vmfLowConfidenceTaskSamples.length < sampleLimit) {
        summary.vmfLowConfidenceTaskSamples.push(
          `[vmf_low_confidence] task=create ipn='${item.ipn}' field='${item.fieldName}' confidence='${Number(item.confidence || 0).toFixed(2)}'`
        );
      }
      continue;
    }

    const existingName = normalizeText(existing.name);
    const existingDescription = normalizeText(existing.description);
    if (existingName === payload.name && existingDescription === normalizeText(payload.description)) {
      summary.vmfLowConfidenceTasksSkippedExisting += 1;
      continue;
    }

    if (dryRun) {
      summary.vmfLowConfidenceTasksUpdated += 1;
    } else {
      try {
        await clickupService.updateTask(existing.id, {
          name: payload.name,
          description: payload.description,
          status: payload.status
        });
        summary.vmfLowConfidenceTasksUpdated += 1;
      } catch (error) {
        summary.errors.push(`ClickUp update failed for ${item.ipn}/${item.fieldName}: ${error.message}`);
      }
    }
    if (summary.vmfLowConfidenceTaskSamples.length < sampleLimit) {
      summary.vmfLowConfidenceTaskSamples.push(
        `[vmf_low_confidence] task=update ipn='${item.ipn}' field='${item.fieldName}' confidence='${Number(item.confidence || 0).toFixed(2)}'`
      );
    }

    if (processed === 1 || processed % 100 === 0 || processed === tasks.length) {
      emitProgress(progressCallback, {
        stage: 'phase4blite_scan_tables',
        percent: 97,
        counts: summary,
        message:
          `VMF task upsert progress ${processed}/${tasks.length} ` +
          `(created=${summary.vmfLowConfidenceTasksCreated || 0}, updated=${summary.vmfLowConfidenceTasksUpdated || 0}, ` +
          `skipped=${summary.vmfLowConfidenceTasksSkippedExisting || 0})`
      });
    }
  }
}

function buildMfTaskKey({ ipn, prefix, fieldName }) {
  return `phase=4C|rule=MF|ipn=${normalizeIpn(ipn)}|prefix=${normalizeText(prefix)}|field=${normalizeText(fieldName)}`;
}

function buildMfTaskPayload(task = {}, openStatus = '') {
  const name = `[Phase4][MF] ${task.ipn} | ${task.fieldName} | ${task.prefix}`;
  const description = [
    'Phase: 4C',
    'RuleType: MF',
    `TaskKey: ${task.taskKey}`,
    `IPN: ${task.ipn}`,
    `Prefix: ${task.prefix}`,
    `Table: ${task.tableName}`,
    `ItemSpecificRecordID: ${task.recordId || ''}`,
    `Field: ${task.fieldName}`,
    'AIAllowed: No',
    'Reason: MF field requires manual research.'
  ].join('\n');

  return {
    name,
    description,
    status: normalizeText(openStatus)
  };
}

async function upsertMfManualTasks(clickupService, summary, tasks = [], options = {}) {
  const dryRun = Boolean(options.dryRun);
  const sampleLimit = Number(options.sampleLimit || 20);
  const openStatus = normalizeText(options.openStatus || 'To Do');

  if (!clickupService || tasks.length === 0) return;

  const openTasks = await clickupService.fetchTasksByStatuses([], {
    includeClosed: false,
    subtasks: false
  });
  const existingMap = new Map();
  for (const task of openTasks) {
    const taskKey = extractTaskKeyFromTask(task);
    if (!taskKey || existingMap.has(taskKey)) continue;
    existingMap.set(taskKey, task);
  }

  for (const item of tasks) {
    const payload = buildMfTaskPayload(item, openStatus);
    const existing = existingMap.get(item.taskKey);
    if (!existing) {
      if (dryRun) {
        summary.mfTasksCreated += 1;
      } else {
        try {
          await clickupService.request('POST', `/list/${clickupService.listId}/task`, {
            data: payload.status
              ? {
                  name: payload.name,
                  description: payload.description,
                  status: payload.status
                }
              : {
                  name: payload.name,
                  description: payload.description
                }
          });
          summary.mfTasksCreated += 1;
        } catch (error) {
          if (error?.response?.status === 400 && payload.status) {
            await clickupService.request('POST', `/list/${clickupService.listId}/task`, {
              data: {
                name: payload.name,
                description: payload.description
              }
            });
            summary.mfTasksCreated += 1;
          } else {
            summary.errors.push(`MF ClickUp create failed for ${item.ipn}/${item.fieldName}: ${error.message}`);
          }
        }
      }
      if (summary.mfTaskSamples.length < sampleLimit) {
        summary.mfTaskSamples.push(`[mf_manual] task=create title='${payload.name}'`);
      }
      continue;
    }

    const existingName = normalizeText(existing.name);
    const existingDescription = normalizeText(existing.description);
    if (existingName === payload.name && existingDescription === normalizeText(payload.description)) {
      summary.mfTasksSkippedExisting += 1;
      continue;
    }

    if (dryRun) {
      summary.mfTasksUpdated += 1;
    } else {
      try {
        await clickupService.updateTask(existing.id, {
          name: payload.name,
          description: payload.description,
          status: payload.status
        });
        summary.mfTasksUpdated += 1;
      } catch (error) {
        summary.errors.push(`MF ClickUp update failed for ${item.ipn}/${item.fieldName}: ${error.message}`);
      }
    }
    if (summary.mfTaskSamples.length < sampleLimit) {
      summary.mfTaskSamples.push(`[mf_manual] task=update title='${payload.name}'`);
    }
  }
}

async function findRecordIdByIpn(itemService, tableId, ipn) {
  const key = normalizeIpn(ipn);
  if (!key) return '';
  const safe = escapeAirtableFormulaValue(key);
  const data = await itemService.request('GET', `/${encodeURIComponent(tableId)}`, {
    params: {
      filterByFormula: `{IPN}="${safe}"`,
      maxRecords: 1,
      fields: ['IPN']
    }
  });
  const records = Array.isArray(data?.records) ? data.records : [];
  return normalizeText(records[0]?.id || '');
}

async function fetchItemSpecificRecord(itemService, tableId, recordId) {
  const id = normalizeText(recordId);
  if (!id) return null;
  return itemService.request('GET', `/${encodeURIComponent(tableId)}/${encodeURIComponent(id)}`);
}

async function runMfDeterminedWriteback(itemService, clickupService, summary, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const sampleLimit = Number(options.sampleLimit || 20);
  const determinedStatus = normalizeText(options.determinedStatus || DEFAULT_PHASE4B_DETERMINED_STATUS);
  const preferredCompletedStatus = normalizeText(options.completedStatus || DEFAULT_PHASE4B_COMPLETED_STATUS);
  const tablesByName = options.tablesByName || new Map();
  const tableFieldsByName = options.tableFieldsByName || new Map();

  const determinedTasks = await clickupService.fetchTasksByStatuses([determinedStatus], {
    includeClosed: false,
    subtasks: false
  });
  const mfTasks = determinedTasks.filter(task => {
    const description = String(task?.description || '');
    const ruleType = normalizeText(parseTaskDescriptionLine(description, 'RuleType')).toUpperCase();
    const taskKey = normalizeText(parseTaskDescriptionLine(description, 'TaskKey'));
    return ruleType === 'MF' || taskKey.includes('phase=4C|rule=MF');
  });

  const closeStatus = dryRun ? '' : resolvePreferredClosedStatus(await clickupService.getList(), preferredCompletedStatus);
  if (!dryRun && !closeStatus) {
    summary.errors.push('Phase4C writeback: unable to resolve a closed/completed status in ClickUp list.');
  }

  for (const task of mfTasks) {
    const meta = parsePhase4BTaskMetadata(task);
    const finalValue = extractFinalValueFromTask(task);

    if (!meta.tableName || !meta.fieldName) {
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`Phase4C writeback skipped task ${meta.taskId || 'unknown'}: missing table/field metadata.`);
      }
      continue;
    }
    if (!finalValue) {
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`Phase4C writeback skipped task ${meta.taskId || 'unknown'}: missing final researched value.`);
      }
      continue;
    }

    const tableId = tablesByName.get(meta.tableName.toLowerCase()) || '';
    if (!tableId) {
      summary.errors.push(`Phase4C writeback failed task ${meta.taskId || 'unknown'}: table '${meta.tableName}' not found.`);
      continue;
    }

    const tableFieldNames = tableFieldsByName.get(meta.tableName.toLowerCase()) || new Set();
    if (!tableFieldNames.has(meta.fieldName)) {
      summary.fieldsMissingInSchema += 1;
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`Phase4C writeback failed task ${meta.taskId || 'unknown'}: field '${meta.fieldName}' missing in schema.`);
      }
      continue;
    }

    let recordId = normalizeText(meta.recordId);
    if (!recordId) {
      recordId = await findRecordIdByIpn(itemService, tableId, meta.ipn);
    }
    if (!recordId) {
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`Phase4C writeback failed task ${meta.taskId || 'unknown'}: row not found for IPN '${meta.ipn}'.`);
      }
      continue;
    }

    let record;
    try {
      record = await fetchItemSpecificRecord(itemService, tableId, recordId);
    } catch (error) {
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`Phase4C writeback failed task ${meta.taskId || 'unknown'}: ${formatAirtableError(error)}`);
      }
      continue;
    }

    const currentValue = normalizeText(record?.fields?.[meta.fieldName]);
    if (currentValue) {
      summary.mfWritebacksSkippedAlreadyFilled += 1;
      if (!dryRun) {
        try {
          await clickupService.addTaskComment(meta.taskId, `No writeback needed. Airtable already has '${meta.fieldName}' value '${currentValue}'.`);
        } catch (_) {}
        if (closeStatus) {
          try {
            await clickupService.updateTaskStatus(meta.taskId, closeStatus);
          } catch (_) {}
        }
      }
      continue;
    }

    const lockFields = buildFixedLockFields(tableFieldNames, meta.fieldName);
    const updateFields = {
      [meta.fieldName]: finalValue,
      ...lockFields
    };
    if (Object.keys(lockFields).length > 0) {
      summary.mfFixedLocked = Number(summary.mfFixedLocked || 0) + 1;
    }

    if (!dryRun) {
      const writeResult = await patchTableRecords(itemService, tableId, [{ id: recordId, fields: updateFields }]);
      if (writeResult.updatedRecords <= 0 || writeResult.errors.length > 0) {
        if (summary.errors.length < sampleLimit) {
          const err = writeResult.errors[0] || 'unknown Airtable writeback error';
          summary.errors.push(`Phase4C writeback failed task ${meta.taskId || 'unknown'}: ${err}`);
        }
        continue;
      }
    }

    summary.mfWritebacksCompleted += 1;
    if (summary.mfWritebackSamples.length < sampleLimit) {
      summary.mfWritebackSamples.push(`[mf_writeback] ipn='${meta.ipn}' table='${meta.tableName}' field='${meta.fieldName}' value='${finalValue}'`);
    }
    if (!dryRun && closeStatus) {
      try {
        await clickupService.updateTaskStatus(meta.taskId, closeStatus);
      } catch (error) {
        if (summary.errors.length < sampleLimit) {
          summary.errors.push(`Phase4C close failed task ${meta.taskId || 'unknown'}: ${error.message}`);
        }
      }
    }
  }
}

async function runPhase4BLite(options = {}, progressCallback = () => {}) {
  const args = {
    ...parseArgs([]),
    ...options
  };
  const stored = loadPhaseConfigFromStore();

  const airtableToken = normalizeText(process.env.AIRTABLE_TOKEN || stored.airtableToken);
  const masterBaseId = normalizeText(process.env.AIRTABLE_BASE_ID || stored.airtableBaseId);
  const masterTable = normalizeText(
    process.env.AIRTABLE_MASTER_TABLE || stored.airtableMasterTable || 'Master Parts Table'
  );
  const ebayListingsTableName = normalizeListingsTableName(
    process.env.PHASE4D_LISTINGS_TABLE || stored.phase4DListingsTable || DEFAULT_EBAY_LISTINGS_TABLE
  );
  const itemSpecificsBaseId = normalizeText(
    process.env.AIRTABLE_ITEM_SPECIFICS_BASE_ID ||
      process.env.ITEM_SPECIFICS_BASE_ID ||
      stored.itemSpecificsBaseId
  );
  const clickupToken = normalizeText(process.env.CLICKUP_TOKEN || stored.clickupToken);
  const clickupListId = normalizeText(
    args.phase4BClickupListId ||
      process.env.PHASE4B_CLICKUP_LIST_ID ||
      stored.phase4BClickupListId
  );
  const openaiApiKey = normalizeText(args.openaiApiKey || stored.openaiApiKey || '');
  const openaiModel = normalizeText(args.openaiModel || stored.openaiModel || 'gpt-5.4-mini');
  const openaiBaseUrl = normalizeText(args.openaiBaseUrl || stored.openaiBaseUrl || '');

  if (!airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (!masterBaseId) throw new Error('Missing AIRTABLE_BASE_ID (Master base).');
  if (!itemSpecificsBaseId) throw new Error('Missing item specifics base ID (AIRTABLE_ITEM_SPECIFICS_BASE_ID).');
  if (!args.rulesDriveFile) throw new Error('Missing rules drive file. Provide --rules-drive-file=<FILE_ID_OR_URL>.');
  if (!openaiApiKey) throw new Error('Missing OpenAI API key for Phase 4B-lite.');
  const hasClickupConfig = Boolean(clickupToken && clickupListId);
  if (!args.dryRun && !clickupToken) throw new Error('Missing ClickUp token for VMF low-confidence tasks.');
  if (!args.dryRun && !clickupListId) {
    throw new Error('Missing Phase 4B ClickUp List ID for VMF low-confidence tasks.');
  }

  emitProgress(progressCallback, {
    stage: 'phase4blite_load_rules',
    percent: 10,
    message: 'Loading VF/VMF rules workbook from Google Drive...'
  });

  let rulesByPrefix;
  let logicRowsScanned = 0;
  let rulesSource = '';
  const { workbook, fileId } = await loadWorkbookFromDrive(args.rulesDriveFile, args.authContext);
  const ws = workbook.getWorksheet(args.logicSheetName);
  const parsed = parseLogicWorksheet(ws, args.logicSheetName);
  rulesByPrefix = parsed.byPrefix;
  logicRowsScanned = parsed.scannedRows;
  rulesSource = `google_drive:${fileId}`;

  const aiService = new Phase4AiEvaluatorService({
    apiKey: openaiApiKey,
    model: openaiModel,
    baseUrl: openaiBaseUrl || undefined,
    timeoutMs: args.aiTimeoutMs,
    maxAttempts: args.aiMaxAttempts,
    baseDelayMs: 500,
    promptCacheEnabled: args.promptCacheEnabled,
    promptCacheKey: args.promptCacheKey,
    debugPromptIpn: args.phase4BTestIpn || args.phase4BDebugPromptIpn || process.env.PHASE4B_DEBUG_PROMPT_IPN || ''
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
  const clickupService = hasClickupConfig
    ? new ClickUpService({
        token: clickupToken,
        listId: clickupListId
      })
    : null;

  emitProgress(progressCallback, {
    stage: 'phase4blite_load_master',
    percent: 18,
    message: 'Loading Master Parts records for AI context...'
  });
  let lastMasterLoadProgressAt = Date.now();
  const masterRows = await fetchAllRecordsWithFallbackAndProgress(
    masterService,
    masterTable,
    [],
    state => {
      const now = Date.now();
      if (!state?.hasMore || now - lastMasterLoadProgressAt >= 800) {
        lastMasterLoadProgressAt = now;
        emitProgress(progressCallback, {
          stage: 'phase4blite_load_master',
          percent: 18,
          message:
            `Loading Master Parts records for AI context... ` +
            `Loaded ${Number(state?.loaded || 0)} rows (page ${Number(state?.page || 1)}).`
        });
      }
    }
  );
  const masterMap = new Map();
  for (const row of masterRows) {
    const ipn = normalizeIpn(row?.fields?.IPN);
    if (!ipn || masterMap.has(ipn)) continue;
    masterMap.set(ipn, row);
  }

  emitProgress(progressCallback, {
    stage: 'phase4blite_load_master',
    percent: 19,
    message: `Preparing eBay listing lookup from '${ebayListingsTableName}'...`
  });
  const ebayContextCache = new Map();
  const ebayContextStats = {
    lookups: 0,
    lookupHits: 0,
    lookupMisses: 0,
    lookupErrors: 0,
    cacheHits: 0
  };
  const ebayLookupServices = [masterService, itemService];

  async function getEbayContextForIpn(ipn) {
    const key = normalizeIpn(ipn);
    if (!key) return null;
    if (ebayContextCache.has(key)) {
      ebayContextStats.cacheHits += 1;
      return ebayContextCache.get(key);
    }

    ebayContextStats.lookups += 1;
    try {
      let context = null;
      for (const service of ebayLookupServices) {
        try {
          context = await fetchEbayContextByIpn(service, ebayListingsTableName, key);
        } catch (innerError) {
          continue;
        }
        if (context) break;
      }
      if (context) {
        ebayContextStats.lookupHits += 1;
        ebayContextCache.set(key, context);
      } else {
        ebayContextStats.lookupMisses += 1;
        ebayContextCache.set(key, null);
      }
      return context;
    } catch (error) {
      ebayContextStats.lookupErrors += 1;
      ebayContextCache.set(key, null);
      return null;
    }
  }

  const tables = await schemaService.listTables();
  const allRoutableTables = tables.filter(table => Boolean(parsePrefixFromTableName(table?.name)));
  const requestedTableName = normalizeText(args.testTableName);
  const requestedIpnSet = parseIpnSet(args.phase4BTestIpn);
  const requestedIpnSingle = requestedIpnSet.size === 1 ? Array.from(requestedIpnSet)[0] : '';
  const requestedIpnLabel = requestedIpnSet.size > 0 ? Array.from(requestedIpnSet).join(', ') : '';
  const routableTables = requestedTableName
    ? allRoutableTables.filter(
        table => normalizeText(table?.name).toLowerCase() === requestedTableName.toLowerCase()
      )
    : Number(args.testMaxTables || 0) > 0
      ? allRoutableTables.slice(0, Number(args.testMaxTables))
      : allRoutableTables;
  if (requestedTableName && routableTables.length === 0) {
    throw new Error(`Test table not found: '${requestedTableName}'. Use exact Airtable table name.`);
  }

  const summary = {
    dryRun: args.dryRun,
    ruleTypes: args.ruleTypes,
    rulesSource,
    authContext: args.authContext,
    rulesDriveFile: args.rulesDriveFile || '',
    logicSheetName: args.logicSheetName,
    logicRowsScanned,
    openaiModel,
    promptCacheEnabled: Boolean(args.promptCacheEnabled),
    promptCacheKey: normalizeText(args.promptCacheKey),
    phase4BClickupListId: clickupListId,
    testTableName: requestedTableName,
    testIpn: requestedIpnLabel,
    testMaxTables: Number(args.testMaxTables || 0),
    aiConcurrency: args.aiConcurrency,
    aiTimeoutMs: args.aiTimeoutMs,
    aiMaxAttempts: args.aiMaxAttempts,
    aiCallsPlanned: 0,
    aiCallsCompleted: 0,
    aiCallsFailed: 0,
    aiWebSearchUsed: 0,
    aiWebSearchIpns: [],
    aiWebSearchEvents: [],
    aiFailureTypes: {},
    aiFailureSamples: [],
    ebayContextRowsScanned: 0,
    ebayContextRowsMapped: 0,
    ebayContextRowsWithoutKey: 0,
    ebayContextRowsWithoutContext: 0,
    ebayContextLookupCount: ebayContextStats.lookups,
    ebayContextLookupHits: ebayContextStats.lookupHits,
    ebayContextLookupMisses: ebayContextStats.lookupMisses,
    ebayContextLookupErrors: ebayContextStats.lookupErrors,
    ebayContextCacheHits: ebayContextStats.cacheHits,
    ebayContextMatchedRows: 0,
    ebayContextMissingRows: 0,
    tablesScanned: 0,
    rowsScanned: 0,
    rowsWithIPN: 0,
    masterPartsMissing: 0,
    vfFieldsEvaluated: 0,
    vfFieldsUpdated: 0,
    vfFieldsLowConfidenceSkipped: 0,
    vfFixedLockedSkipped: 0,
    vfDotNumberSkipped: 0,
    vmfFieldsEvaluated: 0,
    vmfFieldsUpdated: 0,
    vmfFixedLockedSkipped: 0,
    vmfLowConfidenceTasksCreated: 0,
    vmfLowConfidenceTasksUpdated: 0,
    vmfLowConfidenceTasksSkippedExisting: 0,
    vmfDeterminedTasksFound: 0,
    vmfDeterminedTasksProcessed: 0,
    vmfDeterminedTasksMissingMeta: 0,
    vmfDeterminedTasksMissingValue: 0,
    vmfDeterminedWritebackSucceeded: 0,
    vmfDeterminedWritebackFailed: 0,
    vmfDeterminedTasksClosed: 0,
    vmfDeterminedTaskCloseFailed: 0,
    vmfDeterminedFixedLocked: 0,
    fieldsMissingInSchema: 0,
    fieldsMissingInSchemaSamples: [],
    writeSamples: [],
    vmfLowConfidenceTaskSamples: [],
    errors: []
  };

  const missingFieldSet = new Set();
  const vmfLowConfidenceTasks = [];
  const aiWebSearchIpnSet = new Set();
  const aiWebSearchEvents = [];
  const tablesByName = new Map(
    (tables || [])
      .map(table => [normalizeText(table?.name).toLowerCase(), normalizeText(table?.id)])
      .filter(([name, id]) => Boolean(name && id))
  );
  const tableFieldsByName = new Map(
    (tables || [])
      .map(table => [
        normalizeText(table?.name).toLowerCase(),
        new Set((table?.fields || []).map(field => normalizeText(field?.name)).filter(Boolean))
      ])
      .filter(([name]) => Boolean(name))
  );

  emitProgress(progressCallback, {
    stage: 'phase4blite_load_rules',
    percent: 14,
    counts: summary,
    message:
      `Rules parsed: prefixes=${rulesByPrefix.size}, rows=${logicRowsScanned}, aiConcurrency=${args.aiConcurrency}, aiTimeoutMs=${args.aiTimeoutMs}, aiMaxAttempts=${args.aiMaxAttempts}` +
      `${summary.testTableName ? `, testTableName='${summary.testTableName}'` : ''}` +
      `${summary.testIpn ? `, testIpn='${summary.testIpn}'` : ''}` +
      `${summary.testMaxTables > 0 ? `, testMaxTables=${summary.testMaxTables}` : ''}`
  });

  for (let i = 0; i < routableTables.length; i += 1) {
    const table = routableTables[i];
    const tableName = normalizeText(table?.name);
    const tableId = normalizeText(table?.id);
    const prefix = parsePrefixFromTableName(tableName);
    if (!tableId || !prefix) continue;

    summary.tablesScanned += 1;
    if (i === 0 || (i + 1) % 10 === 0 || i + 1 === routableTables.length) {
      const ratio = routableTables.length > 0 ? (i + 1) / routableTables.length : 1;
      emitProgress(progressCallback, {
        stage: 'phase4blite_scan_tables',
        percent: Math.min(95, 20 + Math.floor(ratio * 70)),
        counts: summary,
        message: `Processing table ${i + 1}/${routableTables.length}: ${tableName}`
      });
    }

    const prefixRules = rulesByPrefix.get(prefix);
    if (!prefixRules || prefixRules.size === 0) {
      emitProgress(progressCallback, {
        stage: 'phase4blite_scan_tables',
        percent: Math.min(95, 20 + Math.floor(((i + 1) / Math.max(1, routableTables.length)) * 70)),
        counts: summary,
        message: `Skipping table ${i + 1}/${routableTables.length}: ${tableName} (prefix ${prefix}) -> no VF/VMF rules`
      });
      continue;
    }

    const tableFields = new Set(
      (table?.fields || []).map(field => normalizeText(field?.name)).filter(Boolean)
    );
    const applicableRules = new Map();
    for (const [fieldName, ruleMeta] of prefixRules.entries()) {
      if (!tableFields.has(fieldName)) {
        missingFieldSet.add(`${tableName}::${fieldName}`);
        continue;
      }
      applicableRules.set(fieldName, ruleMeta);
    }
    if (applicableRules.size === 0) {
      emitProgress(progressCallback, {
        stage: 'phase4blite_scan_tables',
        percent: Math.min(95, 20 + Math.floor(((i + 1) / Math.max(1, routableTables.length)) * 70)),
        counts: summary,
        message: `Skipping table ${i + 1}/${routableTables.length}: ${tableName} (prefix ${prefix}) -> no VF/VMF fields exist in schema`
      });
      continue;
    }

    const fetchFields = ['IPN', ...applicableRules.keys()];
    const rows = await fetchAllRecordsWithFallback(itemService, tableId, fetchFields);
    summary.rowsScanned += rows.length;
    emitProgress(progressCallback, {
      stage: 'phase4blite_scan_tables',
      percent: Math.min(95, 20 + Math.floor(((i + 1) / Math.max(1, routableTables.length)) * 70)),
      counts: summary,
      message: `Table ${i + 1}/${routableTables.length}: ${tableName} -> rows=${rows.length}, vfVmfFields=${applicableRules.size}`
    });

    const updatesByRecord = new Map();
    const updateRuleCountByRecord = new Map();
    let tableRowsProcessed = 0;
    const evaluationCandidates = [];

    for (const row of rows) {
      tableRowsProcessed += 1;
      if (tableRowsProcessed === 1 || tableRowsProcessed % 250 === 0 || tableRowsProcessed === rows.length) {
        const ratio = routableTables.length > 0 ? (i + 1) / routableTables.length : 1;
        emitProgress(progressCallback, {
          stage: 'phase4blite_scan_tables',
          percent: Math.min(95, 20 + Math.floor(ratio * 70)),
          counts: summary,
          message: `Preparing candidates for table ${i + 1}/${routableTables.length}: ${tableName} (rows ${tableRowsProcessed}/${rows.length})`
        });
      }

      const rowFields = row?.fields || {};
      const ipn = normalizeIpn(rowFields.IPN);
      if (!ipn) continue;
      if (requestedIpnSet.size > 0 && !requestedIpnSet.has(ipn)) continue;
      summary.rowsWithIPN += 1;

      const master = masterMap.get(ipn);
      if (!master) {
        summary.masterPartsMissing += 1;
        continue;
      }
      const context = extractMasterPartsContext(master.fields || {});
      if (Object.keys(context).length === 0) continue;
      const ebayContext = (await getEbayContextForIpn(ipn)) || {};
      summary.ebayContextLookupCount = ebayContextStats.lookups;
      summary.ebayContextLookupHits = ebayContextStats.lookupHits;
      summary.ebayContextLookupMisses = ebayContextStats.lookupMisses;
      summary.ebayContextLookupErrors = ebayContextStats.lookupErrors;
      summary.ebayContextCacheHits = ebayContextStats.cacheHits;
      summary.ebayContextRowsScanned = ebayContextStats.lookups;
      summary.ebayContextRowsMapped = ebayContextStats.lookupHits;
      summary.ebayContextRowsWithoutContext = ebayContextStats.lookupMisses;
      if (
        ebayContext &&
        (ebayContext.productTitle || ebayContext.listingConditionsAndOptions || ebayContext.listingDescription)
      ) {
        summary.ebayContextMatchedRows += 1;
      } else {
        summary.ebayContextMissingRows += 1;
      }

      for (const [fieldName, ruleMeta] of applicableRules.entries()) {
        const ruleType = normalizeText(ruleMeta?.ruleType).toUpperCase();
        if (isFieldFixedLocked(rowFields, fieldName)) {
          if (ruleType === 'VF') summary.vfFixedLockedSkipped += 1;
          if (ruleType === 'VMF') summary.vmfFixedLockedSkipped += 1;
          continue;
        }
        if (!isBlankCell(rowFields[fieldName])) continue;

        if (ruleType === 'VF') {
          if (isDotNumberIpn(ipn)) {
            summary.vfDotNumberSkipped += 1;
            continue;
          }
          summary.vfFieldsEvaluated += 1;
        } else if (ruleType === 'VMF') {
          summary.vmfFieldsEvaluated += 1;
        } else {
          continue;
        }
        evaluationCandidates.push({
          rowId: String(row.id || ''),
          ipn,
          prefix,
          tableName,
          fieldName,
          ruleType,
          context,
          allowedValues: Array.isArray(ruleMeta?.allowedValues) ? ruleMeta.allowedValues : [],
          listingTitle: normalizeText(ebayContext.productTitle),
          listingDescription: normalizeText(ebayContext.listingDescription),
          listingConditionsAndOptions: normalizeText(ebayContext.listingConditionsAndOptions)
        });
      }
    }

    summary.aiCallsPlanned += evaluationCandidates.length;
    emitProgress(progressCallback, {
      stage: 'phase4blite_scan_tables',
      percent: Math.min(95, 20 + Math.floor(((i + 1) / Math.max(1, routableTables.length)) * 70)),
      counts: summary,
      message: `AI evaluating table ${i + 1}/${routableTables.length}: ${tableName} -> candidates=${evaluationCandidates.length}, ipnBatchSize=${args.aiIpnBatchSize}`
    });

    let tableAiCompleted = 0;
    let tableAiFailed = 0;
    let lastAiProgressAt = Date.now();
    const pendingWebByIpn = new Map();
    const evaluationPayloads = evaluationCandidates.map((candidate, index) => ({
      requestId: `${i + 1}:${index + 1}:${candidate.rowId}:${candidate.fieldName}`,
      ipn: candidate.ipn,
      prefix: candidate.prefix,
      tableName: candidate.tableName,
      fieldName: candidate.fieldName,
      ruleType: candidate.ruleType,
      masterPartsData: candidate.context,
      allowedValues: candidate.allowedValues,
      listingTitle: candidate.listingTitle,
      listingDescription: candidate.listingDescription,
      listingConditionsAndOptions: candidate.listingConditionsAndOptions
    }));

    const batchFirstPass = await aiService.evaluateFieldChatBatch(evaluationPayloads, {
      ipnBatchSize: Math.max(1, Math.min(300, Number(args.aiIpnBatchSize || 250) || 250)),
      onBatchComplete: state => {
        const now = Date.now();
        if (now - lastAiProgressAt < 1000 && state?.index !== state?.total) return;
        lastAiProgressAt = now;
        const ratio = routableTables.length > 0 ? (i + 1) / routableTables.length : 1;
        emitProgress(progressCallback, {
          stage: 'phase4blite_scan_tables',
          percent: Math.min(95, 20 + Math.floor(ratio * 70)),
          counts: summary,
          message:
            `AI first-pass batches table ${i + 1}/${routableTables.length}: ${tableName} ` +
            `(batch ${state?.index || 0}/${state?.total || 0}, size=${state?.size || 0})`
        });
      }
    });

    const firstPassResults = batchFirstPass?.resultsByRequestId instanceof Map
      ? batchFirstPass.resultsByRequestId
      : new Map();
    const failedCount = Number(batchFirstPass?.failedCount || 0);
    summary.aiCallsCompleted += Math.max(0, evaluationCandidates.length - failedCount);
    summary.aiCallsFailed += failedCount;
    tableAiCompleted += Math.max(0, evaluationCandidates.length - failedCount);
    tableAiFailed += failedCount;
    if (failedCount > 0) {
      incrementCounter(summary.aiFailureTypes, 'batch_first_pass_failed');
      if (summary.aiFailureSamples.length < args.sampleLimit) {
        summary.aiFailureSamples.push(
          `${tableName} | first-pass batch failed items=${failedCount}`
        );
      }
    }

    for (let c = 0; c < evaluationCandidates.length; c += 1) {
      const candidate = evaluationCandidates[c];
      const requestId = evaluationPayloads[c].requestId;
      const aiResult = firstPassResults.get(requestId) || {
        value: '',
        confidence: 0,
        reason: 'first-pass missing result',
        webSearchUsed: false,
        webSources: []
      };
      const candidateValue = enforceAllowedValue(
        normalizeText(aiResult?.value),
        candidate.allowedValues
      );
      const confidence = Number(aiResult?.confidence || 0);
      const isHighConfidence = candidateValue && confidence >= LOW_CONFIDENCE_THRESHOLD;

      if (isHighConfidence) {
        if (!updatesByRecord.has(candidate.rowId)) updatesByRecord.set(candidate.rowId, {});
        updatesByRecord.get(candidate.rowId)[candidate.fieldName] = candidateValue;
        const existing = updateRuleCountByRecord.get(candidate.rowId) || { vf: 0, vmf: 0 };
        if (candidate.ruleType === 'VF') existing.vf += 1;
        if (candidate.ruleType === 'VMF') existing.vmf += 1;
        updateRuleCountByRecord.set(candidate.rowId, existing);
        if (summary.writeSamples.length < args.sampleLimit) {
          summary.writeSamples.push(
            `[write_candidate] table='${candidate.tableName}' ipn='${candidate.ipn}' field='${candidate.fieldName}' rule='${candidate.ruleType}' confidence='${confidence.toFixed(2)}' value='${candidateValue}'`
          );
        }
        continue;
      }

      if (!pendingWebByIpn.has(candidate.ipn)) pendingWebByIpn.set(candidate.ipn, []);
      pendingWebByIpn.get(candidate.ipn).push({
        ...candidate,
        firstPass: {
          value: candidateValue,
          confidence,
          reason: normalizeText(aiResult?.reason) || 'low confidence'
        }
      });
    }

    const pendingWebCandidates = Array.from(pendingWebByIpn.values()).flat();
    if (pendingWebCandidates.length > 0) {
      const webPayloads = pendingWebCandidates.map((candidate, index) => ({
        requestId: `4b:web:${i + 1}:${index + 1}:${candidate.rowId}:${candidate.fieldName}`,
        ipn: candidate.ipn,
        prefix: candidate.prefix,
        tableName: candidate.tableName,
        fieldName: candidate.fieldName,
        ruleType: candidate.ruleType,
        masterPartsData: candidate.context,
        allowedValues: candidate.allowedValues,
        listingTitle: candidate.listingTitle,
        listingDescription: candidate.listingDescription,
        listingConditionsAndOptions: candidate.listingConditionsAndOptions
      }));
      let webResultsByRequestId = new Map();
      try {
        const webBatch = await aiService.evaluateFieldsWithSharedWebSearchBatch(webPayloads, {
          ipnBatchSize: Math.max(1, Math.min(300, Number(args.aiIpnBatchSize || 250) || 250))
        });
        webResultsByRequestId =
          webBatch?.resultsByRequestId instanceof Map ? webBatch.resultsByRequestId : new Map();
      } catch (error) {
        summary.errors.push(`Shared web search batch failed: ${error.message}`);
      }

      for (let p = 0; p < pendingWebCandidates.length; p += 1) {
        const candidate = pendingWebCandidates[p];
        const requestId = webPayloads[p].requestId;
        const webResult = webResultsByRequestId.get(requestId) || null;
        const webValue = enforceAllowedValue(
          normalizeText(webResult?.value),
          candidate.allowedValues
        );
        const webConfidence = Number(webResult?.confidence || 0);
        const useWebValue = webValue && webConfidence >= LOW_CONFIDENCE_THRESHOLD;

        if (webResult?.webSearchUsed) {
          summary.aiWebSearchUsed += 1;
          aiWebSearchIpnSet.add(candidate.ipn);
          if (aiWebSearchEvents.length < args.sampleLimit) {
            aiWebSearchEvents.push(
              `web_search_used ipn='${candidate.ipn}' table='${candidate.tableName}' field='${candidate.fieldName}' rule='${candidate.ruleType}'`
            );
          }
        }

        if (useWebValue) {
          if (!updatesByRecord.has(candidate.rowId)) updatesByRecord.set(candidate.rowId, {});
          updatesByRecord.get(candidate.rowId)[candidate.fieldName] = webValue;
          const existing = updateRuleCountByRecord.get(candidate.rowId) || { vf: 0, vmf: 0 };
          if (candidate.ruleType === 'VF') existing.vf += 1;
          if (candidate.ruleType === 'VMF') existing.vmf += 1;
          updateRuleCountByRecord.set(candidate.rowId, existing);
          if (summary.writeSamples.length < args.sampleLimit) {
            summary.writeSamples.push(
              `[write_candidate_web] table='${candidate.tableName}' ipn='${candidate.ipn}' field='${candidate.fieldName}' rule='${candidate.ruleType}' confidence='${webConfidence.toFixed(2)}' value='${webValue}'`
            );
          }
          continue;
        }

        if (candidate.ruleType === 'VF') {
          summary.vfFieldsLowConfidenceSkipped += 1;
          continue;
        }

        vmfLowConfidenceTasks.push({
          taskKey: buildVmfTaskKey({
            ipn: candidate.ipn,
            prefix: candidate.prefix,
            fieldName: candidate.fieldName
          }),
          ipn: candidate.ipn,
          prefix: candidate.prefix,
          tableName: candidate.tableName,
          recordId: candidate.rowId,
          fieldName: candidate.fieldName,
          confidence: useWebValue ? webConfidence : Number(candidate?.firstPass?.confidence || 0),
          candidateValue: useWebValue ? webValue : normalizeText(candidate?.firstPass?.value),
          reason: normalizeText(webResult?.reason || candidate?.firstPass?.reason) || 'low confidence',
          contextSummary: summarizeContext(candidate.context)
        });
      }
    }

    const updates = Array.from(updatesByRecord.entries()).map(([id, fields]) => ({ id, fields }));
    if (updates.length > 0 && !args.dryRun) {
      const writeResult = await patchTableRecords(itemService, tableId, updates);
      for (const recordId of writeResult.successfulRecordIds) {
        const counts = updateRuleCountByRecord.get(String(recordId)) || { vf: 0, vmf: 0 };
        summary.vfFieldsUpdated += counts.vf;
        summary.vmfFieldsUpdated += counts.vmf;
      }
      if (writeResult.errors.length > 0) {
        summary.errors.push(
          ...writeResult.errors.slice(0, args.sampleLimit).map(message => `${tableName}: ${message}`)
        );
      }
    }
    emitProgress(progressCallback, {
      stage: 'phase4blite_scan_tables',
      percent: Math.min(95, 20 + Math.floor(((i + 1) / Math.max(1, routableTables.length)) * 70)),
      counts: summary,
      message: `Completed table ${i + 1}/${routableTables.length}: ${tableName} (aiPlanned=${evaluationCandidates.length}, updates=${updates.length}, vfUpdated=${summary.vfFieldsUpdated}, vmfUpdated=${summary.vmfFieldsUpdated})`
    });
  }

  const vmfTaskMap = new Map();
  for (const task of vmfLowConfidenceTasks) {
    if (!vmfTaskMap.has(task.taskKey)) vmfTaskMap.set(task.taskKey, task);
  }

  emitProgress(progressCallback, {
    stage: 'phase4blite_scan_tables',
    percent: 96,
    counts: summary,
    message: `Processing VMF low-confidence tasks: unique=${vmfTaskMap.size}`
  });
  await upsertVmfLowConfidenceTasks(clickupService, summary, Array.from(vmfTaskMap.values()), {
    dryRun: args.dryRun,
    openStatus: args.clickupOpenStatus,
    sampleLimit: args.sampleLimit,
    progressCallback
  });

  emitProgress(progressCallback, {
    stage: 'phase4blite_manual_writeback',
    percent: 98,
    counts: summary,
    message: `Processing VMF determined-value writeback tasks (status='${DEFAULT_PHASE4B_DETERMINED_STATUS}')...`
  });
  await runVmfDeterminedWriteback(itemService, clickupService, summary, {
    dryRun: args.dryRun,
    sampleLimit: args.sampleLimit,
    determinedStatus: DEFAULT_PHASE4B_DETERMINED_STATUS,
    completedStatus: DEFAULT_PHASE4B_COMPLETED_STATUS,
    targetIpn: requestedIpnSingle,
    tablesByName,
    tableFieldsByName
  });

  summary.fieldsMissingInSchema = missingFieldSet.size;
  if (missingFieldSet.size > 0) {
    summary.fieldsMissingInSchemaSamples = Array.from(missingFieldSet).slice(0, args.sampleLimit);
  }
  summary.aiWebSearchIpns = Array.from(aiWebSearchIpnSet);
  summary.aiWebSearchEvents = aiWebSearchEvents;
  if (summary.errors.length > args.sampleLimit) {
    summary.errors = summary.errors.slice(0, args.sampleLimit);
  }

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: summary,
    message:
      `Phase 4B-lite completed (${args.dryRun ? 'dry run' : 'write run'}). ` +
      `AI failed=${summary.aiCallsFailed || 0}${summary.aiCallsFailed > 0 ? ` (types: ${formatTopErrorStats(summary.aiFailureTypes)})` : ''}. ` +
      `eBayContext lookups=${summary.ebayContextLookupCount || 0}, hits=${summary.ebayContextLookupHits || 0}, cacheHits=${summary.ebayContextCacheHits || 0}, ` +
      `matched=${summary.ebayContextMatchedRows}, missing=${summary.ebayContextMissingRows}.`
  });
  return summary;
}

async function runPhase4BWritebackOnly(options = {}, progressCallback = () => {}) {
  const args = {
    ...parseArgs([]),
    ...options,
    dryRun: false,
    execute: true
  };
  const stored = loadPhaseConfigFromStore();

  const airtableToken = normalizeText(process.env.AIRTABLE_TOKEN || stored.airtableToken);
  const itemSpecificsBaseId = normalizeText(
    process.env.AIRTABLE_ITEM_SPECIFICS_BASE_ID ||
      process.env.ITEM_SPECIFICS_BASE_ID ||
      stored.itemSpecificsBaseId
  );
  const clickupToken = normalizeText(process.env.CLICKUP_TOKEN || stored.clickupToken);
  const clickupListId = normalizeText(
    args.phase4BClickupListId ||
      args.phase4CClickupListId ||
      process.env.PHASE4B_CLICKUP_LIST_ID ||
      process.env.PHASE4C_CLICKUP_LIST_ID ||
      stored.phase4BClickupListId ||
      stored.phase4CClickupListId
  );

  if (!airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (!itemSpecificsBaseId) throw new Error('Missing item specifics base ID (AIRTABLE_ITEM_SPECIFICS_BASE_ID).');
  if (!clickupToken) throw new Error('Missing ClickUp token for Phase 4B writeback poller.');
  if (!clickupListId) throw new Error('Missing Phase 4B ClickUp List ID for writeback poller.');

  const schemaService = new AirtableSchemaService({
    token: airtableToken,
    baseId: itemSpecificsBaseId
  });
  const itemService = new AirtableService({
    token: airtableToken,
    baseId: itemSpecificsBaseId
  });
  const clickupService = new ClickUpService({
    token: clickupToken,
    listId: clickupListId
  });

  const summary = {
    dryRun: false,
    phase4BClickupListId: clickupListId,
    vmfDeterminedTasksFound: 0,
    vmfDeterminedTasksProcessed: 0,
    vmfDeterminedTasksMissingMeta: 0,
    vmfDeterminedTasksMissingValue: 0,
    vmfDeterminedWritebackSucceeded: 0,
    vmfDeterminedWritebackFailed: 0,
    vmfDeterminedTasksClosed: 0,
    vmfDeterminedTaskCloseFailed: 0,
    vmfDeterminedFixedLocked: 0,
    errors: []
  };

  emitProgress(progressCallback, {
    stage: 'phase4blite_manual_writeback',
    percent: 10,
    counts: summary,
    message: `Phase 4B writeback poller: checking '${DEFAULT_PHASE4B_DETERMINED_STATUS}' tasks...`
  });

  const tables = await schemaService.listTables();
  const tablesByName = new Map(
    (tables || [])
      .map(table => [normalizeText(table?.name).toLowerCase(), normalizeText(table?.id)])
      .filter(([name, id]) => Boolean(name && id))
  );
  const tableFieldsByName = new Map(
    (tables || [])
      .map(table => [
        normalizeText(table?.name).toLowerCase(),
        new Set((table?.fields || []).map(field => normalizeText(field?.name)).filter(Boolean))
      ])
      .filter(([name]) => Boolean(name))
  );

  await runVmfDeterminedWriteback(itemService, clickupService, summary, {
    dryRun: false,
    sampleLimit: Number(args.sampleLimit || 20),
    determinedStatus: DEFAULT_PHASE4B_DETERMINED_STATUS,
    completedStatus: DEFAULT_PHASE4B_COMPLETED_STATUS,
    tablesByName,
    tableFieldsByName
  });

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: summary,
    message:
      `Phase 4B writeback poller completed. Found=${summary.vmfDeterminedTasksFound || 0}, ` +
      `WritebackSucceeded=${summary.vmfDeterminedWritebackSucceeded || 0}, Closed=${summary.vmfDeterminedTasksClosed || 0}.`
  });

  return summary;
}

async function runPhase4CMFWritebackOnly(options = {}, progressCallback = () => {}) {
  const args = {
    ...parseArgs([]),
    ...options,
    dryRun: false,
    execute: true
  };
  const stored = loadPhaseConfigFromStore();

  const airtableToken = normalizeText(process.env.AIRTABLE_TOKEN || stored.airtableToken);
  const itemSpecificsBaseId = normalizeText(
    process.env.AIRTABLE_ITEM_SPECIFICS_BASE_ID ||
      process.env.ITEM_SPECIFICS_BASE_ID ||
      stored.itemSpecificsBaseId
  );
  const clickupToken = normalizeText(process.env.CLICKUP_TOKEN || stored.clickupToken);
  const clickupListId = normalizeText(
    args.phase4CClickupListId ||
      args.phase4BClickupListId ||
      process.env.PHASE4C_CLICKUP_LIST_ID ||
      process.env.PHASE4B_CLICKUP_LIST_ID ||
      stored.phase4CClickupListId ||
      stored.phase4BClickupListId
  );

  if (!airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (!itemSpecificsBaseId) throw new Error('Missing item specifics base ID (AIRTABLE_ITEM_SPECIFICS_BASE_ID).');
  if (!clickupToken) throw new Error('Missing ClickUp token for Phase 4C writeback poller.');
  if (!clickupListId) throw new Error('Missing Phase 4C ClickUp List ID for writeback poller.');

  const schemaService = new AirtableSchemaService({
    token: airtableToken,
    baseId: itemSpecificsBaseId
  });
  const itemService = new AirtableService({
    token: airtableToken,
    baseId: itemSpecificsBaseId
  });
  const clickupService = new ClickUpService({
    token: clickupToken,
    listId: clickupListId
  });

  const summary = {
    dryRun: false,
    phase4CClickupListId: clickupListId,
    mfWritebacksCompleted: 0,
    mfWritebacksSkippedAlreadyFilled: 0,
    mfFixedLocked: 0,
    mfWritebackSamples: [],
    errors: []
  };

  emitProgress(progressCallback, {
    stage: 'phase4cmf_writeback',
    percent: 10,
    counts: summary,
    message: `Phase 4C writeback poller: checking '${DEFAULT_PHASE4B_DETERMINED_STATUS}' tasks...`
  });

  const tables = await schemaService.listTables();
  const tablesByName = new Map(
    (tables || [])
      .map(table => [normalizeText(table?.name).toLowerCase(), normalizeText(table?.id)])
      .filter(([name, id]) => Boolean(name && id))
  );
  const tableFieldsByName = new Map(
    (tables || [])
      .map(table => [
        normalizeText(table?.name).toLowerCase(),
        new Set((table?.fields || []).map(field => normalizeText(field?.name)).filter(Boolean))
      ])
      .filter(([name]) => Boolean(name))
  );

  await runMfDeterminedWriteback(itemService, clickupService, summary, {
    dryRun: false,
    sampleLimit: Number(args.sampleLimit || 20),
    determinedStatus: DEFAULT_PHASE4B_DETERMINED_STATUS,
    completedStatus: DEFAULT_PHASE4B_COMPLETED_STATUS,
    tablesByName,
    tableFieldsByName
  });

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: summary,
    message:
      `Phase 4C writeback poller completed. Writebacks=${summary.mfWritebacksCompleted || 0}, ` +
      `SkippedAlreadyFilled=${summary.mfWritebacksSkippedAlreadyFilled || 0}.`
  });

  return summary;
}

async function runPhase4CMF(options = {}, progressCallback = () => {}) {
  const args = {
    ...parseArgs([]),
    ...options
  };
  const stored = loadPhaseConfigFromStore();

  const airtableToken = normalizeText(process.env.AIRTABLE_TOKEN || stored.airtableToken);
  const itemSpecificsBaseId = normalizeText(
    process.env.AIRTABLE_ITEM_SPECIFICS_BASE_ID ||
      process.env.ITEM_SPECIFICS_BASE_ID ||
      stored.itemSpecificsBaseId
  );
  const clickupToken = normalizeText(process.env.CLICKUP_TOKEN || stored.clickupToken);
  const clickupListId = normalizeText(
    args.phase4CClickupListId ||
      args.phase4BClickupListId ||
      process.env.PHASE4C_CLICKUP_LIST_ID ||
      process.env.PHASE4B_CLICKUP_LIST_ID ||
      stored.phase4CClickupListId ||
      stored.phase4BClickupListId
  );
  const openStatus = normalizeText(
    args.phase4CClickupOpenStatus ||
      args.clickupOpenStatus ||
      process.env.PHASE4C_CLICKUP_OPEN_STATUS ||
      process.env.PHASE4B_CLICKUP_OPEN_STATUS ||
      stored.phase4CClickupOpenStatus ||
      stored.phase4BClickupOpenStatus ||
      'To Do'
  );

  if (!airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (!itemSpecificsBaseId) throw new Error('Missing item specifics base ID (AIRTABLE_ITEM_SPECIFICS_BASE_ID).');
  if (!args.rulesDriveFile) throw new Error('Missing rules drive file. Provide --rules-drive-file=<FILE_ID_OR_URL>.');
  if (!clickupToken) throw new Error('Missing ClickUp token for Phase 4C MF tasks.');
  if (!clickupListId) throw new Error('Missing Phase 4C ClickUp List ID for MF tasks.');

  emitProgress(progressCallback, {
    stage: 'phase4cmf_load_rules',
    percent: 10,
    message: 'Loading MF rules workbook from Google Drive...'
  });

  const { workbook, fileId } = await loadWorkbookFromDrive(args.rulesDriveFile, args.authContext);
  const ws = workbook.getWorksheet(args.logicSheetName);
  const parsed = parseLogicWorksheet(ws, args.logicSheetName, ['MF']);
  const rulesByPrefix = parsed.byPrefix;

  const schemaService = new AirtableSchemaService({
    token: airtableToken,
    baseId: itemSpecificsBaseId
  });
  const itemService = new AirtableService({
    token: airtableToken,
    baseId: itemSpecificsBaseId
  });
  const clickupService = new ClickUpService({
    token: clickupToken,
    listId: clickupListId
  });

  const tables = await schemaService.listTables();
  const allRoutableTables = tables.filter(table => Boolean(parsePrefixFromTableName(table?.name)));
  const requestedTableName = normalizeText(args.testTableName);
  const routableTables = requestedTableName
    ? allRoutableTables.filter(
        table => normalizeText(table?.name).toLowerCase() === requestedTableName.toLowerCase()
      )
    : Number(args.testMaxTables || 0) > 0
      ? allRoutableTables.slice(0, Number(args.testMaxTables))
      : allRoutableTables;
  if (requestedTableName && routableTables.length === 0) {
    throw new Error(`Test table not found: '${requestedTableName}'. Use exact Airtable table name.`);
  }

  const tablesByName = new Map(
    (tables || [])
      .map(table => [normalizeText(table?.name).toLowerCase(), normalizeText(table?.id)])
      .filter(([name, id]) => Boolean(name && id))
  );
  const tableFieldsByName = new Map(
    (tables || [])
      .map(table => [
        normalizeText(table?.name).toLowerCase(),
        new Set((table?.fields || []).map(field => normalizeText(field?.name)).filter(Boolean))
      ])
      .filter(([name]) => Boolean(name))
  );

  const summary = {
    dryRun: Boolean(args.dryRun),
    rulesSource: `google_drive:${fileId}`,
    tablesScanned: 0,
    rowsScanned: 0,
    rowsWithIPN: 0,
    mfFieldsScanned: 0,
    mfFieldsAlreadyFilled: 0,
    mfFieldsFixedLockedSkipped: 0,
    mfTasksCreated: 0,
    mfTasksUpdated: 0,
    mfTasksSkippedExisting: 0,
    mfWritebacksCompleted: 0,
    mfWritebacksSkippedAlreadyFilled: 0,
    mfFixedLocked: 0,
    fieldsMissingInSchema: 0,
    mfTaskSamples: [],
    mfWritebackSamples: [],
    errors: []
  };

  const pendingMfTasks = [];
  emitProgress(progressCallback, {
    stage: 'phase4cmf_scan_tables',
    percent: 20,
    counts: summary,
    message: `Scanning MF fields across ${routableTables.length} tables...`
  });

  for (let i = 0; i < routableTables.length; i += 1) {
    const table = routableTables[i];
    const tableName = normalizeText(table?.name);
    const tableId = normalizeText(table?.id);
    const prefix = parsePrefixFromTableName(tableName);
    if (!tableId || !prefix) continue;

    summary.tablesScanned += 1;
    const mfFieldsMap = rulesByPrefix.get(prefix);
    if (!mfFieldsMap || mfFieldsMap.size === 0) continue;

    const tableFieldNames = tableFieldsByName.get(tableName.toLowerCase()) || new Set();
    const mfFieldNames = Array.from(mfFieldsMap.keys()).filter(field => tableFieldNames.has(field));
    const missingMfFields = Array.from(mfFieldsMap.keys()).filter(field => !tableFieldNames.has(field));
    summary.fieldsMissingInSchema += missingMfFields.length;
    if (mfFieldNames.length === 0) continue;

    const rows = await fetchAllRecordsWithFallback(itemService, tableId, ['IPN', ...mfFieldNames]);
    summary.rowsScanned += rows.length;

    for (const row of rows) {
      const rowId = normalizeText(row?.id);
      const fields = row?.fields || {};
      const ipn = normalizeIpn(fields.IPN);
      if (!ipn) continue;
      summary.rowsWithIPN += 1;

      for (const fieldName of mfFieldNames) {
        summary.mfFieldsScanned += 1;
        if (isFieldFixedLocked(fields, fieldName)) {
          summary.mfFieldsFixedLockedSkipped += 1;
          continue;
        }
        const currentValue = normalizeText(fields[fieldName]);
        if (currentValue) {
          summary.mfFieldsAlreadyFilled += 1;
          continue;
        }

        pendingMfTasks.push({
          taskKey: buildMfTaskKey({ ipn, prefix, fieldName }),
          ipn,
          prefix,
          tableName,
          recordId: rowId,
          fieldName
        });
      }
    }

    if (i === 0 || (i + 1) % 10 === 0 || i + 1 === routableTables.length) {
      const ratio = routableTables.length > 0 ? (i + 1) / routableTables.length : 1;
      emitProgress(progressCallback, {
        stage: 'phase4cmf_scan_tables',
        percent: Math.min(80, 20 + Math.floor(ratio * 50)),
        counts: summary,
        message: `Scanning table ${i + 1}/${routableTables.length}: ${tableName}`
      });
    }
  }

  const mfTaskMap = new Map();
  for (const task of pendingMfTasks) {
    if (!mfTaskMap.has(task.taskKey)) mfTaskMap.set(task.taskKey, task);
  }

  emitProgress(progressCallback, {
    stage: 'phase4cmf_tasks',
    percent: 85,
    counts: summary,
    message: `Upserting MF manual tasks: unique=${mfTaskMap.size}`
  });
  await upsertMfManualTasks(clickupService, summary, Array.from(mfTaskMap.values()), {
    dryRun: args.dryRun,
    sampleLimit: args.sampleLimit,
    openStatus
  });

  emitProgress(progressCallback, {
    stage: 'phase4cmf_writeback',
    percent: 92,
    counts: summary,
    message: `Processing MF determined-value writeback tasks (status='${DEFAULT_PHASE4B_DETERMINED_STATUS}')...`
  });
  await runMfDeterminedWriteback(itemService, clickupService, summary, {
    dryRun: args.dryRun,
    sampleLimit: args.sampleLimit,
    determinedStatus: DEFAULT_PHASE4B_DETERMINED_STATUS,
    completedStatus: DEFAULT_PHASE4B_COMPLETED_STATUS,
    tablesByName,
    tableFieldsByName
  });

  if (summary.errors.length > args.sampleLimit) {
    summary.errors = summary.errors.slice(0, args.sampleLimit);
  }

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: summary,
    message:
      `Phase 4C (MF) completed (${args.dryRun ? 'dry run' : 'write run'}). ` +
      `TasksCreated=${summary.mfTasksCreated}, TasksUpdated=${summary.mfTasksUpdated}, ` +
      `Writebacks=${summary.mfWritebacksCompleted}.`
  });

  return summary;
}

function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  const text = normalizeText(value).toLowerCase();
  if (!text) return defaultValue;
  if (['true', '1', 'yes', 'y'].includes(text)) return true;
  if (['false', '0', 'no', 'n'].includes(text)) return false;
  return defaultValue;
}

function resolveFieldByKeywords(fields = {}, keywords = []) {
  const entries = Object.entries(fields || {});
  const targetKeywords = keywords.map(item => normalizeText(item).toLowerCase()).filter(Boolean);
  if (targetKeywords.length === 0) return '';
  for (const [name, rawValue] of entries) {
    const value = normalizeText(rawValue);
    if (!value) continue;
    const key = normalizeText(name).toLowerCase();
    if (targetKeywords.every(word => key.includes(word))) return value;
  }
  return '';
}

function compactText(value, maxLength = 4000) {
  const text = normalizeText(value);
  if (!text) return '';
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function buildAiMasterContext(masterFields = {}) {
  const context = extractMasterPartsContext(masterFields);
  const entries = Object.entries(context)
    .slice(0, 40)
    .map(([key, value]) => [key, compactText(value, 600)]);
  return Object.fromEntries(entries);
}

function resolveFsVMasterValue(fieldName, masterFields = {}) {
  const field = normalizeText(fieldName).toLowerCase();
  if (!field) return '';

  if (field.includes('length')) {
    return (
      resolveFieldByKeywords(masterFields, ['shipstation', 'length']) ||
      resolveFieldByKeywords(masterFields, ['locked', 'length']) ||
      resolveFieldByKeywords(masterFields, ['package', 'length']) ||
      resolveFieldByKeywords(masterFields, ['length'])
    );
  }
  if (field.includes('width')) {
    return (
      resolveFieldByKeywords(masterFields, ['shipstation', 'width']) ||
      resolveFieldByKeywords(masterFields, ['locked', 'width']) ||
      resolveFieldByKeywords(masterFields, ['package', 'width']) ||
      resolveFieldByKeywords(masterFields, ['width'])
    );
  }
  if (field.includes('height')) {
    return (
      resolveFieldByKeywords(masterFields, ['shipstation', 'height']) ||
      resolveFieldByKeywords(masterFields, ['locked', 'height']) ||
      resolveFieldByKeywords(masterFields, ['package', 'height']) ||
      resolveFieldByKeywords(masterFields, ['height'])
    );
  }
  if (field.includes('weight')) {
    return (
      resolveFieldByKeywords(masterFields, ['shipstation', 'weight']) ||
      resolveFieldByKeywords(masterFields, ['locked', 'weight']) ||
      resolveFieldByKeywords(masterFields, ['package', 'weight']) ||
      resolveFieldByKeywords(masterFields, ['weight'])
    );
  }

  return '';
}

function isManualOverrideForField(listingFields = {}, fieldName = '') {
  return isManualOverrideFromGovernance(listingFields, fieldName);
}

function isListingRowInScope(listingFields = {}) {
  const statusCandidates = [
    'Phase 4 Status',
    'Listing Enrichment Status',
    'Enrichment Status',
    'Queue Status'
  ];
  for (const name of statusCandidates) {
    const raw = normalizeText(getFieldValueByName(listingFields, name)).toLowerCase();
    if (!raw) continue;
    if (
      raw.includes('pending') ||
      raw.includes('new') ||
      raw.includes('queue') ||
      raw.includes('working') ||
      raw.includes('in progress')
    ) {
      return true;
    }
    return false;
  }
  return true;
}

async function ensureListingCFields(schemaService, tableId, tableName, tableFieldsByName, requiredFields = [], dryRun = true) {
  const key = normalizeText(tableName).toLowerCase();
  const existing = tableFieldsByName.get(key) || new Set();
  const created = [];
  for (const fieldName of requiredFields) {
    if (!fieldName.startsWith('C:')) continue;
    if (existing.has(fieldName)) continue;
    if (!dryRun) {
      await schemaService.createField(tableId, {
        name: fieldName,
        type: 'singleLineText'
      });
    }
    existing.add(fieldName);
    created.push(fieldName);
  }
  tableFieldsByName.set(key, existing);
  return created;
}

async function runPhase4DListing(options = {}, progressCallback = () => {}) {
  const args = {
    ...parseArgs([]),
    ...options
  };
  const stored = loadPhaseConfigFromStore();

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
  const openaiApiKey = normalizeText(args.openaiApiKey || stored.openaiApiKey || '');
  const openaiModel = normalizeText(args.openaiModel || stored.openaiModel || 'gpt-5.4-mini');
  const openaiBaseUrl = normalizeText(args.openaiBaseUrl || stored.openaiBaseUrl || '');
  const requestedIpnSet = parseIpnSet(args.phase4DTestIpn || args.phase4BTestIpn);
  const requestedIpnLabel = requestedIpnSet.size > 0 ? Array.from(requestedIpnSet).join(', ') : '';

  if (!airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (!masterBaseId) throw new Error('Missing AIRTABLE_BASE_ID.');
  if (!args.rulesDriveFile) throw new Error('Missing rules drive file. Provide --rules-drive-file=<FILE_ID_OR_URL>.');
  if (!openaiApiKey) throw new Error('Missing OpenAI API key for Phase 4D.');

  emitProgress(progressCallback, {
    stage: 'phase4d_load_rules',
    percent: 8,
    message: 'Loading listing-only rules workbook from Google Drive...'
  });

  const { workbook, fileId } = await loadWorkbookFromDrive(args.rulesDriveFile, args.authContext);
  const ws = workbook.getWorksheet(args.logicSheetName);
  const parsed = parseLogicWorksheet(ws, args.logicSheetName, ['FSV', 'V1', 'V2', 'VB']);
  const rulesByPrefix = parsed.byPrefix;

  const schemaService = new AirtableSchemaService({
    token: airtableToken,
    baseId: masterBaseId
  });
  const airtableService = new AirtableService({
    token: airtableToken,
    baseId: masterBaseId
  });
  const aiService = new Phase4AiEvaluatorService({
    apiKey: openaiApiKey,
    model: openaiModel,
    baseUrl: openaiBaseUrl || undefined,
    timeoutMs: args.aiTimeoutMs,
    maxAttempts: args.aiMaxAttempts,
    baseDelayMs: 500,
    promptCacheEnabled: args.promptCacheEnabled,
    promptCacheKey: args.promptCacheKey,
    debugPromptIpn:
      args.phase4DTestIpn ||
      args.phase4BTestIpn ||
      args.phase4BDebugPromptIpn ||
      process.env.PHASE4D_DEBUG_PROMPT_IPN ||
      process.env.PHASE4B_DEBUG_PROMPT_IPN ||
      ''
  });

  const tables = await schemaService.listTables();
  const configuredListingsTableObj = (tables || []).find(
    table => normalizeText(table?.name).toLowerCase() === listingsTable.toLowerCase()
  );
  if (!configuredListingsTableObj?.id) {
    throw new Error(`Listing table not found: '${listingsTable}'.`);
  }
  const listingsTableId = normalizeText(configuredListingsTableObj.id);
  const selectedListingsTableName = normalizeText(configuredListingsTableObj.name || listingsTable);
  const tableFieldsByName = new Map(
    (tables || [])
      .map(table => [
        normalizeText(table?.name).toLowerCase(),
        new Set((table?.fields || []).map(field => normalizeText(field?.name)).filter(Boolean))
      ])
      .filter(([name]) => Boolean(name))
  );

  emitProgress(progressCallback, {
    stage: 'phase4d_scan_listings',
    percent: 16,
    message: 'Loading Master Parts records for Phase 4D context...'
  });
  let lastMasterLoadProgressAt = Date.now();
  const masterRows = await fetchAllRecordsWithFallbackAndProgress(
    airtableService,
    masterTable,
    [],
    state => {
      const now = Date.now();
      if (!state?.hasMore || now - lastMasterLoadProgressAt >= 800) {
        lastMasterLoadProgressAt = now;
        emitProgress(progressCallback, {
          stage: 'phase4d_scan_listings',
          percent: 16,
          message:
            `Loading Master Parts records for Phase 4D context... ` +
            `Loaded ${Number(state?.loaded || 0)} rows (page ${Number(state?.page || 1)}).`
        });
      }
    }
  );
  const masterByIpn = new Map();
  for (const row of masterRows) {
    const ipn = normalizeIpn(row?.fields?.IPN);
    if (!ipn || masterByIpn.has(ipn)) continue;
    masterByIpn.set(ipn, row);
  }

  emitProgress(progressCallback, {
    stage: 'phase4d_scan_listings',
    percent: 20,
    message: `Loading listings from '${selectedListingsTableName}'...`
  });

  const listingSelectFields = [
    EBAY_LISTING_RECORD_KEY_FIELD,
    'Item ID',
    'eBay Item ID',
    'Ebay Item ID',
    'Record Key',
    ...EBAY_LISTING_IPN_FIELDS,
    EBAY_LISTING_TITLE_FIELD,
    EBAY_LISTING_CONDITIONS_FIELD,
    'c: partshunter203 ebay MOTORS conditions & options',
    'Listing Conditions and Options',
    ...EBAY_LISTING_DESCRIPTION_FIELDS
  ];
  const effectiveListingsTableName = selectedListingsTableName;
  const effectiveListingsTableId = listingsTableId;
  let lastListingsLoadProgressAt = Date.now();
  const listingsRows = await fetchAllRecordsWithFallbackAndProgress(
    airtableService,
    effectiveListingsTableId,
    listingSelectFields,
    state => {
      const now = Date.now();
      if (!state?.hasMore || now - lastListingsLoadProgressAt >= 800) {
        lastListingsLoadProgressAt = now;
        emitProgress(progressCallback, {
          stage: 'phase4d_scan_listings',
          percent: 20,
          message:
            `Loading listings from '${effectiveListingsTableName}'... ` +
            `Loaded ${Number(state?.loaded || 0)} rows (page ${Number(state?.page || 1)}).`
        });
      }
    }
  );

  const summary = {
    dryRun: Boolean(args.dryRun),
    rulesSource: `google_drive:${fileId}`,
    rulesDriveFile: args.rulesDriveFile || '',
    listingsTable: effectiveListingsTableName,
    testIpn: requestedIpnLabel,
    listingsScanned: listingsRows.length,
    listingsEligible: 0,
    skippedAlreadyPublished: 0,
    skippedByTestIpn: 0,
    skippedMissingIpn: 0,
    skippedOutOfScope: 0,
    skippedNoPrefixRules: 0,
    masterPartsMissing: 0,
    listingFieldsCreated: 0,
    fsvFieldsEvaluated: 0,
    fsvFieldsUpdated: 0,
    fsvDNAWritten: 0,
    v1FieldsEvaluated: 0,
    v1FieldsUpdated: 0,
    v1DNAWritten: 0,
    v1LowConfidenceLeftBlank: 0,
    v2FieldsEvaluated: 0,
    v2FieldsUpdated: 0,
    v2DNAWritten: 0,
    v2LowConfidenceLeftBlank: 0,
    v2DNASkippedOverwrite: 0,
    vbFieldsEvaluated: 0,
    vbFieldsUpdated: 0,
    vbLowConfidenceLeftBlank: 0,
    aiWebSearchUsed: 0,
    aiWebSearchIpns: [],
    aiWebSearchEvents: [],
    manualOverrideSkipped: 0,
    sampleSkips: [],
    sampleOutputs: [],
    errors: []
  };
  let aiCalls = 0;
  let writesDone = 0;
  let lastProgressAt = Date.now();
  const publishedIdentitySet = asIdentitySet(args.phase5PublishedIdentities || []);
  const firstPassCandidates = [];
  const pendingWebByIpn = new Map();
  const aiWebSearchIpnSet = new Set();
  const aiWebSearchEvents = [];
  const pushSkipSample = message => {
    if (!message) return;
    if (summary.sampleSkips.length < args.sampleLimit) {
      summary.sampleSkips.push(message);
    }
  };

  for (let i = 0; i < listingsRows.length; i += 1) {
    const row = listingsRows[i];
    const listingFields = row?.fields || {};
    const recordId = normalizeText(row?.id);
    const recordKey = firstNonEmptyField(listingFields, [
      EBAY_LISTING_RECORD_KEY_FIELD,
      'Item ID',
      'eBay Item ID',
      'Ebay Item ID',
      'Record Key'
    ]) || recordId;
    const ipn = resolveListingIpn(listingFields);
    if (!ipn) {
      summary.skippedMissingIpn += 1;
      const availableFields = Object.keys(listingFields || {})
        .map(name => normalizeText(name))
        .filter(Boolean)
        .slice(0, 12)
        .join(', ');
      pushSkipSample(
        `skip=missing_ipn record='${recordKey || recordId}' fields='${availableFields || 'none'}'`
      );
      continue;
    }
    if (requestedIpnSet.size > 0 && !requestedIpnSet.has(ipn)) {
      summary.skippedByTestIpn += 1;
      continue;
    }
    if (isPublishedIdentity(listingFields, publishedIdentitySet)) {
      summary.skippedAlreadyPublished += 1;
      pushSkipSample(`skip=already_published record='${recordKey || recordId}' ipn='${ipn}'`);
      continue;
    }
    if (!isListingRowInScope(listingFields)) {
      summary.skippedOutOfScope += 1;
      const listingStatus = normalizeText(
        listingFields['c: Listing Status'] ||
          listingFields['C: Listing Status'] ||
          listingFields['Listing Status']
      );
      pushSkipSample(
        `skip=out_of_scope record='${recordKey || recordId}' ipn='${ipn}' status='${listingStatus || 'blank'}'`
      );
      continue;
    }

    const master = masterByIpn.get(ipn);
    if (!master) {
      summary.masterPartsMissing += 1;
      pushSkipSample(`skip=missing_master record='${recordKey || recordId}' ipn='${ipn}'`);
      continue;
    }
    const prefix = normalizeText(master?.fields?.['IPN Prefix'] || parsePrefixFromTableName(ipn));
    const prefixRules = rulesByPrefix.get(prefix);
    if (!prefixRules || prefixRules.size === 0) {
      summary.skippedNoPrefixRules += 1;
      pushSkipSample(`skip=no_prefix_rules record='${recordKey || recordId}' ipn='${ipn}' prefix='${prefix}'`);
      continue;
    }
    summary.listingsEligible += 1;

    const ruleFieldNames = Array.from(prefixRules.keys());
    const createdFields = await ensureListingCFields(
      schemaService,
      effectiveListingsTableId,
      effectiveListingsTableName,
      tableFieldsByName,
      ruleFieldNames,
      Boolean(args.dryRun)
    );
    if (!args.dryRun) {
      summary.listingFieldsCreated += createdFields.length;
    }

    for (const fieldName of ruleFieldNames) {
      const ruleMeta = prefixRules.get(fieldName) || {};
      const ruleType = normalizeText(ruleMeta.ruleType).toUpperCase();
      const currentValue = normalizeText(listingFields[fieldName]);
      if (isManualOverrideForField(listingFields, fieldName)) {
        summary.manualOverrideSkipped += 1;
        continue;
      }

      if (ruleType === 'FSV') {
        summary.fsvFieldsEvaluated += 1;
        const sourceValue = resolveFsVMasterValue(fieldName, master?.fields || {});
        const nextValue = sourceValue || 'Does Not Apply';
        const canWrite =
          !currentValue ||
          currentValue.toLowerCase() === 'does not apply';
        if (!canWrite || currentValue === nextValue) continue;
        if (args.dryRun) continue;
        if (!args.dryRun) {
          const writeResult = await patchTableRecords(
            airtableService,
            effectiveListingsTableId,
            [{ id: recordId, fields: { [fieldName]: nextValue } }]
          );
          if (writeResult.updatedRecords <= 0 || writeResult.errors.length > 0) {
            if (summary.errors.length < args.sampleLimit) {
              summary.errors.push(`FsV write failed record='${recordKey}' field='${fieldName}'`);
            }
            continue;
          }
        }
        summary.fsvFieldsUpdated += 1;
        writesDone += 1;
        if (nextValue === 'Does Not Apply') summary.fsvDNAWritten += 1;
        listingFields[fieldName] = nextValue;
        if (summary.sampleOutputs.length < args.sampleLimit) {
          summary.sampleOutputs.push(`[FsV] record='${recordKey}' ipn='${ipn}' field='${fieldName}' value='${nextValue}'`);
        }
        continue;
      }

      if (ruleType === 'V1') {
        summary.v1FieldsEvaluated += 1;
        if (currentValue && currentValue.toLowerCase() !== 'does not apply') continue;
      } else if (ruleType === 'V2') {
        summary.v2FieldsEvaluated += 1;
        if (currentValue && currentValue.toLowerCase() === 'does not apply') {
          summary.v2DNASkippedOverwrite += 1;
          continue;
        }
        if (currentValue) continue;
      } else if (ruleType === 'VB') {
        summary.vbFieldsEvaluated += 1;
        if (currentValue) continue;
      } else {
        continue;
      }

      firstPassCandidates.push({
        recordId,
        recordKey,
        ipn,
        prefix,
        fieldName,
        ruleType,
        currentValue,
        masterPartsData: buildAiMasterContext(master?.fields || {}),
        allowedValues: Array.isArray(ruleMeta?.allowedValues) ? ruleMeta.allowedValues : [],
        listingTitle: compactText(
          firstNonEmptyField(listingFields, [EBAY_LISTING_TITLE_FIELD, 'Product Title', 'Product Title(New)', 'Listing Title']),
          1000
        ),
        listingDescription: compactText(firstNonEmptyField(listingFields, EBAY_LISTING_DESCRIPTION_FIELDS), 4000),
        listingConditionsAndOptions: compactText(
          firstNonEmptyField(listingFields, [
            EBAY_LISTING_CONDITIONS_FIELD,
            'c: partshunter203 ebay MOTORS conditions & options',
            'Listing Conditions and Options'
          ]),
          2000
        )
      });
    }

    const now = Date.now();
    if (
      i === 0 ||
      (i + 1) % 100 === 0 ||
      i + 1 === listingsRows.length ||
      now - lastProgressAt >= 10000
    ) {
      lastProgressAt = now;
      emitProgress(progressCallback, {
        stage: 'phase4d_scan_listings',
        percent: Math.min(95, 20 + Math.floor(((i + 1) / Math.max(1, listingsRows.length)) * 70)),
        counts: summary,
        message:
          `Processing listing ${i + 1}/${listingsRows.length} ` +
          `(recordKey='${recordKey || recordId}', eligible=${summary.listingsEligible}, aiCalls=${aiCalls}, writes=${writesDone}, ` +
          `FsV=${summary.fsvFieldsUpdated}, V1=${summary.v1FieldsUpdated}, V2=${summary.v2FieldsUpdated}, VB=${summary.vbFieldsUpdated}, ` +
          `manualSkipped=${summary.manualOverrideSkipped}, publishedSkipped=${summary.skippedAlreadyPublished}, missingIpn=${summary.skippedMissingIpn}, ` +
          `outOfScope=${summary.skippedOutOfScope}, noPrefixRules=${summary.skippedNoPrefixRules}, masterMissing=${summary.masterPartsMissing})`
      });
    }
  }

  if (firstPassCandidates.length > 0) {
    emitProgress(progressCallback, {
      stage: 'phase4d_scan_listings',
      percent: 95,
      counts: summary,
      message:
        `Running AI first-pass in IPN batches (size=${args.aiIpnBatchSize}) ` +
        `for ${firstPassCandidates.length} candidates...`
    });
    const firstPassPayloads = firstPassCandidates.map((candidate, index) => ({
      requestId: `4d:${index + 1}:${candidate.recordId}:${candidate.fieldName}`,
      recordKey: candidate.recordKey,
      ipn: candidate.ipn,
      prefix: candidate.prefix,
      tableName: effectiveListingsTableName,
      fieldName: candidate.fieldName,
      ruleType: candidate.ruleType,
      masterPartsData: candidate.masterPartsData,
      allowedValues: candidate.allowedValues,
      listingTitle: candidate.listingTitle,
      listingDescription: candidate.listingDescription,
      listingConditionsAndOptions: candidate.listingConditionsAndOptions
    }));
    const firstPassBatch = await aiService.evaluateFieldChatBatch(firstPassPayloads, {
      ipnBatchSize: Math.max(1, Math.min(300, Number(args.aiIpnBatchSize || 250) || 250))
    });
    aiCalls += firstPassCandidates.length;
    const firstPassResults = firstPassBatch?.resultsByRequestId instanceof Map
      ? firstPassBatch.resultsByRequestId
      : new Map();

    for (let idx = 0; idx < firstPassCandidates.length; idx += 1) {
      const candidate = firstPassCandidates[idx];
      const requestId = firstPassPayloads[idx].requestId;
      const aiResult = firstPassResults.get(requestId) || {
        value: '',
        confidence: 0,
        reason: 'first-pass missing result',
        webSearchUsed: false,
        webSources: []
      };
      const confidence = Number(aiResult?.confidence || 0);
      const candidateValue = enforceAllowedValue(
        normalizeText(aiResult?.value),
        candidate.allowedValues
      );
      const nextValue = confidence >= LOW_CONFIDENCE_THRESHOLD && candidateValue ? candidateValue : '';

      if (!nextValue) {
        if (!pendingWebByIpn.has(candidate.ipn)) pendingWebByIpn.set(candidate.ipn, []);
        pendingWebByIpn.get(candidate.ipn).push({
          ...candidate,
          firstPass: {
            value: candidateValue,
            confidence,
            reason: normalizeText(aiResult?.reason) || 'low confidence'
          }
        });
        continue;
      }
      if (candidate.currentValue === nextValue) continue;
      if (args.dryRun) continue;

      const writeResult = await patchTableRecords(
        airtableService,
        effectiveListingsTableId,
        [{ id: candidate.recordId, fields: { [candidate.fieldName]: nextValue } }]
      );
      if (writeResult.updatedRecords <= 0 || writeResult.errors.length > 0) {
        if (summary.errors.length < args.sampleLimit) {
          summary.errors.push(
            `${candidate.ruleType} write failed record='${candidate.recordKey}' field='${candidate.fieldName}'`
          );
        }
        continue;
      }

      if (candidate.ruleType === 'V1') {
        summary.v1FieldsUpdated += 1;
      } else if (candidate.ruleType === 'V2') {
        summary.v2FieldsUpdated += 1;
      } else if (candidate.ruleType === 'VB') {
        summary.vbFieldsUpdated += 1;
      }
      writesDone += 1;
      if (summary.sampleOutputs.length < args.sampleLimit) {
        summary.sampleOutputs.push(
          `[${candidate.ruleType}] record='${candidate.recordKey}' ipn='${candidate.ipn}' field='${candidate.fieldName}' value='${nextValue}' confidence='${confidence.toFixed(2)}'`
        );
      }
    }
  }

  const pendingWebCandidates = Array.from(pendingWebByIpn.values()).flat();
  if (pendingWebCandidates.length > 0) {
    const webPayloads = pendingWebCandidates.map((candidate, index) => ({
      requestId: `4d:web:${index + 1}:${candidate.recordId}:${candidate.fieldName}`,
      ipn: candidate.ipn,
      prefix: candidate.prefix,
      tableName: effectiveListingsTableName,
      fieldName: candidate.fieldName,
      ruleType: candidate.ruleType,
      masterPartsData: candidate.masterPartsData,
      allowedValues: candidate.allowedValues,
      listingTitle: candidate.listingTitle,
      listingDescription: candidate.listingDescription,
      listingConditionsAndOptions: candidate.listingConditionsAndOptions
    }));
    let webResultsByRequestId = new Map();
    try {
      const webBatch = await aiService.evaluateFieldsWithSharedWebSearchBatch(webPayloads, {
        ipnBatchSize: Math.max(1, Math.min(300, Number(args.aiIpnBatchSize || 250) || 250))
      });
      webResultsByRequestId =
        webBatch?.resultsByRequestId instanceof Map ? webBatch.resultsByRequestId : new Map();
    } catch (error) {
      if (summary.errors.length < args.sampleLimit) {
        summary.errors.push(`Shared web search batch failed: ${error.message}`);
      }
    }

    for (let p = 0; p < pendingWebCandidates.length; p += 1) {
      const candidate = pendingWebCandidates[p];
      const requestId = webPayloads[p].requestId;
      const webResult = webResultsByRequestId.get(requestId) || null;
      const webValue = enforceAllowedValue(
        normalizeText(webResult?.value),
        candidate.allowedValues
      );
      const webConfidence = Number(webResult?.confidence || 0);
      const nextValue = webConfidence >= LOW_CONFIDENCE_THRESHOLD && webValue ? webValue : '';

      if (webResult?.webSearchUsed) {
        summary.aiWebSearchUsed += 1;
        aiWebSearchIpnSet.add(candidate.ipn);
        if (aiWebSearchEvents.length < args.sampleLimit) {
          aiWebSearchEvents.push(
            `web_search_used ipn='${candidate.ipn}' record='${candidate.recordKey || candidate.recordId}' field='${candidate.fieldName}' rule='${candidate.ruleType}'`
          );
        }
      }

      if (nextValue && candidate.currentValue === nextValue) {
        continue;
      }

      if (nextValue && candidate.currentValue !== nextValue) {
        if (args.dryRun) {
          continue;
        }
        const writeResult = await patchTableRecords(
          airtableService,
          effectiveListingsTableId,
          [{ id: candidate.recordId, fields: { [candidate.fieldName]: nextValue } }]
        );
        if (writeResult.updatedRecords <= 0 || writeResult.errors.length > 0) {
          if (summary.errors.length < args.sampleLimit) {
            summary.errors.push(`${candidate.ruleType} write failed record='${candidate.recordKey}' field='${candidate.fieldName}'`);
          }
          if (candidate.ruleType === 'VB') {
            summary.vbLowConfidenceLeftBlank += 1;
          } else if (candidate.ruleType === 'V1') {
            summary.v1LowConfidenceLeftBlank = Number(summary.v1LowConfidenceLeftBlank || 0) + 1;
          } else if (candidate.ruleType === 'V2') {
            summary.v2LowConfidenceLeftBlank = Number(summary.v2LowConfidenceLeftBlank || 0) + 1;
          }
          continue;
        }
        if (candidate.ruleType === 'V1') {
          summary.v1FieldsUpdated += 1;
        } else if (candidate.ruleType === 'V2') {
          summary.v2FieldsUpdated += 1;
        } else if (candidate.ruleType === 'VB') {
          summary.vbFieldsUpdated += 1;
        }
        writesDone += 1;
        if (summary.sampleOutputs.length < args.sampleLimit) {
          summary.sampleOutputs.push(
            `[${candidate.ruleType}][web] record='${candidate.recordKey || candidate.recordId}' ipn='${candidate.ipn}' field='${candidate.fieldName}' value='${nextValue}' confidence='${webConfidence.toFixed(2)}'`
          );
        }
        continue;
      }

      if (candidate.ruleType === 'VB') {
        summary.vbLowConfidenceLeftBlank += 1;
      } else if (candidate.ruleType === 'V1') {
        summary.v1LowConfidenceLeftBlank = Number(summary.v1LowConfidenceLeftBlank || 0) + 1;
      } else if (candidate.ruleType === 'V2') {
        summary.v2LowConfidenceLeftBlank = Number(summary.v2LowConfidenceLeftBlank || 0) + 1;
      }
    }
  }

  if (summary.errors.length > args.sampleLimit) {
    summary.errors = summary.errors.slice(0, args.sampleLimit);
  }
  summary.aiWebSearchIpns = Array.from(aiWebSearchIpnSet);
  summary.aiWebSearchEvents = aiWebSearchEvents;
  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: summary,
    message: `Phase 4D completed (${args.dryRun ? 'dry run' : 'write run'}).`
  });
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPhase4BLite(args, progress => {
    const stage = String(progress?.stage || 'running');
    const message = normalizeText(progress?.message);
    if (message) {
      console.log(`[phase4blite:${stage}] ${message}`);
    } else {
      console.log(`[phase4blite:${stage}]`);
    }
  });
  console.log('=== Phase 4B-lite Summary ===');
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Phase 4B-lite failed: ${formatAirtableError(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  runPhase4BLite,
  runPhase4BWritebackOnly,
  runPhase4CMFWritebackOnly,
  runPhase4CMF,
  runPhase4DListing
};

