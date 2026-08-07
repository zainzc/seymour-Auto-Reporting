const assert = require('assert');

const {
  getProcessingBreakdownForRun,
  selectProcessingRunIdentity,
  getQuickBooksAutomationOverview,
  classifyProcessingStatus,
  classifyProcessingTransactionType,
  dedupeProcessingRecords
} = require('../src/services/quickBooksOverviewService');

function record(fields = {}, createdTime = '2026-08-01T00:00:00.000Z', id = '') {
  return {
    id: id || `rec_${Math.random().toString(16).slice(2)}`,
    createdTime,
    fields
  };
}

function rowFor(rows, label) {
  return rows.find(row => row.transactionType === label);
}

async function testLatestNonRetryRunSelectionIgnoresOverallStatus() {
  const selected = selectProcessingRunIdentity([
    record({ 'Run ID': 'FAILED-LATEST', 'Run Type': 'SCHEDULED', 'Overall Status': 'FAILED', 'Start Time': '2026-08-05T10:00:00.000Z' }),
    record({ 'Run ID': 'COMPLETED-OLDER', 'Run Type': 'SCHEDULED', 'Overall Status': 'COMPLETED', 'Start Time': '2026-08-04T10:00:00.000Z' }),
    record({ 'Run ID': 'COMPLETED-LATEST', 'Run Type': 'SCHEDULED', 'Overall Status': 'COMPLETED', 'Start Time': '2026-08-05T09:00:00.000Z' })
  ], []);

  assert.strictEqual(selected.runId, 'FAILED-LATEST');
  assert.strictEqual(selected.source, 'Run Logs');
}

async function testRetryRunsAreExcluded() {
  const selected = selectProcessingRunIdentity([
    record({ 'Run ID': 'RETRY-LATEST', 'Run Type': 'RETRY', 'Overall Status': 'COMPLETED', 'Start Time': '2026-08-05T10:00:00.000Z' }),
    record({ 'Run ID': 'FULL-OLDER', 'Run Type': 'SCHEDULED', 'Overall Status': 'COMPLETED', 'Start Time': '2026-08-04T10:00:00.000Z' })
  ], []);

  assert.strictEqual(selected.runId, 'FULL-OLDER');
}

async function testRunLocksFallback() {
  const selected = selectProcessingRunIdentity([], [
    record({ 'Run ID': 'ACTIVE-LOCK', Status: 'ACTIVE', 'Lock Acquisition Time': '2026-08-05T10:00:00.000Z' }),
    record({ 'Run ID': 'RETRY-LOCK', Status: 'RELEASED', 'Run Type': 'RETRY', 'Lock Acquisition Time': '2026-08-05T09:00:00.000Z' }),
    record({ 'Run ID': 'FALLBACK-LOCK', Status: 'RELEASED', 'Lock Acquisition Time': '2026-08-05T08:00:00.000Z' })
  ]);

  assert.strictEqual(selected.runId, 'FALLBACK-LOCK');
  assert.strictEqual(selected.source, 'Run Locks');
}

async function testManualSelectionWins() {
  const selected = selectProcessingRunIdentity([
    record({ 'Run ID': 'LATEST', 'Overall Status': 'COMPLETED', 'Start Time': '2026-08-05T10:00:00.000Z' })
  ], [], 'HISTORICAL');

  assert.strictEqual(selected.runId, 'HISTORICAL');
  assert.strictEqual(selected.source, 'Manual Selection');
}

async function testTransactionTypeAndStatusNormalization() {
  assert.strictEqual(classifyProcessingTransactionType(record({ 'Transaction Type': 'INVOICES' })), 'INVOICE');
  assert.strictEqual(classifyProcessingTransactionType(record({ 'Transaction Type': 'RECEIVED PAYMENT' })), 'PAYMENT');
  assert.strictEqual(classifyProcessingTransactionType(record({ 'Transaction Type': 'RETURN_RECEIPT' })), 'REFUND_RECEIPT');
  assert.strictEqual(classifyProcessingTransactionType(record({ 'Transaction Type': 'CREDIT MEMOS' })), 'CREDIT_MEMO');
  assert.strictEqual(classifyProcessingTransactionType(record({ 'Source Tab': 'Credit Memo NEW' })), 'CREDIT_MEMO');

  assert.strictEqual(classifyProcessingStatus('Imported'), 'imported');
  assert.strictEqual(classifyProcessingStatus('Already Imported'), 'duplicates');
  assert.strictEqual(classifyProcessingStatus('IMPORT-FAILED'), 'errors');
  assert.strictEqual(classifyProcessingStatus('manual review'), 'needsReview');
  assert.strictEqual(classifyProcessingStatus('queued for retry'), 'retryQueued');
  assert.strictEqual(classifyProcessingStatus('not applicable'), 'skipped');
  assert.strictEqual(classifyProcessingStatus('mystery'), 'unclassified');
}

