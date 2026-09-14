const cron = require('node-cron');
const axios = require('axios');

const CONFIG_KEY = 'quickBooksAutomationSettings';
const LOGS_KEY = 'quickBooksAutomationWebhookLogs';
const WORKFLOW_DEFINITIONS = Object.freeze({
  main: Object.freeze({ label: 'Main Run', webhookUrl: 'https://seymourauto.app.n8n.cloud/webhook/qb-01-main-controll' }),
  retry1: Object.freeze({ label: 'Retry 1', webhookUrl: 'https://seymourauto.app.n8n.cloud/webhook/qb-10-retry1-controll' }),
  retry2: Object.freeze({ label: 'Retry 2', webhookUrl: 'https://seymourauto.app.n8n.cloud/webhook/qb-10-retry2-controll' })
});
const DEFAULT_TIMEZONE = 'America/New_York';
const DEFAULT_RUN_TIME = '01:00';
const MAX_LOGS = 25;
const MAX_SCHEDULED_RETRIES = 3;
const RETRY_DELAY_MS = 30 * 60 * 1000;

const activeJobs = new Map();
const activeRetryTimers = new Map();
const runningWorkflows = new Set();
let configStore = null;

function getConfigStore() {
  if (!configStore) {
    configStore = require('../config/configStore');
  }
  return configStore;
}

function normalizeRunTime(value = '') {
  const text = String(value || '').trim();
  if (/^\d{2}:\d{2}$/.test(text)) {
    const [hour, minute] = text.split(':').map(Number);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return text;
  }
  return DEFAULT_RUN_TIME;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'active', 'enabled'].includes(text)) return true;
  if (['false', '0', 'no', 'paused', 'disabled'].includes(text)) return false;
  return fallback;
}

function getWorkflowDefinition(workflowKey = 'main') {
  const definition = WORKFLOW_DEFINITIONS[String(workflowKey || '').trim()];
  if (!definition) throw new Error(`Unknown QuickBooks workflow: ${workflowKey}`);
  return definition;
}

function getZonedParts(date = new Date(), timezone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const map = {};
  parts.forEach(part => {
    if (part.type !== 'literal') map[part.type] = part.value;
  });
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour === '24' ? '0' : map.hour),
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

function zonedDateKey(date = new Date(), timezone = DEFAULT_TIMEZONE) {
  const parts = getZonedParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function addDaysUtc(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function makeDateForZone(parts, timezone = DEFAULT_TIMEZONE) {
  let candidate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0));
  for (let i = 0; i < 4; i += 1) {
    const actual = getZonedParts(candidate, timezone);
    const desiredUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second || 0);
    const diffMs = desiredUtc - actualUtc;
    if (diffMs === 0) break;
    candidate = new Date(candidate.getTime() + diffMs);
  }
  return candidate;
}

