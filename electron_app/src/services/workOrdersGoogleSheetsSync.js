const { google } = require('googleapis');
const { fetchWorkOrderRows } = require('./workOrdersPowerlinkService');
const {
  convertPartPicturesToDriveLinks,
  resetRunStats,
  getRunStats
} = require('./googleDriveImageService');

const DEFAULT_WORK_ORDERS_SHEET_NAME = process.env.WORK_ORDERS_SHEET_NAME || 'Work Orders';

const WORK_ORDERS_HEADERS = [
  'Date/Time Last Synced',
  'Created',
  'W/O or Quote Number',
  'Status',
  'Created By',
  'Ship Via',
  'Amount (Total)',
  'Customer PO',
  'Billing Customer Name',
  'Shipping Customer Name',
  'Shipping Customer Address',
  'Shipping Customer Phone Number',
  'eBay Order Number',
  'Detail (IPN)',
  'R#',
  'Stock #',
  'S/C',
  'Location',
  'Notes',
  'Part Pictures',
  'Record Type'
];

function normalizeCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toSheetRowObject(input = {}) {
  const row = {};
  WORK_ORDERS_HEADERS.forEach(header => {
    row[header] = normalizeCell(input[header]);
  });
  return row;
}

function buildRecordKey(row = {}) {
  const recordType = normalizeCell(row['Record Type']);
  const number = normalizeCell(row['W/O or Quote Number']);
  if (!recordType || !number) return '';
  return `${recordType}-${number}`;
}

function rowsEqualByHeaders(a = {}, b = {}) {
  return WORK_ORDERS_HEADERS.every(header => normalizeCell(a[header]) === normalizeCell(b[header]));
}

function rowObjectToValues(row = {}) {
  return WORK_ORDERS_HEADERS.map(header => normalizeCell(row[header]));
}

async function getSheetsClient(authClient) {
  if (!authClient) throw new Error('Google auth client is required');
  return google.sheets({ version: 'v4', auth: authClient });
}

async function getSpreadsheetMeta(sheets, spreadsheetId) {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties'
  });
  return response?.data?.sheets || [];
}

async function ensureSheetExists(sheets, spreadsheetId, sheetName) {
  const sheetsMeta = await getSpreadsheetMeta(sheets, spreadsheetId);
  const existing = sheetsMeta.find(s => s?.properties?.title === sheetName);
  if (existing) return existing.properties.sheetId;

  const addResult = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: { title: sheetName }
          }
        }
      ]
    }
  });

  const addedSheetId = addResult?.data?.replies?.[0]?.addSheet?.properties?.sheetId;
  if (addedSheetId === undefined || addedSheetId === null) {
    throw new Error(`Failed to create sheet "${sheetName}"`);
  }
  return addedSheetId;
}

async function readExistingRows(sheets, spreadsheetId, sheetName) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:Z`
  });
  const values = Array.isArray(response?.data?.values) ? response.data.values : [];
  if (!values.length) {
    return {
      headers: WORK_ORDERS_HEADERS,
      rows: []
    };
  }

  const sourceHeaders = values[0].map(v => String(v || '').trim());
  const rows = values.slice(1).map(line => {
    const row = {};
    WORK_ORDERS_HEADERS.forEach((header, index) => {
      const sourceIndex = sourceHeaders.indexOf(header);
      const value = sourceIndex >= 0 ? line[sourceIndex] : line[index];
      row[header] = normalizeCell(value);
    });
    return row;
  });

  return {
    headers: WORK_ORDERS_HEADERS,
    rows
  };
}

async function overwriteSheetSnapshot(sheets, spreadsheetId, sheetName, rows) {
  const payload = [
    WORK_ORDERS_HEADERS,
    ...rows.map(rowObjectToValues)
  ];

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${sheetName}!A:Z`
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: payload
    }
  });
}

