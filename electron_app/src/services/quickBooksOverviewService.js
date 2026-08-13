const AirtableService = require('./airtableService');
const AirtableSchemaService = require('./airtableSchemaService');

const AUDIT_BASE_ID = 'appV4NPQj0k53avOJ';
const STAGING_BASE_ID = 'appBCWdJiujeXGtsy';
const CLICKUP_EXCEPTIONS_LIST_URL = 'https://app.clickup.com/8616856/v/l/6-901113989918-1';

const AUDIT_TABLES = {
  runLogs: 'Run Logs',
  recordProcessingLogs: 'Record Processing Logs',
  errorLogs: 'Error Logs',
  preflightCheckLogs: 'Preflight Check Logs'
};

const STAGING_TABLES = {
  runLocks: 'Run Locks',
  invoiceStaging: 'Invoice Staging',
  receivedPaymentStaging: 'Received Payment Staging',
  returnReceiptStaging: 'Return Receipt Staging',
  creditMemoStaging: 'Credit Memo Staging',
  automationConfiguration: 'Automation Configuration',
  automationRuntimeConfiguration: 'Automation Runtime Configuration'
};

const TRANSACTION_TYPES = [
  { key: 'INVOICE', label: 'Invoices', table: STAGING_TABLES.invoiceStaging },
  { key: 'PAYMENT', label: 'Received Payments', table: STAGING_TABLES.receivedPaymentStaging },
  { key: 'REFUND_RECEIPT', label: 'Refund Receipts', table: STAGING_TABLES.returnReceiptStaging },
  { key: 'CREDIT_MEMO', label: 'Credit Memos', table: STAGING_TABLES.creditMemoStaging }
];

const FIELD_ALIASES = {
  runId: ['Run ID'],
  batchId: ['Batch ID', 'Batch', 'Import Batch ID', 'Source Batch ID'],
  runType: ['Run Type', 'Type', 'Import Type', 'Trigger', 'Trigger Type', 'Run Trigger'],
  finalStatus: ['Overall Status'],
  startTime: ['Start Time', 'Started At', 'Run Started At', 'Started', 'Start Timestamp'],
  finishTime: ['Finish Time', 'Finished At', 'Completed At', 'Run Finished At', 'End Time', 'Ended At'],
  duration: ['Duration', 'Duration Seconds', 'Duration MS', 'Duration Milliseconds', 'Total Duration'],
  stage: ['Last Staging Step'],
  reason: ['Last Staging Error'],
  acquiredAt: ['Lock Acquisition Time', 'Acquired At', 'Locked At', 'Created At', 'Started At'],
  expiresAt: ['Lock Expiration', 'Lock Expires At', 'Expires At', 'Expiration Time'],
  releasedAt: ['Released At', 'Lock Released At', 'Completed At', 'Finished At'],
  lockStatus: ['Status'],
  active: ['Active', 'Is Active', 'Running', 'Is Running', 'Locked'],
  selectedEnvironment: ['Selected Environment', 'Environment', 'Selected Env', 'Active Environment'],
  quickBooksEnvironment: ['QuickBooks Environment', 'QB Environment', 'QBO Environment'],
  timezone: ['timzone'],
  paused: ['Paused', 'Is Paused', 'Automation Paused'],
  preflightStatus: ['Preflight Status', 'Status', 'Result', 'Check Status'],
  preflightTimestamp: ['Preflight Timestamp', 'Timestamp', 'Checked At', 'Created At'],
  sourceChanged: ['RAW Refreshed'],
  googleSheetValidation: ['Google Sheet Validation', 'Google Sheets Validation', 'Sheet Validation Status'],
  tabsValidation: ['Required Tabs Validation', 'Tabs Validation', 'Required Tabs Status'],
  columnsValidation: ['Required Columns Validation', 'Columns Validation', 'Required Columns Status'],
  failureCode: ['Failure Code', 'Error Code', 'Code'],
  preflightReason: ['Failure Reason', 'Failure Reason in Preflight Check Logs table'],
  preflightClickUpTaskLink: ['ClickUp Task Link'],
  transactionType: ['Transaction Type', 'Type', 'Record Type', 'Entity Type', 'Object Type'],
  sourceTab: ['Source Tab'],
  sourceRecordKey: ['Source Record Key'],
  logKey: ['Log Key'],
  sourceTransactionNumber: [
    'Source Transaction Number',
    'Source Transaction #',
    'Transaction Number',
    'Invoice Number',
    'Payment Number',
    'Record Number'
  ],
  processingStatus: ['Processing Status', 'Status', 'Result', 'Outcome', 'Final Status'],
  endingStatus: ['Ending Status'],
  errorCode: ['Error Code', 'Failure Code', 'Code'],
  errorMessage: ['Error Message', 'Message', 'Short Error Message', 'Reason'],
  timestamp: ['Timestamp', 'Created At', 'Error Timestamp', 'Processed At'],
  processedAt: ['Processed At'],
  clickUpUrl: ['ClickUp Task Link'],
  importedCount: ['Records Imported'],
  duplicateCount: ['Duplicates'],
  errorCount: ['Errors'],
  needsReviewCount: ['Needs Review'],
  recordsReadCount: ['Records Read'],
  stagedCount: ['Records Staged'],
  airtableStagingUrl: ['Airtable Staging URL', 'Staging URL', 'Open Airtable Staging URL'],
  runAuditUrl: ['Run Audit URL', 'Audit URL', 'Run Logs URL'],
  errorLogsUrl: ['Error Logs URL', 'Error Log URL', 'Airtable Error Logs URL'],
  clickUpExceptionsUrl: ['ClickUp Exceptions URL', 'ClickUp Exception URL', 'Exceptions URL']
};

