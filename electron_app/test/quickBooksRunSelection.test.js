const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRunDayCatalog,
  selectOverviewRun,
  getQuickBooksAutomationOverview,
  getProcessingBreakdownForRun
} = require('../src/services/quickBooksOverviewService');

function run(runId, runType, startTime, status = 'Completed') {
  return {
    id: `record-${runId}`,
    fields: {
      'Run ID': runId,
      'Run Type': runType,
      'Start Time': startTime,
      'Overall Status': status
    }
  };
}

test('groups runs by America/New_York business day and orders main before dynamic retries', () => {
  const records = [
    run('retry-2', 'Retry 2', '2026-09-15T06:00:00.000Z'),
    run('main-1', 'Full', '2026-09-15T04:30:00.000Z'),
    run('retry-1', 'Retry', '2026-09-15T05:00:00.000Z'),
    run('previous-day', 'Full', '2026-09-15T03:30:00.000Z')
  ];

  const catalog = buildRunDayCatalog(records, 'America/New_York');

  assert.deepEqual(catalog.map(day => day.date), ['2026-09-15', '2026-09-14']);
  assert.deepEqual(catalog[0].runs.map(item => item.runId), ['main-1', 'retry-1', 'retry-2']);
  assert.deepEqual(catalog[0].runs.map(item => item.label), ['Main Run', 'Retry 1', 'Retry 2']);
});

test('keeps only the latest 30 run-days', () => {
  const records = Array.from({ length: 35 }, (_, index) =>
    run(`run-${index}`, 'Full', new Date(Date.UTC(2026, 8, 1 + index, 16)).toISOString())
  );

  const catalog = buildRunDayCatalog(records, 'America/New_York', 30);

  assert.equal(catalog.length, 30);
  assert.equal(catalog[0].date, '2026-10-05');
  assert.equal(catalog.at(-1).date, '2026-09-06');
});

test('defaults to main for the latest day and otherwise the newest retry', () => {
  const withMain = buildRunDayCatalog([
    run('retry-new', 'Retry 1', '2026-09-15T08:00:00.000Z'),
    run('main', 'Full', '2026-09-15T04:00:00.000Z')
  ], 'America/New_York');
  assert.equal(selectOverviewRun(withMain).runId, 'main');

  const retriesOnly = buildRunDayCatalog([
    run('retry-1', 'Retry 1', '2026-09-15T05:00:00.000Z'),
    run('retry-2', 'Retry 2', '2026-09-15T06:00:00.000Z')
  ], 'America/New_York');
  assert.equal(selectOverviewRun(retriesOnly).runId, 'retry-2');
});

test('retry-only days default by newest timestamp rather than highest retry number', () => {
  const catalog = buildRunDayCatalog([
    run('retry-7-old', 'Retry 7', '2026-09-15T05:00:00.000Z'),
    run('retry-2-new', 'Retry 2', '2026-09-15T08:00:00.000Z')
  ], 'America/New_York');

  assert.equal(selectOverviewRun(catalog).runId, 'retry-2-new');
});

test('honors an exact selected Run ID without falling back to another execution', () => {
  const catalog = buildRunDayCatalog([
    run('main', 'Full', '2026-09-15T04:00:00.000Z'),
    run('retry-1', 'Retry 1', '2026-09-15T05:00:00.000Z')
  ], 'America/New_York');

  assert.equal(selectOverviewRun(catalog, 'retry-1').runId, 'retry-1');
  assert.equal(selectOverviewRun(catalog, 'missing'), null);
});

test('distinguishes retry records that share the same Run ID by Airtable record ID', () => {
  const retry1 = run('shared-run', 'Retry 1', '2026-09-15T05:00:00.000Z');
  const retry2 = run('shared-run', 'Retry 2', '2026-09-15T06:00:00.000Z');
  retry1.id = 'rec-retry-1';
  retry2.id = 'rec-retry-2';

  const catalog = buildRunDayCatalog([retry1, retry2], 'America/New_York');

  assert.deepEqual(catalog[0].runs.map(item => item.recordId), ['rec-retry-1', 'rec-retry-2']);
  assert.equal(selectOverviewRun(catalog, 'rec-retry-2').label, 'Retry 2');
});

test('processing breakdown exposes authoritative totals for the summary cards', async () => {
  const processingRecords = [
    { fields: { 'Run ID': 'shared-run', 'Transaction Type': 'Invoice', 'Ending Status': 'Imported', 'Source Record Key': 'a' } },
    { fields: { 'Run ID': 'shared-run', 'Transaction Type': 'Payment', 'Ending Status': 'Imported', 'Source Record Key': 'b' } },
    { fields: { 'Run ID': 'shared-run', 'Transaction Type': 'Invoice', 'Ending Status': 'Duplicate', 'Source Record Key': 'c' } }
  ];
  const breakdown = await getProcessingBreakdownForRun({
    fetchRecordsByFormula: async () => processingRecords
  }, 'shared-run');

  assert.deepEqual(breakdown.summary, {
    total: 3,
    imported: 2,
    duplicates: 1,
    errors: 0,
    needsReview: 0,
    retryQueued: 0,
    skipped: 0,
    unclassified: 0
  });
});

