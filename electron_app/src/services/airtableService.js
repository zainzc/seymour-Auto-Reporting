const axios = require('axios');
const { chunkArray } = require('../utils/chunk');
const { retryWithBackoff, sleep } = require('../utils/retry');

class AirtableService {
  constructor(config) {
    this.token = config.token;
    this.baseId = config.baseId;
    this.masterTable = config.masterTable;
    this.categoryTable = config.categoryTable;
    this.minIntervalMs = 220; // <= 5 req/sec
    this.lastRequestAt = 0;

    if (!this.token || !this.baseId) {
      throw new Error('Airtable configuration is missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID.');
    }

    this.client = axios.create({
      baseURL: `https://api.airtable.com/v0/${this.baseId}`,
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
          console.warn(`Airtable retry attempt ${attempt} after ${delayMs}ms (status: ${status || 'n/a'})`);
        }
      }
    );
  }

  async fetchAllRecords(tableName, selectFields = []) {
    const records = [];
    let offset = null;

    do {
      const params = {};
      if (offset) params.offset = offset;
      if (selectFields.length > 0) params.fields = selectFields;

      const data = await this.request('GET', `/${encodeURIComponent(tableName)}`, { params });
      records.push(...(data.records || []));
      offset = data.offset || null;
    } while (offset);

    return records;
  }

  static buildOrFormula(fieldName, values) {
    const terms = values.map(value => {
      const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `{${fieldName}}="${escaped}"`;
    });
    return `OR(${terms.join(',')})`;
  }

  static buildAndFormula(clauses) {
    const cleanClauses = (clauses || []).filter(Boolean);
    if (cleanClauses.length === 0) return '';
    if (cleanClauses.length === 1) return cleanClauses[0];
    return `AND(${cleanClauses.join(',')})`;
  }

  static buildEqualsFormula(fieldName, value) {
    const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `{${fieldName}}="${escaped}"`;
  }

  async fetchMasterPartsByIpns(ipns) {
    const uniqueIpns = [...new Set(ipns.filter(Boolean))];
    const results = [];

    for (const group of chunkArray(uniqueIpns, 120)) {
      const formula = AirtableService.buildOrFormula('IPN', group);
      let offset = null;

      do {
        const params = { filterByFormula: formula };
        if (offset) params.offset = offset;

        const data = await this.request('GET', `/${encodeURIComponent(this.masterTable)}`, { params });
        results.push(...(data.records || []));
        offset = data.offset || null;
      } while (offset);
    }

    return results;
  }

  async fetchMasterPartByIpn(ipn) {
    const normalized = String(ipn || '').trim();
    if (!normalized) return null;

    const formula = AirtableService.buildEqualsFormula('IPN', normalized);
    const data = await this.request('GET', `/${encodeURIComponent(this.masterTable)}`, {
      params: {
        filterByFormula: formula,
        maxRecords: 2
      }
    });

    const records = data?.records || [];
    if (records.length === 0) return null;
    return records[0];
  }

  async fetchCategoryRecordsByPrefixAndName(ipnPrefix, categoryName) {
    const prefixText = String(ipnPrefix || '').trim();
    const targetName = String(categoryName || '').trim().toLowerCase();
    if (!prefixText || !targetName) return [];

    const data = await this.request('GET', `/${encodeURIComponent(this.categoryTable)}`, {
      params: {
        filterByFormula: `{IPN Prefix}=${prefixText}`
      }
    });

    const records = data?.records || [];
    return records.filter(record => {
      const name = String(record?.fields?.['Category Name'] || '').trim().toLowerCase();
      return name === targetName;
    });
  }

  async setMasterPartCategory(masterRecordId, categoryRecordId) {
    const recordId = String(masterRecordId || '').trim();
    const categoryId = String(categoryRecordId || '').trim();
    if (!recordId) {
      throw new Error('Airtable master record ID is required.');
    }
    if (!categoryId) {
      throw new Error('Airtable category record ID is required.');
    }

    const data = await this.request('PATCH', `/${encodeURIComponent(this.masterTable)}`, {
      data: {
        records: [
          {
            id: recordId,
            fields: {
              Categories: [categoryId]
            }
          }
        ],
        typecast: true
      }
    });

    return (data?.records || [])[0] || null;
  }

  async createMasterParts(records, onProgress = null) {
    const result = await this.writeMasterPartsWithFallback('POST', records, onProgress);
    return result;
  }

  async updateMasterParts(records, onProgress = null) {
    const result = await this.writeMasterPartsWithFallback('PATCH', records, onProgress);
    return result;
  }

  static getAirtableErrorMessage(error) {
    const status = error?.response?.status;
    const payload = error?.response?.data;
    const detail =
      payload?.error?.message ||
      payload?.error ||
      error?.message ||
      'Unknown Airtable error';
    return status ? `HTTP ${status}: ${detail}` : String(detail);
  }

  getRecordLabel(record, method) {
    if (method === 'PATCH') {
      return record?.id ? `id=${record.id}` : 'id=unknown';
    }
    const ipn = record?.fields?.IPN;
    return ipn ? `IPN=${ipn}` : 'IPN=unknown';
  }

  async writeMasterPartsWithFallback(method, records, onProgress = null) {
    const endpoint = `/${encodeURIComponent(this.masterTable)}`;
    let written = 0;
    let processed = 0;
    let failed = 0;
    const errors = [];
    let droppedErrorCount = 0;
    const maxErrorLines = 200;
    const batches = chunkArray(records, 10);
    const totalBatches = batches.length;
    let batchIndex = 0;

    for (const batch of batches) {
      batchIndex += 1;
      try {
        const data = await this.request(method, endpoint, {
          data: { records: batch, typecast: true }
        });
        const successCount = (data.records || []).length;
        written += successCount;
        processed += batch.length;
      } catch (batchError) {
        const status = batchError?.response?.status;
        if (status !== 422) {
          throw batchError;
        }

        // 422 usually indicates one or more invalid records in a batch.
        // Retry individually so valid records can still be written and we can surface precise failures.
        for (const record of batch) {
          try {
            const singleData = await this.request(method, endpoint, {
              data: { records: [record], typecast: true }
            });
            written += (singleData.records || []).length;
          } catch (singleError) {
            failed += 1;
            const label = this.getRecordLabel(record, method);
            const message = AirtableService.getAirtableErrorMessage(singleError);
            if (errors.length < maxErrorLines) {
              errors.push(`${label} -> ${message}`);
            } else {
              droppedErrorCount += 1;
            }
          } finally {
            processed += 1;
          }
        }
      }

      if (typeof onProgress === 'function') {
        onProgress({
          method,
          processedRecords: processed,
          totalRecords: records.length,
          writtenRecords: written,
          failedRecords: failed,
          batchIndex,
          totalBatches
        });
      }
    }

    if (droppedErrorCount > 0) {
      errors.push(`...and ${droppedErrorCount} additional Airtable write errors.`);
    }

    return { count: written, errors };
  }

  static async fetchAllBases(token) {
    if (!token) {
      throw new Error('Airtable token is required.');
    }

    const client = axios.create({
      baseURL: 'https://api.airtable.com/v0',
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const bases = [];
    let offset = null;

    do {
      const response = await client.get('/meta/bases', {
        params: offset ? { offset } : {}
      });
      const data = response.data || {};
      bases.push(...(data.bases || []));
      offset = data.offset || null;
    } while (offset);

    return bases
      .map(base => ({
        id: String(base.id || ''),
        name: String(base.name || 'Unnamed Base'),
        permissionLevel: String(base.permissionLevel || '')
      }))
      .filter(base => base.id);
  }
}

module.exports = AirtableService;
