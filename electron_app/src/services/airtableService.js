const axios = require('axios');
const { chunkArray } = require('../utils/chunk');
const { retryWithBackoff, sleep } = require('../utils/retry');
const AirtableSchemaService = require('./airtableSchemaService');

const DEFAULT_MASTER_TABLE_ID = 'tbl0tzQ3dxeWRcQzr';
const DEFAULT_CATEGORY_TABLE_ID = 'tblbotUAVXn7RHeMB';
const DEFAULT_CATEGORY_LINK_FIELD_NAME = 'Category Definitions Link';

class AirtableService {
  constructor(config) {
    this.token = config.token;
    this.baseId = config.baseId;
    this.masterTable = config.masterTable;
    this.categoryTable = config.categoryTable;
    this.masterTableId = String(config.masterTableId || DEFAULT_MASTER_TABLE_ID).trim();
    this.categoryTableId = String(config.categoryTableId || DEFAULT_CATEGORY_TABLE_ID).trim();
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
    this._categoryLinkFieldNameCache = null;
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

  clearSchemaCache() {
    this._schemaTablesCache = null;
    this._masterFieldNamesCache = null;
    this._categoryLinkFieldNameCache = null;
  }

  findSchemaTable(tables = [], preferredId = '', preferredName = '') {
    const id = String(preferredId || '').trim();
    const name = String(preferredName || '').trim().toLowerCase();
    if (id) {
      const byId = tables.find(table => String(table?.id || '').trim() === id);
      if (byId) return byId;
    }
    if (name) {
      const byName = tables.find(
        table => String(table?.name || '').trim().toLowerCase() === name
      );
      if (byName) return byName;
    }
    return null;
  }

  async getMasterFieldNames() {
    if (this._masterFieldNamesCache) {
      return this._masterFieldNamesCache;
    }
    const tables = await this.getSchemaTables();
    const masterTable = this.findSchemaTable(tables, this.masterTableId, this.masterTable);
    const names = new Set(
      (masterTable?.fields || []).map(field => String(field?.name || '').trim()).filter(Boolean)
    );
    this._masterFieldNamesCache = names;
    return names;
  }

  async resolveMasterCategoryLinkFieldName(preferredName = '') {
    if (this._categoryLinkFieldNameCache) {
      return this._categoryLinkFieldNameCache;
    }

    const preferred = String(preferredName || '').trim();
    const tables = await this.getSchemaTables();
    const masterTable = this.findSchemaTable(tables, this.masterTableId, this.masterTable);
    const categoryTable =
      this.findSchemaTable(tables, this.categoryTableId, this.categoryTable) ||
      this.findSchemaTable(tables, '', 'Category Definitions');
    const fields = masterTable?.fields || [];
    const linkedTableId = String(categoryTable?.id || this.categoryTableId || '').trim();

    const match = fields.find(field => {
      if (String(field?.type || '').trim() !== 'multipleRecordLinks') return false;
      const fieldLinkedTableId = String(field?.options?.linkedTableId || '').trim();
      if (!fieldLinkedTableId || !linkedTableId) return false;
      return fieldLinkedTableId === linkedTableId;
    });

    if (match?.name) {
      this._categoryLinkFieldNameCache = String(match.name);
      return this._categoryLinkFieldNameCache;
    }

    if (preferred) {
      const preferredField = fields.find(
        field =>
          String(field?.name || '').trim().toLowerCase() === preferred.toLowerCase() &&
          String(field?.type || '').trim() === 'multipleRecordLinks'
      );
      if (preferredField?.name) {
        this._categoryLinkFieldNameCache = String(preferredField.name);
        return this._categoryLinkFieldNameCache;
      }
    }

    return '';
  }

  async ensureMasterCategoryLinkField(preferredName = DEFAULT_CATEGORY_LINK_FIELD_NAME) {
    const existing = await this.resolveMasterCategoryLinkFieldName(preferredName);
    if (existing) return existing;

    const tables = await this.getSchemaTables();
    const masterTable = this.findSchemaTable(tables, this.masterTableId, this.masterTable);
    const categoryTable =
      this.findSchemaTable(tables, this.categoryTableId, this.categoryTable) ||
      this.findSchemaTable(tables, '', 'Category Definitions');

    const masterTableId = String(masterTable?.id || this.masterTableId || '').trim();
    const categoryTableId = String(categoryTable?.id || this.categoryTableId || '').trim();
    if (!masterTableId || !categoryTableId) {
      throw new Error('Unable to resolve Airtable Master Parts or Category Definitions table schema.');
    }

    const schemaService = new AirtableSchemaService({
      token: this.token,
      baseId: this.baseId
    });

    const created = await schemaService.createField(masterTableId, {
      name: String(preferredName || DEFAULT_CATEGORY_LINK_FIELD_NAME).trim() || DEFAULT_CATEGORY_LINK_FIELD_NAME,
      type: 'multipleRecordLinks',
      options: {
        linkedTableId: categoryTableId,
        isReversed: false
      }
    });

    this.clearSchemaCache();
    const createdName = String(created?.name || preferredName || DEFAULT_CATEGORY_LINK_FIELD_NAME).trim();
    this._categoryLinkFieldNameCache = createdName;
    return createdName;
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
    const resolvedLinkField = await this.ensureMasterCategoryLinkField(
      preferredLinkField || DEFAULT_CATEGORY_LINK_FIELD_NAME
    );
    if (!resolvedLinkField) {
      throw new Error('Category link field could not be resolved or created.');
    }

    const data = await this.request('PATCH', `/${encodeURIComponent(this.masterTable)}`, {
      data: {
        records: [
          {
            id: recordId,
            fields: {
              [resolvedLinkField]: [categoryId]
            }
          }
        ],
        typecast: true
      }
    });

    return (data?.records || [])[0] || null;
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
    const successfulRecordIds = [];

    for (const batch of batches) {
      batchIndex += 1;
      try {
        const data = await this.request(method, endpoint, {
          data: { records: batch, typecast: true }
        });
        const successCount = (data.records || []).length;
        written += successCount;
        processed += batch.length;
        if (method === 'PATCH') {
          batch.forEach(record => {
            if (record?.id) successfulRecordIds.push(String(record.id));
          });
        } else {
          (data.records || []).forEach(record => {
            if (record?.id) successfulRecordIds.push(String(record.id));
          });
        }
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
            if (method === 'PATCH') {
              if (record?.id) successfulRecordIds.push(String(record.id));
            } else {
              (singleData.records || []).forEach(savedRecord => {
                if (savedRecord?.id) successfulRecordIds.push(String(savedRecord.id));
              });
            }
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

    return { count: written, errors, successfulRecordIds };
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
