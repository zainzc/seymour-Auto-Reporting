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

test('one Run ID produces one selector entry using the final processing record', () => {
  const staging = {
    id: 'rec-staging',
    fields: {
      'Run ID': 'QBO-RETRY-RETRY_2-20260915095327-41626',
      'Batch ID': 'QBO-BATCH-20260915095413-41629',
      'Run Type': 'Retry 2',
      'Start Time': '2026-09-15T09:53:27.000Z',
      'Finish Time': '2026-09-15T09:54:13.000Z',
      'Overall Status': 'STAGING_READY',
      'Records Staged': 5201,
      'Records Imported': 5201
    }
  };
  const final = {
    id: 'rec-final',
    fields: {
      'Run ID': 'QBO-RETRY-RETRY_2-20260915095327-41626',
      'Batch ID': 'QBO-BATCH-20260915095413-41629',
      'Run Type': 'Retry 2',
      'Start Time': '2026-09-15T09:54:14.000Z',
      'Finish Time': '2026-09-15T10:39:42.000Z',
      'Overall Status': 'Completed',
      'Records Imported': 463,
      'Duplicates': 7,
      'Errors': 2
    }
  };

  const catalog = buildRunDayCatalog([staging, final], 'America/New_York');

  assert.equal(catalog[0].runs.length, 1);
  assert.deepEqual(catalog[0].runs[0], {
    recordId: 'rec-final',
    runId: 'QBO-RETRY-RETRY_2-20260915095327-41626',
    label: 'Retry 2',
    runType: 'Retry 2',
    retryAttempt: 2,
    isRetry: true,
    startedAt: '2026-09-15T09:54:14.000Z',
    status: 'Completed'
  });
});

test('a staging-only Run ID is not exposed as a selectable execution', () => {
  const catalog = buildRunDayCatalog([{
    id: 'rec-staging-only',
    fields: {
      'Run ID': 'staging-only',
      'Run Type': 'Full',
      'Start Time': '2026-09-15T09:53:27.000Z',
      'Overall Status': 'STAGING_READY',
      'Records Imported': 5201
    }
  }], 'America/New_York');

  assert.deepEqual(catalog, []);
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

test('overview uses final processing fields instead of staging totals for a shared Run ID', async () => {
  const runId = 'QBO-RETRY-RETRY_2-20260915095327-41626';
  const records = [
    {
      id: 'rec-staging',
      fields: {
        'Run ID': runId,
        'Batch ID': 'QBO-BATCH-20260915095413-41629',
        'Run Type': 'Retry 2',
        'Start Time': '2026-09-15T09:53:27.000Z',
        'Finish Time': '2026-09-15T09:54:13.000Z',
        'Overall Status': 'STAGING_READY',
        'Records Staged': 5201,
        'Records Imported': 5201,
        'Duplicates': 0,
        'Errors': 0
      }
    },
    {
      id: 'rec-final',
      fields: {
        'Run ID': runId,
        'Batch ID': 'QBO-BATCH-20260915095413-41629',
        'Run Type': 'Retry 2',
        'Start Time': '2026-09-15T09:54:14.000Z',
        'Finish Time': '2026-09-15T10:39:42.000Z',
        'Overall Status': 'Completed',
        'Records Staged': 463,
        'Records Imported': 463,
        'Duplicates': 7,
        'Errors': 2,
        'Needs Review': 3
      }
    }
  ];
  const auditService = {
    request: async (_method, tablePath) => tablePath.includes('Run%20Logs') ? { records } : { records: [] },
    fetchRecordsByFormula: async () => []
  };
  const stagingService = {
    fetchAllRecords: async table => table === 'Run Locks'
      ? [{ fields: { 'Run ID': runId, Status: 'Released', 'Released At': '2026-09-15T10:39:43.000Z' } }]
      : []
  };

  const result = await getQuickBooksAutomationOverview({
    airtableToken: 'token', auditService, stagingService,
    selectedRunId: runId, includeProcessingBreakdown: false
  });

  assert.equal(result.overview.runDays[0].runs.length, 1);
  assert.equal(result.overview.selectedRun.recordId, 'rec-final');
  assert.equal(result.overview.selectedRun.status, 'Completed');
  assert.equal(result.overview.selectedRun.startedAt, '2026-09-15T09:54:14.000Z');
  assert.equal(result.overview.selectedRun.finishedAt, '2026-09-15T10:39:42.000Z');
  assert.equal(result.overview.selectedRun.durationSeconds, 2728);
  assert.deepEqual(result.overview.latestImportSummary, {
    recordsRead: 0,
    staged: 463,
    imported: 463,
    duplicates: 7,
    errors: 2,
    needsReview: 3
  });
});

test('a completed processing record remains Running while its Run Lock is active', async () => {
  const runId = 'locked-run';
  const auditService = {
    request: async (_method, tablePath) => tablePath.includes('Run%20Logs')
      ? { records: [run(runId, 'Full', '2026-09-15T09:54:14.000Z', 'Completed')] }
      : { records: [] },
    fetchRecordsByFormula: async () => []
  };
  const stagingService = {
    fetchAllRecords: async table => table === 'Run Locks'
      ? [{ fields: { 'Run ID': runId, Status: 'Active', 'Lock Acquisition Time': '2026-09-15T09:54:13.000Z' } }]
      : []
  };

  const result = await getQuickBooksAutomationOverview({
    airtableToken: 'token', auditService, stagingService,
    selectedRunId: runId, includeProcessingBreakdown: false
  });

  assert.equal(result.overview.selectedRun.status, 'Running');
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
