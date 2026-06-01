const cron = require('node-cron');
const { getReportingConfig, saveReportingConfig, getInventoryConfig } = require('../config/configStore');
const oauth2Service = require('./oauth2Service');
const { runWorkOrdersSync, DEFAULT_WORK_ORDERS_SHEET_NAME } = require('./workOrdersGoogleSheetsSync');

let activeJob = null;
let isWorkOrdersSyncRunning = false;
const MAX_SUCCESSFUL_RUNS_IN_HISTORY = 20;

function getCronExpression(frequency) {
  if (frequency === 'every_1_minute') return '* * * * *';
  if (frequency === 'every_3_minutes') return '*/3 * * * *';
  if (frequency === 'every_5_minutes') return '*/5 * * * *';
  throw new Error(`Invalid Work Orders frequency: ${frequency}`);
}

function logWorkOrdersExecution(success, message, summary = null) {
  const logs = getReportingConfig('workOrdersExecutionLogs') || [];
  logs.unshift({
    timestamp: new Date().toISOString(),
    type: 'WorkOrders',
    success,
    message,
    summary: summary || null
  });

  // Keep execution history until we exceed the configured number of
  // successful completed runs, then prune the oldest run history.
  let successfulCompletedRuns = 0;
  let pruneAfterIndex = logs.length;
  for (let i = 0; i < logs.length; i += 1) {
    const log = logs[i];
    const isSuccessfulCompletion = Boolean(
      log?.success && typeof log?.message === 'string' && /completed/i.test(log.message)
    );
    if (!isSuccessfulCompletion) continue;

    successfulCompletedRuns += 1;
    if (successfulCompletedRuns === MAX_SUCCESSFUL_RUNS_IN_HISTORY) {
      pruneAfterIndex = i + 1;
      break;
    }
  }

  if (successfulCompletedRuns >= MAX_SUCCESSFUL_RUNS_IN_HISTORY && logs.length > pruneAfterIndex) {
    logs.splice(pruneAfterIndex);
  }

  saveReportingConfig('workOrdersExecutionLogs', logs);
}

function clearWorkOrdersExecutionLogs() {
  saveReportingConfig('workOrdersExecutionLogs', []);
}

function stopWorkOrdersSchedule() {
  if (activeJob) {
    activeJob.stop();
    activeJob = null;
  }

  const current = getReportingConfig('workOrdersActiveSchedule');
  if (current) {
    saveReportingConfig('workOrdersActiveSchedule', {
      ...current,
      active: false
    });
  }

  console.log('[WorkOrders] Schedule stopped');
}

function startWorkOrdersSchedule(config) {
  stopWorkOrdersSchedule();
  const cronExpression = getCronExpression(config.frequency);

  activeJob = cron.schedule(
    cronExpression,
    async () => {
      await executeWorkOrdersScheduledJob(config);
    },
    {
      scheduled: true,
      timezone: 'America/New_York'
    }
  );

  saveReportingConfig('workOrdersActiveSchedule', {
    ...config,
    active: true,
    cronExpression,
    createdAt: new Date().toISOString()
  });

  console.log(`[WorkOrders] Schedule started: ${cronExpression}`);
  return true;
}

async function executeWorkOrdersScheduledJob(config) {
  if (isWorkOrdersSyncRunning) {
    const message = 'Work Orders sync skipped: previous run still in progress';
    console.log(`[WorkOrders] ${message}`);
    logWorkOrdersExecution(true, message, { skipped: true, reason: 'already_running' });
    return {
      success: true,
      skipped: true,
      message
    };
  }

  isWorkOrdersSyncRunning = true;
  logWorkOrdersExecution(true, 'Work Orders scheduled sync started', {
    trigger: 'schedule',
    startedAt: new Date().toISOString()
  });
  console.log(`[WorkOrders] Scheduled sync started at ${new Date().toISOString()}`);

  if (config.endDate) {
    const endDate = new Date(config.endDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (today > endDate) {
      stopWorkOrdersSchedule();
      const current = getReportingConfig('workOrdersActiveSchedule');
      saveReportingConfig('workOrdersActiveSchedule', {
        ...(current || config),
        active: false
      });
      const message = 'End date reached - Work Orders schedule deactivated';
      logWorkOrdersExecution(false, message);
      isWorkOrdersSyncRunning = false;
      return {
        success: false,
        message
      };
    }
  }

  const isAuthenticated = await oauth2Service.isAuthenticated('reporting');
  if (!isAuthenticated) {
    const message = 'Google authentication expired - please reconnect';
    logWorkOrdersExecution(false, message);
    isWorkOrdersSyncRunning = false;
    return {
      success: false,
      message
    };
  }

  try {
    const authClient = await oauth2Service.getAuthenticatedClient('reporting');
    let driveAuthClient = null;
    try {
      driveAuthClient = await oauth2Service.getAuthenticatedClient('inventory');
    } catch (_) {
      driveAuthClient = authClient;
    }
    const summary = await runWorkOrdersSync({
      authClient,
      driveAuthClient,
      spreadsheetId: config.spreadsheetId,
      sheetName: config.sheetName || DEFAULT_WORK_ORDERS_SHEET_NAME,
      driveFolderId: config.driveFolderId || '',
      driveServiceAccountKeyPath: config.driveServiceAccountKeyPath || '',
      imageUploadFallback: config.imageUploadFallback || '',
      clickupToken:
        config.clickupToken ||
        getReportingConfig('workOrdersClickupToken') ||
        (getInventoryConfig('phase2Config') || {}).clickupToken ||
        process.env.CLICKUP_TOKEN ||
        '',
      clickupListId:
        config.clickupListId ||
        getReportingConfig('workOrdersClickupListId') ||
        (getInventoryConfig('phase2Config') || {}).clickupListId ||
        process.env.WORK_ORDERS_CLICKUP_LIST_ID ||
        ''
    });

    const updatedSchedule = getReportingConfig('workOrdersActiveSchedule') || {};
    saveReportingConfig('workOrdersActiveSchedule', {
      ...updatedSchedule,
      ...config,
      active: true,
      lastRun: new Date().toISOString()
    });

    logWorkOrdersExecution(true, 'Work Orders schedule sync completed', summary);
    return {
      success: true,
      message: 'Work Orders schedule sync completed',
      summary
    };
  } catch (error) {
    const failureSummary = error?.summary || null;
    const message = `Work Orders schedule sync failed: ${error.message}`;
    console.error(`[WorkOrders] ${message}`);
    logWorkOrdersExecution(false, message, failureSummary);
    return {
      success: false,
      message,
      summary: failureSummary
    };
  } finally {
    isWorkOrdersSyncRunning = false;
  }
}

function resumeWorkOrdersSchedule() {
  const config = getReportingConfig('workOrdersActiveSchedule');
  if (config && config.active) {
    startWorkOrdersSchedule(config);
  }
}

function getWorkOrdersExecutionLogs(limit = 50) {
  const logs = getReportingConfig('workOrdersExecutionLogs') || [];
  return logs.slice(0, limit);
}

module.exports = {
  startWorkOrdersSchedule,
  stopWorkOrdersSchedule,
  resumeWorkOrdersSchedule,
  executeWorkOrdersScheduledJob,
  getWorkOrdersExecutionLogs,
  logWorkOrdersExecution,
  clearWorkOrdersExecutionLogs
};
