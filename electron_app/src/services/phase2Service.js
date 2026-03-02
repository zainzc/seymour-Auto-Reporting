const AirtableService = require('./airtableService');
const ClickUpService = require('./clickupService');
const { readSheetRows } = require('./phase2SheetsService');
const {
  validateHeaders,
  buildRowObject,
  normalizeRow
} = require('./phase2ValidationService');
const { buildCategoryIndex } = require('./phase2CategoryService');
const { buildPhase2Plan } = require('./phase2PlanningService');
const { getInventoryConfig, saveInventoryConfig } = require('../config/configStore');

function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return defaultValue;
}

function buildPhase2Config(options = {}) {
  const savedConfig = getInventoryConfig('phase2Config') || {};

  return {
    sheetId:
      options.sheetId ||
      savedConfig.sheetId ||
      process.env.GOOGLE_SHEET_ID ||
      getInventoryConfig('spreadsheetId'),
    tabName:
      options.tabName ||
      savedConfig.tabName ||
      process.env.GOOGLE_TAB_NAME ||
      getInventoryConfig('worksheetName'),
    airtableToken: options.airtableToken || savedConfig.airtableToken || process.env.AIRTABLE_TOKEN,
    airtableBaseId: options.airtableBaseId || savedConfig.airtableBaseId || process.env.AIRTABLE_BASE_ID,
    airtableMasterTable:
      options.airtableMasterTable ||
      savedConfig.airtableMasterTable ||
      process.env.AIRTABLE_MASTER_TABLE ||
      'Master Parts Table',
    airtableCategoryTable:
      options.airtableCategoryTable ||
      savedConfig.airtableCategoryTable ||
      process.env.AIRTABLE_CATEGORY_TABLE ||
      'Category Names',
    clickupToken: options.clickupToken || savedConfig.clickupToken || process.env.CLICKUP_TOKEN,
    clickupListId: options.clickupListId || savedConfig.clickupListId || process.env.CLICKUP_LIST_ID,
    phase2WritebackEnabled:
      typeof options.phase2WritebackEnabled !== 'undefined'
        ? parseBoolean(options.phase2WritebackEnabled)
        : parseBoolean(
            savedConfig.phase2WritebackEnabled,
            parseBoolean(process.env.PHASE2_WRITEBACK_ENABLED, false)
          ),
    writebackPollIntervalMinutes:
      Number(options.writebackPollIntervalMinutes) ||
      Number(savedConfig.writebackPollIntervalMinutes) ||
      Number(process.env.WRITEBACK_POLL_INTERVAL_MINUTES) ||
      120,
    clickupResolvedCategoryFieldName:
      options.clickupResolvedCategoryFieldName ||
      savedConfig.clickupResolvedCategoryFieldName ||
      process.env.CLICKUP_RESOLVED_CATEGORY_FIELD_NAME ||
      'Resolved Category',
    clickupStatusDetermined:
      options.clickupStatusDetermined ||
      savedConfig.clickupStatusDetermined ||
      process.env.CLICKUP_STATUS_DETERMINED ||
      'Category Determined',
    clickupStatusCompleted:
      options.clickupStatusCompleted ||
      savedConfig.clickupStatusCompleted ||
      process.env.CLICKUP_STATUS_COMPLETED ||
      'Completed',
    phase2AutoRunEnabled:
      typeof options.phase2AutoRunEnabled !== 'undefined'
        ? parseBoolean(options.phase2AutoRunEnabled)
        : parseBoolean(
            savedConfig.phase2AutoRunEnabled,
            parseBoolean(process.env.PHASE2_AUTORUN_ENABLED, true)
          ),
    phase2AutoRunPollMinutes:
      Number(options.phase2AutoRunPollMinutes) ||
      Number(savedConfig.phase2AutoRunPollMinutes) ||
      Number(process.env.PHASE2_AUTORUN_POLL_MINUTES) ||
      3,
    phase2AutoRunCooldownMinutes:
      Number(options.phase2AutoRunCooldownMinutes) ||
      Number(savedConfig.phase2AutoRunCooldownMinutes) ||
      Number(process.env.PHASE2_AUTORUN_COOLDOWN_MINUTES) ||
      5,
    authContext: 'inventory'
  };
}