function calculateNextRunAt(settings = {}, now = new Date()) {
  if (!parseBoolean(settings.enabled, false)) return null;
  const timezone = String(settings.timezone || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
  const [hour, minute] = normalizeRunTime(settings.runTime).split(':').map(Number);
  const todayParts = getZonedParts(now, timezone);
  let target = makeDateForZone({
    year: todayParts.year,
    month: todayParts.month,
    day: todayParts.day,
    hour,
    minute
  }, timezone);

  if (target <= now) {
    const tomorrow = addDaysUtc(todayParts, 1);
    target = makeDateForZone({
      ...tomorrow,
      hour,
      minute
    }, timezone);
  }

  return target.toISOString();
}

function buildDailyCron(runTime = DEFAULT_RUN_TIME) {
  const [hour, minute] = normalizeRunTime(runTime).split(':').map(Number);
  return `${minute} ${hour} * * *`;
}

function getLogs() {
  const { getInventoryConfig } = getConfigStore();
  return getInventoryConfig(LOGS_KEY) || [];
}

function saveLogs(logs = []) {
  const { saveInventoryConfig } = getConfigStore();
  saveInventoryConfig(LOGS_KEY, Array.isArray(logs) ? logs.slice(0, MAX_LOGS) : []);
}

function appendLog(entry = {}) {
  const logs = getLogs();
  logs.unshift({
    timestamp: new Date().toISOString(),
    ...entry
  });
  saveLogs(logs);
}

function getDefaultWorkflow(runTime = DEFAULT_RUN_TIME) {
  return {
    enabled: false,
    runTime,
    timezone: DEFAULT_TIMEZONE,
    nextRunAt: null,
    lastScheduledExecutionDate: '',
    lastScheduledExecutionAt: '',
    lastScheduledSuccessAt: '',
    lastWebhookAttempt: null,
    retryOccurrenceDate: '',
    retryAttempts: 0,
    nextRetryAt: null
  };
}

function getDefaultSettings() {
  return {
    workflows: {
      main: getDefaultWorkflow(DEFAULT_RUN_TIME),
      retry1: getDefaultWorkflow('06:00'),
      retry2: getDefaultWorkflow('10:00')
    }
  };
}

function normalizeWorkflowSettings(stored = {}) {
  const defaults = getDefaultSettings();
  const hasWorkflowShape = stored?.workflows && typeof stored.workflows === 'object';
  const workflows = {};
  Object.keys(WORKFLOW_DEFINITIONS).forEach(key => {
    const legacyMain = key === 'main' && !hasWorkflowShape ? stored : {};
    const source = hasWorkflowShape && stored.workflows[key] && typeof stored.workflows[key] === 'object'
      ? stored.workflows[key]
      : legacyMain;
    const fallback = defaults.workflows[key];
    workflows[key] = {
      ...fallback,
      ...source,
      enabled: parseBoolean(source.enabled, fallback.enabled),
      runTime: normalizeRunTime(source.runTime || fallback.runTime),
      timezone: DEFAULT_TIMEZONE
    };
    workflows[key].nextRunAt = workflows[key].enabled ? calculateNextRunAt(workflows[key]) : null;
  });
  return { workflows };
}

function getSettings() {
  const { getInventoryConfig } = getConfigStore();
  return normalizeWorkflowSettings(getInventoryConfig(CONFIG_KEY) || {});
}

function saveSettings(next = {}) {
  const { saveInventoryConfig } = getConfigStore();
  const current = getSettings();
  const incoming = next.workflows || {};
  const merged = normalizeWorkflowSettings({
    workflows: Object.fromEntries(Object.keys(WORKFLOW_DEFINITIONS).map(key => [key, {
      ...current.workflows[key],
      ...(incoming[key] || {})
    }]))
  });
  saveInventoryConfig(CONFIG_KEY, merged);
  return merged;
}

function summarizeResponse(response) {
  const data = response?.data;
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data.slice(0, 220);
  if (typeof data === 'object') {
    const safe = {};
    ['message', 'status', 'success', 'runId', 'executionId'].forEach(key => {
      if (data[key] !== undefined) safe[key] = data[key];
    });
    const text = Object.keys(safe).length > 0 ? JSON.stringify(safe) : JSON.stringify(data).slice(0, 220);
    return text.slice(0, 220);
  }
  return String(data).slice(0, 220);
}

function saveAttemptToSettings(workflowKey, attempt) {
  const current = getSettings();
  const workflow = current.workflows[workflowKey];
  const updates = {
    lastWebhookAttempt: attempt
  };
  if (attempt.success) {
    updates.lastScheduledSuccessAt = attempt.timestamp;
  }
  saveSettings({ workflows: { [workflowKey]: { ...workflow, ...updates } } });
}

async function triggerWebhook(workflowKey = 'main', triggerType = 'scheduled', meta = {}) {
  const definition = getWorkflowDefinition(workflowKey);
  if (runningWorkflows.has(workflowKey)) {
    const skipped = {
      triggerType,
      workflowKey,
      workflowLabel: definition.label,
      success: true,
      skipped: true,
      message: 'QuickBooks webhook skipped: previous invocation still in progress.',
      configuredRunTime: meta.runTime || getSettings().workflows[workflowKey].runTime,
      timezone: DEFAULT_TIMEZONE
    };
    appendLog(skipped);
    return skipped;
  }

  runningWorkflows.add(workflowKey);
  const settings = getSettings().workflows[workflowKey];
  const timestamp = new Date().toISOString();
  try {
    const response = await axios.get(definition.webhookUrl, {
      timeout: 30000,
      validateStatus: () => true
    });
    const success = response.status >= 200 && response.status < 300;
    const attempt = {
      timestamp,
      triggerType,
      workflowKey,
      workflowLabel: definition.label,
      success,
      httpStatus: response.status,
      configuredRunTime: settings.runTime,
      timezone: DEFAULT_TIMEZONE,
      occurrenceDate: meta.occurrenceDate || '',
      retryAttempt: Number(meta.retryAttempt || 0),
      message: success ? `${definition.label} workflow webhook triggered.` : `${definition.label} workflow webhook failed.`,
      responseSummary: summarizeResponse(response)
    };
    appendLog(attempt);
    saveAttemptToSettings(workflowKey, attempt);
    return attempt;
  } catch (error) {
    const attempt = {
      timestamp,
      triggerType,
      workflowKey,
      workflowLabel: definition.label,
      success: false,
      httpStatus: error?.response?.status || null,
      configuredRunTime: settings.runTime,
      timezone: DEFAULT_TIMEZONE,
      occurrenceDate: meta.occurrenceDate || '',
      retryAttempt: Number(meta.retryAttempt || 0),
      message: `${definition.label} workflow webhook request failed.`,
      errorSummary: String(error?.message || error || 'Unknown error').slice(0, 220)
    };
    appendLog(attempt);
    saveAttemptToSettings(workflowKey, attempt);
    return attempt;
  } finally {
    runningWorkflows.delete(workflowKey);
  }
}

function stopRetryTimer(workflowKey) {
  const timer = activeRetryTimers.get(workflowKey);
  if (timer) {
    clearTimeout(timer);
    activeRetryTimers.delete(workflowKey);
  }
}

function scheduleRetry(workflowKey, occurrenceDate) {
  stopRetryTimer(workflowKey);
  const settings = getSettings().workflows[workflowKey];
  if (!settings.enabled) return;
  if (!occurrenceDate) return;
  const attempts = Number(settings.retryAttempts || 0);
  if (attempts >= MAX_SCHEDULED_RETRIES) return;

  const nextRetryAt = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
  saveSettings({ workflows: { [workflowKey]: { ...settings, retryOccurrenceDate: occurrenceDate, retryAttempts: attempts, nextRetryAt } } });

  const timer = setTimeout(async () => {
    activeRetryTimers.delete(workflowKey);
    await executeScheduledRetry(workflowKey, occurrenceDate);
  }, RETRY_DELAY_MS);
  activeRetryTimers.set(workflowKey, timer);
}

async function executeScheduledRetry(workflowKey = 'main', occurrenceDate) {
  getWorkflowDefinition(workflowKey);
  const settings = getSettings().workflows[workflowKey];
  if (!settings.enabled) return { success: false, skipped: true, message: 'QuickBooks automation paused.' };
  if (settings.retryOccurrenceDate !== occurrenceDate) {
    return { success: false, skipped: true, message: 'Retry occurrence no longer active.' };
  }
  const nextAttempt = Number(settings.retryAttempts || 0) + 1;
  if (nextAttempt > MAX_SCHEDULED_RETRIES) {
    return { success: false, skipped: true, message: 'Retry limit reached.' };
  }

  saveSettings({ workflows: { [workflowKey]: { ...settings, retryAttempts: nextAttempt, nextRetryAt: null } } });
  const result = await triggerWebhook(workflowKey, 'delivery_retry', {
    occurrenceDate,
    retryAttempt: nextAttempt
  });
  if (!result.success && nextAttempt < MAX_SCHEDULED_RETRIES) {
    scheduleRetry(workflowKey, occurrenceDate);
  }
  return result;
}

async function executeScheduledOccurrence(workflowKey = 'main') {
  getWorkflowDefinition(workflowKey);
  const settings = getSettings().workflows[workflowKey];
  if (!settings.enabled) {
    return { success: false, skipped: true, message: 'QuickBooks automation paused.' };
  }

  const occurrenceDate = zonedDateKey(new Date(), DEFAULT_TIMEZONE);
  if (settings.lastScheduledExecutionDate === occurrenceDate) {
    appendLog({
      triggerType: 'scheduled',
      workflowKey,
      workflowLabel: getWorkflowDefinition(workflowKey).label,
      success: true,
      skipped: true,
      occurrenceDate,
      configuredRunTime: settings.runTime,
      timezone: DEFAULT_TIMEZONE,
      message: 'QuickBooks scheduled webhook skipped: occurrence already attempted.'
    });
    return { success: true, skipped: true, message: 'Scheduled occurrence already attempted.' };
  }

  saveSettings({ workflows: { [workflowKey]: {
    ...settings,
    lastScheduledExecutionDate: occurrenceDate,
    lastScheduledExecutionAt: new Date().toISOString(),
    retryOccurrenceDate: '', retryAttempts: 0, nextRetryAt: null
  } } });

  const result = await triggerWebhook(workflowKey, 'scheduled', {
    occurrenceDate,
    retryAttempt: 0
  });

  if (!result.success) {
    scheduleRetry(workflowKey, occurrenceDate);
  }

  const fresh = getSettings().workflows[workflowKey];
  saveSettings({ workflows: { [workflowKey]: { ...fresh, nextRunAt: calculateNextRunAt(fresh) } } });
  return result;
}

function stopSchedule(options = {}) {
  activeJobs.forEach(job => job.stop());
  activeJobs.clear();
  Object.keys(WORKFLOW_DEFINITIONS).forEach(stopRetryTimer);

  if (options.persistPaused) {
    const current = getSettings();
    saveSettings({ workflows: Object.fromEntries(Object.entries(current.workflows).map(([key, workflow]) => [key, {
      ...workflow, enabled: false, nextRunAt: null
    }])) });
  }
}

function startSchedule(settings = getSettings()) {
  stopSchedule({ persistPaused: false });
  const normalized = saveSettings(settings);
  Object.entries(normalized.workflows).forEach(([workflowKey, workflow]) => {
    if (!workflow.enabled) return;
    const job = cron.schedule(buildDailyCron(workflow.runTime), () => {
      executeScheduledOccurrence(workflowKey).catch(error => {
        appendLog({
          triggerType: 'scheduled',
          workflowKey,
          workflowLabel: getWorkflowDefinition(workflowKey).label,
          success: false,
          message: 'QuickBooks scheduled webhook failed before request.',
          errorSummary: String(error?.message || error || 'Unknown error').slice(0, 220),
          configuredRunTime: workflow.runTime,
          timezone: DEFAULT_TIMEZONE
        });
      });
    }, {
      scheduled: true,
      timezone: DEFAULT_TIMEZONE
    });
    activeJobs.set(workflowKey, job);
  });

  Object.entries(getSettings().workflows).forEach(([workflowKey, workflow]) => {
    if (!workflow.enabled || !workflow.nextRetryAt || !workflow.retryOccurrenceDate) return;
    const delay = Date.parse(workflow.nextRetryAt) - Date.now();
    if (delay > 0 && delay <= RETRY_DELAY_MS) {
      const timer = setTimeout(async () => {
        activeRetryTimers.delete(workflowKey);
        await executeScheduledRetry(workflowKey, workflow.retryOccurrenceDate);
      }, delay);
      activeRetryTimers.set(workflowKey, timer);
    }
  });

  return getStatus();
}

function resumeSchedule() {
  const settings = getSettings();
  if (!Object.values(settings.workflows).some(workflow => workflow.enabled)) {
    stopSchedule({ persistPaused: false });
    return getStatus();
  }
  return startSchedule(settings);
}

function updateSettings(payload = {}) {
  const current = getSettings();
  const incoming = payload.workflows || {
    main: { enabled: payload.enabled, runTime: payload.runTime }
  };
  const next = saveSettings({ workflows: Object.fromEntries(Object.keys(WORKFLOW_DEFINITIONS).map(key => [key, {
    ...current.workflows[key],
    ...(incoming[key] || {})
  }])) });

  if (Object.values(next.workflows).some(workflow => workflow.enabled)) {
    return startSchedule(next);
  }

  stopSchedule({ persistPaused: false });
  return getStatus();
}

async function runNow(workflowKey = 'main') {
  return triggerWebhook(workflowKey, 'manual', {
    occurrenceDate: '',
    retryAttempt: 0
  });
}

function runNowInBackground(workflowKey = 'main') {
  const definition = getWorkflowDefinition(workflowKey);
  const requested = {
    timestamp: new Date().toISOString(),
    triggerType: 'manual',
    workflowKey,
    workflowLabel: definition.label,
    success: true,
    pending: true,
    configuredRunTime: getSettings().workflows[workflowKey].runTime,
    timezone: DEFAULT_TIMEZONE,
    occurrenceDate: '',
    retryAttempt: 0,
    message: `${definition.label} webhook request started.`
  };
  appendLog(requested);

  setTimeout(() => {
    triggerWebhook(workflowKey, 'manual', {
      occurrenceDate: '',
      retryAttempt: 0
    }).catch(error => {
      const failed = {
        timestamp: new Date().toISOString(),
        triggerType: 'manual',
        workflowKey,
        workflowLabel: definition.label,
        success: false,
        configuredRunTime: getSettings().workflows[workflowKey].runTime,
        timezone: DEFAULT_TIMEZONE,
        occurrenceDate: '',
        retryAttempt: 0,
        message: 'QuickBooks manual webhook request failed.',
        errorSummary: String(error?.message || error || 'Unknown error').slice(0, 220)
      };
      appendLog(failed);
      saveAttemptToSettings(workflowKey, failed);
    });
  }, 0);

  return requested;
}

function getStatus() {
  const settings = getSettings();
  const main = settings.workflows.main;
  return {
    ...settings,
    enabled: main.enabled,
    runTime: main.runTime,
    timezone: DEFAULT_TIMEZONE,
    nextRunAt: main.nextRunAt,
    lastWebhookAttempt: main.lastWebhookAttempt,
    status: Object.values(settings.workflows).some(workflow => workflow.enabled) ? 'Active' : 'Paused',
    logs: getLogs(),
    retryDelayMinutes: RETRY_DELAY_MS / 60000,
    maxScheduledRetries: MAX_SCHEDULED_RETRIES
  };
}

module.exports = {
  WORKFLOW_DEFINITIONS,
  DEFAULT_TIMEZONE,
  DEFAULT_RUN_TIME,
  MAX_LOGS,
  MAX_SCHEDULED_RETRIES,
  RETRY_DELAY_MS,
  getStatus,
  updateSettings,
  runNow,
  runNowInBackground,
  startSchedule,
  stopSchedule,
  resumeSchedule,
  calculateNextRunAt,
  executeScheduledOccurrence,
  executeScheduledRetry,
  zonedDateKey,
  buildDailyCron,
  normalizeWorkflowSettings,
  getWorkflowDefinition,
  triggerWebhook
};
