const { loadEnv } = require('../config/loadEnv');
const ClickUpService = require('../services/clickupService');
const AirtableService = require('../services/airtableService');
const ElectronStore = require('electron-store').default;
const path = require('path');

loadEnv();

function normalizeText(value) {
  return String(value || '').trim();
}

function formatHttpError(error) {
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
  return {
    dryRun: !argv.includes('--execute'),
    sampleLimit: Number(
      argv.find(arg => arg.startsWith('--sample-limit='))?.split('=')[1] || 50
    ),
    listId:
      argv.find(arg => arg.startsWith('--list-id='))?.split('=')[1] ||
      process.env.CLICKUP_LIST_ID ||
      '',
    token: process.env.CLICKUP_TOKEN || ''
  };
}

function loadPhase2ConfigFromStore() {
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

function parseEpochMs(value) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return num;
  const parsed = Date.parse(String(value || '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickTaskToKeep(tasks = []) {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  const ranked = [...tasks].sort((a, b) => {
    const aTime = parseEpochMs(a?.date_updated || a?.date_created);
    const bTime = parseEpochMs(b?.date_updated || b?.date_created);
    if (bTime !== aTime) return bTime - aTime;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });
  return ranked[0] || null;
}

function extractMasterRecordIdFromTask(task = {}) {
  const description = String(task?.description || '');
  const match = description.match(/(?:^|\n)\s*MasterRecordID:\s*([^\n\r]+)/i);
  return normalizeText(match?.[1] || '');
}

function parseIpnFromTask(task = {}) {
  return (
    ClickUpService.extractIpnFromTask(task) ||
    ClickUpService.extractCustomFieldText(task, 'IPN')
  );
}

function resolveTaskKey(task) {
  const ipn = parseIpnFromTask(task);
  if (!ipn) return '';
  const type = ClickUpService.extractTaskType(task);
  return ClickUpService.buildTaskIdentityKey(ipn, type);
}

function resolveClosedStatusName(listData = {}, configuredCompleted = '') {
  const statuses = Array.isArray(listData?.statuses) ? listData.statuses : [];
  const normalizedConfigured = normalizeText(configuredCompleted).toLowerCase();

  if (normalizedConfigured) {
    const exact = statuses.find(
      status => normalizeText(status?.status).toLowerCase() === normalizedConfigured
    );
    if (exact?.status) return String(exact.status);
  }

  const closed = statuses.find(
    status => normalizeText(status?.type).toLowerCase() === 'closed'
  );
  if (closed?.status) return String(closed.status);

  const byName = statuses.find(status => {
    const text = normalizeText(status?.status).toLowerCase();
    return text.includes('complete') || text.includes('closed') || text.includes('done');
  });
  if (byName?.status) return String(byName.status);

  return '';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stored = loadPhase2ConfigFromStore();
  const token = normalizeText(args.token || stored.clickupToken);
  const listId = normalizeText(args.listId || stored.clickupListId);
  const configuredCompleted = normalizeText(stored.clickupStatusCompleted || 'Completed');
  const airtableToken = normalizeText(process.env.AIRTABLE_TOKEN || stored.airtableToken);
  const airtableBaseId = normalizeText(process.env.AIRTABLE_BASE_ID || stored.airtableBaseId);
  const airtableMasterTable = normalizeText(stored.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table');

  if (!token || !listId) {
    throw new Error('Missing CLICKUP_TOKEN or CLICKUP_LIST_ID (env or saved Phase2 config).');
  }

  const clickupService = new ClickUpService({ token, listId });
  const listData = await clickupService.getList();
  const closedStatus = resolveClosedStatusName(listData, configuredCompleted);
  if (!closedStatus) {
    throw new Error('Could not resolve a closed/completed status in the ClickUp list.');
  }

  const openTasks = await clickupService.fetchTasksByStatuses([], {
    includeClosed: false,
    subtasks: false,
    maxPages: 200
  });
  const masterByIpn = new Map();
  if (airtableToken && airtableBaseId) {
    const airtableService = new AirtableService({
      token: airtableToken,
      baseId: airtableBaseId,
      masterTable: airtableMasterTable
    });
    let masterRows = [];
    try {
      masterRows = await airtableService.fetchAllRecords(airtableMasterTable, [
        'IPN',
        'ClickUp Task ID'
      ]);
    } catch (error) {
      const status = error?.response?.status;
      if (status !== 422) throw error;
      // Fallback for bases where "ClickUp Task ID" field does not exist or has a different name.
      masterRows = await airtableService.fetchAllRecords(airtableMasterTable, []);
    }
    for (const row of masterRows) {
      const ipn = normalizeText(row?.fields?.IPN).toUpperCase();
      if (!ipn || masterByIpn.has(ipn)) continue;
      masterByIpn.set(ipn, row);
    }
  }

  const groups = new Map();
  for (const task of openTasks) {
    const key = resolveTaskKey(task);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }

  const duplicateGroups = [...groups.entries()].filter(([, tasks]) => tasks.length > 1);
  const tasksToClose = [];
  const sample = [];
  for (const [key, tasks] of duplicateGroups) {
    const ipn = normalizeText(parseIpnFromTask(tasks[0])).toUpperCase();
    const master = masterByIpn.get(ipn) || null;
    const preferredTaskId = normalizeText(master?.fields?.['ClickUp Task ID']);

    let keeper = null;
    let keepReason = 'latest_updated';

    if (preferredTaskId) {
      keeper =
        tasks.find(task => normalizeText(task?.id) === preferredTaskId) ||
        null;
      if (keeper) {
        keepReason = 'master_clickup_task_id';
      }
    }

    if (!keeper && master?.id) {
      keeper =
        tasks.find(task => extractMasterRecordIdFromTask(task) === normalizeText(master.id)) ||
        null;
      if (keeper) {
        keepReason = 'master_record_id_match';
      }
    }

    if (!keeper) {
      keeper = pickTaskToKeep(tasks);
    }

    const close = tasks.filter(task => String(task?.id || '') !== String(keeper?.id || ''));
    close.forEach(task => tasksToClose.push(task));

    if (sample.length < args.sampleLimit) {
      sample.push({
        key,
        ipn,
        totalOpenTasks: tasks.length,
        keepTaskId: String(keeper?.id || ''),
        keepTaskName: String(keeper?.name || ''),
        keepReason,
        closeTaskIds: close.map(task => String(task?.id || ''))
      });
    }
  }

  const summary = {
    dryRun: args.dryRun,
    listId,
    listName: String(listData?.name || ''),
    closedStatusUsed: closedStatus,
    totalOpenTasksScanned: openTasks.length,
    duplicateKeyGroups: duplicateGroups.length,
    tasksMarkedToClose: tasksToClose.length,
    sample
  };

  console.log('=== ClickUp Duplicate Task Cleanup Summary ===');
  console.log(JSON.stringify(summary, null, 2));

  if (args.dryRun) {
    console.log('Dry-run mode: no ClickUp task status updates performed.');
    return;
  }

  if (tasksToClose.length === 0) {
    console.log('No duplicate open tasks to close.');
    return;
  }

  let closedCount = 0;
  for (const task of tasksToClose) {
    const taskId = String(task?.id || '').trim();
    if (!taskId) continue;
    await clickupService.updateTaskStatus(taskId, closedStatus);
    closedCount += 1;
  }
  console.log(`Closed duplicate tasks: ${closedCount}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`ClickUp duplicate cleanup failed: ${formatHttpError(error)}`);
    process.exitCode = 1;
  });
}
