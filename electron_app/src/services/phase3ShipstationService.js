const axios = require('axios');
const { retryWithBackoff, sleep } = require('../utils/retry');

const SHIPSTATION_BASE_URL = 'https://ssapi.shipstation.com';

function toIsoString(value) {
  if (!(value instanceof Date)) return null;
  const timestamp = value.getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

class Phase3ShipstationService {
  constructor(config = {}) {
    this.apiKey = String(config.apiKey || '').trim();
    this.apiSecret = String(config.apiSecret || '').trim();
    this.storeId = Number(config.storeId);
    this.pageSize = Number(config.pageSize) > 0 ? Math.min(500, Number(config.pageSize)) : 50;
    this.lookbackDays = Number(config.lookbackDays) > 0 ? Number(config.lookbackDays) : 90;
    this.maxPages = Number(config.maxPages) > 0 ? Number(config.maxPages) : 300;
    this.minIntervalMs = 220;
    this.lastRequestAt = 0;

    if (!this.apiKey || !this.apiSecret) {
      throw new Error('ShipStation v1 credentials are missing.');
    }
    if (!Number.isFinite(this.storeId)) {
      throw new Error('ShipStation store ID is missing or invalid.');
    }

    this.client = axios.create({
      baseURL: SHIPSTATION_BASE_URL,
      timeout: 30000,
      auth: {
        username: this.apiKey,
        password: this.apiSecret
      },
      headers: {
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

  async request(path, params) {
    return retryWithBackoff(
      async () => {
        await this.throttle();
        const response = await this.client.get(path, { params });
        return response.data;
      },
      {
        maxAttempts: 6,
        baseDelayMs: 500,
        onRetry: ({ attempt, delayMs, error }) => {
          const status = error?.response?.status;
          console.warn(
            `ShipStation retry attempt ${attempt} after ${delayMs}ms (status: ${status || 'n/a'})`
          );
        }
      }
    );
  }

  async fetchShipments(options = {}, progressCallback = () => {}) {
    const lookbackDays =
      Number(options.lookbackDays) > 0 ? Number(options.lookbackDays) : this.lookbackDays;
    const maxPages = Number(options.maxPages) > 0 ? Number(options.maxPages) : this.maxPages;

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const createDateStart = toIsoString(startDate);
    const createDateEnd = toIsoString(endDate);

    let page = 1;
    const shipments = [];

    while (page <= maxPages) {
      const params = {
        storeId: this.storeId,
        page,
        pageSize: this.pageSize,
        sortBy: 'CreateDate',
        sortDir: 'DESC',
        includeShipmentItems: 'true',
        createDateStart,
        createDateEnd
      };

      const data = await this.request('/shipments', params);
      const rows = Array.isArray(data?.shipments) ? data.shipments : [];
      shipments.push(...rows);

      progressCallback({
        page,
        fetchedThisPage: rows.length,
        shipmentsFetched: shipments.length
      });

      const totalPages = Number(data?.pages);
      const hasMoreByPageCount = Number.isFinite(totalPages) ? page < totalPages : rows.length > 0;
      if (!hasMoreByPageCount || rows.length === 0) {
        break;
      }

      page += 1;
    }

    return {
      shipments,
      lookbackDays,
      pageSize: this.pageSize,
      pagesFetched: page
    };
  }
}

module.exports = Phase3ShipstationService;