test('overview scopes preflight, errors, summaries, and metadata to the exact selected retry Run ID', async () => {
  const formulas = [];
  const records = [
    run('main', 'Full', '2026-09-15T04:00:00.000Z'),
    { ...run('retry-1', 'Retry 1', '2026-09-15T05:00:00.000Z'), fields: {
      ...run('retry-1', 'Retry 1', '2026-09-15T05:00:00.000Z').fields,
      'Records Staged': 7,
      'Records Imported': 6,
      'Errors': 1
    } }
  ];
  const auditService = {
    request: async (_method, tablePath) => tablePath.includes('Run%20Logs') ? { records } : { records: [] },
    fetchRecordsByFormula: async (table, formula) => {
      formulas.push({ table, formula });
      return [];
    }
  };
  const stagingService = { fetchAllRecords: async () => [] };

  const result = await getQuickBooksAutomationOverview({
    airtableToken: 'token',
    auditService,
    stagingService,
    selectedRunId: 'retry-1',
    includeProcessingBreakdown: false
  });

  assert.equal(result.overview.selectedRun.runId, 'retry-1');
  assert.equal(result.overview.selectedRun.isRetry, true);
  assert.equal(result.overview.latestImportSummary.staged, 7);
  assert.equal(result.overview.latestImportSummary.imported, 6);
  assert.equal(result.overview.meta.processingRunId, 'retry-1');
  assert.equal(formulas.length, 2);
  assert.equal(formulas.every(entry => entry.formula.includes('retry-1')), true);
});

test('overview stops paging after at least 30 distinct run-days are available', async () => {
  const records = Array.from({ length: 120 }, (_, index) =>
    run(`run-${index}`, 'Full', new Date(Date.UTC(2026, 0, 1 + index, 16)).toISOString())
  ).reverse();
  let requests = 0;
  const auditService = {
    request: async (_method, tablePath, options) => {
      if (!tablePath.includes('Run%20Logs')) return { records: [] };
      requests += 1;
      const start = options.params.offset === 'page-2' ? 100 : 0;
      return { records: records.slice(start, start + 100), offset: start === 0 ? 'page-2' : undefined };
    },
    fetchRecordsByFormula: async () => []
  };

  const result = await getQuickBooksAutomationOverview({
    airtableToken: 'token',
    auditService,
    stagingService: { fetchAllRecords: async () => [] },
    includeProcessingBreakdown: false
  });

  assert.equal(requests, 1);
  assert.equal(result.overview.runDays.length, 30);
});

test('overview keeps paging past 200 dense records until 30 Eastern run-days are available', async () => {
  const dense = Array.from({ length: 200 }, (_, index) =>
    run(`dense-${index}`, `Retry ${index + 1}`, new Date(Date.UTC(2026, 4, 31, 12, index % 60)).toISOString())
  );
  const olderDays = Array.from({ length: 30 }, (_, index) =>
    run(`older-${index}`, 'Full', new Date(Date.UTC(2026, 4, 30 - index, 16)).toISOString())
  );
  const records = [...dense, ...olderDays];
  let requests = 0;
  const auditService = {
    request: async (_method, tablePath, options) => {
      if (!tablePath.includes('Run%20Logs')) return { records: [] };
      const start = options.params.offset ? Number(options.params.offset) : 0;
      requests += 1;
      return { records: records.slice(start, start + 100), offset: start + 100 < records.length ? String(start + 100) : undefined };
    },
    fetchRecordsByFormula: async () => []
  };
  const result = await getQuickBooksAutomationOverview({
    airtableToken: 'token', auditService,
    stagingService: { fetchAllRecords: async () => [] },
    includeProcessingBreakdown: false
  });

  assert.equal(requests, 3);
  assert.equal(result.overview.runDays.length, 30);
});

test('overview completes the thirtieth day before stopping pagination', async () => {
  const firstPage = [
    ...Array.from({ length: 29 }, (_, index) => run(`recent-${index}`, 'Full', new Date(Date.UTC(2026, 5, 30 - index, 16)).toISOString())),
    ...Array.from({ length: 71 }, (_, index) => run(`day-30-first-${index}`, `Retry ${index + 1}`, '2026-06-01T16:00:00.000Z'))
  ];
  const secondPage = [
    run('day-30-final', 'Retry 72', '2026-06-01T15:00:00.000Z'),
    run('day-31', 'Full', '2026-05-31T16:00:00.000Z')
  ];
  let requests = 0;
  const auditService = {
    request: async (_method, tablePath, options) => {
      if (!tablePath.includes('Run%20Logs')) return { records: [] };
      requests += 1;
      return options.params.offset
        ? { records: secondPage }
        : { records: firstPage, offset: 'page-2' };
    },
    fetchRecordsByFormula: async () => []
  };
  const result = await getQuickBooksAutomationOverview({
    airtableToken: 'token', auditService,
    stagingService: { fetchAllRecords: async () => [] },
    includeProcessingBreakdown: false
  });

  assert.equal(requests, 2);
  assert.equal(result.overview.runDays.at(-1).runs.some(item => item.runId === 'day-30-final'), true);
});

test('overview groups run-days in Eastern time even when configuration names another timezone', async () => {
  const auditService = {
    request: async (_method, tablePath) => tablePath.includes('Run%20Logs')
      ? { records: [run('boundary', 'Full', '2026-09-15T04:30:00.000Z')] }
      : { records: [] },
    fetchRecordsByFormula: async () => []
  };
  const stagingService = {
    fetchAllRecords: async table => table === 'Automation Runtime Configuration'
      ? [{ fields: { timzone: 'America/Los_Angeles' } }]
      : []
  };
  const result = await getQuickBooksAutomationOverview({
    airtableToken: 'token', auditService, stagingService, includeProcessingBreakdown: false
  });

  assert.equal(result.overview.runDays[0].date, '2026-09-15');
});
