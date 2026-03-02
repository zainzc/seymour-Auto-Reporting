const { Phase2WritebackService } = require('./phase2WritebackService');

class Phase2WritebackPollerService {
  constructor() {
    this.timer = null;
    this.running = false;
    this.inFlight = false;
    this.intervalMinutes = 120;
    this.lastRunAt = null;
    this.lastSummary = null;
    this.lastError = null;
    this.currentConfig = null;
  }

  getStatus() {
    return {
      active: this.running,
      inFlight: this.inFlight,
      intervalMinutes: this.intervalMinutes,
      lastRunAt: this.lastRunAt,
      lastSummary: this.lastSummary,
      lastError: this.lastError
    };
  }

  async executeOnce(configOverride = null) {
    const config = configOverride || this.currentConfig;
    if (!config) {
      throw new Error('Write-back poller config is missing.');
    }
    if (this.inFlight) {
      return {
        skipped: true,
        reason: 'already_running',
        status: this.getStatus()
      };
    }

    this.inFlight = true;
    try {
      const service = new Phase2WritebackService(config);
      const summary = await service.runOnce();
      this.lastRunAt = new Date().toISOString();
      this.lastSummary = summary;
      this.lastError = null;
      console.log('Phase2 write-back poll summary', summary);
      return {
        skipped: false,
        summary
      };
    } catch (error) {
      this.lastRunAt = new Date().toISOString();
      this.lastError = error.message;
      throw error;
    } finally {
      this.inFlight = false;
    }
  }

  start(config) {
    if (!config || typeof config !== 'object') {
      throw new Error('Write-back poller config is required.');
    }

    const intervalMinutes = Number(config.pollIntervalMinutes);
    this.intervalMinutes = Number.isFinite(intervalMinutes) && intervalMinutes > 0
      ? intervalMinutes
      : 120;
    this.currentConfig = {
      ...config,
      pollIntervalMinutes: this.intervalMinutes
    };

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.running = true;

    // Fire immediately, then continue on interval.
    this.executeOnce().catch(error => {
      console.error('Phase2 write-back initial run failed:', error.message);
    });

    this.timer = setInterval(() => {
      this.executeOnce().catch(error => {
        console.error('Phase2 write-back poll run failed:', error.message);
      });
    }, this.intervalMinutes * 60 * 1000);

    return this.getStatus();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    return this.getStatus();
  }
}

module.exports = new Phase2WritebackPollerService();
