const AirtableService = require('./airtableService');
const ClickUpService = require('./clickupService');
const { readSheetRows } = require('./phase2SheetsService');
const { chunkArray } = require('../utils/chunk');
const {
  validateHeaders,
  buildRowObject,
  normalizeRow
} = require('./phase2ValidationService');
const {
  buildCategoryDefinitionsIndex,
  buildPhase2PlanV2,
  buildTaskKey
} = require('./phase2CategoryResolutionV2Service');
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
      'Category Definitions',
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
      'Category Identifier Selection',
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
    clickupStatusNeedsReview:
      options.clickupStatusNeedsReview ||
      savedConfig.clickupStatusNeedsReview ||
      process.env.CLICKUP_STATUS_NEEDS_REVIEW ||
      'Needs Review',
    categoryLinkFieldName:
      options.categoryLinkFieldName ||
      savedConfig.categoryLinkFieldName ||
      process.env.AIRTABLE_CATEGORY_LINK_FIELD ||
      'Category Definitions',
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

function buildInterchangeKey(row) {
  const interchange = String(row?.interchangeNumber || '').trim();
  if (interchange) return `INTERCHANGE::${interchange.toUpperCase()}`;

  // Fallback keeps behavior stable for rows where interchange is missing.
  const ipn = String(row?.ipn || '').trim();
  return `IPN::${ipn.toUpperCase()}`;
}

function applyGroupedQoh(normalizedRows = []) {
  const qohByInterchange = new Map();

  for (const row of normalizedRows) {
    const key = buildInterchangeKey(row);
    const current = qohByInterchange.get(key) || 0;
    qohByInterchange.set(key, current + (Number(row?.qoh) || 0));
  }

  normalizedRows.forEach(row => {
    const key = buildInterchangeKey(row);
    row.qoh = qohByInterchange.get(key) || 0;
  });
}