async function testRunIdOnlyAggregationAndMultipleBatches() {
  let seenFormula = '';
  const service = {
    async fetchRecordsByFormula(tableName, formula, selectFields, maxRecords) {
      seenFormula = formula;
      assert.strictEqual(tableName, 'Record Processing Logs');
      assert.deepStrictEqual(selectFields, []);
      assert.strictEqual(maxRecords, 0);
      return [
        record({ 'Run ID': 'RUN-1', 'Batch ID': 'A', 'Source Record Key': 'INVOICE|1', 'Transaction Type': 'INVOICE', 'Ending Status': 'Imported' }),
        record({ 'Run ID': 'RUN-1', 'Batch ID': 'B', 'Source Record Key': 'INVOICE|2', 'Transaction Type': 'INVOICE', 'Ending Status': 'Error' }),
        record({ 'Run ID': 'RUN-1', 'Batch ID': '', 'Source Record Key': 'PAYMENT|446296|ROW_11', 'Transaction Type': 'PAYMENT', 'Ending Status': 'Duplicate' })
      ];
    }
  };

  const result = await getProcessingBreakdownForRun(service, 'RUN-1');
  assert.strictEqual(seenFormula, 'AND({Run ID}="RUN-1")');
  assert.ok(!seenFormula.includes('Batch ID'));
  assert.strictEqual(rowFor(result.rows, 'Invoices').total, 2);
  assert.strictEqual(rowFor(result.rows, 'Invoices').imported, 1);
  assert.strictEqual(rowFor(result.rows, 'Invoices').errors, 1);
  assert.strictEqual(rowFor(result.rows, 'Received Payments').duplicates, 1);
}

async function testMoreThanOneHundredRecordsAndAllRowsReturned() {
  const records = Array.from({ length: 150 }, (_, index) => record({
    'Run ID': 'RUN-150',
    'Source Record Key': `INVOICE|${index}`,
    'Transaction Type': 'INVOICE',
    'Ending Status': index % 2 === 0 ? 'Imported' : 'Error'
  }));
  const service = {
    async fetchRecordsByFormula() {
      return records;
    }
  };

  const result = await getProcessingBreakdownForRun(service, 'RUN-150');
  assert.strictEqual(result.recordCount, 150);
  assert.strictEqual(result.dedupedRecordCount, 150);
  assert.strictEqual(result.rows.length, 4);
  assert.strictEqual(rowFor(result.rows, 'Invoices').total, 150);
  assert.strictEqual(rowFor(result.rows, 'Credit Memos').total, 0);
}

async function testUnknownStatusAndDeduping() {
  const rows = [
    record({ 'Source Record Key': 'INVOICE|1', 'Transaction Type': 'INVOICE', 'Ending Status': 'Imported', 'Processed At': '2026-08-01T01:00:00.000Z' }),
    record({ 'Source Record Key': 'INVOICE|1', 'Transaction Type': 'INVOICE', 'Ending Status': 'Error', 'Processed At': '2026-08-01T02:00:00.000Z' }),
    record({ 'Source Record Key': 'INVOICE|2', 'Transaction Type': 'INVOICE', 'Ending Status': 'Strange', 'Processed At': '2026-08-01T03:00:00.000Z' }),
    record({ 'Source Record Key': 'PAYMENT|446296|ROW_11', 'Transaction Type': 'PAYMENT', 'Ending Status': 'Imported' }),
    record({ 'Source Record Key': 'PAYMENT|446296|ROW_12', 'Transaction Type': 'PAYMENT', 'Ending Status': 'Imported' })
  ];
  const deduped = dedupeProcessingRecords(rows);
  assert.strictEqual(deduped.length, 4);

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await getProcessingBreakdownForRun({ async fetchRecordsByFormula() { return rows; } }, 'RUN-DEDUPE');
    assert.strictEqual(rowFor(result.rows, 'Invoices').total, 2);
    assert.strictEqual(rowFor(result.rows, 'Invoices').errors, 1);
    assert.strictEqual(rowFor(result.rows, 'Invoices').unclassified, 1);
    assert.strictEqual(rowFor(result.rows, 'Received Payments').total, 2);
    assert.strictEqual(rowFor(result.rows, 'Received Payments').imported, 2);
    assert.deepStrictEqual(result.unrecognizedStatuses, { Strange: 1 });
  } finally {
    console.warn = originalWarn;
  }
}

