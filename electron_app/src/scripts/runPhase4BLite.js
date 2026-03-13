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

loadEnv();

const LOW_CONFIDENCE_THRESHOLD = 0.75;
const DEFAULT_EBAY_MOCK_TABLE = 'eBay Listings (API) (Mock)';
const EBAY_MOCK_TITLE_FIELD = 'Product Title';
const EBAY_MOCK_CONDITIONS_FIELD = 'Listing Conditions and Options';
const EBAY_MOCK_KEY_FIELDS = [
  'C: partshunter203 ebay MOTORS interchange part number',
  'IPN',
  'IP',
  'InventoryNumber',
  'Inventory Number',
  'SKU',
  'RNumber',
  'Record Key'
];

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeIpn(value) {
  return normalizeText(value).toUpperCase();
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

function isBlankCell(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return normalizeText(value) === '';
  if (Array.isArray(value)) return value.length === 0;
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
    aiTimeoutMs: Math.max(
      5000,
      Number(getArg('--ai-timeout-ms') || process.env.PHASE4B_AI_TIMEOUT_MS || 20000) || 20000
    ),
    aiMaxAttempts: Math.max(
      1,
      Number(getArg('--ai-max-attempts') || process.env.PHASE4B_AI_MAX_ATTEMPTS || 2) || 2
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
    openaiModel: normalizeText(getArg('--openai-model') || process.env.OPENAI_MODEL || 'gpt-4o-mini'),
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

function parseAllowedValues(raw) {
  const text = normalizeText(raw);
  if (!text) return [];
  return text
    .split(/[\n|;,]+/)
    .map(item => normalizeText(item))
    .filter(Boolean);
}

function parseLogicWorksheet(ws, sheetName) {
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

  for (let r = 2; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r).values.slice(1);
    const prefix = normalizeText(row[idxPrefix]);
    const fieldName = normalizeText(row[idxField]);
    const rule = normalizeText(row[idxRule]).toUpperCase();
    if (!prefix && !fieldName && !rule) continue;
    scannedRows += 1;
    if (!['VF', 'VMF'].includes(rule)) continue;
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
  const ebayMockTableName = normalizeText(
    process.env.EBAY_MOCK_TABLE_NAME || stored.ebayMockTableName || DEFAULT_EBAY_MOCK_TABLE
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
      stored.phase4BClickupListId ||
      process.env.CLICKUP_LIST_ID ||
      stored.clickupListId
  );
  const openaiApiKey = normalizeText(args.openaiApiKey || stored.openaiApiKey || '');
  const openaiModel = normalizeText(args.openaiModel || stored.openaiModel || 'gpt-4o-mini');
  const openaiBaseUrl = normalizeText(args.openaiBaseUrl || stored.openaiBaseUrl || '');

  if (!airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (!masterBaseId) throw new Error('Missing AIRTABLE_BASE_ID (Master base).');
  if (!itemSpecificsBaseId) throw new Error('Missing item specifics base ID (AIRTABLE_ITEM_SPECIFICS_BASE_ID).');
  if (!args.rulesDriveFile) throw new Error('Missing rules drive file. Provide --rules-drive-file=<FILE_ID_OR_URL>.');
  if (!openaiApiKey) throw new Error('Missing OpenAI API key for Phase 4B-lite.');
  if (!clickupToken || !clickupListId) throw new Error('Missing ClickUp token/list for VMF low-confidence tasks.');

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
    promptCacheKey: args.promptCacheKey
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
  const clickupService = new ClickUpService({
    token: clickupToken,
    listId: clickupListId
  });

  emitProgress(progressCallback, {
    stage: 'phase4blite_load_master',
    percent: 18,
    message: 'Loading Master Parts records for AI context...'
  });
  const masterRows = await fetchAllRecordsWithFallback(masterService, masterTable, []);
  const masterMap = new Map();
  for (const row of masterRows) {
    const ipn = normalizeIpn(row?.fields?.IPN);
    if (!ipn || masterMap.has(ipn)) continue;
    masterMap.set(ipn, row);
  }

  emitProgress(progressCallback, {
    stage: 'phase4blite_load_master',
    percent: 19,
    message: `Loading eBay mock listing context from '${ebayMockTableName}'...`
  });
  const ebayContextMap = new Map();
  const ebayContextStats = {
    rowsScanned: 0,
    rowsMapped: 0,
    rowsWithoutKey: 0,
    rowsWithoutContext: 0
  };
  try {
    const ebayRows = await fetchAllRecordsWithFallback(masterService, ebayMockTableName, [
      ...EBAY_MOCK_KEY_FIELDS,
      EBAY_MOCK_TITLE_FIELD,
      EBAY_MOCK_CONDITIONS_FIELD
    ]);
    ebayContextStats.rowsScanned = ebayRows.length;
    for (const row of ebayRows) {
      const fields = row?.fields || {};
      const keyRaw = firstNonEmptyField(fields, EBAY_MOCK_KEY_FIELDS);
      const key = normalizeIpn(keyRaw);
      if (!key) {
        ebayContextStats.rowsWithoutKey += 1;
        continue;
      }

      const productTitle = firstNonEmptyField(fields, [EBAY_MOCK_TITLE_FIELD, 'Title', 'Listing Title']);
      const listingConditionsAndOptions = firstNonEmptyField(fields, [
        EBAY_MOCK_CONDITIONS_FIELD,
        'Listing Condition',
        'Listing Conditions'
      ]);
      if (!productTitle && !listingConditionsAndOptions) {
        ebayContextStats.rowsWithoutContext += 1;
        continue;
      }

      const existing = ebayContextMap.get(key) || {};
      ebayContextMap.set(key, {
        productTitle: existing.productTitle || productTitle,
        listingConditionsAndOptions: existing.listingConditionsAndOptions || listingConditionsAndOptions
      });
    }
    ebayContextStats.rowsMapped = ebayContextMap.size;
  } catch (error) {
    // Keep run non-blocking if the mock table is unavailable.
    const message = formatAirtableError(error);
    emitProgress(progressCallback, {
      stage: 'phase4blite_load_master',
      percent: 19,
      message: `eBay mock listing context unavailable: ${message}`
    });
  }

  const tables = await schemaService.listTables();
  const routableTables = tables.filter(table => Boolean(parsePrefixFromTableName(table?.name)));

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
    aiConcurrency: args.aiConcurrency,
    aiTimeoutMs: args.aiTimeoutMs,
    aiMaxAttempts: args.aiMaxAttempts,
    aiCallsPlanned: 0,
    aiCallsCompleted: 0,
    aiCallsFailed: 0,
    ebayContextRowsScanned: ebayContextStats.rowsScanned,
    ebayContextRowsMapped: ebayContextStats.rowsMapped,
    ebayContextRowsWithoutKey: ebayContextStats.rowsWithoutKey,
    ebayContextRowsWithoutContext: ebayContextStats.rowsWithoutContext,
    ebayContextMatchedRows: 0,
    ebayContextMissingRows: 0,
    tablesScanned: 0,
    rowsScanned: 0,
    rowsWithIPN: 0,
    masterPartsMissing: 0,
    vfFieldsEvaluated: 0,
    vfFieldsUpdated: 0,
    vfFieldsLowConfidenceSkipped: 0,
    vfDotNumberSkipped: 0,
    vmfFieldsEvaluated: 0,
    vmfFieldsUpdated: 0,
    vmfLowConfidenceTasksCreated: 0,
    vmfLowConfidenceTasksUpdated: 0,
    vmfLowConfidenceTasksSkippedExisting: 0,
    fieldsMissingInSchema: 0,
    fieldsMissingInSchemaSamples: [],
    writeSamples: [],
    vmfLowConfidenceTaskSamples: [],
    errors: []
  };

  const missingFieldSet = new Set();
  const vmfLowConfidenceTasks = [];

  emitProgress(progressCallback, {
    stage: 'phase4blite_load_rules',
    percent: 14,
    counts: summary,
    message: `Rules parsed: prefixes=${rulesByPrefix.size}, rows=${logicRowsScanned}, aiConcurrency=${args.aiConcurrency}, aiTimeoutMs=${args.aiTimeoutMs}, aiMaxAttempts=${args.aiMaxAttempts}`
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
      summary.rowsWithIPN += 1;

      const master = masterMap.get(ipn);
      if (!master) {
        summary.masterPartsMissing += 1;
        continue;
      }
      const context = extractMasterPartsContext(master.fields || {});
      if (Object.keys(context).length === 0) continue;
      const ebayContext = ebayContextMap.get(ipn) || {};
      if (ebayContextMap.has(ipn)) {
        summary.ebayContextMatchedRows += 1;
      } else {
        summary.ebayContextMissingRows += 1;
      }

      for (const [fieldName, ruleMeta] of applicableRules.entries()) {
        if (!isBlankCell(rowFields[fieldName])) continue;
        const ruleType = normalizeText(ruleMeta?.ruleType).toUpperCase();

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
          listingConditionsAndOptions: normalizeText(ebayContext.listingConditionsAndOptions)
        });
      }
    }

    summary.aiCallsPlanned += evaluationCandidates.length;
    emitProgress(progressCallback, {
      stage: 'phase4blite_scan_tables',
      percent: Math.min(95, 20 + Math.floor(((i + 1) / Math.max(1, routableTables.length)) * 70)),
      counts: summary,
      message: `AI evaluating table ${i + 1}/${routableTables.length}: ${tableName} -> candidates=${evaluationCandidates.length}, concurrency=${args.aiConcurrency}`
    });

    let tableAiCompleted = 0;
    let tableAiFailed = 0;
    let lastAiProgressAt = Date.now();
    await processWithConcurrency(
      evaluationCandidates,
      args.aiConcurrency,
      async candidate => {
        let aiResult = null;
        try {
          aiResult = await aiService.evaluateField({
            ipn: candidate.ipn,
            prefix: candidate.prefix,
            tableName: candidate.tableName,
            fieldName: candidate.fieldName,
            ruleType: candidate.ruleType,
            masterPartsData: candidate.context,
            allowedValues: candidate.allowedValues,
            listingTitle: candidate.listingTitle,
            listingConditionsAndOptions: candidate.listingConditionsAndOptions
          });
          summary.aiCallsCompleted += 1;
          tableAiCompleted += 1;
        } catch (error) {
          summary.aiCallsFailed += 1;
          tableAiFailed += 1;
          summary.errors.push(
            `AI evaluation failed for ${candidate.ipn}/${candidate.fieldName} (${candidate.ruleType}): ${error.message}`
          );
          if (candidate.ruleType === 'VMF') {
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
              confidence: 0,
              candidateValue: '',
              reason: `AI error: ${error.message}`,
              contextSummary: summarizeContext(candidate.context)
            });
          }
          return;
        }

        const candidateValue = normalizeText(aiResult?.value);
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
          return;
        }

        if (candidate.ruleType === 'VF') {
          summary.vfFieldsLowConfidenceSkipped += 1;
          return;
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
          confidence,
          candidateValue,
          reason: normalizeText(aiResult?.reason) || 'low confidence',
          contextSummary: summarizeContext(candidate.context)
        });
      },
      completed => {
        const now = Date.now();
        if (
          completed === 1 ||
          completed % 25 === 0 ||
          completed === evaluationCandidates.length ||
          now - lastAiProgressAt >= 10000
        ) {
          lastAiProgressAt = now;
          const ratio = routableTables.length > 0 ? (i + 1) / routableTables.length : 1;
          emitProgress(progressCallback, {
            stage: 'phase4blite_scan_tables',
            percent: Math.min(95, 20 + Math.floor(ratio * 70)),
            counts: summary,
            message: `AI progress table ${i + 1}/${routableTables.length}: ${tableName} (${completed}/${evaluationCandidates.length}, done=${tableAiCompleted}, failed=${tableAiFailed})`
          });
        }
      }
    );

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
    sampleLimit: args.sampleLimit
  });

  summary.fieldsMissingInSchema = missingFieldSet.size;
  if (missingFieldSet.size > 0) {
    summary.fieldsMissingInSchemaSamples = Array.from(missingFieldSet).slice(0, args.sampleLimit);
  }
  if (summary.errors.length > args.sampleLimit) {
    summary.errors = summary.errors.slice(0, args.sampleLimit);
  }

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: summary,
    message:
      `Phase 4B-lite completed (${args.dryRun ? 'dry run' : 'write run'}). ` +
      `eBayContext rows=${summary.ebayContextRowsScanned}, mapped=${summary.ebayContextRowsMapped}, ` +
      `matched=${summary.ebayContextMatchedRows}, missing=${summary.ebayContextMissingRows}.`
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
  runPhase4BLite
};
