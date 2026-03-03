const { loadEnv } = require('../config/loadEnv');
const { getInventoryConfig } = require('../config/configStore');
const AirtableService = require('../services/airtableService');
const AirtableSchemaService = require('../services/airtableSchemaService');
const oauth2Service = require('../services/oauth2Service');
const { google } = require('googleapis');
const { retryWithBackoff } = require('../utils/retry');

loadEnv();

const DEFAULT_TEMPLATE_INDEX_TABLE = 'eBay Item Specific Templates';
const TEMPLATE_INDEX_NAME_CANDIDATES = [
  'eBay Item Specifics Templates',
  'eBay Item Specific Templates',
  'eBay Item Specific Template'
];
const DEFAULT_REFERENCE_TABLE = '104-Grille';
const DEFAULT_AUTH_CONTEXT = 'inventory';
const MAX_TABLE_NAME_LENGTH = 100;
const MAX_FIELD_NAME_LENGTH = 255;

function getErrorMessage(error) {
  const status = error?.response?.status;
  const payload = error?.response?.data;
  const detail =
    payload?.error?.message ||
    payload?.error?.type ||
    payload?.error ||
    error?.message ||
    'Unknown error';
  return status ? `HTTP ${status}: ${detail}` : String(detail);
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function sanitizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sanitizeTableName(value) {
  const stripped = sanitizeWhitespace(String(value || '').replace(/\.(xlsx|gsheet)$/i, ''));
  const fallback = stripped || 'Unnamed Template';
  return fallback.slice(0, MAX_TABLE_NAME_LENGTH);
}

function sanitizeFieldName(value) {
  const cleaned = sanitizeWhitespace(String(value || '').replace(/[\x00-\x1F\x7F]/g, ''));
  return cleaned.slice(0, MAX_FIELD_NAME_LENGTH);
}

function extractSpreadsheetIdFromText(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  const urlMatch = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/i);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1];
  }

  if (/^[a-zA-Z0-9-_]{20,}$/.test(text)) {
    return text;
  }

  return '';
}

function collectStrings(value, collector) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value.trim()) collector.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectStrings(item, collector));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach(item => collectStrings(item, collector));
  }
}

function firstStringFromValue(value) {
  const strings = [];
  collectStrings(value, strings);
  return strings.length > 0 ? strings[0] : '';
}

function inferTemplateName(fields = {}, spreadsheetId = '') {
  const entries = Object.entries(fields || {});
  const preferred = entries
    .filter(([key]) => normalizeName(key).includes('name'))
    .map(([, value]) => firstStringFromValue(value))
    .find(Boolean);
  if (preferred) return preferred;

  const fallback = entries.map(([, value]) => firstStringFromValue(value)).find(Boolean);
  if (fallback) return fallback;

  return spreadsheetId || 'Unnamed Template';
}

