const axios = require('axios');
const { chunkArray } = require('../utils/chunk');
const { retryWithBackoff, sleep } = require('../utils/retry');
const AirtableSchemaService = require('./airtableSchemaService');

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
    this._schemaTablesCache = null;
    this._masterFieldNamesCache = null;
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

  async validateConfig() {
    const checks = [];
    if (this.masterTable) {
      await this.request('GET', `/${encodeURIComponent(this.masterTable)}`, {
        params: { maxRecords: 1 }
      });
      checks.push({ table: this.masterTable, ok: true });
    }
    if (this.categoryTable && this.categoryTable !== this.masterTable) {
      await this.request('GET', `/${encodeURIComponent(this.categoryTable)}`, {
        params: { maxRecords: 1 }
      });
      checks.push({ table: this.categoryTable, ok: true });
    }
    return {
      success: true,
      baseId: this.baseId,
      checks
    };
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

  async findMasterPartByIPN(ipn) {
    return this.fetchMasterPartByIpn(ipn);
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

  async fetchCategoryRecordsByPrefix(ipnPrefix) {
    const prefixText = String(ipnPrefix || '').trim();
    if (!prefixText) return [];
    const data = await this.request('GET', `/${encodeURIComponent(this.categoryTable)}`, {
      params: {
        filterByFormula: `{IPN Prefix}=${prefixText}`
      }
    });
    return data?.records || [];
  }

  async fetchCategoryRecordsByPrefixAndIdentifier(ipnPrefix, identifier) {
    const prefixText = String(ipnPrefix || '').trim();
    const target = String(identifier || '').trim().toLowerCase();
    if (!prefixText || !target) return [];
    const rows = await this.fetchCategoryRecordsByPrefix(prefixText);
    return rows.filter(record => {
      const fields = record?.fields || {};
      const a = String(fields['Category Identifier / Conditions & Options'] || '')
        .trim()
        .toLowerCase();
      const b = String(fields['Conditions & Options'] || '').trim().toLowerCase();
      return a === target || b === target;
    });
  }

  async getSchemaTables() {
    if (Array.isArray(this._schemaTablesCache)) {
      return this._schemaTablesCache;
    }
    const service = new AirtableSchemaService({
      token: this.token,
      baseId: this.baseId
    });
    this._schemaTablesCache = await service.listTables();
    return this._schemaTablesCache;
  }

  async getMasterFieldNames() {
    if (this._masterFieldNamesCache) {
      return this._masterFieldNamesCache;
    }
    const tables = await this.getSchemaTables();
    const masterTable = tables.find(
      table => String(table?.name || '').trim().toLowerCase() === String(this.masterTable || '').trim().toLowerCase()
    );
    const names = new Set(
      (masterTable?.fields || []).map(field => String(field?.name || '').trim()).filter(Boolean)
    );
    this._masterFieldNamesCache = names;
    return names;
  }

  async resolveMasterCategoryLinkFieldName(preferredName = '') {
    const preferred = String(preferredName || '').trim();
    const tables = await this.getSchemaTables();
    const masterTable = tables.find(
      table => String(table?.name || '').trim().toLowerCase() === String(this.masterTable || '').trim().toLowerCase()
    );
    const categoryTable = tables.find(
      table => String(table?.name || '').trim().toLowerCase() === String(this.categoryTable || '').trim().toLowerCase()
    );
    const fields = masterTable?.fields || [];

    const byName = name =>
      fields.find(field => String(field?.name || '').trim().toLowerCase() === String(name || '').trim().toLowerCase());

    if (preferred && byName(preferred)) return preferred;
    if (byName('Category Definitions')) return 'Category Definitions';
    if (byName('Categories')) return 'Categories';

    const categoryTableId = String(categoryTable?.id || '').trim();
    if (categoryTableId) {
      const linked = fields.find(field => {
        if (String(field?.type || '').trim() !== 'multipleRecordLinks') return false;
        const linkedTableId = String(field?.options?.linkedTableId || '').trim();
        return linkedTableId && linkedTableId === categoryTableId;
      });
      if (linked?.name) return String(linked.name);
    }

    const anyRecordLink = fields.find(
      field => String(field?.type || '').trim() === 'multipleRecordLinks' && field?.name
    );
    if (anyRecordLink?.name) return String(anyRecordLink.name);

    return preferred || 'Category Definitions';
  }

  async setMasterPartCategory(masterRecordId, categoryRecordId, options = {}) {
    const recordId = String(masterRecordId || '').trim();
    const categoryId = String(categoryRecordId || '').trim();
    if (!recordId) {
      throw new Error('Airtable master record ID is required.');
    }
    if (!categoryId) {
      throw new Error('Airtable category record ID is required.');
    }

    const preferredLinkField = String(options.linkFieldName || '').trim();
    const resolvedLinkField = await this.resolveMasterCategoryLinkFieldName(preferredLinkField);
    const candidates = [...new Set([preferredLinkField, resolvedLinkField, 'Category Definitions', 'Categories'].filter(Boolean))];
    let lastError = null;

    for (const fieldName of candidates) {
      try {
        const data = await this.request('PATCH', `/${encodeURIComponent(this.masterTable)}`, {
          data: {
            records: [
              {
                id: recordId,
                fields: {
                  [fieldName]: [categoryId]
                }
              }
            ],
            typecast: true
          }
        });
        return (data?.records || [])[0] || null;
      } catch (error) {
        const detail = String(
          error?.response?.data?.error?.message ||
            error?.response?.data?.error ||
            error?.message ||
            ''
        ).toLowerCase();
        if (error?.response?.status === 422 && detail.includes('unknown field')) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    if (lastError) throw lastError;
    throw new Error('Failed to update category link on Master Parts.');
  }

  async updateMasterPartFields(masterRecordId, fieldsToSet = {}) {
    const recordId = String(masterRecordId || '').trim();
    if (!recordId) {
      throw new Error('Airtable master record ID is required.');
    }

    const sanitizedFields = {};
    Object.entries(fieldsToSet || {}).forEach(([key, value]) => {
      if (!key) return;
      if (value === null || value === undefined) return;
      if (typeof value === 'string' && !value.trim()) return;
      sanitizedFields[key] = value;
    });

    if (Object.keys(sanitizedFields).length === 0) {
      return null;
    }

    const data = await this.request('PATCH', `/${encodeURIComponent(this.masterTable)}`, {
      data: {
        records: [
          {
            id: recordId,
            fields: sanitizedFields
          }
        ],
        typecast: true
      }
    });

    return (data?.records || [])[0] || null;
  }

  async updateMasterShipstationFields(masterRecordId, fieldsToSet = {}) {
    const recordId = String(masterRecordId || '').trim();
    if (!recordId) {
      throw new Error('Airtable master record ID is required.');
    }

    const sanitizedFields = {};
    Object.entries(fieldsToSet || {}).forEach(([key, value]) => {
      if (!key) return;
      if (value === null || value === undefined) return;
      if (typeof value === 'string' && !value.trim()) return;
      sanitizedFields[key] = value;
    });

    if (Object.keys(sanitizedFields).length === 0) {
      return null;
    }

    return this.updateMasterPartFields(recordId, sanitizedFields);
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
