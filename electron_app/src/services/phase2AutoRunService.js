const crypto = require('crypto');
const { readSheetRows } = require('./phase2SheetsService');
const { runPhase2, buildPhase2Config } = require('./phase2Service');
const { getInventoryConfig, saveInventoryConfig } = require('../config/configStore');

const STATE_KEY = 'phase2AutoRunState';

function toInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return fallback;
}

function getFingerprint(values) {
  const rows = Array.isArray(values) ? values : [];
  const totalRows = Math.max(0, rows.length - 1);
  const header = rows[0] || [];
  const lastRow = rows[rows.length - 1] || [];
  const digest = crypto
    .createHash('sha1')
    .update(JSON.stringify({ header, lastRow, totalRows }))
    .digest('hex');
  return `${totalRows}:${digest}`;
}

class Phase2AutoRunService {
  constructor() {
    this.timer = null;
    this.active = false;
    this.inFlight = false;
    this.pendingForce = false;
    this.lastError = null;
    this.lastSummary = null;
    this.lastReason = null;
    this.pollMinutes = 3;
    this.cooldownMinutes = 5;
  }

  getState() {
    return getInventoryConfig(STATE_KEY) || {};
  }

  saveState(nextState) {
    const previous = this.getState();
    const merged = {
      ...previous,
      ...nextState,
      updatedAt: new Date().toISOString()
    };
    saveInventoryConfig(STATE_KEY, merged);
    return merged;
  }

  getStatus() {
    const state = this.getState();
    return {
      active: this.active,
      inFlight: this.inFlight,
      pollMinutes: this.pollMinutes,
      cooldownMinutes: this.cooldownMinutes,
      lastError: this.lastError,
      lastSummary: this.lastSummary,
      lastReason: this.lastReason,
      lastFingerprint: state.lastFingerprint || null,
      lastRunAt: state.lastRunAt || null
    };
  }

  buildRuntimeConfig(overrides = {}) {
    const stored = getInventoryConfig('phase2Config') || {};
    const merged = buildPhase2Config({
      ...stored,
      ...overrides
    });
    return merged;
  }

  isConfigRunnable(config) {
    return Boolean(
      config &&
        config.sheetId &&
        config.tabName &&
        config.airtableToken &&
        config.airtableBaseId &&
        config.clickupToken &&
        config.clickupListId
    );
  }

  async readFingerprint(config) {
    const values = await readSheetRows(config.sheetId, config.tabName, config.authContext || 'inventory');
    return getFingerprint(values);
  }

  isInCooldown(config) {
    const state = this.getState();
    const cooldownMinutes = toInt(config.phase2AutoRunCooldownMinutes, this.cooldownMinutes);
    const lastRunAt = state.lastRunAt ? Date.parse(state.lastRunAt) : NaN;
    if (!Number.isFinite(lastRunAt)) return false;
    const elapsedMs = Date.now() - lastRunAt;
    return elapsedMs < cooldownMinutes * 60 * 1000;
  }

  async trigger(reason, options = {}) {
    const force = Boolean(options.force);
    const config = this.buildRuntimeConfig(options.configOverrides || {});
    if (!this.isConfigRunnable(config)) {
      return { skipped: true, reason: 'phase2_config_incomplete' };
    }

    if (this.inFlight) {
      if (force) this.pendingForce = true;
      return { skipped: true, reason: 'already_running' };
    }

    this.inFlight = true;
    try {
      const currentFingerprint = await this.readFingerprint(config);
      const state = this.getState();
      const previousFingerprint = state.lastFingerprint || null;

      if (!previousFingerprint) {
        this.saveState({ lastFingerprint: currentFingerprint });
        if (!force) {
          return { skipped: true, reason: 'baseline_initialized' };
        }
      }

      if (!force && currentFingerprint === previousFingerprint) {
        return { skipped: true, reason: 'no_sheet_change' };
      }

      if (!force && this.isInCooldown(config)) {
        return { skipped: true, reason: 'cooldown_active' };
      }

      const summary = await runPhase2(config, () => {});
      this.lastSummary = summary;
      this.lastReason = reason;
      this.lastError = null;
      this.saveState({
        lastFingerprint: currentFingerprint,
        lastRunAt: new Date().toISOString(),
        lastReason: reason
      });
      console.log('Phase2 auto-run completed', {
        reason,
        created: summary.created,
        updated: summary.updated,
        tasks: summary.clickupTasksCreated
      });
      return { skipped: false, summary };
    } catch (error) {
      this.lastError = error.message;
      this.lastReason = reason;
      this.saveState({
        lastError: error.message,
        lastErrorAt: new Date().toISOString(),
        lastReason: reason
      });
      console.error('Phase2 auto-run failed:', error.message);
      return { skipped: true, reason: 'run_failed', error: error.message };
    } finally {
      this.inFlight = false;
      if (this.pendingForce) {
        this.pendingForce = false;
        this.trigger('queued_force_trigger', { force: true }).catch(() => {});
      }
    }
  }

  async onPhase1PushSuccess(payload = {}) {
    const overrides = {
      sheetId: payload.spreadsheetId,
      tabName: payload.worksheetName
    };
    const config = this.buildRuntimeConfig(overrides);
    if (!parseBoolean(config.phase2AutoRunEnabled, true)) {
      return { skipped: true, reason: 'autorun_disabled' };
    }

    const state = this.getState();
    const hasBaseline = Boolean(state.lastFingerprint);

    return this.trigger('phase1_push_success', {
      force: !hasBaseline,
      configOverrides: overrides
    });
  }

  start(options = {}) {
    const config = this.buildRuntimeConfig(options.configOverrides || {});
    const enabled = parseBoolean(
      typeof options.enabled !== 'undefined' ? options.enabled : config.phase2AutoRunEnabled,
      true
    );
    if (!enabled) {
      this.stop();
      return this.getStatus();
    }

    this.pollMinutes = toInt(
      options.pollMinutes || config.phase2AutoRunPollMinutes || process.env.PHASE2_AUTORUN_POLL_MINUTES,
      3
    );
    this.cooldownMinutes = toInt(
      options.cooldownMinutes ||
        config.phase2AutoRunCooldownMinutes ||
        process.env.PHASE2_AUTORUN_COOLDOWN_MINUTES,
      5
    );

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.active = true;
    this.timer = setInterval(() => {
      this.trigger('sheet_poll').catch(() => {});
    }, this.pollMinutes * 60 * 1000);

    // Run initial poll once to establish baseline quickly.
    this.trigger('initial_poll').catch(() => {});
    console.log(
      `Phase2 auto-run poller started (${this.pollMinutes} min poll, ${this.cooldownMinutes} min cooldown)`
    );

    return this.getStatus();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.active = false;
    return this.getStatus();
  }
}

module.exports = new Phase2AutoRunService();