async function syncWorkOrdersRowsToSheet({ authClient, spreadsheetId, latestRows, sheetName = DEFAULT_WORK_ORDERS_SHEET_NAME }) {
  const sheets = await getSheetsClient(authClient);
  await ensureSheetExists(sheets, spreadsheetId, sheetName);

  console.log('[WorkOrders] Google Sheet read started');
  const existing = await readExistingRows(sheets, spreadsheetId, sheetName);

  const existingMap = new Map();
  existing.rows.forEach(row => {
    const key = buildRecordKey(row);
    if (!key) return;
    existingMap.set(key, row);
  });

  const latestMap = new Map();
  latestRows.forEach(rawRow => {
    const row = toSheetRowObject(rawRow);
    const key = buildRecordKey(row);
    if (!key) return;
    latestMap.set(key, row);
  });

  let inserted = 0;
  let updated = 0;
  let removed = 0;

  latestMap.forEach((row, key) => {
    const oldRow = existingMap.get(key);
    if (!oldRow) {
      inserted += 1;
      return;
    }
    if (!rowsEqualByHeaders(oldRow, row)) {
      updated += 1;
    }
  });

  existingMap.forEach((_, key) => {
    if (!latestMap.has(key)) removed += 1;
  });

  const nextRows = Array.from(latestMap.values());
  await overwriteSheetSnapshot(sheets, spreadsheetId, sheetName, nextRows);

  console.log(`[WorkOrders] Google Sheet insert/update/delete summary: inserted=${inserted}, updated=${updated}, removed=${removed}`);
  return {
    inserted,
    updated,
    removed,
    totalWritten: nextRows.length
  };
}

async function runWorkOrdersSync({ authClient, spreadsheetId, sheetName = DEFAULT_WORK_ORDERS_SHEET_NAME }) {
  const summary = {
    fetched: 0,
    inserted: 0,
    updated: 0,
    removed: 0,
    imagesUploaded: 0,
    imagesSkipped: 0,
    errors: []
  };

  console.log('[WorkOrders] Work Orders sync started');
  console.log('[WorkOrders] Powerlink SQL query started');
  let rows = [];
  try {
    rows = await fetchWorkOrderRows();
    summary.fetched = rows.length;
    console.log(`[WorkOrders] Powerlink SQL query completed. fetched=${rows.length}`);
  } catch (error) {
    const message = `Powerlink SQL query failed: ${error.message}`;
    console.error(`[WorkOrders] ${message}`);
    summary.errors.push(message);
    throw Object.assign(new Error(message), { summary });
  }

  console.log('[WorkOrders] Image upload started');
  resetRunStats();
  for (const row of rows) {
    const source = row['Part Pictures'];
    if (!normalizeCell(source)) {
      row['Part Pictures'] = '';
      continue;
    }

    try {
      const converted = await convertPartPicturesToDriveLinks(source);
      row['Part Pictures'] = normalizeCell(converted);
    } catch (error) {
      const message = `Image conversion failed for record ${buildRecordKey(row) || 'unknown'}: ${error.message}`;
      console.error(`[WorkOrders] ${message}`);
      summary.errors.push(message);
      row['Part Pictures'] = '';
    }
  }

  const stats = getRunStats();
  summary.imagesUploaded = stats.uploaded;
  summary.imagesSkipped = stats.missing + stats.failed;
  console.log(
    `[WorkOrders] Image upload summary: uploaded=${stats.uploaded}, cached=${stats.cached}, missing=${stats.missing}, failed=${stats.failed}`
  );

  try {
    const syncResult = await syncWorkOrdersRowsToSheet({
      authClient,
      spreadsheetId,
      latestRows: rows,
      sheetName
    });
    summary.inserted = syncResult.inserted;
    summary.updated = syncResult.updated;
    summary.removed = syncResult.removed;
  } catch (error) {
    const message = `Google Sheets sync failed: ${error.message}`;
    console.error(`[WorkOrders] ${message}`);
    summary.errors.push(message);
    throw Object.assign(new Error(message), { summary });
  }

  console.log('[WorkOrders] Work Orders sync completed');
  return summary;
}

module.exports = {
  WORK_ORDERS_HEADERS,
  DEFAULT_WORK_ORDERS_SHEET_NAME,
  buildRecordKey,
  syncWorkOrdersRowsToSheet,
  runWorkOrdersSync
};
