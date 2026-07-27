const { google } = require('googleapis');
const oauth2Service = require('./oauth2Service');
const {
  normalizeText
} = require('./phase5GovernanceService');

const DEFAULT_TAB = 'Log';

const REQUIRED_HEADERS = [
  'Published At',
  'Batch ID',
  'IPN',
  'IPN Prefix',
  'eBay Item ID',
  'eBay Category ID',
  'Category Name',
  'eBay Store Category',
  'AI Optimized Title',
  'Quantity (if updated)',
  'Price (if updated)',
  'Airtable Record ID',
  'Publish Run ID (optional)',
  'Payload Hash (optional, recommended for idempotency)'
];

function normalizeEbayItemId(value) {
  const text = normalizeText(value)
    .replace(/^[\s'"`]+/, '')
    .replace(/[\s'"`]+$/, '');
  if (/^[\d\s.,'-]+$/.test(text)) {
    return text.replace(/\D+/g, '');
  }
  return text;
}

function toSheetEbayItemIdValue(value) {
  const itemId = normalizeEbayItemId(value);
  if (/^\d+$/.test(itemId)) {
    const numeric = Number(itemId);
    if (Number.isSafeInteger(numeric)) return numeric;
  }
  return itemId;
}

function normalizeNumericIdentifier(value) {
  const text = normalizeText(value)
    .replace(/^[\s'"`]+/, '')
    .replace(/[\s'"`]+$/, '');
  if (/^[\d\s.,'-]+$/.test(text)) {
    return text.replace(/\D+/g, '');
  }
  return text;
}

function toSheetNumericIdentifierValue(value) {
  const identifier = normalizeNumericIdentifier(value);
  if (/^\d+$/.test(identifier)) {
    const numeric = Number(identifier);
    if (Number.isSafeInteger(numeric)) return numeric;
  }
  return identifier;
}

class Phase5PublishLogService {
  constructor(config = {}) {
    this.enabled = String(config.enabled ?? process.env.PHASE5_SHEETS_LOG_ENABLED ?? 'false').trim().toLowerCase() === 'true';
    this.spreadsheetId = normalizeText(config.spreadsheetId || process.env.PHASE5_SHEETS_LOG_SPREADSHEET_ID || '');
    this.tabName = normalizeText(config.tabName || process.env.PHASE5_SHEETS_LOG_TAB || DEFAULT_TAB) || DEFAULT_TAB;
    this.authContext = normalizeText(config.authContext || process.env.PHASE5_SHEETS_LOG_AUTH_CONTEXT || 'inventory') || 'inventory';
  }

  isConfigured() {
    return this.enabled && !!this.spreadsheetId;
  }

  getRangeA1() {
    return `${this.tabName}!A:N`;
  }

  async getSheetsClient() {
    if (!oauth2Service.isAuthenticated(this.authContext)) {
      throw new Error(`Google OAuth not connected for context '${this.authContext}'.`);
    }
    const auth = oauth2Service.getAuthenticatedClient(this.authContext);
    return google.sheets({ version: 'v4', auth });
  }

  async ensureHeaders(sheets) {
    const read = await sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tabName}!A1:N1`
    });
    const row = Array.isArray(read?.data?.values) && read.data.values.length > 0 ? read.data.values[0] : [];
    const current = row.map(item => normalizeText(item));
    const matches =
      current.length >= REQUIRED_HEADERS.length &&
      REQUIRED_HEADERS.every((header, idx) => normalizeText(current[idx]) === header);
    if (matches) return;

    await sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tabName}!A1:N1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [REQUIRED_HEADERS]
      }
    });
  }

  async appendLogRow(row = []) {
    if (!this.enabled) return { success: true, skipped: true, reason: 'disabled' };
    if (!this.spreadsheetId) {
      throw new Error('Missing Google Sheets spreadsheet ID for Phase 5 publish log.');
    }
    if (!Array.isArray(row) || row.length !== 14) {
      throw new Error('Phase 5 publish log row must include exactly 14 columns.');
    }

    const cleanRow = row.slice();
    cleanRow[4] = toSheetEbayItemIdValue(cleanRow[4]);
    cleanRow[5] = toSheetNumericIdentifierValue(cleanRow[5]);

    const sheets = await this.getSheetsClient();
    await this.ensureHeaders(sheets);

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: this.getRangeA1(),
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [cleanRow]
      }
    });

    return {
      success: true,
      updates: response?.data?.updates || null
    };
  }

  async fetchLogRows() {
    if (!this.spreadsheetId) {
      throw new Error('Missing Google Sheets spreadsheet ID for Phase 5 publish log.');
    }
    const sheets = await this.getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: this.getRangeA1()
    });
    return Array.isArray(response?.data?.values) ? response.data.values : [];
  }

  async fetchLatestHashesByItemId() {
    const rows = await this.fetchLogRows();
    if (!Array.isArray(rows) || rows.length <= 1) return new Map();
    const map = new Map();
    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i] || [];
      const itemId = normalizeEbayItemId(row[4]);
      const payloadHash = normalizeText(row[13]);
      if (!itemId) continue;
      if (payloadHash) {
        map.set(itemId, payloadHash);
        continue;
      }
      if (!map.has(itemId)) {
        map.set(itemId, '');
      }
    }
    return map;
  }

  async fetchPublishedState() {
    const rows = await this.fetchLogRows();
    const identities = new Set();
    const payloadHashes = new Set();
    if (!Array.isArray(rows) || rows.length <= 1) {
      return { identities: [], payloadHashes: [] };
    }

    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i] || [];
      const itemId = normalizeEbayItemId(row[4]);
      const ipn = normalizeText(row[2]).toUpperCase();
      const payloadHash = normalizeText(row[13]);
      if (itemId) identities.add(`ITEM:${itemId}`);
      if (ipn) identities.add(`IPN:${ipn}`);
      if (payloadHash) payloadHashes.add(payloadHash);
    }

    return {
      identities: Array.from(identities),
      payloadHashes: Array.from(payloadHashes)
    };
  }
}

module.exports = {
  Phase5PublishLogService
};
