const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../config/loadEnv');
const AirtableService = require('../services/airtableService');
const AirtableSchemaService = require('../services/airtableSchemaService');
const { getInventoryConfig } = require('../config/configStore');

loadEnv();

const DEFAULT_TABLE_NAME = 'eBay Listings (API) (Mock)';
const DEFAULT_BATCH_SIZE = 10;
const PRIMARY_KEY_FIELD = 'Record Key';
const LISTING_CONDITIONS_OPTIONS_FIELD = 'Listing Conditions and Options';
const MOCK_LISTING_CONDITIONS_OPTIONS = ['LH', 'RH', 'Black (BLK)', 'White (WHT)', 'Red (RED)', 'Blue (BLU)'];

function normalizeText(value) {
  return String(value || '').trim();
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

function loadPhaseConfigFromStore() {
  return getInventoryConfig('phase2Config') || {};
}

function parseArgs(argv = []) {
  const getArg = name =>
    argv.find(arg => arg.startsWith(`${name}=`))?.split('=').slice(1).join('=') || '';
  return {
    csvPath: normalizeText(getArg('--csv-path') || ''),
    tableName: normalizeText(getArg('--table-name') || DEFAULT_TABLE_NAME),
    dryRun: !argv.includes('--execute')
  };
}

function sanitizeFieldName(name, index) {
  const base = normalizeText(name) || `Unnamed Column ${index + 1}`;
  return base.slice(0, 255);
}

function buildUniqueHeaderNames(headers = []) {
  const used = new Map();
  return headers.map((header, index) => {
    const base = sanitizeFieldName(header, index);
    const key = base.toLowerCase();
    const count = (used.get(key) || 0) + 1;
    used.set(key, count);
    if (count === 1) return base;
    return `${base} (${count})`.slice(0, 255);
  });
}

function hasFieldName(fieldNames = [], target = '') {
  const normalizedTarget = normalizeText(target).toLowerCase();
  if (!normalizedTarget) return false;
  return fieldNames.some(name => normalizeText(name).toLowerCase() === normalizedTarget);
}

function getMockListingConditionsAndOptions(rowIndex = 0) {
  return MOCK_LISTING_CONDITIONS_OPTIONS[rowIndex % MOCK_LISTING_CONDITIONS_OPTIONS.length];
}

function parseCsvRowsStream(filePath) {
  const MAX_QUEUE_ROWS = 500;
  const RESUME_QUEUE_ROWS = 150;
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  let buffer = '';
  let row = [];
  let cell = '';
  let inQuotes = false;

  const queue = [];
  let done = false;
  let error = null;
  let resolver = null;
  let isPaused = false;

  function pushRow(parsedRow) {
    queue.push(parsedRow);
    if (!isPaused && queue.length >= MAX_QUEUE_ROWS) {
      stream.pause();
      isPaused = true;
    }
    if (resolver) {
      const fn = resolver;
      resolver = null;
      fn();
    }
  }

  function parseChunk(chunk, flush = false) {
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i];
      const next = chunk[i + 1];

      if (inQuotes) {
        if (ch === '"') {
          if (next === '"') {
            cell += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          cell += ch;
        }
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(cell);
        cell = '';
      } else if (ch === '\n') {
        row.push(cell);
        pushRow(row);
        row = [];
        cell = '';
      } else if (ch === '\r') {
        if (next === '\n') {
          // CRLF handled by LF branch
        } else {
          row.push(cell);
          pushRow(row);
          row = [];
          cell = '';
        }
      } else {
        cell += ch;
      }
    }

    if (flush) {
      if (cell.length > 0 || row.length > 0) {
        row.push(cell);
        pushRow(row);
        row = [];
        cell = '';
      }
    }
  }

  stream.on('data', chunk => {
    buffer += chunk;
    parseChunk(buffer);
    buffer = '';
  });

  stream.on('error', err => {
    error = err;
    done = true;
    if (resolver) {
      const fn = resolver;
      resolver = null;
      fn();
    }
  });

  stream.on('end', () => {
    parseChunk('', true);
    done = true;
    if (resolver) {
      const fn = resolver;
      resolver = null;
      fn();
    }
  });

  return {
    async *[Symbol.asyncIterator]() {
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise(resolve => {
            resolver = resolve;
          });
        }
      while (queue.length > 0) {
        yield queue.shift();
        if (isPaused && queue.length <= RESUME_QUEUE_ROWS) {
          stream.resume();
          isPaused = false;
        }
      }
    }
    if (error) throw error;
  }
  };
}