function extractSpreadsheetIdFromFields(fields = {}) {
  const strings = [];
  collectStrings(fields, strings);
  for (const text of strings) {
    const id = extractSpreadsheetIdFromText(text);
    if (id) return id;
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
  const baseId = String(
    overrides.baseId ||
    process.env.AIRTABLE_ITEM_SPECIFICS_BASE_ID ||
      process.env.ITEM_SPECIFICS_BASE_ID ||
      getInventoryConfig('itemSpecificsBaseId') ||
      phase2Config.itemSpecificsBaseId ||
      ''
  ).trim();

  const templateIndexTableName = String(
    overrides.templateIndexTableName ||
    process.env.AIRTABLE_ITEM_SPECIFICS_TEMPLATE_TABLE ||
      getInventoryConfig('itemSpecificsTemplateTable') ||
      DEFAULT_TEMPLATE_INDEX_TABLE
  ).trim();

  const referenceTableName = String(
    overrides.referenceTableName ||
    process.env.AIRTABLE_ITEM_SPECIFICS_REFERENCE_TABLE ||
      getInventoryConfig('itemSpecificsReferenceTable') ||
      DEFAULT_REFERENCE_TABLE
  ).trim();

  const authContext = String(
    overrides.authContext ||
    process.env.ITEM_SPECIFICS_GOOGLE_AUTH_CONTEXT || DEFAULT_AUTH_CONTEXT
  ).trim();

  return {
    token,
    baseId,
    templateIndexTableName,
    referenceTableName,
    authContext
  };
}

function buildIpnFieldCreatePayload(referenceIpnField) {
  const payload = {
    name: 'IPN',
    type: String(referenceIpnField?.type || 'singleLineText')
  };

  if (referenceIpnField?.description) {
    payload.description = String(referenceIpnField.description);
  }

  if (
    referenceIpnField?.options &&
    typeof referenceIpnField.options === 'object' &&
    Object.keys(referenceIpnField.options).length > 0
  ) {
    payload.options = referenceIpnField.options;
  }

  return payload;
}

function buildSingleLineTextFieldPayload(name) {
  return {
    name: sanitizeFieldName(name),
    type: 'singleLineText'
  };
}

function ensureUniqueNames(names = []) {
  const seen = new Set();
  const result = [];
  for (const rawName of names) {
    const name = sanitizeFieldName(rawName);
    if (!name) continue;
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result.sort((a, b) => a.localeCompare(b));
}

async function getSheetsClient(authContext) {
  if (!oauth2Service.isAuthenticated(authContext)) {
    throw new Error(
      `Google auth context '${authContext}' is not connected. Connect Google first in the app.`
    );
  }
  const auth = oauth2Service.getAuthenticatedClient(authContext);
  return google.sheets({ version: 'v4', auth });
}

async function extractAspectFieldsFromTemplate(sheets, spreadsheetId) {
  const response = await retryWithBackoff(
    async () =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Aspects!A:ZZ'
      }),
    {
      maxAttempts: 5,
      baseDelayMs: 500,
      shouldRetry: error => {
        const status = error?.response?.status;
        return status === 429 || (status >= 500 && status <= 599);
      },
      onRetry: ({ attempt, delayMs, error }) => {
        const status = error?.response?.status;
        console.warn(
          `Google Sheets retry attempt ${attempt} after ${delayMs}ms (status: ${status || 'n/a'})`
        );
      }
    }
  );

  const values = Array.isArray(response?.data?.values) ? response.data.values : [];
  if (values.length === 0) {
    throw new Error('Aspects tab is empty or missing.');
  }

  let headerRowIndex = -1;
  let aspectIndex = -1;
  const scanLimit = Math.min(values.length, 12);
  for (let i = 0; i < scanLimit; i += 1) {
    const headers = (values[i] || []).map(value => sanitizeWhitespace(value));
    const idx = headers.findIndex(header => normalizeName(header) === 'aspectname');
    if (idx >= 0) {
      headerRowIndex = i;
      aspectIndex = idx;
      break;
    }
  }

  if (aspectIndex < 0) {
    throw new Error('AspectName column not found in Aspects tab.');
  }

  const aspectNames = [];
  for (let i = headerRowIndex + 1; i < values.length; i += 1) {
    const rawValue = values[i]?.[aspectIndex];
    const aspectName = sanitizeFieldName(rawValue);
    if (!aspectName) continue;
    if (!aspectName.startsWith('C:')) continue;
    aspectNames.push(aspectName);
  }

  return ensureUniqueNames(aspectNames);
}

function mapTablesByName(tables = []) {
  const map = new Map();
  tables.forEach(table => {
    const key = normalizeName(table?.name);
    if (!key) return;
    map.set(key, table);
  });
  return map;
}

function findFieldByName(fields = [], name) {
  const target = normalizeName(name);
  return (fields || []).find(field => normalizeName(field?.name) === target) || null;
}

function resolveTableByNameCandidates(tableMap, names = []) {
  for (const name of names) {
    const key = normalizeName(name);
    if (!key) continue;
    const match = tableMap.get(key);
    if (match) return match;
  }
  return null;
}