const CONFIG_KEY_FIELD_ALIASES = ['Config Key', 'Key', 'Name'];
const CONFIG_VALUE_FIELD_ALIASES = ['Value', 'Config Value'];

function normalizeKey(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeText(value = '') {
  if (Array.isArray(value)) {
    return value.map(item => normalizeText(item)).filter(Boolean).join(', ');
  }
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.name) return normalizeText(value.name);
    if (value.text) return normalizeText(value.text);
    return '';
  }
  return String(value).trim();
}

function normalizeOptionalReason(value = '') {
  const text = normalizeText(value);
  return !text || text === '[]' ? 'No' : text;
}

function buildFieldLookup(record = {}) {
  const fields = record?.fields || {};
  const lookup = new Map();
  Object.keys(fields).forEach(name => {
    lookup.set(normalizeKey(name), name);
  });
  return lookup;
}

function getField(record, aliases = []) {
  const fields = record?.fields || {};
  const lookup = buildFieldLookup(record);
  for (const alias of aliases) {
    const key = normalizeKey(alias);
    if (lookup.has(key)) {
      return fields[lookup.get(key)];
    }
  }
  return undefined;
}

function getText(record, aliases = []) {
  return normalizeText(getField(record, aliases));
}

function getNumber(record, aliases = []) {
  const raw = getField(record, aliases);
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function parseTimestamp(value) {
  const text = normalizeText(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function getRecordTime(record, aliases = []) {
  return parseTimestamp(getField(record, aliases)) || parseTimestamp(record?.createdTime);
}

function getConfigValue(records = [], keys = []) {
  const wanted = new Set((Array.isArray(keys) ? keys : [keys]).map(normalizeKey).filter(Boolean));
  if (wanted.size === 0) return '';
  const match = (Array.isArray(records) ? records : []).find(record => {
    const key = getText(record, CONFIG_KEY_FIELD_ALIASES);
    return wanted.has(normalizeKey(key));
  });
  return match ? getText(match, CONFIG_VALUE_FIELD_ALIASES) : '';
}

function compareByTimeDesc(a, b, aliases = []) {
  const at = Date.parse(getRecordTime(a, aliases) || '') || 0;
  const bt = Date.parse(getRecordTime(b, aliases) || '') || 0;
  return bt - at;
}

function isTruthy(value) {
  const text = normalizeText(value).toLowerCase();
  return value === true || ['true', 'yes', 'y', '1', 'active', 'running', 'locked'].includes(text);
}

function isRetryRun(record) {
  const type = getText(record, FIELD_ALIASES.runType).toLowerCase();
  return /\bretry\b/.test(type) && !/\bfull\b/.test(type);
}

function normalizeStatus(value = '') {
  const text = normalizeText(value).toLowerCase();
  if (!text) return 'Unknown';
  if (['complete', 'completed', 'completed_with_exceptions', 'success', 'succeeded', 'passed'].includes(text)) return 'Completed';
  if (['failed', 'failure', 'error', 'errored'].includes(text)) return 'Failed';
  if (['running', 'in progress', 'active', 'processing'].includes(text)) return 'Running';
  if (['paused', 'pause'].includes(text)) return 'Paused';
  return normalizeText(value);
}

function isCompletedStatus(value = '') {
  return normalizeStatus(value) === 'Completed';
}

function isFailedStatus(value = '') {
  return normalizeStatus(value) === 'Failed';
}

function isActiveLock(record) {
  const status = getText(record, FIELD_ALIASES.lockStatus).toLowerCase();
  if (status === 'active') return true;
  if (status === 'released') return false;
  return false;
}

function recordMatchesIdentity(record, identity = {}) {
  const recordRunId = getText(record, FIELD_ALIASES.runId);

  return Boolean(identity.runId) && recordRunId === identity.runId;
}

function normalizeTransactionType(value = '') {
  const key = normalizeKey(value);
  if (key.includes('invoice')) return 'INVOICE';
  if (key.includes('payment')) return 'PAYMENT';
  if (key.includes('refund') || key.includes('returnreceipt')) return 'REFUND_RECEIPT';
  if (key.includes('creditmemo')) return 'CREDIT_MEMO';
  return '';
}

function classifyProcessingTransactionType(record = {}) {
  return normalizeTransactionType(getText(record, FIELD_ALIASES.transactionType)) ||
    normalizeTransactionType(getText(record, FIELD_ALIASES.sourceTab));
}

function normalizeEndingStatus(value = '') {
  return normalizeText(value).toUpperCase().replace(/[\s-]+/g, '_');
}

function classifyProcessingStatus(value = '') {
  const status = normalizeEndingStatus(value);
  if (!status) return 'unclassified';
  if (['IMPORTED', 'SUCCESS', 'SUCCEEDED', 'COMPLETED'].includes(status)) return 'imported';
  if (['ALREADY_IMPORTED', 'DUPLICATE', 'DUPLICATE_FOUND', 'EXISTS_IN_QUICKBOOKS'].includes(status)) return 'duplicates';
  if (['ERROR', 'FAILED', 'FAILURE', 'IMPORT_FAILED'].includes(status)) return 'errors';
  if (['NEEDS_REVIEW', 'REVIEW_REQUIRED', 'MANUAL_REVIEW'].includes(status)) return 'needsReview';
  if (['RETRY_QUEUED', 'QUEUED_FOR_RETRY', 'RETRY_PENDING'].includes(status)) return 'retryQueued';
  if (['SKIPPED', 'IGNORED', 'NOT_APPLICABLE'].includes(status)) return 'skipped';
  return 'unclassified';
}

function emptyMetrics() {
  return {
    total: 0,
    imported: 0,
    duplicates: 0,
    errors: 0,
    needsReview: 0,
    retryQueued: 0,
    skipped: 0,
    unclassified: 0
  };
}

function aggregateProcessing(records = []) {
  const summary = emptyMetrics();
  const byType = {};
  TRANSACTION_TYPES.forEach(type => {
    byType[type.key] = {
      type: type.key,
      label: type.label,
      ...emptyMetrics()
    };
  });

  records.forEach(record => {
    const typeKey = classifyProcessingTransactionType(record);
    const bucket = typeKey && byType[typeKey] ? byType[typeKey] : null;
    const status = classifyProcessingStatus(getText(record, FIELD_ALIASES.endingStatus));

    summary.total += 1;
    if (bucket) bucket.total += 1;

    if (status !== 'unclassified') {
      summary[status] += 1;
      if (bucket) bucket[status] += 1;
    } else {
      summary.unclassified += 1;
      if (bucket) bucket.unclassified += 1;
    }
  });

  return {
    summary,
    byType: TRANSACTION_TYPES.map(type => byType[type.key])
  };
}

function runIdentity(record) {
  return {
    runId: getText(record, FIELD_ALIASES.runId)
  };
}

function escapeAirtableFormulaString(value = '') {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildRunIdFormula(runId = '') {
  const id = normalizeText(runId);
  return id ? AirtableService.buildEqualsFormula('Run ID', id) : '';
}

function runTimestampMs(record = {}) {
  return Date.parse(getRecordTime(record, FIELD_ALIASES.startTime) || '') || 0;
}

function lockTimestampMs(record = {}) {
  return Date.parse(getRecordTime(record, FIELD_ALIASES.acquiredAt) || '') || 0;
}

function selectLatestFullRunForProcessing(runLogs = []) {
  return (Array.isArray(runLogs) ? runLogs : [])
    .filter(record => getText(record, FIELD_ALIASES.runId))
    .filter(record => !isRetryRun(record))
    .sort((a, b) => runTimestampMs(b) - runTimestampMs(a))[0] || null;
}

function selectLatestRunLockFallback(runLocks = []) {
  return (Array.isArray(runLocks) ? runLocks : [])
    .filter(record => getText(record, FIELD_ALIASES.runId))
    .filter(record => !isRetryRun(record))
    .filter(record => !isActiveLock(record))
    .sort((a, b) => lockTimestampMs(b) - lockTimestampMs(a))[0] || null;
}

function selectProcessingRunIdentity(runLogs = [], runLocks = [], selectedRunId = '') {
  const explicitRunId = normalizeText(selectedRunId);
  if (explicitRunId) {
    return {
      runId: explicitRunId,
      source: 'Manual Selection',
      record: null
    };
  }

  const latestRun = selectLatestFullRunForProcessing(runLogs);
  if (latestRun) {
    return {
      runId: getText(latestRun, FIELD_ALIASES.runId),
      source: 'Run Logs',
      record: latestRun
    };
  }

  const latestLock = selectLatestRunLockFallback(runLocks);
  if (latestLock) {
    return {
      runId: getText(latestLock, FIELD_ALIASES.runId),
      source: 'Run Locks',
      record: latestLock
    };
  }

  return {
    runId: '',
    source: 'Unavailable',
    record: null
  };
}

function processingRecordTimeMs(record = {}) {
  return Date.parse(getRecordTime(record, FIELD_ALIASES.processedAt) || '') ||
    Date.parse(getRecordTime(record, FIELD_ALIASES.timestamp) || '') ||
    Date.parse(record?.createdTime || '') ||
    0;
}

function dedupeProcessingRecords(records = []) {
  const bySourceKey = new Map();
  const passthrough = [];

  (Array.isArray(records) ? records : []).forEach(record => {
    const sourceKey = getText(record, FIELD_ALIASES.sourceRecordKey);
    if (!sourceKey) {
      passthrough.push(record);
      return;
    }

    const current = bySourceKey.get(sourceKey);
    if (!current || processingRecordTimeMs(record) >= processingRecordTimeMs(current)) {
      bySourceKey.set(sourceKey, record);
    }
  });

  return [...bySourceKey.values(), ...passthrough];
}

function logUnclassifiedStatuses(rows = [], runId = '') {
  const counts = {};
  (Array.isArray(rows) ? rows : []).forEach(record => {
    const status = getText(record, FIELD_ALIASES.endingStatus) || '<blank>';
    if (classifyProcessingStatus(status) !== 'unclassified') return;
    counts[status] = (counts[status] || 0) + 1;
  });

  if (Object.keys(counts).length > 0) {
    console.warn(`Unclassified QuickBooks processing statuses for Run ID ${runId}: ${JSON.stringify(counts)}`);
  }

  return counts;
}

async function getProcessingBreakdownForRun(auditService, runId, options = {}) {
  const selectedRunId = normalizeText(runId);
  if (!selectedRunId) {
    return {
      runId: '',
      source: options.source || 'Unavailable',
      status: 'no_run_id',
      message: 'No completed QuickBooks Run ID was found.',
      rows: TRANSACTION_TYPES.map(type => ({ transactionType: type.label, type: type.key, label: type.label, ...emptyMetrics() })),
      recordCount: 0,
      dedupedRecordCount: 0,
      unrecognizedStatuses: {}
    };
  }

  const formula = `AND({Run ID}="${escapeAirtableFormulaString(selectedRunId)}")`;
  const records = await auditService.fetchRecordsByFormula(AUDIT_TABLES.recordProcessingLogs, formula, [], 0);
  const dedupedRecords = dedupeProcessingRecords(records);
  const unrecognizedStatuses = logUnclassifiedStatuses(dedupedRecords, selectedRunId);
  const aggregate = aggregateProcessing(dedupedRecords);
  const rows = aggregate.byType.map(row => ({
    transactionType: row.label,
    ...row
  }));
  const status = dedupedRecords.length > 0 ? 'success' : 'no_records';

  return {
    runId: selectedRunId,
    source: options.source || 'Run Logs',
    status,
    message: status === 'no_records'
      ? `No processing records were found for Run ID: ${selectedRunId}`
      : 'Processing records loaded.',
    rows,
    recordCount: Array.isArray(records) ? records.length : 0,
    dedupedRecordCount: dedupedRecords.length,
    unrecognizedStatuses
  };
}

function durationFromRun(record) {
  const explicit = getNumber(record, FIELD_ALIASES.duration);
  if (explicit !== null) {
    return explicit;
  }
  const start = getRecordTime(record, FIELD_ALIASES.startTime);
  const finish = getRecordTime(record, FIELD_ALIASES.finishTime);
  if (!start || !finish) return null;
  const seconds = Math.round((Date.parse(finish) - Date.parse(start)) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function summarizeRun(record = null) {
  if (!record) return null;
  return {
    runId: getText(record, FIELD_ALIASES.runId) || 'Unavailable',
    batchId: getText(record, FIELD_ALIASES.batchId) || 'Unavailable',
    runType: getText(record, FIELD_ALIASES.runType) || 'Unknown',
    status: normalizeStatus(getText(record, FIELD_ALIASES.finalStatus)),
    startedAt: getRecordTime(record, FIELD_ALIASES.startTime),
    finishedAt: getRecordTime(record, FIELD_ALIASES.finishTime),
    durationSeconds: durationFromRun(record),
    failureStage: getText(record, FIELD_ALIASES.stage) || 'Unavailable',
    failureReason: getText(record, FIELD_ALIASES.reason) || 'Unavailable'
  };
}

function importedCountForRun(processingLogs = [], runRecord = null) {
  if (!runRecord || !Array.isArray(processingLogs)) return null;
  const identity = runIdentity(runRecord);
  if (!identity.runId) return null;
  return processingLogs
    .filter(record => recordMatchesIdentity(record, identity))
    .filter(record => classifyProcessingStatus(getText(record, FIELD_ALIASES.endingStatus)) === 'imported')
    .length;
}

function summarizePreflight(record = null) {
  if (!record) {
    return {
      status: 'Unknown',
      timestamp: null,
      sourceDataChanged: 'Unknown',
      googleSheetValidation: 'Unknown',
      requiredTabsValidation: 'Unknown',
      requiredColumnsValidation: 'Unknown',
      failureCode: '',
      reason: '',
      clickUpTaskLink: 'Unavailable'
    };
  }

  return {
    status: normalizeStatus(getText(record, FIELD_ALIASES.preflightStatus)),
    timestamp: getRecordTime(record, FIELD_ALIASES.preflightTimestamp),
    sourceDataChanged: isTruthy(getField(record, FIELD_ALIASES.sourceChanged)) ? 'Yes' : 'No',
    googleSheetValidation: getText(record, FIELD_ALIASES.googleSheetValidation) || 'Unknown',
    requiredTabsValidation: getText(record, FIELD_ALIASES.tabsValidation) || 'Unknown',
    requiredColumnsValidation: getText(record, FIELD_ALIASES.columnsValidation) || 'Unknown',
    failureCode: getText(record, FIELD_ALIASES.failureCode),
    reason: normalizeOptionalReason(getField(record, FIELD_ALIASES.preflightReason)),
    clickUpTaskLink: getText(record, FIELD_ALIASES.preflightClickUpTaskLink) || 'Unavailable'
  };
}

function sanitizeMessage(value = '') {
  return normalizeText(value).replace(/\s+/g, ' ').slice(0, 220);
}

function isValidExternalUrl(value = '') {
  try {
    const url = new URL(normalizeText(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function choosePreferredView(table = {}) {
  const views = Array.isArray(table?.views) ? table.views : [];
  if (views.length === 0) return null;
  const gridView = views.find(view => normalizeText(view?.name).toLowerCase() === 'grid view');
  return gridView || views[0] || null;
}

function findSchemaTable(tables = [], identifiers = []) {
  const wanted = new Set((Array.isArray(identifiers) ? identifiers : [identifiers]).map(normalizeKey).filter(Boolean));
  if (wanted.size === 0) return null;
  return (Array.isArray(tables) ? tables : []).find(table => (
    wanted.has(normalizeKey(table?.id)) || wanted.has(normalizeKey(table?.name))
  )) || null;
}

function buildAirtableTableUrl(baseId = '', tableId = '', tableName = '', schemaTables = []) {
  const resolvedBaseId = normalizeText(baseId);
  const table = findSchemaTable(schemaTables, [tableId, tableName]);
  const resolvedTableId = normalizeText(table?.id) || normalizeText(tableId);
  if (!resolvedBaseId || !resolvedTableId) return '';

  const view = choosePreferredView(table);
  const viewId = normalizeText(view?.id);
  return viewId
    ? `https://airtable.com/${resolvedBaseId}/${resolvedTableId}/${viewId}?blocks=hide`
    : `https://airtable.com/${resolvedBaseId}/${resolvedTableId}`;
}

function firstConfiguredUrl(records = [], aliases = [], configKeys = []) {
  for (const record of Array.isArray(records) ? records : []) {
    const value = getText(record, aliases);
    if (isValidExternalUrl(value)) return value;
  }

  const configValue = getConfigValue(records, configKeys);
  return isValidExternalUrl(configValue) ? configValue : '';
}

function pickConfiguredLinks(context = {}) {
  const runtimeConfig = Array.isArray(context.runtimeConfig) ? context.runtimeConfig : [];
  const automationConfig = Array.isArray(context.automationConfig) ? context.automationConfig : [];
  const records = Array.isArray(context) ? context : [...runtimeConfig, ...automationConfig];
  const latestWideRecords = Array.isArray(context)
    ? records
    : [
        latestRecord(runtimeConfig, FIELD_ALIASES.timestamp),
        latestRecord(automationConfig, FIELD_ALIASES.timestamp)
      ].filter(Boolean);
  const directUrlRecords = [...latestWideRecords, ...records];

  const auditBaseId = getConfigValue(records, ['airtable.auditBaseId', 'auditBaseId']) || context.auditBaseId || AUDIT_BASE_ID;
  const stagingBaseId = getConfigValue(records, ['airtable.stagingBaseId', 'stagingBaseId']) || context.stagingBaseId || STAGING_BASE_ID;
  const invoiceStagingTableId = getConfigValue(records, ['airtable.invoiceStagingTableId', 'invoiceStagingTableId']);
  const runLogsTableId = getConfigValue(records, ['airtable.runLogsTableId', 'runLogsTableId']);
  const preflightLogsTableId = getConfigValue(records, ['airtable.preflightLogsTableId', 'preflightLogsTableId']);
  const recordProcessingLogsTableId = getConfigValue(records, ['airtable.recordProcessingLogsTableId', 'recordProcessingLogsTableId']);
  const errorLogsTableId = getConfigValue(records, ['airtable.errorLogsTableId', 'errorLogsTableId']);
  const runLocksTableId = getConfigValue(records, ['airtable.runLocksTableId', 'runLocksTableId']);

  const airtableStagingUrl =
    firstConfiguredUrl(directUrlRecords, FIELD_ALIASES.airtableStagingUrl, ['airtable.stagingUrl', 'airtable.invoiceStagingUrl']) ||
    buildAirtableTableUrl(stagingBaseId, invoiceStagingTableId, STAGING_TABLES.invoiceStaging, context.stagingSchema);
  const runAuditUrl =
    firstConfiguredUrl(directUrlRecords, FIELD_ALIASES.runAuditUrl, ['airtable.runAuditUrl', 'airtable.runLogsUrl']) ||
    buildAirtableTableUrl(auditBaseId, runLogsTableId, AUDIT_TABLES.runLogs, context.auditSchema);
  const preflightLogsUrl =
    buildAirtableTableUrl(auditBaseId, preflightLogsTableId, AUDIT_TABLES.preflightCheckLogs, context.auditSchema);
  const recordProcessingLogsUrl =
    buildAirtableTableUrl(auditBaseId, recordProcessingLogsTableId, AUDIT_TABLES.recordProcessingLogs, context.auditSchema);
  const errorLogsUrl =
    firstConfiguredUrl(directUrlRecords, FIELD_ALIASES.errorLogsUrl, ['airtable.errorLogsUrl']) ||
    buildAirtableTableUrl(auditBaseId, errorLogsTableId, AUDIT_TABLES.errorLogs, context.auditSchema);
  const runLocksUrl =
    buildAirtableTableUrl(stagingBaseId, runLocksTableId, STAGING_TABLES.runLocks, context.stagingSchema);
  const clickUpExceptionsUrl = firstConfiguredUrl(
    directUrlRecords,
    FIELD_ALIASES.clickUpExceptionsUrl,
    ['clickup.exceptionsUrl', 'clickup.exceptionUrl', 'clickup.exceptionsListUrl']
  ) || CLICKUP_EXCEPTIONS_LIST_URL;

  const candidates = [
    ['airtableStaging', 'Open Airtable Staging', airtableStagingUrl],
    ['runAudit', 'Open Run Audit', runAuditUrl],
    ['preflightLogs', 'Open Preflight Logs', preflightLogsUrl],
    ['recordProcessingLogs', 'Open Record Processing Logs', recordProcessingLogsUrl],
    ['errorLogs', 'Open Error Logs', errorLogsUrl],
    ['runLocks', 'Open Run Locks', runLocksUrl],
    ['clickUpExceptions', 'Open ClickUp Exceptions', clickUpExceptionsUrl]
  ];
  return candidates
    .filter(([, , url]) => isValidExternalUrl(url))
    .map(([key, label, url]) => ({ key, label, url }));
}

async function fetchTable(service, tableName) {
  return service.fetchAllRecords(tableName, []);
}

async function fetchRecentRecordsSafe(service, tableName, warnings, options = {}) {
  try {
    const params = {};
    const maxRecords = Number(options.maxRecords || 0);
    if (maxRecords > 0) params.maxRecords = maxRecords;
    if (options.sortField) {
      params.sort = [{ field: options.sortField, direction: 'desc' }];
    }
    const data = await service.request('GET', `/${encodeURIComponent(tableName)}`, { params });
    return Array.isArray(data?.records) ? data.records : [];
  } catch (error) {
    warnings.push(`${tableName}: ${AirtableService.getAirtableErrorMessage(error)}`);
    return null;
  }
}

async function fetchRecordsByFormulaSafe(service, tableName, formula, warnings, options = {}) {
  try {
    return await service.fetchRecordsByFormula(
      tableName,
      formula,
      Array.isArray(options.fields) ? options.fields : [],
      Number(options.maxRecords || 0)
    );
  } catch (error) {
    warnings.push(`${tableName}: ${AirtableService.getAirtableErrorMessage(error)}`);
    return null;
  }
}

async function fetchTableSafe(service, tableName, warnings) {
  try {
    return await fetchTable(service, tableName);
  } catch (error) {
    warnings.push(`${tableName}: ${AirtableService.getAirtableErrorMessage(error)}`);
    return null;
  }
}

async function listSchemaSafe(token, baseId, warnings, label) {
  try {
    const schema = new AirtableSchemaService({ token, baseId });
    return await schema.listTables();
  } catch (error) {
    warnings.push(`${label} schema: ${AirtableService.getAirtableErrorMessage(error)}`);
    return [];
  }
}

function schemaSummary(tables = [], expectedNames = []) {
  const byName = new Map((tables || []).map(table => [normalizeKey(table?.name), table]));
  return expectedNames.map(name => {
    const table = byName.get(normalizeKey(name));
    return {
      name,
      id: table?.id || '',
      available: Boolean(table?.id),
      fields: Array.isArray(table?.fields) ? table.fields.map(field => field.name).filter(Boolean) : []
    };
  });
}

function latestRecord(records = [], aliases = []) {
  return [...(records || [])].sort((a, b) => compareByTimeDesc(a, b, aliases))[0] || null;
}

function latestImportSummaryFromRun(record = null) {
  return {
    recordsRead: getNumber(record, FIELD_ALIASES.recordsReadCount) || 0,
    staged: getNumber(record, FIELD_ALIASES.stagedCount) || 0,
    imported: getNumber(record, FIELD_ALIASES.importedCount) || 0,
    duplicates: getNumber(record, FIELD_ALIASES.duplicateCount) || 0,
    errors: getNumber(record, FIELD_ALIASES.errorCount) || 0,
    needsReview: getNumber(record, FIELD_ALIASES.needsReviewCount) || 0
  };
}

function buildRecentErrors(errorRecords = [], processingErrorRecords = []) {
  const fromErrorLogs = errorRecords.map(record => ({
    transactionType: getText(record, FIELD_ALIASES.transactionType) || 'Unknown',
    sourceTransactionNumber: getText(record, FIELD_ALIASES.sourceTransactionNumber) || 'Unavailable',
    errorCode: getText(record, FIELD_ALIASES.errorCode) || 'Unavailable',
    message: sanitizeMessage(getText(record, FIELD_ALIASES.errorMessage) || getText(record, FIELD_ALIASES.reason)),
    failureStage: getText(record, FIELD_ALIASES.stage) || 'Unavailable',
    timestamp: getRecordTime(record, FIELD_ALIASES.timestamp),
    clickUpUrl: isValidExternalUrl(getText(record, FIELD_ALIASES.clickUpUrl))
      ? getText(record, FIELD_ALIASES.clickUpUrl)
      : ''
  }));

  const fromProcessing = processingErrorRecords.map(record => ({
    transactionType: getText(record, FIELD_ALIASES.transactionType) || 'Unknown',
    sourceTransactionNumber: getText(record, FIELD_ALIASES.sourceTransactionNumber) || 'Unavailable',
    errorCode: getText(record, FIELD_ALIASES.errorCode) || 'Unavailable',
    message: sanitizeMessage(getText(record, FIELD_ALIASES.errorMessage) || getText(record, FIELD_ALIASES.reason)),
    failureStage: getText(record, FIELD_ALIASES.stage) || 'Unavailable',
    timestamp: getRecordTime(record, FIELD_ALIASES.timestamp),
    clickUpUrl: ''
  }));

  return [...fromErrorLogs, ...fromProcessing]
    .filter(item => item.message || item.errorCode !== 'Unavailable')
    .sort((a, b) => (Date.parse(b.timestamp || '') || 0) - (Date.parse(a.timestamp || '') || 0));
}

async function getQuickBooksAutomationOverview(options = {}) {
  const token = normalizeText(options.airtableToken || process.env.AIRTABLE_TOKEN);
  const auditBaseId = normalizeText(options.auditBaseId || process.env.QUICKBOOKS_AUDIT_BASE_ID || AUDIT_BASE_ID);
  const stagingBaseId = normalizeText(options.stagingBaseId || process.env.QUICKBOOKS_STAGING_BASE_ID || STAGING_BASE_ID);
  const warnings = [];

  if (!token) {
    return {
      success: false,
      message: 'Airtable token is unavailable.',
      overview: null,
      warnings
    };
  }

  const auditService = options.auditService || new AirtableService({ token, baseId: auditBaseId });
  const stagingService = options.stagingService || new AirtableService({ token, baseId: stagingBaseId });

  const [runLogs, runLocks, runtimeConfig, automationConfig] = await Promise.all([
    fetchRecentRecordsSafe(auditService, AUDIT_TABLES.runLogs, warnings, {
      sortField: 'Start Time',
      maxRecords: 40
    }),
    fetchTableSafe(stagingService, STAGING_TABLES.runLocks, warnings),
    fetchTableSafe(stagingService, STAGING_TABLES.automationRuntimeConfiguration, warnings),
    fetchTableSafe(stagingService, STAGING_TABLES.automationConfiguration, warnings)
  ]);

  const fullRuns = Array.isArray(runLogs)
    ? runLogs.filter(record => !isRetryRun(record)).sort((a, b) => compareByTimeDesc(a, b, FIELD_ALIASES.startTime))
    : [];
  const latestFullRun = selectLatestFullRunForProcessing(runLogs);
  const lastSuccessfulRun = fullRuns.find(record => isCompletedStatus(getText(record, FIELD_ALIASES.finalStatus))) || null;
  const lastFailedRun = fullRuns.find(record => isFailedStatus(getText(record, FIELD_ALIASES.finalStatus))) || null;
  const activeLock = Array.isArray(runLocks) ? runLocks.find(isActiveLock) || null : null;
  const latestRuntimeConfig = latestRecord(runtimeConfig || [], FIELD_ALIASES.timestamp);
  const latestAutomationConfig = latestRecord(automationConfig || [], FIELD_ALIASES.timestamp);
  const selectedEnvironment =
    getConfigValue(runtimeConfig, ['runtime.selectedEnvironment', 'selectedEnvironment']) ||
    getText(latestRuntimeConfig, FIELD_ALIASES.selectedEnvironment) ||
    getText(latestAutomationConfig, FIELD_ALIASES.selectedEnvironment) ||
    'Unknown';
  const quickBooksEnvironment =
    getConfigValue(runtimeConfig, ['quickbooks_environment', 'quickbooks environment', 'qbo_environment']) ||
    getText(latestRuntimeConfig, FIELD_ALIASES.quickBooksEnvironment) ||
    getText(latestAutomationConfig, FIELD_ALIASES.quickBooksEnvironment) ||
    selectedEnvironment;
  const timezone =
    getConfigValue(runtimeConfig, ['timezone', 'timzone']) ||
    getText(latestRuntimeConfig, FIELD_ALIASES.timezone) ||
    getText(latestAutomationConfig, FIELD_ALIASES.timezone) ||
    'Configured timezone unavailable';

  const latestStatus = normalizeStatus(getText(latestFullRun, FIELD_ALIASES.finalStatus));
  const hasValidConfig = Boolean(latestRuntimeConfig || latestAutomationConfig);
  const isPaused = isTruthy(getField(latestRuntimeConfig, FIELD_ALIASES.paused)) || isTruthy(getField(latestAutomationConfig, FIELD_ALIASES.paused));
  const currentStatus = activeLock
    ? 'Running'
    : latestStatus === 'Failed'
      ? 'Failed'
      : isPaused
        ? 'Paused'
        : hasValidConfig
          ? 'Active'
          : 'Unknown';

  const identity = runIdentity(latestFullRun || {});
  const runIdFormula = buildRunIdFormula(identity.runId);
  const [preflightLogsForLatest, errorRecordsForLatest] = runIdFormula
    ? await Promise.all([
        fetchRecordsByFormulaSafe(auditService, AUDIT_TABLES.preflightCheckLogs, runIdFormula, warnings, {
          maxRecords: 20
        }),
        fetchRecordsByFormulaSafe(auditService, AUDIT_TABLES.errorLogs, runIdFormula, warnings, {
          maxRecords: 500
        })
      ])
    : [[], []];
  const preflightForLatest = Array.isArray(preflightLogsForLatest)
    ? preflightLogsForLatest
        .sort((a, b) => compareByTimeDesc(a, b, FIELD_ALIASES.preflightTimestamp))[0] || null
    : null;
  const shouldLoadProcessingBreakdown = options.includeProcessingBreakdown !== false;
  const processingRunIdentity = selectProcessingRunIdentity(runLogs, runLocks, options.selectedRunId);
  let processingBreakdown;
  if (shouldLoadProcessingBreakdown) {
    try {
      processingBreakdown = await getProcessingBreakdownForRun(auditService, processingRunIdentity.runId, {
        source: processingRunIdentity.source
      });
    } catch (error) {
      warnings.push(`${AUDIT_TABLES.recordProcessingLogs}: ${AirtableService.getAirtableErrorMessage(error)}`);
      processingBreakdown = {
        runId: processingRunIdentity.runId || '',
        source: processingRunIdentity.source || 'Unavailable',
        status: 'error',
        message: AirtableService.getAirtableErrorMessage(error),
        rows: TRANSACTION_TYPES.map(type => ({ transactionType: type.label, type: type.key, label: type.label, ...emptyMetrics() })),
        recordCount: 0,
        dedupedRecordCount: 0,
        unrecognizedStatuses: {}
      };
    }
  } else {
    processingBreakdown = {
      runId: processingRunIdentity.runId || '',
      source: processingRunIdentity.source || 'Unavailable',
      status: processingRunIdentity.runId ? 'deferred' : 'no_run_id',
      message: processingRunIdentity.runId
        ? 'Record Processing Logs are loading separately.'
        : 'No completed QuickBooks Run ID was found for transaction processing results.',
      rows: TRANSACTION_TYPES.map(type => ({ transactionType: type.label, type: type.key, label: type.label, ...emptyMetrics() })),
      recordCount: 0,
      dedupedRecordCount: 0,
      unrecognizedStatuses: {}
    };
  }

  const lastSuccessfulSummary = summarizeRun(lastSuccessfulRun);
  if (lastSuccessfulSummary) {
    lastSuccessfulSummary.importedTransactionCount = getNumber(lastSuccessfulRun, FIELD_ALIASES.importedCount) || 0;
  }
  const lastFailedSummary = summarizeRun(lastFailedRun);

  const overview = {
    success: warnings.length === 0,
    generatedAt: new Date().toISOString(),
    timezone,
    bases: {
      audit: { id: auditBaseId, tables: [] },
      staging: { id: stagingBaseId, tables: [] }
    },
    warnings,
    environment: {
      selected: selectedEnvironment || 'Unknown',
      quickBooks: quickBooksEnvironment || 'Unknown'
    },
    currentStatus: {
      status: currentStatus,
      selectedEnvironment: selectedEnvironment || 'Unknown',
      activeRunId: activeLock ? getText(activeLock, FIELD_ALIASES.runId) || 'Unavailable' : '',
      lockAcquiredAt: activeLock ? getRecordTime(activeLock, FIELD_ALIASES.acquiredAt) : null,
      lockExpiresAt: activeLock ? getRecordTime(activeLock, FIELD_ALIASES.expiresAt) : null,
      latestFullRun: summarizeRun(latestFullRun)
    },
    lastSuccessfulImport: lastSuccessfulSummary,
    lastFailedImport: lastFailedSummary,
    latestPreflight: summarizePreflight(preflightForLatest),
    latestImportSummary: latestImportSummaryFromRun(latestFullRun),
    processingBreakdown,
    resultsByTransactionType: processingBreakdown.rows,
    recentErrors: buildRecentErrors(errorRecordsForLatest, []),
    links: pickConfiguredLinks({
      runtimeConfig,
      automationConfig,
      auditSchema: [],
      stagingSchema: [],
      auditBaseId,
      stagingBaseId
    }),
    meta: {
      latestFullRunId: identity.runId || '',
      processingRunId: processingBreakdown.runId || '',
      processingRunSource: processingBreakdown.source || '',
      processingRecordsMatched: processingBreakdown.dedupedRecordCount || 0,
      retryRunsExcluded: Array.isArray(runLogs) ? runLogs.length - fullRuns.length : 0,
      partialData: warnings.length > 0
    }
  };

  const criticalTablesMissing = !Array.isArray(runLogs) && !Array.isArray(runLocks) && !hasValidConfig;
  if (criticalTablesMissing) {
    return {
      success: false,
      message: 'QuickBooks Automation overview could not load required Airtable data.',
      overview,
      warnings
    };
  }

  return {
    success: true,
    message: warnings.length > 0 ? 'QuickBooks Automation overview loaded with partial data.' : 'QuickBooks Automation overview loaded.',
    overview,
    warnings
  };
}

module.exports = {
  AUDIT_BASE_ID,
  STAGING_BASE_ID,
  AUDIT_TABLES,
  STAGING_TABLES,
  TRANSACTION_TYPES,
  getQuickBooksAutomationOverview,
  getProcessingBreakdownForRun,
  selectProcessingRunIdentity,
  selectLatestFullRunForProcessing,
  selectLatestRunLockFallback,
  dedupeProcessingRecords,
  aggregateProcessing,
  recordMatchesIdentity,
  isRetryRun,
  normalizeTransactionType,
  classifyProcessingTransactionType,
  normalizeEndingStatus,
  classifyProcessingStatus,
  escapeAirtableFormulaString
};