function emitProgress(progressCallback, payload) {
  if (typeof progressCallback === 'function') {
    progressCallback(payload);
  }
}

async function runPhase2(options = {}, progressCallback = () => {}) {
  const summary = {
    totalRows: 0,
    validRows: 0,
    skippedMissingIPN: 0,
    skippedExcludedPrefix: 0,
    created: 0,
    updated: 0,
    categoryResolved: 0,
    clickupTasksCreated: 0,
    clickupTasksSkippedExisting: 0,
    errors: []
  };

  const config = buildPhase2Config(options);

  if (!config.sheetId || !config.tabName) {
    throw new Error('Phase 2 source sheet config is missing. Set spreadsheet ID and tab name first.');
  }

  if (!config.airtableToken || !config.airtableBaseId) {
    throw new Error('Airtable config missing. Set AIRTABLE_TOKEN and AIRTABLE_BASE_ID.');
  }

  if (!config.clickupToken || !config.clickupListId) {
    throw new Error('ClickUp config missing. Set CLICKUP_TOKEN and CLICKUP_LIST_ID.');
  }

  const clickupValidation = new ClickUpService({
    token: config.clickupToken,
    listId: config.clickupListId
  });
  await clickupValidation.validateAccess();

  console.log('Phase2 started', {
    sheetId: config.sheetId,
    tabName: config.tabName
  });

  emitProgress(progressCallback, { stage: 'read_sheet', percent: 10, counts: summary });
  const values = await readSheetRows(config.sheetId, config.tabName, config.authContext);
  const headers = (values[0] || []).map(value => String(value || '').trim());
  const matchedHeaders = validateHeaders(headers);

  summary.totalRows = Math.max(0, values.length - 1);

  emitProgress(progressCallback, { stage: 'normalize_filter', percent: 25, counts: summary });
  const normalizedRows = [];
  for (let i = 1; i < values.length; i += 1) {
    const rowObject = buildRowObject(matchedHeaders, values[i] || []);
    const normalized = normalizeRow(rowObject, i + 1);
    if (normalized.skipReason === 'missing_ipn') {
      summary.skippedMissingIPN += 1;
      continue;
    }
    if (normalized.skipReason === 'excluded_prefix') {
      summary.skippedExcludedPrefix += 1;
      continue;
    }
    normalizedRows.push(normalized);
  }
  summary.validRows = normalizedRows.length;

  const airtableService = new AirtableService({
    token: config.airtableToken,
    baseId: config.airtableBaseId,
    masterTable: config.airtableMasterTable,
    categoryTable: config.airtableCategoryTable
  });

  emitProgress(progressCallback, { stage: 'load_category_reference', percent: 40, counts: summary });
  const categoryRows = await airtableService.fetchAllRecords(config.airtableCategoryTable, [
    'Category Name',
    'IPN Prefix',
    'Conditions & Options'
  ]);
  const categoryIndex = buildCategoryIndex(categoryRows);

  emitProgress(progressCallback, { stage: 'load_existing_master_parts', percent: 55, counts: summary });
  const ipns = normalizedRows.map(row => row.ipn);
  const existingRows = ipns.length > 0 ? await airtableService.fetchMasterPartsByIpns(ipns) : [];
  const existingMap = new Map(existingRows.map(record => [record.fields?.IPN, record]));

  emitProgress(progressCallback, { stage: 'plan_upserts', percent: 70, counts: summary });
  const taskCache = getInventoryConfig('phase2TaskCache') || {};
  const plan = buildPhase2Plan({
    normalizedRows,
    existingMap,
    categoryIndex,
    taskCache
  });
  summary.categoryResolved = plan.categoryResolved;

  emitProgress(progressCallback, { stage: 'execute_airtable_writes', percent: 82, counts: summary });
  const totalToWrite = plan.creates.length + plan.updates.length;
  let createProcessed = 0;
  let updateProcessed = 0;
  let lastWriteProgressEmitAt = 0;
  let lastWriteProgressProcessed = -1;

  const emitWriteProgress = (message = null) => {
    const processed = createProcessed + updateProcessed;
    const now = Date.now();
    const shouldEmit =
      message ||
      processed === totalToWrite ||
      processed - lastWriteProgressProcessed >= 200 ||
      now - lastWriteProgressEmitAt >= 3000;
    if (!shouldEmit) return;

    lastWriteProgressEmitAt = now;
    lastWriteProgressProcessed = processed;
    const ratio = totalToWrite > 0 ? processed / totalToWrite : 1;
    const percent = Math.min(91, 82 + Math.floor(ratio * 9));
    emitProgress(progressCallback, {
      stage: 'execute_airtable_writes',
      percent,
      counts: summary,
      message:
        message ||
        `Writing to Airtable: ${processed}/${totalToWrite} records processed`
    });
  };

  emitWriteProgress('Writing to Airtable...');

  if (plan.creates.length > 0) {
    const createResult = await airtableService.createMasterParts(plan.creates, progress => {
      createProcessed = progress.processedRecords;
      emitWriteProgress();
    });
    summary.created = createResult.count || 0;
    if (Array.isArray(createResult.errors) && createResult.errors.length > 0) {
      summary.errors.push(
        ...createResult.errors.map(message => `Airtable create failed: ${message}`)
      );
    }
  }
  if (plan.updates.length > 0) {
    const updateResult = await airtableService.updateMasterParts(plan.updates, progress => {
      updateProcessed = progress.processedRecords;
      emitWriteProgress();
    });
    summary.updated = updateResult.count || 0;
    if (Array.isArray(updateResult.errors) && updateResult.errors.length > 0) {
      summary.errors.push(
        ...updateResult.errors.map(message => `Airtable update failed: ${message}`)
      );
    }
  }

  emitWriteProgress('Airtable write stage completed.');

  emitProgress(progressCallback, { stage: 'create_clickup_tasks', percent: 92, counts: summary });
  if (plan.clickupTasks.length > 0) {
    const clickupService = new ClickUpService({
      token: config.clickupToken,
      listId: config.clickupListId
    });
    let existingOpenTaskIpns = new Set();
    try {
      existingOpenTaskIpns = await clickupService.fetchOpenTaskIpnSet();
    } catch (error) {
      summary.errors.push(
        `ClickUp dedupe pre-check failed; continuing with local cache only: ${error.message}`
      );
    }

    for (const task of plan.clickupTasks) {
      const normalizedTaskIpn = ClickUpService.normalizeIpn(task.ipn);
      if (existingOpenTaskIpns.has(normalizedTaskIpn)) {
        summary.clickupTasksSkippedExisting += 1;
        continue;
      }

      try {
        await clickupService.createTask(task);
        taskCache[task.taskKey] = {
          createdAt: new Date().toISOString(),
          ipn: task.ipn,
          reason: task.reason
        };
        summary.clickupTasksCreated += 1;
        existingOpenTaskIpns.add(normalizedTaskIpn);
      } catch (error) {
        const errorMsg = `ClickUp task failed for ${task.ipn}: ${error.message}`;
        summary.errors.push(errorMsg);
      }
    }

    saveInventoryConfig('phase2TaskCache', taskCache);
  }

  emitProgress(progressCallback, { stage: 'completed', percent: 100, counts: summary });
  console.log('Phase2 completed', summary);
  return summary;
}

module.exports = {
  runPhase2,
  buildPhase2Config
};