function emitProgress(progressCallback, payload = {}) {
  if (typeof progressCallback === 'function') {
    progressCallback({
      at: new Date().toISOString(),
      ...payload
    });
  }
}

async function runItemSpecificTableSync(options = {}, progressCallback = () => {}) {
  const config = buildConfig(options);
  if (!config.token) {
    throw new Error('Missing Airtable token. Set AIRTABLE_TOKEN or save token in app config.');
  }
  if (!config.baseId) {
    throw new Error(
      'Missing Item Specifics base id. Set AIRTABLE_ITEM_SPECIFICS_BASE_ID or inventoryWebhook.itemSpecificsBaseId.'
    );
  }

  const summary = {
    totalTemplatesProcessed: 0,
    tablesCreated: 0,
    tablesSkippedExisting: 0,
    fieldsAddedByTable: {},
    failures: []
  };
  emitProgress(progressCallback, {
    stage: 'start',
    message: `Starting item specific table sync (base=${config.baseId}, indexTable=${config.templateIndexTableName}).`
  });

  const airtableRecordsService = new AirtableService({
    token: config.token,
    baseId: config.baseId
  });
  const airtableSchemaService = new AirtableSchemaService({
    token: config.token,
    baseId: config.baseId
  });
  const sheets = await getSheetsClient(config.authContext);

  emitProgress(progressCallback, {
    stage: 'preflight',
    message: `Preflight: baseId=${config.baseId}, templateTable='${config.templateIndexTableName}', referenceTable='${config.referenceTableName}'.`
  });

  let tables = [];
  try {
    tables = await airtableSchemaService.listTables();
  } catch (error) {
    throw new Error(
      `Failed reading Airtable schema tables for base '${config.baseId}' via meta API: ${getErrorMessage(error)}`
    );
  }
  let tableMap = mapTablesByName(tables);

  const resolvedTemplateTable = resolveTableByNameCandidates(tableMap, [
    config.templateIndexTableName,
    ...TEMPLATE_INDEX_NAME_CANDIDATES
  ]);
  if (!resolvedTemplateTable) {
    const available = tables.map(table => String(table?.name || '')).filter(Boolean).slice(0, 20);
    throw new Error(
      `Template index table not found. Tried '${config.templateIndexTableName}' and known variants. Sample tables in base: ${available.join(', ')}`
    );
  }

  let templateRows = [];
  try {
    // Use table ID to avoid name-matching issues.
    templateRows = await airtableRecordsService.fetchAllRecords(resolvedTemplateTable.id);
  } catch (error) {
    throw new Error(
      `Failed reading template index table '${resolvedTemplateTable.name}' (${resolvedTemplateTable.id}) in base '${config.baseId}': ${getErrorMessage(error)}`
    );
  }
  if (templateRows.length === 0) {
    console.log(`No rows found in '${resolvedTemplateTable.name}'. Nothing to process.`);
    emitProgress(progressCallback, {
      stage: 'completed',
      message: `No rows found in '${resolvedTemplateTable.name}'.`,
      summary
    });
    return summary;
  }

  const referenceTable = tableMap.get(normalizeName(config.referenceTableName));
  if (!referenceTable) {
    throw new Error(`Reference table '${config.referenceTableName}' was not found in target base.`);
  }

  const referenceIpnField = findFieldByName(referenceTable.fields || [], 'IPN');
  if (!referenceIpnField) {
    throw new Error(`Reference table '${config.referenceTableName}' is missing IPN field.`);
  }

  const ipnFieldPayload = buildIpnFieldCreatePayload(referenceIpnField);

  for (const row of templateRows) {
    summary.totalTemplatesProcessed += 1;
    const fields = row?.fields || {};

    try {
      const spreadsheetId = extractSpreadsheetIdFromFields(fields);
      if (!spreadsheetId) {
        throw new Error('Google Sheet ID/URL was not found in template row.');
      }

      const inferredName = inferTemplateName(fields, spreadsheetId);
      const tableName = sanitizeTableName(inferredName);
      if (!tableName) {
        throw new Error('Target table name resolved to empty value.');
      }

      const aspectFields = await extractAspectFieldsFromTemplate(sheets, spreadsheetId);

      let targetTable = tableMap.get(normalizeName(tableName));
      if (!targetTable) {
        const createPayload = {
          name: tableName,
          fields: [
            ipnFieldPayload,
            ...aspectFields.map(name => buildSingleLineTextFieldPayload(name))
          ]
        };

        const createdTable = await airtableSchemaService.createTable(createPayload);
        summary.tablesCreated += 1;
        summary.fieldsAddedByTable[tableName] = createPayload.fields.length;
        console.log(
          `[CREATE] ${tableName}: table created with ${createPayload.fields.length} fields (${aspectFields.length} aspect fields).`
        );
        emitProgress(progressCallback, {
          stage: 'table_created',
          message: `Created table '${tableName}' with ${createPayload.fields.length} fields.`
        });

        tables = await airtableSchemaService.listTables();
        tableMap = mapTablesByName(tables);
        targetTable = tableMap.get(normalizeName(createdTable?.name || tableName));
        continue;
      }

      summary.tablesSkippedExisting += 1;
      const existingFieldNames = new Set(
        (targetTable.fields || []).map(field => normalizeName(field?.name))
      );

      let fieldsAdded = 0;
      if (!existingFieldNames.has(normalizeName('IPN'))) {
        await airtableSchemaService.createField(targetTable.id, ipnFieldPayload);
        fieldsAdded += 1;
        existingFieldNames.add(normalizeName('IPN'));
      }

      for (const aspectName of aspectFields) {
        const key = normalizeName(aspectName);
        if (existingFieldNames.has(key)) continue;
        await airtableSchemaService.createField(
          targetTable.id,
          buildSingleLineTextFieldPayload(aspectName)
        );
        fieldsAdded += 1;
        existingFieldNames.add(key);
      }

      summary.fieldsAddedByTable[tableName] = (summary.fieldsAddedByTable[tableName] || 0) + fieldsAdded;
      console.log(
        `[PATCH] ${tableName}: existing table, added ${fieldsAdded} missing fields.`
      );
      emitProgress(progressCallback, {
        stage: 'table_patched',
        message: `Patched table '${tableName}': added ${fieldsAdded} fields.`
      });

      tables = await airtableSchemaService.listTables();
      tableMap = mapTablesByName(tables);
    } catch (error) {
      const rowLabel =
        inferTemplateName(fields, '') ||
        String(row?.id || `row-${summary.totalTemplatesProcessed}`);
      const message = `${rowLabel}: ${getErrorMessage(error)}`;
      summary.failures.push(message);
      console.error(`[FAIL] ${message}`);
      emitProgress(progressCallback, {
        stage: 'failure',
        message
      });
    }
  }

  console.log('\n=== Item Specific Table Sync Summary ===');
  console.log(`Templates processed: ${summary.totalTemplatesProcessed}`);
  console.log(`Tables created: ${summary.tablesCreated}`);
  console.log(`Tables skipped (already existed): ${summary.tablesSkippedExisting}`);

  const fieldEntries = Object.entries(summary.fieldsAddedByTable);
  if (fieldEntries.length > 0) {
    console.log('Fields added by table:');
    fieldEntries
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([tableName, count]) => {
        console.log(`  - ${tableName}: ${count}`);
      });
  } else {
    console.log('Fields added by table: none');
  }

  if (summary.failures.length > 0) {
    console.log('Failures:');
    summary.failures.forEach(message => console.log(`  - ${message}`));
  } else {
    console.log('Failures: none');
  }

  emitProgress(progressCallback, {
    stage: 'completed',
    message: 'Item specific table sync completed.',
    summary
  });
  return summary;
}

if (require.main === module) {
  runItemSpecificTableSync().catch(error => {
    console.error(`Item specific table sync failed: ${getErrorMessage(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  runItemSpecificTableSync
};
