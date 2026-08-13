const cron = require('node-cron');
const axios = require('axios');

const CONFIG_KEY = 'quickBooksAutomationSettings';
const LOGS_KEY = 'quickBooksAutomationWebhookLogs';
const MAIN_WORKFLOW_WEBHOOK_URL = 'https://seymourauto.app.n8n.cloud/webhook/qb-01-main-controll';
const DEFAULT_TIMEZONE = 'America/New_York';
const DEFAULT_RUN_TIME = '01:00';
const MAX_LOGS = 25;
const MAX_SCHEDULED_RETRIES = 3;
const RETRY_DELAY_MS = 30 * 60 * 1000;
const WEBHOOK_AUTH_HEADER = 'X-QBO-Automation-Key';

let activeJob = null;
let activeRetryTimer = null;
let isWebhookRunning = false;
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

function getDefaultSettings() {
  return {
    enabled: false,
    runTime: DEFAULT_RUN_TIME,
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

function getSettings() {
  const { getInventoryConfig } = getConfigStore();
  const stored = getInventoryConfig(CONFIG_KEY) || {};
  const merged = {
    ...getDefaultSettings(),
    ...stored,
    enabled: parseBoolean(stored.enabled, false),
    runTime: normalizeRunTime(stored.runTime),
    timezone: DEFAULT_TIMEZONE
  };
  merged.nextRunAt = merged.enabled ? calculateNextRunAt(merged) : null;
  return merged;
}

function saveSettings(next = {}) {
  const { saveInventoryConfig } = getConfigStore();
  const current = getSettings();
  const merged = {
    ...current,
    ...next,
    enabled: parseBoolean(next.enabled, current.enabled),
    runTime: normalizeRunTime(next.runTime || current.runTime),
    timezone: DEFAULT_TIMEZONE
  };
  merged.nextRunAt = merged.enabled ? calculateNextRunAt(merged) : null;
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

function getWebhookAuthKey() {
  return String(
    process.env[WEBHOOK_AUTH_HEADER] ||
    process.env.QBO_AUTOMATION_KEY ||
    process.env.QUICKBOOKS_AUTOMATION_KEY ||
    ''
  ).trim();
}

function saveAttemptToSettings(attempt) {
  const current = getSettings();
  const updates = {
    lastWebhookAttempt: attempt
  };
  if (attempt.success) {
    updates.lastScheduledSuccessAt = attempt.timestamp;
  }
  saveSettings({
    ...current,
    ...updates
  });
}

async function triggerWebhook(triggerType = 'scheduled', meta = {}) {
  if (isWebhookRunning) {
    const skipped = {
      triggerType,
      success: true,
      skipped: true,
      message: 'QuickBooks webhook skipped: previous invocation still in progress.',
      configuredRunTime: meta.runTime || getSettings().runTime,
      timezone: DEFAULT_TIMEZONE
    };
    appendLog(skipped);
    return skipped;
  }

  isWebhookRunning = true;
  const settings = getSettings();
  const timestamp = new Date().toISOString();
  try {
    const authKey = getWebhookAuthKey();
    if (!authKey) {
      throw new Error(`${WEBHOOK_AUTH_HEADER} is missing from environment configuration.`);
    }
    const response = await axios.get(MAIN_WORKFLOW_WEBHOOK_URL, {
      headers: {
        [WEBHOOK_AUTH_HEADER]: authKey
      },
      timeout: 30000,
      validateStatus: () => true
    });
    const success = response.status >= 200 && response.status < 300;
    const attempt = {
      timestamp,
      triggerType,
      success,
      httpStatus: response.status,
      configuredRunTime: settings.runTime,
      timezone: DEFAULT_TIMEZONE,
      occurrenceDate: meta.occurrenceDate || '',
      retryAttempt: Number(meta.retryAttempt || 0),
      message: success ? 'QuickBooks parent workflow webhook triggered.' : 'QuickBooks parent workflow webhook failed.',
      responseSummary: summarizeResponse(response)
    };
    appendLog(attempt);
    saveAttemptToSettings(attempt);
    return attempt;
  } catch (error) {
    const attempt = {
      timestamp,
      triggerType,
      success: false,
      httpStatus: error?.response?.status || null,
      configuredRunTime: settings.runTime,
      timezone: DEFAULT_TIMEZONE,
      occurrenceDate: meta.occurrenceDate || '',
      retryAttempt: Number(meta.retryAttempt || 0),
      message: 'QuickBooks parent workflow webhook request failed.',
      errorSummary: String(error?.message || error || 'Unknown error').slice(0, 220)
    };
    appendLog(attempt);
    saveAttemptToSettings(attempt);
    return attempt;
  } finally {
    isWebhookRunning = false;
  }
}

function stopRetryTimer() {
  if (activeRetryTimer) {
    clearTimeout(activeRetryTimer);
    activeRetryTimer = null;
  }
}

function scheduleRetry(occurrenceDate) {
  stopRetryTimer();
  const settings = getSettings();
  if (!settings.enabled) return;
  if (!occurrenceDate) return;
  const attempts = Number(settings.retryAttempts || 0);
  if (attempts >= MAX_SCHEDULED_RETRIES) return;

  const nextRetryAt = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
  saveSettings({
    ...settings,
    retryOccurrenceDate: occurrenceDate,
    retryAttempts: attempts,
    nextRetryAt
  });

  activeRetryTimer = setTimeout(async () => {
    activeRetryTimer = null;
    await executeScheduledRetry(occurrenceDate);
  }, RETRY_DELAY_MS);
}

async function executeScheduledRetry(occurrenceDate) {
  const settings = getSettings();
  if (!settings.enabled) return { success: false, skipped: true, message: 'QuickBooks automation paused.' };
  if (settings.retryOccurrenceDate !== occurrenceDate) {
    return { success: false, skipped: true, message: 'Retry occurrence no longer active.' };
  }
  const nextAttempt = Number(settings.retryAttempts || 0) + 1;
  if (nextAttempt > MAX_SCHEDULED_RETRIES) {
    return { success: false, skipped: true, message: 'Retry limit reached.' };
  }

  saveSettings({
    ...settings,
    retryAttempts: nextAttempt,
    nextRetryAt: null
  });
  const result = await triggerWebhook('scheduled_retry', {
    occurrenceDate,
    retryAttempt: nextAttempt
  });
  if (!result.success && nextAttempt < MAX_SCHEDULED_RETRIES) {
    scheduleRetry(occurrenceDate);
  }
  return result;
}

async function executeScheduledOccurrence() {
  const settings = getSettings();
  if (!settings.enabled) {
    return { success: false, skipped: true, message: 'QuickBooks automation paused.' };
  }

  const occurrenceDate = zonedDateKey(new Date(), DEFAULT_TIMEZONE);
  if (settings.lastScheduledExecutionDate === occurrenceDate) {
    appendLog({
      triggerType: 'scheduled',
      success: true,
      skipped: true,
      occurrenceDate,
      configuredRunTime: settings.runTime,
      timezone: DEFAULT_TIMEZONE,
      message: 'QuickBooks scheduled webhook skipped: occurrence already attempted.'
    });
    return { success: true, skipped: true, message: 'Scheduled occurrence already attempted.' };
  }

  saveSettings({
    ...settings,
    lastScheduledExecutionDate: occurrenceDate,
    lastScheduledExecutionAt: new Date().toISOString(),
    retryOccurrenceDate: '',
    retryAttempts: 0,
    nextRetryAt: null
  });

  const result = await triggerWebhook('scheduled', {
    occurrenceDate,
    retryAttempt: 0
  });

  if (!result.success) {
    scheduleRetry(occurrenceDate);
  }

  const fresh = getSettings();
  saveSettings({
    ...fresh,
    nextRunAt: calculateNextRunAt(fresh)
  });
  return result;
}

function stopSchedule(options = {}) {
  if (activeJob) {
    activeJob.stop();
    activeJob = null;
  }
  stopRetryTimer();

  if (options.persistPaused) {
    const current = getSettings();
    saveSettings({
      ...current,
      enabled: false,
      nextRunAt: null
    });
  }
}

function startSchedule(settings = getSettings()) {
  stopSchedule({ persistPaused: false });
  const normalized = saveSettings({
    ...settings,
    enabled: true,
    runTime: settings.runTime
  });
  const cronExpression = buildDailyCron(normalized.runTime);
  activeJob = cron.schedule(
    cronExpression,
    () => {
      executeScheduledOccurrence().catch(error => {
        appendLog({
          triggerType: 'scheduled',
          success: false,
          message: 'QuickBooks scheduled webhook failed before request.',
          errorSummary: String(error?.message || error || 'Unknown error').slice(0, 220),
          configuredRunTime: normalized.runTime,
          timezone: DEFAULT_TIMEZONE
        });
      });
    },
    {
      scheduled: true,
      timezone: DEFAULT_TIMEZONE
    }
  );

  const fresh = getSettings();
  if (fresh.nextRetryAt && fresh.retryOccurrenceDate) {
    const delay = Date.parse(fresh.nextRetryAt) - Date.now();
    if (delay > 0 && delay <= RETRY_DELAY_MS) {
      activeRetryTimer = setTimeout(async () => {
        activeRetryTimer = null;
        await executeScheduledRetry(fresh.retryOccurrenceDate);
      }, delay);
    }
  }

  return getStatus();
}

function resumeSchedule() {
  const settings = getSettings();
  if (!settings.enabled) {
    stopSchedule({ persistPaused: false });
    return getStatus();
  }
  return startSchedule(settings);
}

function updateSettings(payload = {}) {
  const current = getSettings();
  const enabled = parseBoolean(payload.enabled, current.enabled);
  const next = saveSettings({
    ...current,
    enabled,
    runTime: normalizeRunTime(payload.runTime || current.runTime),
    timezone: DEFAULT_TIMEZONE
  });

  if (enabled) {
    return startSchedule(next);
  }

  stopSchedule({ persistPaused: false });
  saveSettings({
    ...next,
    enabled: false,
    nextRunAt: null
  });
  return getStatus();
}

async function runNow() {
  return triggerWebhook('manual', {
    occurrenceDate: '',
    retryAttempt: 0
  });
}

function getStatus() {
  const settings = getSettings();
  return {
    ...settings,
    status: settings.enabled ? 'Active' : 'Paused',
    logs: getLogs(),
    retryDelayMinutes: RETRY_DELAY_MS / 60000,
    maxScheduledRetries: MAX_SCHEDULED_RETRIES
  };
}

module.exports = {
  DEFAULT_TIMEZONE,
  DEFAULT_RUN_TIME,
  MAX_LOGS,
  MAX_SCHEDULED_RETRIES,
  RETRY_DELAY_MS,
  getStatus,
  updateSettings,
  runNow,
  startSchedule,
  stopSchedule,
  resumeSchedule,
  calculateNextRunAt,
  executeScheduledOccurrence,
  executeScheduledRetry,
  zonedDateKey,
  buildDailyCron
};