function parseIpnPrefixFromIpn(ipn) {
  const firstToken = String(ipn || '').trim().split('-')[0];
  const parsed = parseInt(firstToken, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isExcludedIpn(ipn) {
  const normalized = String(ipn || '').trim().toUpperCase();
  return normalized.startsWith('900') || normalized.startsWith('950') || normalized.startsWith('999');
}

function hasLinkedCategoryValue(fields = {}, linkFieldName = '') {
  const candidates = [linkFieldName, 'Category Definitions', 'Categories']
    .map(item => String(item || '').trim())
    .filter(Boolean);
  for (const fieldName of candidates) {
    const value = fields?.[fieldName];
    if (Array.isArray(value) && value.length > 0) return true;
  }
  return false;
}

function chooseTrackingField(masterFieldNames, name) {
  return masterFieldNames.has(name) ? name : '';
}

function formatDetailedServiceError(error, stage = '') {
  const status = error?.response?.status;
  const payload = error?.response?.data;
  const detail =
    payload?.error?.message ||
    payload?.error?.type ||
    payload?.error ||
    payload?.message ||
    error?.message ||
    'Unknown error';
  const base = status ? `HTTP ${status}: ${detail}` : String(detail);
  return stage ? `${stage} failed: ${base}` : base;
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
    clickupTasksUpdated: 0,
    clickupTasksSkippedExisting: 0,
    deterministicResolved: 0,
    multiCategoryTasksPlanned: 0,
    exceptionTasksPlanned: 0,
    unmappedPrefixes: [],
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
  let values;
  try {
    values = await readSheetRows(config.sheetId, config.tabName, config.authContext);
  } catch (error) {
    throw new Error(formatDetailedServiceError(error, 'read_sheet'));
  }
  const headers = (values[0] || []).map(value => String(value || '').trim());
  const matchedHeaders = validateHeaders(headers);

  summary.totalRows = Math.max(0, values.length - 1);

  emitProgress(progressCallback, { stage: 'normalize_filter', percent: 25, counts: summary });
  const normalizedRows = [];
  const totalSourceRows = Math.max(0, values.length - 1);
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

    if (i === 1 || i % 5000 === 0 || i === values.length - 1) {
      emitProgress(progressCallback, {
        stage: 'normalize_filter',
        percent: 25,
        counts: summary,
        message: `Normalizing rows: ${i}/${totalSourceRows} scanned, valid=${normalizedRows.length}, skippedMissing=${summary.skippedMissingIPN}, skippedExcluded=${summary.skippedExcludedPrefix}`
      });
    }
  }
  applyGroupedQoh(normalizedRows);
  summary.validRows = normalizedRows.length;

  const airtableService = new AirtableService({
    token: config.airtableToken,
    baseId: config.airtableBaseId,
    masterTable: config.airtableMasterTable,
    categoryTable: config.airtableCategoryTable
  });

  emitProgress(progressCallback, { stage: 'load_category_reference', percent: 40, counts: summary });
  let categoryRows;
  try {
    categoryRows = await airtableService.fetchAllRecords(config.airtableCategoryTable);
  } catch (error) {
    throw new Error(formatDetailedServiceError(error, 'load_category_reference'));
  }
  emitProgress(progressCallback, {
    stage: 'load_category_reference',
    percent: 40,
    counts: summary,
    message: `Loaded category definitions: ${categoryRows.length}`
  });
  const categoryIndex = buildCategoryDefinitionsIndex(categoryRows);
  const categoryLinkFieldName = await airtableService.resolveMasterCategoryLinkFieldName(
    config.categoryLinkFieldName || 'Category Definitions'
  );
  const masterFieldNames = await airtableService.getMasterFieldNames();

  emitProgress(progressCallback, { stage: 'load_existing_master_parts', percent: 55, counts: summary });
  const ipns = normalizedRows.map(row => row.ipn);
  let existingRows = [];
  try {
    if (ipns.length > 0) {
      const uniqueIpns = [...new Set(ipns.filter(Boolean))];
      const groups = chunkArray(uniqueIpns, 120);
      let processedGroups = 0;
      for (const group of groups) {
        processedGroups += 1;
        const formula = AirtableService.buildOrFormula('IPN', group);
        let offset = null;
        do {
          const params = { filterByFormula: formula };
          if (offset) params.offset = offset;
          const data = await airtableService.request(
            'GET',
            `/${encodeURIComponent(config.airtableMasterTable)}`,
            { params }
          );
          existingRows.push(...(data.records || []));
          offset = data.offset || null;
        } while (offset);

        if (processedGroups === 1 || processedGroups % 20 === 0 || processedGroups === groups.length) {
          emitProgress(progressCallback, {
            stage: 'load_existing_master_parts',
            percent: 55,
            counts: summary,
            message: `Loading existing master parts: batch ${processedGroups}/${groups.length}, records loaded=${existingRows.length}`
          });
        }
      }
    }
  } catch (error) {
    throw new Error(formatDetailedServiceError(error, 'load_existing_master_parts'));
  }
  const existingMap = new Map(existingRows.map(record => [record.fields?.IPN, record]));

  emitProgress(progressCallback, { stage: 'plan_upserts', percent: 70, counts: summary });
  const taskCache = getInventoryConfig('phase2TaskCache') || {};
  const plan = buildPhase2PlanV2({
    normalizedRows,
    existingMap,
    categoryIndex,
    taskCache,
    categoryLinkFieldName,
    masterFieldNames
  });
  summary.categoryResolved = plan.categoryResolved;
  summary.deterministicResolved = plan.deterministicResolved || 0;
  summary.multiCategoryTasksPlanned = plan.multiCategoryTasksPlanned || 0;
  summary.exceptionTasksPlanned = plan.exceptionTasksPlanned || 0;
  summary.unmappedPrefixes = Array.isArray(plan.unmappedPrefixes) ? plan.unmappedPrefixes : [];

  // Self-healing pass: re-check unresolved Master Parts even if not present in current sheet rows.
  const statusFieldName = chooseTrackingField(masterFieldNames, 'Category Resolution Status');
  const identifierFieldName = chooseTrackingField(masterFieldNames, 'Resolved Category Identifier');
  let allMasterRecords = [];
  try {
    allMasterRecords = await airtableService.fetchAllRecords(config.airtableMasterTable);
  } catch (error) {
    throw new Error(formatDetailedServiceError(error, 'self_healing_scan_master_parts'));
  }
  const knownIpns = new Set(normalizedRows.map(row => String(row.ipn || '').trim().toUpperCase()));

  for (let i = 0; i < allMasterRecords.length; i += 1) {
    const record = allMasterRecords[i];
    const idx = i + 1;
    if (idx === 1 || idx % 5000 === 0 || idx === allMasterRecords.length) {
      emitProgress(progressCallback, {
        stage: 'plan_upserts',
        percent: 70,
        counts: summary,
        message: `Planning upserts: self-healing scan ${idx}/${allMasterRecords.length}, plannedCreates=${plan.creates.length}, plannedUpdates=${plan.updates.length}, plannedTasks=${plan.clickupTasks.length}`
      });
    }
    const fields = record?.fields || {};
    const ipn = String(fields.IPN || '').trim();
    if (!ipn) continue;
    const ipnUpper = ipn.toUpperCase();
    if (knownIpns.has(ipnUpper)) continue;
    if (isExcludedIpn(ipnUpper)) continue;
    if (hasLinkedCategoryValue(fields, categoryLinkFieldName)) continue;
    if (statusFieldName && String(fields[statusFieldName] || '').trim().toLowerCase() === 'resolved') {
      continue;
    }

    const storedPrefix = parseInt(String(fields['IPN Prefix'] || '').trim(), 10);
    const ipnPrefix = Number.isFinite(storedPrefix) ? storedPrefix : parseIpnPrefixFromIpn(ipn);
    if (!Number.isFinite(ipnPrefix)) continue;
    const candidates = categoryIndex.get(String(ipnPrefix)) || [];

    if (candidates.length === 1) {
      const setFields = {
        [categoryLinkFieldName]: [candidates[0].recordId]
      };
      if (statusFieldName) setFields[statusFieldName] = 'Resolved';
      if (identifierFieldName && candidates[0].identifier) {
        setFields[identifierFieldName] = candidates[0].identifier;
      }
      plan.updates.push({
        id: record.id,
        fields: setFields
      });
      summary.deterministicResolved += 1;
      summary.categoryResolved += 1;
      continue;
    }

    const taskType = candidates.length > 1 ? 'multi' : 'exception';
    const taskReason = candidates.length > 1 ? 'multiple_category_definitions' : 'no_match';
    const taskKey = buildTaskKey(ipnUpper, taskType);
    const alreadyQueued = plan.clickupTasks.some(
      task => buildTaskKey(task.ipn, task.type) === taskKey
    );
    if (alreadyQueued) continue;

    const validOptions =
      taskType === 'multi'
        ? [...new Set(candidates.map(item => String(item.identifier || '').trim()).filter(Boolean))]
        : [];

    plan.clickupTasks.push({
      taskKey,
      ipn,
      ipnPrefix,
      masterRecordId: record.id,
      categoryCode: '',
      conditionsAndOptions: '',
      partType: '',
      modelYear: '',
      modelName: '',
      locationCode: '',
      stockTicketNumber: '',
      referenceNumber: '',
      type: taskType,
      reason: taskReason,
      validOptions
    });

    if (taskType === 'multi') summary.multiCategoryTasksPlanned += 1;
    else {
      summary.exceptionTasksPlanned += 1;
      if (!summary.unmappedPrefixes.includes(String(ipnPrefix))) {
        summary.unmappedPrefixes.push(String(ipnPrefix));
      }
    }

    if (statusFieldName) {
      plan.updates.push({
        id: record.id,
        fields: {
          [statusFieldName]: taskType === 'multi' ? 'Unresolved' : 'Exception'
        }
      });
    }

  }

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
    let createResult;
    try {
      createResult = await airtableService.createMasterParts(plan.creates, progress => {
        createProcessed = progress.processedRecords;
        emitWriteProgress();
      });
    } catch (error) {
      throw new Error(formatDetailedServiceError(error, 'execute_airtable_writes_create'));
    }
    summary.created = createResult.count || 0;
    if (Array.isArray(createResult.errors) && createResult.errors.length > 0) {
      summary.errors.push(
        ...createResult.errors.map(message => `Airtable create failed: ${message}`)
      );
    }
  }
  if (plan.updates.length > 0) {
    let updateResult;
    try {
      updateResult = await airtableService.updateMasterParts(plan.updates, progress => {
        updateProcessed = progress.processedRecords;
        emitWriteProgress();
      });
    } catch (error) {
      throw new Error(formatDetailedServiceError(error, 'execute_airtable_writes_update'));
    }
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
    let existingOpenTaskMap = new Map();
    const taskIdFieldName = chooseTrackingField(masterFieldNames, 'ClickUp Task ID');
    try {
      existingOpenTaskMap = await clickupService.fetchOpenTaskByKeyMap();
    } catch (error) {
      summary.errors.push(
        `ClickUp dedupe pre-check failed; continuing with local cache only: ${error.message}`
      );
    }

    const totalTasksToProcess = plan.clickupTasks.length;
    let processedTasks = 0;
    for (const task of plan.clickupTasks) {
      const taskKey = buildTaskKey(task.ipn, task.type);

      try {
        const existingTask = existingOpenTaskMap.get(taskKey);
        if (existingTask) {
          const payload = ClickUpService.buildCategoryTaskPayload(task);
          await clickupService.updateTask(existingTask.id, payload);
          summary.clickupTasksUpdated += 1;
          taskCache[taskKey] = {
            updatedAt: new Date().toISOString(),
            ipn: task.ipn,
            type: task.type,
            reason: task.reason
          };

          if (taskIdFieldName) {
            try {
              let masterId = String(task.masterRecordId || '').trim();
              if (!masterId) {
                const master = await airtableService.fetchMasterPartByIpn(task.ipn);
                masterId = String(master?.id || '').trim();
              }
              if (masterId) {
                await airtableService.updateMasterPartFields(masterId, {
                  [taskIdFieldName]: String(existingTask.id || '').trim()
                });
              }
            } catch (taskIdWriteError) {
              summary.errors.push(`ClickUp Task ID update skipped for ${task.ipn}: ${taskIdWriteError.message}`);
            }
          }
          continue;
        }

        const createdTask = await clickupService.createTask(task);
        taskCache[taskKey] = {
          createdAt: new Date().toISOString(),
          ipn: task.ipn,
          type: task.type,
          reason: task.reason
        };
        summary.clickupTasksCreated += 1;
        existingOpenTaskMap.set(taskKey, createdTask || { id: 'created' });

        if (taskIdFieldName) {
          try {
            const createdTaskId = String(createdTask?.id || '').trim();
            if (createdTaskId) {
              let masterId = String(task.masterRecordId || '').trim();
              if (!masterId) {
                const master = await airtableService.fetchMasterPartByIpn(task.ipn);
                masterId = String(master?.id || '').trim();
              }
              if (masterId) {
                await airtableService.updateMasterPartFields(masterId, {
                  [taskIdFieldName]: createdTaskId
                });
              }
            }
          } catch (taskIdWriteError) {
            summary.errors.push(`ClickUp Task ID update skipped for ${task.ipn}: ${taskIdWriteError.message}`);
          }
        }
      } catch (error) {
        const errorMsg = `ClickUp task failed for ${task.ipn}: ${error.message}`;
        summary.errors.push(errorMsg);
      } finally {
        processedTasks += 1;
        if (
          processedTasks === 1 ||
          processedTasks % 100 === 0 ||
          processedTasks === totalTasksToProcess
        ) {
          emitProgress(progressCallback, {
            stage: 'create_clickup_tasks',
            percent: 92,
            counts: summary,
            message: `Processing ClickUp tasks: ${processedTasks}/${totalTasksToProcess}, created=${summary.clickupTasksCreated}, updated=${summary.clickupTasksUpdated}, errors=${summary.errors.length}`
          });
        }
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