async function ensureTableAndFields(schemaService, tableName, fieldNames = [], dryRun = true) {
  const tables = await schemaService.listTables();
  let table = tables.find(item => normalizeText(item?.name) === tableName);
  const existed = Boolean(table);
  if (!table && !dryRun) {
    table = await schemaService.createTable({
      name: tableName,
      fields: [{ name: PRIMARY_KEY_FIELD, type: 'singleLineText' }]
    });
  }
  if (!table) {
    return {
      tableId: '',
      createdTable: false,
      createdFields: [],
      existingFields: new Set()
    };
  }

  const primaryFieldName = normalizeText(table?.primaryFieldId)
    ? normalizeText(
        (table?.fields || []).find(field => normalizeText(field?.id) === normalizeText(table.primaryFieldId))
          ?.name
      )
    : normalizeText((table?.fields || [])[0]?.name);

  if (!dryRun && existed && primaryFieldName.toLowerCase() !== PRIMARY_KEY_FIELD.toLowerCase()) {
    throw new Error(
      `Table '${tableName}' already exists with primary field '${primaryFieldName || 'unknown'}'. Please recreate it with primary field '${PRIMARY_KEY_FIELD}'.`
    );
  }

  const existingFields = new Set(
    (table?.fields || []).map(field => normalizeText(field?.name)).filter(Boolean)
  );
  const createdFields = [];
  if (!dryRun) {
    for (const fieldName of fieldNames) {
      if (existingFields.has(fieldName)) continue;
      const payload = {
        name: fieldName,
        type: 'multilineText'
      };
      await schemaService.createField(table.id, payload);
      existingFields.add(fieldName);
      createdFields.push(fieldName);
    }
  }

  return {
    tableId: String(table.id || ''),
    createdTable: true,
    createdFields,
    existingFields
  };
}

async function flushBatch(itemService, tableName, records, summary, dryRun) {
  if (records.length === 0) return;
  if (dryRun) {
    summary.recordsPlanned += records.length;
    return;
  }
  const data = await itemService.request('PATCH', `/${encodeURIComponent(tableName)}`, {
    data: {
      records,
      typecast: true,
      performUpsert: {
        fieldsToMergeOn: [PRIMARY_KEY_FIELD]
      }
    }
  });
  const returned = Array.isArray(data?.records) ? data.records : [];
  summary.recordsWritten += returned.length;
}

