const cron = require('node-cron');

function normalizeText(value) {
  return String(value || '').trim();
}

const schedules = new Map();

function getScheduleState(key = '') {
  const normalizedKey = normalizeText(key);
  if (!normalizedKey) return null;
  if (!schedules.has(normalizedKey)) {
    schedules.set(normalizedKey, {
      task: null,
      active: false,
      running: false,
      cronExpression: '',
      timezone: '',
      lastRunAt: '',
      lastResult: null
    });
  }
  return schedules.get(normalizedKey);
}

function stopEbayListingsSchedule(key = '') {
  const state = getScheduleState(key);
  if (!state) return null;
  if (state.task) {
    state.task.stop();
    state.task = null;
  }
  state.active = false;
  return getEbayListingsScheduleStatus(key);
}

async function executeTick(key = '', runFn = async () => ({ success: true }), context = {}) {
  const state = getScheduleState(key);
  if (!state) {
    return { success: false, skipped: true, reason: 'missing_schedule_key' };
  }
  if (state.running) {
    return { success: false, skipped: true, reason: 'already_running' };
  }

  state.running = true;
  state.lastRunAt = new Date().toISOString();
  try {
    const result = await runFn(context);
    state.lastResult = {
      at: state.lastRunAt,
      success: !!result?.success,
      summary: result?.summary || null,
      message: normalizeText(result?.message || '')
    };
    return result;
  } finally {
    state.running = false;
  }
}

function startEbayListingsSchedule(key = '', config = {}, runFn = async () => ({ success: true })) {
  const normalizedKey = normalizeText(key);
  if (!normalizedKey) throw new Error('eBay listings schedule key is required.');

  const cronExpression = normalizeText(config.cronExpression || '');
  const timezone = normalizeText(config.timezone || '');
  if (!cron.validate(cronExpression)) {
    throw new Error(`Invalid cron expression for eBay listings schedule: '${cronExpression}'`);
  }

  stopEbayListingsSchedule(normalizedKey);
  const state = getScheduleState(normalizedKey);
  state.task = cron.schedule(
    cronExpression,
    async () => {
      await executeTick(normalizedKey, runFn, { trigger: 'scheduled', key: normalizedKey });
    },
    {
      scheduled: true,
      ...(timezone ? { timezone } : {})
    }
  );
  state.active = true;
  state.cronExpression = cronExpression;
  state.timezone = timezone;
  return getEbayListingsScheduleStatus(normalizedKey);
}

async function runEbayListingsScheduleNow(key = '', runFn = async () => ({ success: true })) {
  return executeTick(key, runFn, { trigger: 'manual_now', key });
}

function getEbayListingsScheduleStatus(key = '') {
  const state = getScheduleState(key);
  if (!state) return null;
  return {
    active: state.active,
    running: state.running,
    cronExpression: state.cronExpression,
    timezone: state.timezone,
    lastRunAt: state.lastRunAt,
    lastResult: state.lastResult
  };
}

function getAllEbayListingsScheduleStatuses() {
  return {
    production_to_sandbox: getEbayListingsScheduleStatus('production_to_sandbox'),
    sandbox_to_airtable: getEbayListingsScheduleStatus('sandbox_to_airtable')
  };
}

module.exports = {
  startEbayListingsSchedule,
  stopEbayListingsSchedule,
  runEbayListingsScheduleNow,
  getEbayListingsScheduleStatus,
  getAllEbayListingsScheduleStatuses
};