async function testEmptyProcessingResults() {
  const result = await getProcessingBreakdownForRun({ async fetchRecordsByFormula() { return []; } }, 'RUN-EMPTY');
  assert.strictEqual(result.status, 'no_records');
  assert.strictEqual(result.rows.length, 4);
  assert.ok(result.message.includes('RUN-EMPTY'));
}

async function testNewRunReplacesPreviousRun() {
  const first = selectProcessingRunIdentity([
    record({ 'Run ID': 'RUN-OLD', 'Overall Status': 'COMPLETED', 'Start Time': '2026-08-01T00:00:00.000Z' })
  ], []);
  const second = selectProcessingRunIdentity([
    record({ 'Run ID': 'RUN-OLD', 'Overall Status': 'COMPLETED', 'Start Time': '2026-08-01T00:00:00.000Z' }),
    record({ 'Run ID': 'RUN-NEW', 'Overall Status': 'COMPLETED', 'Start Time': '2026-08-02T00:00:00.000Z' })
  ], []);

  assert.strictEqual(first.runId, 'RUN-OLD');
  assert.strictEqual(second.runId, 'RUN-NEW');
}

async function testOverviewSectionsUseLatestNonRetryRun() {
  const runLogs = [
    record({ 'Run ID': 'RETRY-LATEST', 'Run Type': 'RETRY', 'Overall Status': 'FAILED', 'Start Time': '2026-08-05T10:00:00.000Z' }),
    record({ 'Run ID': 'FULL-LATEST', 'Run Type': 'SCHEDULED', 'Overall Status': 'FAILED', 'Start Time': '2026-08-05T09:00:00.000Z', 'Records Read': 88, 'Records Staged': 12, Duplicates: 2, Errors: 7, 'Needs Review': 3 }),
    record({ 'Run ID': 'FULL-OLDER', 'Run Type': 'SCHEDULED', 'Overall Status': 'COMPLETED', 'Start Time': '2026-08-04T09:00:00.000Z' })
  ];
  const preflightLogs = [
    record({ 'Run ID': 'RETRY-LATEST', 'Preflight Status': 'Failed', 'Preflight Timestamp': '2026-08-05T10:01:00.000Z', 'Failure Reason': 'retry preflight' }),
    record({ 'Run ID': 'FULL-LATEST', 'Preflight Status': 'Failed', 'Preflight Timestamp': '2026-08-05T09:01:00.000Z', 'Failure Reason': 'full preflight' })
  ];
  const auditService = {
    async fetchAllRecords(tableName) {
      if (tableName === 'Run Logs') return runLogs;
      if (tableName === 'Error Logs') return [];
      if (tableName === 'Preflight Check Logs') return preflightLogs;
      return [];
    },
    async fetchRecordsByFormula() {
      return [];
    }
  };
  const stagingService = {
    async fetchAllRecords(tableName) {
      if (tableName === 'Automation Runtime Configuration') {
        return [
          record({ 'Config Key': 'timezone', Value: 'America/New_York' }),
          record({ 'Config Key': 'airtable.stagingBaseId', Value: 'appSTAGING' }),
          record({ 'Config Key': 'airtable.auditBaseId', Value: 'appAUDIT' }),
          record({ 'Config Key': 'airtable.invoiceStagingTableId', Value: 'tblINVOICE' }),
          record({ 'Config Key': 'airtable.runLogsTableId', Value: 'tblRUNLOGS' }),
          record({ 'Config Key': 'airtable.preflightLogsTableId', Value: 'tblPREFLIGHT' }),
          record({ 'Config Key': 'airtable.recordProcessingLogsTableId', Value: 'tblPROCESSING' }),
          record({ 'Config Key': 'airtable.errorLogsTableId', Value: 'tblERRORS' }),
          record({ 'Config Key': 'airtable.runLocksTableId', Value: 'tblLOCKS' })
        ];
      }
      return [];
    }
  };
  const auditSchemaService = {
    async listTables() {
      return [
        { id: 'tblRUNLOGS', name: 'Run Logs', views: [{ id: 'viwRUNS', name: 'Grid view' }] },
        { id: 'tblPREFLIGHT', name: 'Preflight Check Logs', views: [{ id: 'viwPREFLIGHT', name: 'Grid view' }] },
        { id: 'tblPROCESSING', name: 'Record Processing Logs', views: [{ id: 'viwPROCESSING', name: 'Grid view' }] },
        { id: 'tblERRORS', name: 'Error Logs', views: [{ id: 'viwERRORS', name: 'Grid view' }] }
      ];
    }
  };
  const stagingSchemaService = {
    async listTables() {
      return [
        { id: 'tblINVOICE', name: 'Invoice Staging', views: [{ id: 'viwINVOICE', name: 'Grid view' }] },
        { id: 'tblLOCKS', name: 'Run Locks', views: [{ id: 'viwLOCKS', name: 'Grid view' }] }
      ];
    }
  };

  const result = await getQuickBooksAutomationOverview({
    airtableToken: 'token',
    auditService,
    stagingService,
    auditSchemaService,
    stagingSchemaService
  });

  assert.strictEqual(result.overview.currentStatus.latestFullRun.runId, 'FULL-LATEST');
  assert.strictEqual(result.overview.lastFailedImport.runId, 'FULL-LATEST');
  assert.strictEqual(result.overview.latestPreflight.reason, 'full preflight');
  assert.strictEqual(result.overview.latestImportSummary.recordsRead, 88);
  assert.strictEqual(result.overview.latestImportSummary.staged, 12);
  assert.strictEqual(result.overview.latestImportSummary.duplicates, 2);
  assert.strictEqual(result.overview.latestImportSummary.needsReview, 3);
  assert.strictEqual(result.overview.processingBreakdown.runId, 'FULL-LATEST');
  assert.deepStrictEqual(result.overview.links, [
    { key: 'airtableStaging', label: 'Open Airtable Staging', url: 'https://airtable.com/appSTAGING/tblINVOICE/viwINVOICE?blocks=hide' },
    { key: 'runAudit', label: 'Open Run Audit', url: 'https://airtable.com/appAUDIT/tblRUNLOGS/viwRUNS?blocks=hide' },
    { key: 'preflightLogs', label: 'Open Preflight Logs', url: 'https://airtable.com/appAUDIT/tblPREFLIGHT/viwPREFLIGHT?blocks=hide' },
    { key: 'recordProcessingLogs', label: 'Open Record Processing Logs', url: 'https://airtable.com/appAUDIT/tblPROCESSING/viwPROCESSING?blocks=hide' },
    { key: 'errorLogs', label: 'Open Error Logs', url: 'https://airtable.com/appAUDIT/tblERRORS/viwERRORS?blocks=hide' },
    { key: 'runLocks', label: 'Open Run Locks', url: 'https://airtable.com/appSTAGING/tblLOCKS/viwLOCKS?blocks=hide' }
  ]);
}

async function run() {
  const tests = [
    testLatestNonRetryRunSelectionIgnoresOverallStatus,
    testRetryRunsAreExcluded,
    testRunLocksFallback,
    testManualSelectionWins,
    testTransactionTypeAndStatusNormalization,
    testRunIdOnlyAggregationAndMultipleBatches,
    testMoreThanOneHundredRecordsAndAllRowsReturned,
    testUnknownStatusAndDeduping,
    testEmptyProcessingResults,
    testNewRunReplacesPreviousRun,
    testOverviewSectionsUseLatestNonRetryRun
  ];

  for (const test of tests) {
    await test();
    console.log(`PASS ${test.name}`);
  }
}

run().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
