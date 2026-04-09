const cron = require('node-cron');

function normalizeText(value) {
  return String(value || '').trim();
}

let scheduledTask = null;
let active = false;
let running = false;
let cronExpression = '';
let timezone = '';
let lastRunAt = '';
let lastResult = null;

function stopPhase5AutoPushSchedule() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  active = false;
}

async function executeTick(runFn, context = {}) {
  if (running) {
    return {
      success: false,
      skipped: true,
      reason: 'already_running'
    };
  }
  running = true;
  lastRunAt = new Date().toISOString();
  try {
    const result = await runFn(context);
    lastResult = {
      at: lastRunAt,
      success: !!result?.success,
      summary: result?.summary || null,
      message: normalizeText(result?.message || '')
    };
    return result;
  } finally {
    running = false;
  }
}

function startPhase5AutoPushSchedule(config = {}, runFn = async () => ({ success: true })) {
  const nextCron = normalizeText(config.cronExpression || '0 * * * *');
  const nextTimezone = normalizeText(config.timezone || '');

  if (!cron.validate(nextCron)) {
    throw new Error(`Invalid cron expression for Phase 5 Option B: '${nextCron}'`);
  }

  stopPhase5AutoPushSchedule();

  scheduledTask = cron.schedule(
    nextCron,
    async () => {
      await executeTick(runFn, { trigger: 'scheduled' });
    },
    {
      scheduled: true,
      ...(nextTimezone ? { timezone: nextTimezone } : {})
    }
  );

  active = true;
  cronExpression = nextCron;
  timezone = nextTimezone;

  return {
    active,
    running,
    cronExpression,
    timezone,
    lastRunAt,
    lastResult
  };
}

async function runPhase5AutoPushNow(runFn = async () => ({ success: true })) {
  return executeTick(runFn, { trigger: 'manual_now' });
}

function getPhase5AutoPushScheduleStatus() {
  return {
    active,
    running,
    cronExpression,
    timezone,
    lastRunAt,
    lastResult
  };
}

module.exports = {
  startPhase5AutoPushSchedule,
  stopPhase5AutoPushSchedule,
  runPhase5AutoPushNow,
  getPhase5AutoPushScheduleStatus
};

