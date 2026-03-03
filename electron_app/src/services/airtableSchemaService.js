const axios = require('axios');
const { retryWithBackoff, sleep } = require('../utils/retry');

class AirtableSchemaService {
  constructor(config = {}) {
    this.token = String(config.token || '').trim();
    this.baseId = String(config.baseId || '').trim();
    this.minIntervalMs = 220;
    this.lastRequestAt = 0;

    if (!this.token || !this.baseId) {
      throw new Error('Airtable schema config missing token or baseId.');
    }

    this.client = axios.create({
      baseURL: `https://api.airtable.com/v0/meta/bases/${this.baseId}`,
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    });
  }

  async throttle() {
    const elapsed = Date.now() - this.lastRequestAt;
    const waitMs = this.minIntervalMs - elapsed;
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    this.lastRequestAt = Date.now();
  }

  async request(method, path, options = {}) {
    return retryWithBackoff(
      async () => {
        await this.throttle();
        const response = await this.client.request({
          method,
          url: path,
          params: options.params,
          data: options.data
        });
        return response.data;
      },
      {
        maxAttempts: 6,
        baseDelayMs: 500,
        onRetry: ({ attempt, delayMs, error }) => {
          const status = error?.response?.status;
          console.warn(
            `Airtable schema retry attempt ${attempt} after ${delayMs}ms (status: ${status || 'n/a'})`
          );
        }
      }
    );
  }

  async listTables() {
    const data = await this.request('GET', '/tables');
    return Array.isArray(data?.tables) ? data.tables : [];
  }

  async createTable(payload = {}) {
    const data = await this.request('POST', '/tables', { data: payload });
    return data;
  }

  async createField(tableId, payload = {}) {
    const normalizedTableId = String(tableId || '').trim();
    if (!normalizedTableId) {
      throw new Error('Airtable schema createField requires tableId.');
    }

    const data = await this.request(
      'POST',
      `/tables/${encodeURIComponent(normalizedTableId)}/fields`,
      { data: payload }
    );
    return data;
  }
}

module.exports = AirtableSchemaService;