async function runEbayMockImport(options = {}, progressCallback = () => {}) {
  const args = {
    ...parseArgs([]),
    ...options
  };
  const stored = loadPhaseConfigFromStore();

  const csvPath = normalizeText(args.csvPath || path.resolve(process.cwd(), '..', 'Ebay Listing Example.csv'));
  const tableName = normalizeText(args.tableName || DEFAULT_TABLE_NAME);
  const dryRun = Boolean(args.dryRun);
  const airtableToken = normalizeText(process.env.AIRTABLE_TOKEN || stored.airtableToken);
  const airtableBaseId = normalizeText(process.env.AIRTABLE_BASE_ID || stored.airtableBaseId);

  if (!airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (!airtableBaseId) throw new Error('Missing AIRTABLE_BASE_ID.');
  if (!csvPath) throw new Error('CSV path is required.');
  if (!fs.existsSync(csvPath)) throw new Error(`CSV file not found: ${csvPath}`);

  const summary = {
    dryRun,
    csvPath,
    tableName,
    columnsDetected: 0,
    rowsScanned: 0,
    recordsPlanned: 0,
    recordsWritten: 0,
    tableCreated: false,
    fieldsCreated: 0,
    errors: []
  };

  emitProgress(progressCallback, {
    stage: 'ebaymock_start',
    percent: 5,
    counts: summary,
    message: `Reading CSV header from ${csvPath}`
  });

  const reader = parseCsvRowsStream(csvPath);
  const iterator = reader[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || !Array.isArray(first.value)) {
    throw new Error('CSV appears empty.');
  }
  const rawHeaders = first.value;
  const headerNames = buildUniqueHeaderNames(rawHeaders);
  if (!hasFieldName(headerNames, LISTING_CONDITIONS_OPTIONS_FIELD)) {
    headerNames.push(LISTING_CONDITIONS_OPTIONS_FIELD);
  }
  summary.columnsDetected = headerNames.length;

  const schemaService = new AirtableSchemaService({
    token: airtableToken,
    baseId: airtableBaseId
  });
  const itemService = new AirtableService({
    token: airtableToken,
    baseId: airtableBaseId
  });

  emitProgress(progressCallback, {
    stage: 'ebaymock_prepare_table',
    percent: 15,
    counts: summary,
    message: `Ensuring table '${tableName}' and ${headerNames.length} columns...`
  });

  const ensureResult = await ensureTableAndFields(
    schemaService,
    tableName,
    [PRIMARY_KEY_FIELD, ...headerNames],
    dryRun
  );
  summary.tableCreated = Boolean(ensureResult.tableId);
  summary.fieldsCreated = Array.isArray(ensureResult.createdFields) ? ensureResult.createdFields.length : 0;

  let rowNumber = 1;
  const batch = [];
  const batchRowKeys = new Set();

  async function processRow(values = []) {
    rowNumber += 1;
    summary.rowsScanned += 1;
    const fields = {};
    const rowKey = String(summary.rowsScanned);
    fields[PRIMARY_KEY_FIELD] = rowKey;

    for (let i = 0; i < headerNames.length; i += 1) {
      const fieldName = headerNames[i];
      const rawValue = i < values.length ? values[i] : '';
      fields[fieldName] = String(rawValue || '');
    }
    fields[LISTING_CONDITIONS_OPTIONS_FIELD] = getMockListingConditionsAndOptions(summary.rowsScanned - 1);

    if (batchRowKeys.has(rowKey) && batch.length > 0) {
      await flushBatch(itemService, tableName, batch.splice(0, batch.length), summary, dryRun);
      batchRowKeys.clear();
    }
    batch.push({ fields });
    batchRowKeys.add(rowKey);

    if (batch.length >= DEFAULT_BATCH_SIZE) {
      await flushBatch(itemService, tableName, batch.splice(0, batch.length), summary, dryRun);
      batchRowKeys.clear();
    }
    if (
      summary.rowsScanned === 1 ||
      summary.rowsScanned % 250 === 0
    ) {
      emitProgress(progressCallback, {
        stage: 'ebaymock_import_rows',
        percent: Math.min(95, 20 + Math.floor(summary.rowsScanned / 1000)),
        counts: summary,
        message: `Importing rows... scanned=${summary.rowsScanned}, written=${summary.recordsWritten}, planned=${summary.recordsPlanned}`
      });
    }
  }

  for await (const row of {
    async *[Symbol.asyncIterator]() {
      let next = await iterator.next();
      while (!next.done) {
        yield next.value;
        next = await iterator.next();
      }
    }
  }) {
    try {
      await processRow(row);
    } catch (error) {
      summary.errors.push(`Row ${summary.rowsScanned + 1}: ${formatAirtableError(error)}`);
      if (summary.errors.length >= 50) {
        const sample = summary.errors.slice(0, 3).join(' | ');
        throw new Error(`Import stopped after 50 row errors. Sample: ${sample}`);
      }
    }
  }

  if (batch.length > 0) {
    await flushBatch(itemService, tableName, batch.splice(0, batch.length), summary, dryRun);
    batchRowKeys.clear();
  }

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: summary,
    message: `eBay mock import completed (${dryRun ? 'dry run' : 'write run'}).`
  });
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runEbayMockImport(args, progress => {
    const stage = String(progress?.stage || 'running');
    const message = normalizeText(progress?.message);
    if (message) {
      console.log(`[ebay-mock-import:${stage}] ${message}`);
    } else {
      console.log(`[ebay-mock-import:${stage}]`);
    }
  });
  console.log('=== eBay Mock Import Summary ===');
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`eBay mock import failed: ${formatAirtableError(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  runEbayMockImport
};
