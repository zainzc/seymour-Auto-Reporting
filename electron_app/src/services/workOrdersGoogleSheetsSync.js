const { google } = require('googleapis');
const { fetchWorkOrderRows } = require('./workOrdersPowerlinkService');
const ClickUpService = require('./clickupService');
const {
  convertPartPicturesToDriveLinks,
  setDriveImageRuntimeConfig,
  getDriveConfigStatus,
  resetRunStats,
  getRunStats
} = require('./googleDriveImageService');
const {
  getReportingConfig,
  saveReportingConfig
} = require('../config/configStore');
const {
  DEFAULT_TIME_ZONE,
  getTimeZoneParts,
  timeZoneDateToUtc
} = require('../utils/timezone');

const DEFAULT_WORK_ORDERS_SHEET_NAME = process.env.WORK_ORDERS_SHEET_NAME || 'Work Orders';
const CLICKUP_COMPLETE_STATUS = 'COMPLETE';
const CLICKUP_OPEN_STATUS = 'OPEN';
const CLICKUP_COMPLETED_STATUS_TOKENS = ['COMPLETE', 'COMPLETED', 'CLOSED', 'DONE', 'RESOLVED'];
const PRIORITY_SHIP_VIA = new Set(['DELIVERY', 'PICK-UP', 'CHECK PART', 'RCD', 'CDC', 'FREIGHT']);
const WORK_ORDERS_TASK_NAME_PREFIX = '[WorkOrderSync]';
const WORK_ORDERS_COMPLETED_QUOTE_NUMBERS_CONFIG_KEY = 'workOrdersCompletedQuoteNumbers';
const WORK_ORDERS_TASK_FIELD_NAMES = {
  customer: 'Customer',
  shipVia: 'Ship Via',
  alert: 'Alert',
  location: 'Location',
  detail: 'Interchange Number / Detail',
  woQuoteNumber: 'WO/QuoteNumber',
  totalPrice: 'Total Price',
  poNumber: 'PO Number',
  ebayOrderNumber: 'Ebay Order Number',
  stock: 'Stock #',
  rNumber: 'R Number',
  notes: 'Notes',
  assignee: 'Assignee'
};
const LOCATION_ASSIGNEE_MAP = {
  '1': '1st Floor',
  '2': '2nd/3rd Floor',
  C: 'C Building',
  T1: 'T1',
  T2: 'T2'
};
const WORK_ORDERS_CLICKUP_MAX_CONCURRENCY = 5;

const WORK_ORDERS_HEADERS = [
  'Date/Time Last Synced',
  'Created',
  'W/O or Quote Number',
  'Line Item ID',
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

function normalizeUpper(value) {
  return normalizeCell(value).toUpperCase();
}

function isQuoteRow(row = {}) {
  return normalizeUpper(row['Record Type']) === 'QUOTE';
}

function isCheckPartQuote(row = {}) {
  return isQuoteRow(row) && normalizeUpper(row['Ship Via']) === 'CHECK PART';
}

function buildTaskKey(row = {}) {
  const lineItemId = normalizeCell(row['Line Item ID']);
  if (lineItemId) {
    return `Line Item-${lineItemId}`;
  }
  return buildRecordKey(row);
}

function buildSheetRowKey(row = {}) {
  const lineItemId = normalizeCell(row['Line Item ID']);
  if (lineItemId) {
    return `Line Item-${lineItemId}`;
  }
  return buildRecordKey(row);
}

function buildWorkOrderTaskTitleParts(row = {}) {
  const customerName = normalizeCell(row['Shipping Customer Name'] || row['Billing Customer Name']);
  const interchangeNumber = normalizeCell(row['Detail (IPN)']).split('|')[0].trim();

  const parts = [];
  if (customerName) parts.push(customerName);
  if (interchangeNumber) parts.push(interchangeNumber);

  return parts;
}

function buildTaskName(row = {}) {
  const parts = buildWorkOrderTaskTitleParts(row);
  if (parts.length > 0) {
    return parts.join(' - ').slice(0, 240);
  }

  const recordType = normalizeUpper(row['Record Type']);
  const number = normalizeCell(row['W/O or Quote Number']);
  const detail = normalizeCell(row['Detail (IPN)']).split('|')[0].trim();
  const prefix = recordType === 'WORK ORDER' ? 'WO' : recordType === 'QUOTE' ? 'Quote' : normalizeCell(row['Record Type']);
  const title = `${prefix} ${number}${detail ? ` - ${detail}` : ''}`.trim();
  return title.slice(0, 240);
}

function parseTaskKeyFromName(taskName = '') {
  const text = normalizeCell(taskName);
  if (!text) return '';
  if (text.startsWith(WORK_ORDERS_TASK_NAME_PREFIX)) {
    const remainder = normalizeCell(text.slice(WORK_ORDERS_TASK_NAME_PREFIX.length));
    if (!remainder) return '';
    const keyPart = remainder.split(' - ')[0];
    return normalizeCell(keyPart);
  }

  const woMatch = text.match(/^WO\s+([^\s-]+)/i);
  if (woMatch && woMatch[1]) {
    return `Work Order-${normalizeCell(woMatch[1])}`;
  }

  const quoteMatch = text.match(/^Quote\s+([^\s-]+)/i);
  if (quoteMatch && quoteMatch[1]) {
    return `Quote-${normalizeCell(quoteMatch[1])}`;
  }

  return '';
}

function parseTaskKeyFromDescription(description = '') {
  const text = String(description || '');
  const match = text.match(/(?:^|\n)\s*Record Key:\s*([^\n\r]+)/i);
  return match && match[1] ? normalizeCell(match[1]) : '';
}

function parseTaskRecordType(description = '') {
  const text = String(description || '');
  const match = text.match(/(?:^|\n)\s*Record Type:\s*([^\n\r]+)/i);
  return match && match[1] ? normalizeUpper(match[1]) : '';
}

function parseTaskQuoteNumber(description = '') {
  const text = String(description || '');
  const parentMatch = text.match(/(?:^|\n)\s*Parent Record Key:\s*Quote-([^\n\r]+)/i);
  if (parentMatch && parentMatch[1]) {
    return normalizeCell(parentMatch[1]);
  }

  const quoteMatch = text.match(/(?:^|\n)\s*W\/O or Quote Number:\s*([^\n\r]+)/i);
  return quoteMatch && quoteMatch[1] ? normalizeCell(quoteMatch[1]) : '';
}

function normalizeClickUpStatusToken(value = '') {
  return normalizeUpper(value).replace(/[^A-Z0-9]+/g, ' ').trim();
}

function isCompletedStatusLabel(value = '') {
  const normalized = normalizeClickUpStatusToken(value);
  if (!normalized) return false;
  return CLICKUP_COMPLETED_STATUS_TOKENS.some(token => normalized === token || normalized.includes(token));
}

function getCompletedStatusNamesFromList(list = {}) {
  const completed = new Set();
  const statuses = Array.isArray(list?.statuses) ? list.statuses : [];
  statuses.forEach(status => {
    const type = normalizeUpper(status?.type);
    const label = normalizeClickUpStatusToken(status?.status || status?.name || status?.label);
    if (!label) return;
    if (type === 'CLOSED' || type.includes('CLOSED') || isCompletedStatusLabel(label)) {
      completed.add(label);
    }
  });
  return completed;
}

function normalizeQuoteNumberList(values = []) {
  return Array.from(
    new Set(
      values
        .map(value => normalizeCell(value))
        .filter(Boolean)
    )
  );
}

function loadCompletedQuoteNumberCache() {
  const stored = getReportingConfig(WORK_ORDERS_COMPLETED_QUOTE_NUMBERS_CONFIG_KEY);
  if (!Array.isArray(stored)) return new Set();
  return new Set(normalizeQuoteNumberList(stored));
}

function saveCompletedQuoteNumberCache(quoteNumbers = []) {
  saveReportingConfig(
    WORK_ORDERS_COMPLETED_QUOTE_NUMBERS_CONFIG_KEY,
    normalizeQuoteNumberList(quoteNumbers)
  );
}

function mergeCompletedQuoteNumbers(...setsOrArrays) {
  const merged = new Set();
  setsOrArrays.forEach(values => {
    if (!values) return;
    if (values instanceof Set) {
      values.forEach(value => {
        const normalized = normalizeCell(value);
        if (normalized) merged.add(normalized);
      });
      return;
    }
    if (Array.isArray(values)) {
      values.forEach(value => {
        const normalized = normalizeCell(value);
        if (normalized) merged.add(normalized);
      });
    }
  });
  return merged;
}

async function getQuoteCompletionStateFromClickUp(clickup, completedStatusNames = new Set()) {
  if (!clickup) {
    return {
      completed: new Set(),
      open: new Set()
    };
  }

  const tasks = await clickup.fetchTasksByStatuses([], {
    includeClosed: true,
    subtasks: false
  });

  const quoteStats = new Map();
  for (const task of tasks) {
    const description = String(task?.description || '');
    if (parseTaskRecordType(description) !== 'QUOTE') continue;

    const quoteNumber = parseTaskQuoteNumber(description);
    if (!quoteNumber) continue;

    const current = quoteStats.get(quoteNumber) || { total: 0, open: 0 };
    current.total += 1;
    if (!isCompleteStatus(task?.status?.status || task?.status, completedStatusNames)) {
      current.open += 1;
    }
    quoteStats.set(quoteNumber, current);
  }

  const completed = new Set();
  const open = new Set();
  quoteStats.forEach((stats, quoteNumber) => {
    if (stats.total > 0 && stats.open === 0) {
      completed.add(quoteNumber);
    } else if (stats.open > 0) {
      open.add(quoteNumber);
    }
  });

  return { completed, open };
}

function parseRowDate(value) {
  const text = normalizeCell(value);
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function getZonedParts(date) {
  const parts = getTimeZoneParts(date, DEFAULT_TIME_ZONE);
  if (!parts) {
    return {
      year: 0,
      month: 0,
      day: 0,
      hour: 0,
      minute: 0,
      second: 0,
      weekday: ''
    };
  }

  return {
    year: Number(parts.year || 0),
    month: Number(parts.monthNumber || 0),
    day: Number(parts.day || 0),
    hour: Number(parts.hour || 0),
    minute: Number(parts.minute || 0),
    second: Number(parts.second || 0),
    weekday: parts.weekday || ''
  };
}

function compareLocalParts(a, b) {
  const keys = ['year', 'month', 'day', 'hour', 'minute'];
  for (const key of keys) {
    const av = Number(a[key] || 0);
    const bv = Number(b[key] || 0);
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

function zonedDateToUtc(localParts) {
  return timeZoneDateToUtc(
    {
      year: localParts.year,
      month: localParts.month,
      day: localParts.day,
      hour: localParts.hour,
      minute: localParts.minute,
      second: localParts.second || 0
    },
    DEFAULT_TIME_ZONE
  );
}

function isBusinessWeekday(weekday = '') {
  const day = String(weekday || '').toLowerCase();
  return ['mon', 'tue', 'wed', 'thu', 'fri'].includes(day);
}

function nextBusinessDayParts(baseParts) {
  let cursor = {
    year: baseParts.year,
    month: baseParts.month,
    day: baseParts.day,
    hour: 0,
    minute: 0
  };
  for (let i = 0; i < 10; i += 1) {
    const utc = zonedDateToUtc(cursor);
    const next = new Date(utc.getTime() + 24 * 60 * 60 * 1000);
    const parts = getZonedParts(next);
    cursor = { year: parts.year, month: parts.month, day: parts.day, hour: 0, minute: 0 };
    if (isBusinessWeekday(parts.weekday)) {
      return cursor;
    }
  }
  return cursor;
}

function computeDueDate(createdAt, shipVia = '') {
  const created = createdAt instanceof Date ? createdAt : parseRowDate(createdAt);
  if (!created) return null;
  const local = getZonedParts(created);
  const ship = normalizeUpper(shipVia);
  const isPriority = PRIORITY_SHIP_VIA.has(ship);

  const startHour = 8;
  const endHour = isPriority ? 15 : 13;
  const addHours = isPriority ? 2 : 4;

  const inBusinessDay = isBusinessWeekday(local.weekday);
  const inWindow = inBusinessDay && local.hour >= startHour && local.hour < endHour;
  if (inWindow) {
    return new Date(created.getTime() + addHours * 60 * 60 * 1000);
  }

  const nextBiz = nextBusinessDayParts(local);
  const dueLocal = {
    year: nextBiz.year,
    month: nextBiz.month,
    day: nextBiz.day,
    hour: isPriority ? 10 : 12,
    minute: 0
  };
  return zonedDateToUtc(dueLocal);
}

function isCompleteStatus(status = '', completedStatusNames = new Set()) {
  const normalized = normalizeClickUpStatusToken(status);
  if (!normalized) return false;
  if (completedStatusNames instanceof Set && completedStatusNames.has(normalized)) return true;
  return isCompletedStatusLabel(normalized);
}

function resolveLocationAssigneeLabel(location = '') {
  const value = normalizeUpper(location);
  if (!value) return '';
  const keys = ['T1', 'T2', 'C', '1', '2'];
  for (const key of keys) {
    if (value.startsWith(key)) {
      return LOCATION_ASSIGNEE_MAP[key] || '';
    }
  }
  return '';
}

function buildTaskDescription(row = {}) {
  const pictureLinks = String(row['Part Pictures'] || '')
    .split('|')
    .map(value => normalizeCell(value))
    .filter(Boolean);
  const lines = [
    `Record Key: ${buildTaskKey(row)}`,
    `Parent Record Key: ${buildRecordKey(row)}`,
    `Record Type: ${normalizeCell(row['Record Type'])}`,
    `W/O or Quote Number: ${normalizeCell(row['W/O or Quote Number'])}`,
    `Line Item ID: ${normalizeCell(row['Line Item ID'])}`,
    `Status: ${normalizeCell(row.Status)}`,
    `Created: ${normalizeCell(row.Created)}`,
    `Customer: ${normalizeCell(row['Shipping Customer Name'] || row['Billing Customer Name'])}`,
    `Ship Via: ${normalizeCell(row['Ship Via'])}`,
    `Location: ${normalizeCell(row.Location)}`,
    `Detail (IPN): ${normalizeCell(row['Detail (IPN)'])}`,
    `Stock #: ${normalizeCell(row['Stock #'])}`,
    `R Number: ${normalizeCell(row['R#'])}`,
    `Notes: ${normalizeCell(row.Notes)}`
  ];
  if (pictureLinks.length > 0) {
    lines.push('Part Pictures:');
    pictureLinks.forEach(link => lines.push(link));
  }
  return lines.join('\n');
}

function buildPriorityAlert(shipVia = '') {
  const normalized = normalizeUpper(shipVia);
  return PRIORITY_SHIP_VIA.has(normalized) ? 'Priority' : '';
}

function normalizeMoneyFieldValue(value = '') {
  const text = normalizeCell(value);
  if (!text) return '';
  const numericText = text.replace(/[^0-9.-]/g, '');
  if (!numericText) return '';
  const numericValue = Number(numericText);
  if (!Number.isFinite(numericValue)) return text;
  return numericValue;
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

function extractTaskKey(task = {}) {
  const byName = parseTaskKeyFromName(task?.name);
  if (byName) return byName;
  return parseTaskKeyFromDescription(task?.description);
}

function buildTaskMap(tasks = []) {
  const map = new Map();
  tasks.forEach(task => {
    const key = extractTaskKey(task);
    if (!key || map.has(key)) return;
    map.set(key, task);
  });
  return map;
}

function getCustomFieldMetaMap(listData = {}) {
  const map = new Map();
  const canonicalMap = new Map();
  const fields = Array.isArray(listData?.fields) ? listData.fields : [];
  fields.forEach(field => {
    const rawName = normalizeCell(field?.name);
    const name = normalizeUpper(rawName);
    if (!name) return;
    map.set(name, field);
    const canonical = canonicalFieldName(rawName);
    if (canonical && !canonicalMap.has(canonical)) canonicalMap.set(canonical, field);
  });
  return { byName: map, byCanonical: canonicalMap, fields };
}

function createEmptyFieldMetaLookup() {
  return { byName: new Map(), byCanonical: new Map(), fields: [] };
}

function mergeFieldMetaLookups(baseLookup = null, extraLookup = null) {
  const out = createEmptyFieldMetaLookup();
  const appendField = field => {
    const rawName = normalizeCell(field?.name);
    if (!rawName) return;
    const upperName = normalizeUpper(rawName);
    const canonical = canonicalFieldName(rawName);
    if (!out.byName.has(upperName)) out.byName.set(upperName, field);
    if (canonical && !out.byCanonical.has(canonical)) out.byCanonical.set(canonical, field);
    out.fields.push(field);
  };

  const seed = [baseLookup, extraLookup];
  seed.forEach(lookup => {
    if (!lookup) return;
    const fields = Array.isArray(lookup.fields) ? lookup.fields : [];
    fields.forEach(appendField);
  });

  return out;
}

function buildFieldMetaLookupFromTask(task = {}) {
  const lookup = createEmptyFieldMetaLookup();
  const fields = Array.isArray(task?.custom_fields) ? task.custom_fields : [];
  fields.forEach(field => {
    const rawName = normalizeCell(field?.name);
    if (!rawName) return;
    const upperName = normalizeUpper(rawName);
    const canonical = canonicalFieldName(rawName);
    if (!lookup.byName.has(upperName)) lookup.byName.set(upperName, field);
    if (canonical && !lookup.byCanonical.has(canonical)) lookup.byCanonical.set(canonical, field);
    lookup.fields.push(field);
  });
  return lookup;
}

function canonicalFieldName(value = '') {
  return normalizeCell(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveCustomFieldMeta(fieldMetaLookup, targetName = '') {
  const lookup = fieldMetaLookup || {};
  const byName = lookup.byName instanceof Map ? lookup.byName : new Map();
  const byCanonical = lookup.byCanonical instanceof Map ? lookup.byCanonical : new Map();
  const fields = Array.isArray(lookup.fields) ? lookup.fields : [];

  const exact = byName.get(normalizeUpper(targetName));
  if (exact) return exact;

  const canonicalTarget = canonicalFieldName(targetName);
  if (!canonicalTarget) return null;

  const canonicalExact = byCanonical.get(canonicalTarget);
  if (canonicalExact) return canonicalExact;

  for (const field of fields) {
    const candidate = canonicalFieldName(field?.name);
    if (!candidate) continue;
    if (candidate.includes(canonicalTarget) || canonicalTarget.includes(candidate)) return field;
  }
  return null;
}

function resolveDropdownOptionId(fieldMeta = null, targetLabel = '') {
  if (!fieldMeta || !fieldMeta.type_config || !Array.isArray(fieldMeta.type_config.options)) return null;
  const normalized = normalizeUpper(targetLabel);
  const canonicalTarget = canonicalFieldName(targetLabel);
  const option = fieldMeta.type_config.options.find(opt => {
    const name = normalizeUpper(opt?.name || '');
    const canonicalName = canonicalFieldName(opt?.name || '');
    return name === normalized || (canonicalTarget && canonicalName === canonicalTarget);
  });
  if (!option) return null;
  return String(option.id || option.orderindex || '').trim() || null;
}

function resolveLabelOptionId(fieldMeta = null, targetLabel = '') {
  if (!fieldMeta || !fieldMeta.type_config || !Array.isArray(fieldMeta.type_config.options)) return null;
  const normalized = normalizeUpper(targetLabel);
  const canonicalTarget = canonicalFieldName(targetLabel);
  const option = fieldMeta.type_config.options.find(opt => {
    const name = normalizeUpper(opt?.name || '');
    const label = normalizeUpper(opt?.label || '');
    const canonicalName = canonicalFieldName(opt?.name || '');
    const canonicalLabel = canonicalFieldName(opt?.label || '');
    return (
      name === normalized ||
      label === normalized ||
      (canonicalTarget && (canonicalName === canonicalTarget || canonicalLabel === canonicalTarget))
    );
  });
  if (!option) return null;
  return String(option.id || option.orderindex || '').trim() || null;
}

function buildTaskCustomFields(row = {}, fieldMetaLookup = null, dueDate = null) {
  const resolvedAssignee = resolveLocationAssigneeLabel(row.Location);
  const rawLocation = normalizeCell(row.Location);
  const rowKey = buildRecordKey(row);
  if (rawLocation && !resolvedAssignee) {
    console.warn(`[WorkOrders] No assignee mapping found for Location: ${rawLocation}`);
  } else if (resolvedAssignee) {
    console.log(`[WorkOrders] Assignee field set for ${rowKey || 'unknown'}: ${resolvedAssignee}`);
  }

  const valuesByFieldName = {
    [WORK_ORDERS_TASK_FIELD_NAMES.customer]: normalizeCell(
      row['Shipping Customer Name'] || row['Billing Customer Name']
    ),
    [WORK_ORDERS_TASK_FIELD_NAMES.shipVia]: normalizeCell(row['Ship Via']),
    [WORK_ORDERS_TASK_FIELD_NAMES.alert]: buildPriorityAlert(row['Ship Via']),
    [WORK_ORDERS_TASK_FIELD_NAMES.location]: normalizeCell(row.Location),
    [WORK_ORDERS_TASK_FIELD_NAMES.detail]: normalizeCell(row['Detail (IPN)']),
    [WORK_ORDERS_TASK_FIELD_NAMES.woQuoteNumber]: normalizeCell(row['W/O or Quote Number']),
    [WORK_ORDERS_TASK_FIELD_NAMES.totalPrice]: normalizeCell(row['Amount (Total)']),
    [WORK_ORDERS_TASK_FIELD_NAMES.poNumber]: normalizeCell(row['Customer PO']),
    [WORK_ORDERS_TASK_FIELD_NAMES.ebayOrderNumber]: normalizeCell(row['eBay Order Number']),
    [WORK_ORDERS_TASK_FIELD_NAMES.stock]: normalizeCell(row['Stock #']),
    [WORK_ORDERS_TASK_FIELD_NAMES.rNumber]: normalizeCell(row['R#']),
    [WORK_ORDERS_TASK_FIELD_NAMES.notes]: normalizeCell(row.Notes),
    [WORK_ORDERS_TASK_FIELD_NAMES.assignee]: resolvedAssignee,
    'Due Date': dueDate instanceof Date ? dueDate : null
  };

  const customFields = [];
  const missingFieldNames = [];
  for (const [name, value] of Object.entries(valuesByFieldName)) {
    const fieldMeta = resolveCustomFieldMeta(fieldMetaLookup, name);
    if (!fieldMeta || value === '') {
      if (!fieldMeta && value !== '' && name !== 'Due Date') missingFieldNames.push(name);
      continue;
    }

    let fieldValue = value;
    const fieldType = normalizeUpper(fieldMeta?.type);
    if (fieldType === 'DATE') {
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) continue;
      customFields.push({
        id: fieldMeta.id,
        payload: {
          value: Number(value.getTime()),
          time: true
        },
        fieldName: name,
        fieldType
      });
      continue;
    }
    if (name === WORK_ORDERS_TASK_FIELD_NAMES.totalPrice && (fieldType === 'NUMBER' || fieldType === 'CURRENCY')) {
      fieldValue = normalizeMoneyFieldValue(value);
      if (fieldValue === '') continue;
    }
    if (fieldType === 'DROP_DOWN') {
      const optionId = resolveDropdownOptionId(fieldMeta, value);
      if (!optionId) {
        if (name === WORK_ORDERS_TASK_FIELD_NAMES.assignee) {
          const options = Array.isArray(fieldMeta?.type_config?.options) ? fieldMeta.type_config.options : [];
          const optionNames = options
            .map(opt => normalizeCell(opt?.name || opt?.label || ''))
            .filter(Boolean)
            .join(', ');
          console.warn(
            `[WorkOrders] Assignee dropdown option not found. value='${value}', fieldType='${fieldType}', options='${optionNames}'`
          );
        }
        continue;
      }
      if (name === WORK_ORDERS_TASK_FIELD_NAMES.assignee) {
        console.log(
          `[WorkOrders] Assignee dropdown resolved. value='${value}', optionId='${optionId}', fieldId='${normalizeCell(fieldMeta?.id)}'`
        );
      }
      fieldValue = optionId;
    }
    if (fieldType === 'LABELS') {
      const labelId = resolveLabelOptionId(fieldMeta, value);
      if (!labelId) {
        if (name === WORK_ORDERS_TASK_FIELD_NAMES.assignee) {
          const options = Array.isArray(fieldMeta?.type_config?.options) ? fieldMeta.type_config.options : [];
          const optionNames = options
            .map(opt => normalizeCell(opt?.label || opt?.name || ''))
            .filter(Boolean)
            .join(', ');
          console.warn(
            `[WorkOrders] Assignee label option not found. value='${value}', fieldType='${fieldType}', options='${optionNames}'`
          );
        }
        continue;
      }
      if (name === WORK_ORDERS_TASK_FIELD_NAMES.assignee) {
        console.log(
          `[WorkOrders] Assignee label resolved. value='${value}', optionId='${labelId}', fieldId='${normalizeCell(fieldMeta?.id)}'`
        );
      }
      customFields.push({
        id: fieldMeta.id,
        payload: {
          value: [labelId]
        },
        fieldName: name,
        fieldType
      });
      continue;
    }
    if (
      name === WORK_ORDERS_TASK_FIELD_NAMES.assignee &&
      fieldType !== 'DROP_DOWN' &&
      fieldType !== 'LABELS'
    ) {
      console.warn(
        `[WorkOrders] Assignee field type not supported for label mapping. fieldType='${fieldType}', fieldName='${normalizeCell(
          fieldMeta?.name
        )}', value='${value}'`
      );
    }

    customFields.push({
      id: fieldMeta.id,
      value: fieldValue,
      fieldName: name,
      fieldType
    });
  }
  if (missingFieldNames.length > 0) {
    console.warn(
      `[WorkOrders] Missing ClickUp custom fields for ${rowKey || 'unknown'}: ${missingFieldNames.join(', ')}`
    );
  }

  return customFields;
}

function getTaskCustomFieldById(task = {}, fieldId = '') {
  const id = normalizeCell(fieldId);
  if (!id) return null;
  const fields = Array.isArray(task?.custom_fields) ? task.custom_fields : [];
  return fields.find(field => normalizeCell(field?.id) === id) || null;
}

function normalizePrimitiveForCompare(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return normalizeCell(value);
}

function normalizeTokenForCompare(value) {
  return normalizeCell(value).replace(/\s+/g, ' ').toLowerCase();
}

function normalizeModeToken(value) {
  return normalizeCell(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeMultilineTextForCompare(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

function toEpochMsSafe(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    const candidates = [value.value, value.date, value.start, value.start_date, value.timestamp];
    for (const candidate of candidates) {
      const ms = toEpochMsSafe(candidate);
      if (ms !== null) return ms;
    }
  }
  return null;
}

function normalizeDateMsToMinute(value) {
  const ms = toEpochMsSafe(value);
  if (ms === null) return null;
  return Math.floor(ms / 60000) * 60000;
}

function normalizeArrayForCompare(values = []) {
  return values
    .map(item => {
      if (item && typeof item === 'object') {
        return normalizePrimitiveForCompare(item?.id || item?.value || item?.orderindex || item?.name || '');
      }
      return normalizePrimitiveForCompare(item);
    })
    .filter(Boolean)
    .sort();
}

function findMatchingOption(options = [], rawValue = null) {
  const candidates = [];
  if (rawValue && typeof rawValue === 'object') {
    candidates.push(rawValue.id, rawValue.value, rawValue.orderindex, rawValue.name, rawValue.label);
  } else {
    candidates.push(rawValue);
  }

  const candidateTokens = candidates.map(normalizeTokenForCompare).filter(Boolean);
  if (candidateTokens.length === 0) return null;

  return (
    options.find(opt => {
      const tokens = [
        normalizeTokenForCompare(opt?.id),
        normalizeTokenForCompare(opt?.orderindex),
        normalizeTokenForCompare(opt?.name),
        normalizeTokenForCompare(opt?.label)
      ].filter(Boolean);
      return tokens.some(token => candidateTokens.includes(token));
    }) || null
  );
}

function normalizeSelectSingleValueForCompare(rawValue = null, options = []) {
  const matched = findMatchingOption(options, rawValue);
  if (matched) {
    const canonical = normalizeTokenForCompare(
      matched?.id || matched?.orderindex || matched?.name || matched?.label || ''
    );
    return canonical ? `opt:${canonical}` : '';
  }

  if (rawValue && typeof rawValue === 'object') {
    return normalizeTokenForCompare(rawValue?.id || rawValue?.value || rawValue?.orderindex || rawValue?.name || rawValue?.label || '');
  }
  return normalizeTokenForCompare(rawValue);
}

function normalizeLabelsForCompare(rawValue = null, options = []) {
  const values = Array.isArray(rawValue) ? rawValue : [rawValue];
  return values
    .map(item => normalizeSelectSingleValueForCompare(item, options))
    .filter(Boolean)
    .sort();
}

function arraysEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function extractTaskFieldRawComparableValue(taskField = null) {
  if (!taskField) return '';
  const fieldType = normalizeUpper(taskField?.type);
  const raw = taskField?.value;
  if (raw === null || raw === undefined) return '';
  const options = Array.isArray(taskField?.type_config?.options) ? taskField.type_config.options : [];

  if (fieldType === 'DATE') {
    const ms = normalizeDateMsToMinute(raw);
    return ms === null ? '' : String(ms);
  }

  if (fieldType === 'DROP_DOWN') {
    return normalizeSelectSingleValueForCompare(raw, options);
  }

  if (fieldType === 'LABELS') {
    return normalizeLabelsForCompare(raw, options);
  }

  if (typeof raw === 'object') {
    return normalizePrimitiveForCompare(raw?.id || raw?.value || raw?.orderindex || raw?.name || '');
  }
  return normalizePrimitiveForCompare(raw);
}

function extractPlannedFieldComparableValue(plannedField = null) {
  if (!plannedField || typeof plannedField !== 'object') return '';
  const plannedFieldType = normalizeUpper(plannedField?.fieldType);
  const options = Array.isArray(plannedField?.options) ? plannedField.options : [];
  if (plannedFieldType === 'DATE') {
    const plannedValue = plannedField?.payload?.value ?? plannedField?.value;
    const ms = normalizeDateMsToMinute(plannedValue);
    return ms === null ? '' : String(ms);
  }
  if (plannedFieldType === 'DROP_DOWN') {
    const plannedValue = plannedField?.payload?.value ?? plannedField?.value;
    return normalizeSelectSingleValueForCompare(plannedValue, options);
  }
  if (plannedFieldType === 'LABELS') {
    const plannedValue = plannedField?.payload?.value ?? plannedField?.value;
    return normalizeLabelsForCompare(plannedValue, options);
  }
  if (plannedField.payload && Object.prototype.hasOwnProperty.call(plannedField.payload, 'value')) {
    const payloadValue = plannedField.payload.value;
    if (Array.isArray(payloadValue)) return normalizeArrayForCompare(payloadValue);
    return normalizePrimitiveForCompare(payloadValue);
  }
  return normalizePrimitiveForCompare(plannedField.value);
}

function hasCustomFieldChanged(existingTask = {}, plannedField = null) {
  if (!plannedField) return false;
  const fieldId = normalizeCell(plannedField?.id);
  if (!fieldId) return false;
  const taskField = getTaskCustomFieldById(existingTask, fieldId);
  const existingValue = extractTaskFieldRawComparableValue(taskField);
  const plannedValue = extractPlannedFieldComparableValue(plannedField);

  if (Array.isArray(existingValue) || Array.isArray(plannedValue)) {
    const left = Array.isArray(existingValue) ? existingValue : normalizeArrayForCompare([existingValue]);
    const right = Array.isArray(plannedValue) ? plannedValue : normalizeArrayForCompare([plannedValue]);
    return !arraysEqual(left, right);
  }

  return normalizePrimitiveForCompare(existingValue) !== normalizePrimitiveForCompare(plannedValue);
}

function getTaskDueDateMs(task = {}) {
  const raw = task?.due_date;
  if (raw === null || raw === undefined || raw === '') return null;
  const ms = Number(raw);
  return Number.isFinite(ms) ? ms : null;
}

function buildChangedTaskPayload(existingTask = {}, taskPayload = {}) {
  const changes = {};
  const existingName = normalizeCell(existingTask?.name);
  const desiredName = normalizeCell(taskPayload?.name);
  if (desiredName && desiredName !== existingName) {
    changes.name = desiredName;
  }

  const existingDescription = normalizeMultilineTextForCompare(existingTask?.description);
  const desiredDescription = normalizeMultilineTextForCompare(taskPayload?.description);
  if (desiredDescription !== existingDescription) {
    changes.description = taskPayload.description || '';
  }

  if (Object.prototype.hasOwnProperty.call(taskPayload, 'due_date')) {
    const desiredDueDate = Number(taskPayload.due_date);
    const existingDueDate = getTaskDueDateMs(existingTask);
    if (Number.isFinite(desiredDueDate) && desiredDueDate !== existingDueDate) {
      changes.due_date = desiredDueDate;
      changes.due_date_time = true;
    }
  }

  return changes;
}

function getCustomFieldDisplayValue(field = null) {
  if (!field) return '';
  const raw = field?.value;
  if (raw === null || raw === undefined) return '';

  const fieldType = normalizeUpper(field?.type);
  if (fieldType === 'DROP_DOWN') {
    const options = Array.isArray(field?.type_config?.options) ? field.type_config.options : [];
    const valueId = String(raw);
    const option =
      options.find(opt => String(opt?.id || '') === valueId) ||
      options.find(opt => String(opt?.orderindex || '') === valueId);
    return normalizeCell(option?.name || raw);
  }

  if (fieldType === 'LABELS') {
    const options = Array.isArray(field?.type_config?.options) ? field.type_config.options : [];
    const values = Array.isArray(raw) ? raw : [raw];
    const names = values
      .map(item => {
        const valueId = String(item);
        const option =
          options.find(opt => String(opt?.id || '') === valueId) ||
          options.find(opt => String(opt?.orderindex || '') === valueId);
        return normalizeCell(option?.label || option?.name || '');
      })
      .filter(Boolean);
    if (names.length > 0) return names.join(', ');
    return values.map(v => String(v)).join(', ');
  }

  if (typeof raw === 'object') {
    return normalizeCell(raw?.name || raw?.label || raw?.value || '');
  }
  return normalizeCell(raw);
}

async function verifyAssigneeFieldValue(clickup, taskId, assigneeFieldId, expectedLabel, rowKey) {
  const id = normalizeCell(taskId);
  const fieldId = normalizeCell(assigneeFieldId);
  const expected = normalizeCell(expectedLabel);
  if (!id || !fieldId || !expected) return;

  try {
    const task = await clickup.getTask(id);
    const field = getTaskCustomFieldById(task, fieldId);
    if (!field) {
      console.warn(
        `[WorkOrders] Assignee verify: field not found on task. taskId='${id}', fieldId='${fieldId}', row='${rowKey || 'unknown'}'`
      );
      return;
    }
    const actual = getCustomFieldDisplayValue(field);
    const fieldType = normalizeUpper(field?.type);
    const rawValue = field?.value;
    if (normalizeUpper(actual) !== normalizeUpper(expected)) {
      console.warn(
        `[WorkOrders] Assignee verify mismatch. row='${rowKey || 'unknown'}', expected='${expected}', actual='${actual}', fieldType='${fieldType}', fieldId='${fieldId}', raw='${JSON.stringify(
          rawValue
        )}'`
      );
    } else {
      console.log(
        `[WorkOrders] Assignee verify success. row='${rowKey || 'unknown'}', value='${actual}', fieldType='${fieldType}', fieldId='${fieldId}'`
      );
    }
  } catch (error) {
    console.warn(`[WorkOrders] Assignee verify failed for ${rowKey || id}: ${error?.message || error}`);
  }
}

async function verifyTaskCustomFields(clickup, taskId, customFields = [], rowKey = '', result = null) {
  const id = normalizeCell(taskId);
  const fieldsToVerify = Array.isArray(customFields) ? customFields.filter(field => normalizeCell(field?.id)) : [];
  if (!id || fieldsToVerify.length === 0) {
    return { verifiedFields: 0, mismatches: 0, errors: 0 };
  }

  try {
    const task = await clickup.getTask(id);
    let verifiedFields = 0;
    let mismatches = 0;

    for (const plannedField of fieldsToVerify) {
      const taskField = getTaskCustomFieldById(task, plannedField.id);
      const fieldName = normalizeCell(plannedField?.fieldName || plannedField?.id);
      if (!taskField) {
        mismatches += 1;
        console.warn(
          `[WorkOrders] ClickUp verify mismatch for ${rowKey || id}: field '${fieldName}' not found after update`
        );
        continue;
      }

      const changed = hasCustomFieldChanged({ custom_fields: [taskField] }, plannedField);
      if (changed) {
        mismatches += 1;
        const actual = getCustomFieldDisplayValue(taskField);
        console.warn(
          `[WorkOrders] ClickUp verify mismatch for ${rowKey || id}: field '${fieldName}' expected write did not round-trip cleanly (actual='${actual}')`
        );
      } else {
        verifiedFields += 1;
      }
    }

    if (result) {
      result.verifiedTasks = Number(result.verifiedTasks || 0) + 1;
      result.verifiedFields = Number(result.verifiedFields || 0) + verifiedFields;
      result.verifyMismatches = Number(result.verifyMismatches || 0) + mismatches;
    }

    console.log(
      `[WorkOrders] ClickUp verify completed for ${rowKey || id}: verifiedFields=${verifiedFields}, mismatches=${mismatches}`
    );

    return { verifiedFields, mismatches, errors: 0 };
  } catch (error) {
    const message = error?.message || String(error);
    console.warn(`[WorkOrders] ClickUp verify failed for ${rowKey || id}: ${message}`);
    if (result) {
      result.verifyErrors = Number(result.verifyErrors || 0) + 1;
      if (Array.isArray(result.errors)) {
        result.errors.push(`ClickUp verify failed for ${rowKey || id}: ${message}`);
      }
    }
    return { verifiedFields: 0, mismatches: 0, errors: 1 };
  }
}

async function applyTaskCustomFields(clickup, taskId, customFields = [], recordKey = '', result = null) {
  const id = normalizeCell(taskId);
  if (!id || !Array.isArray(customFields) || customFields.length === 0) return;

  let updatedCount = 0;
  for (const field of customFields) {
    const fieldId = normalizeCell(field?.id);
    if (!fieldId) continue;
    try {
      const body = field && typeof field.payload === 'object' && field.payload !== null
        ? field.payload
        : { value: field.value };
      await clickup.request('POST', `/task/${id}/field/${fieldId}`, {
        data: body
      });
      updatedCount += 1;
    } catch (error) {
      const message =
        error?.response?.data?.err ||
        error?.response?.data?.error ||
        error?.message ||
        String(error);
      console.error(`[WorkOrders] Custom field write failed for ${recordKey || id} (field=${fieldId}): ${message}`);
      if (result && Array.isArray(result.errors)) {
        result.errors.push(
          `ClickUp custom field update failed for ${recordKey || id} (field=${fieldId}): ${message}`
        );
      }
    }
  }
  console.log(`[WorkOrders] Custom fields updated for ${recordKey || id}: count=${updatedCount}`);
}

async function mapWithConcurrency(items, mapper, concurrency = 1) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const maxWorkers = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: maxWorkers }, () => worker());
  await Promise.all(workers);
  return results;
}

async function syncRowsToClickUp({
  clickupToken = '',
  clickupListId = '',
  latestRows = [],
  summary = {}
}) {
  const result = {
    enabled: false,
    created: 0,
    updated: 0,
    skippedUnchanged: 0,
    closed: 0,
    skippedCompleteQuotes: 0,
    skippedCompleteQuoteNumbers: [],
    verifiedTasks: 0,
    verifiedFields: 0,
    verifyMismatches: 0,
    verifyErrors: 0,
    errors: []
  };

  if (!normalizeCell(clickupToken) || !normalizeCell(clickupListId)) {
    return result;
  }
  result.enabled = true;

  const clickup = new ClickUpService({
    token: clickupToken,
    listId: clickupListId
  });

  const list = await clickup.getList();
  let customFieldMeta = getCustomFieldMetaMap(list);
  const completedStatusNames = getCompletedStatusNamesFromList(list);
  const tasks = await clickup.fetchTasksByStatuses([], {
    includeClosed: true,
    subtasks: false
  });
  const taskByKey = buildTaskMap(tasks);
  let assigneeVerificationCount = 0;
  const assigneeVerificationLimit = 20;
  const assigneeVerificationEnabled = String(process.env.WORK_ORDERS_CLICKUP_VERIFY_ASSIGNEE || '').trim() === '1';
  const verifyMode = normalizeModeToken(process.env.WORK_ORDERS_CLICKUP_VERIFY_MODE || 'none');
  const updatedVerifyLimitRaw = Number.parseInt(process.env.WORK_ORDERS_CLICKUP_VERIFY_UPDATED_LIMIT || '20', 10);
  const updatedVerifyLimit = Number.isFinite(updatedVerifyLimitRaw) ? Math.max(0, updatedVerifyLimitRaw) : 20;
  const clickupConcurrencyRaw = Number.parseInt(process.env.WORK_ORDERS_CLICKUP_SYNC_CONCURRENCY || '5', 10);
  const clickupConcurrency = Number.isFinite(clickupConcurrencyRaw)
    ? Math.max(1, Math.min(clickupConcurrencyRaw, WORK_ORDERS_CLICKUP_MAX_CONCURRENCY))
    : 3;
  let updatedVerifyCount = 0;

  function shouldVerifyCreatedCustomFields() {
    return verifyMode !== 'none' && verifyMode !== 'updatedonly';
  }

  function shouldVerifyUpdatedCustomFields() {
    if (verifyMode === 'none' || verifyMode === 'createdonly') return false;
    if (verifyMode === 'all') return true;
    if (verifyMode === 'sample') {
      if (updatedVerifyCount >= updatedVerifyLimit) return false;
      updatedVerifyCount += 1;
      return true;
    }
    if (updatedVerifyCount >= updatedVerifyLimit) return false;
    updatedVerifyCount += 1;
    return true;
  }

  function reserveAssigneeVerificationSlot() {
    if (!assigneeVerificationEnabled) return false;
    if (assigneeVerificationCount >= assigneeVerificationLimit) return false;
    assigneeVerificationCount += 1;
    return true;
  }

  if (assigneeVerificationEnabled) {
    console.log(`[WorkOrders] Assignee verify mode enabled (limit=${assigneeVerificationLimit})`);
  }
  console.log(
    `[WorkOrders] ClickUp sync settings: concurrency=${clickupConcurrency}, verifyMode=${verifyMode}, updatedVerifyLimit=${updatedVerifyLimit}`
  );
  const listFieldCount = Array.isArray(customFieldMeta.fields) ? customFieldMeta.fields.length : 0;
  console.log(`[WorkOrders] ClickUp list field metadata discovered: ${listFieldCount}`);
  console.log(
    `[WorkOrders] ClickUp completed statuses detected: ${Array.from(completedStatusNames).join(', ') || 'none'}`
  );

  if (listFieldCount === 0 && tasks.length > 0) {
    try {
      const seedTaskId = normalizeCell(tasks[0]?.id);
      if (seedTaskId) {
        const taskDetail = await clickup.getTask(seedTaskId);
        const taskFieldMeta = buildFieldMetaLookupFromTask(taskDetail);
        customFieldMeta = mergeFieldMetaLookups(customFieldMeta, taskFieldMeta);
        console.log(
          `[WorkOrders] ClickUp task-field metadata fallback discovered: ${Array.isArray(customFieldMeta.fields) ? customFieldMeta.fields.length : 0}`
        );
      }
    } catch (error) {
      console.warn(`[WorkOrders] ClickUp task-field metadata fallback failed: ${error?.message || error}`);
    }
  }

  const filteredRows = [];
  console.log(`[WorkOrders] Rows read from Google Sheets for ClickUp sync: ${latestRows.length}`);
  for (const row of latestRows) {
    const key = buildTaskKey(row);
    if (!key) continue;
    const existingTask = taskByKey.get(key);
    if (isCheckPartQuote(row) && existingTask && isCompleteStatus(existingTask?.status?.status || existingTask?.status, completedStatusNames)) {
      const quoteNumber = normalizeCell(row['W/O or Quote Number']);
      if (quoteNumber && !result.skippedCompleteQuoteNumbers.includes(quoteNumber)) {
        result.skippedCompleteQuoteNumbers.push(quoteNumber);
      }
      result.skippedCompleteQuotes += 1;
      continue;
    }
    filteredRows.push(row);
  }

  const uniqueFilteredRows = [];
  const seenRowKeys = new Set();
  for (const row of filteredRows) {
    const key = buildTaskKey(row);
    if (!key || seenRowKeys.has(key)) continue;
    seenRowKeys.add(key);
    uniqueFilteredRows.push(row);
  }

  await mapWithConcurrency(uniqueFilteredRows, async row => {
    const key = buildTaskKey(row);
    if (!key) return;
    const existingTask = taskByKey.get(key);
    const dueDate = computeDueDate(row.Created, row['Ship Via']);
    const customFields = buildTaskCustomFields(row, customFieldMeta, dueDate).map(field => {
      const fieldMeta = resolveCustomFieldMeta(customFieldMeta, field.fieldName);
      const options = Array.isArray(fieldMeta?.type_config?.options) ? fieldMeta.type_config.options : [];
      return {
        ...field,
        options
      };
    });
    const resolvedAssignee = resolveLocationAssigneeLabel(row.Location);
    if (dueDate) {
      console.log(`[WorkOrders] Due date calculated for ${key}: ${dueDate.toISOString()}`);
    }

    const taskPayload = {
      name: buildTaskName(row),
      description: buildTaskDescription(row)
    };
    if (dueDate) {
      taskPayload.due_date = Number(dueDate.getTime());
      taskPayload.due_date_time = true;
    }

    try {
      if (!existingTask) {
        const createPayload = {
          ...taskPayload,
          status: CLICKUP_OPEN_STATUS
        };
        let createdTask = null;
        try {
          createdTask = await clickup.request('POST', `/list/${clickupListId}/task`, {
            data: createPayload
          });
        } catch (createError) {
          if (Number(createError?.response?.status || 0) === 400) {
            const fallbackPayload = { ...createPayload };
            delete fallbackPayload.status;
            createdTask = await clickup.request('POST', `/list/${clickupListId}/task`, {
              data: fallbackPayload
            });
          } else {
            throw createError;
          }
        }
        const createdTaskId = normalizeCell(createdTask?.id || createdTask?.task?.id);
        if (createdTaskId) {
          await applyTaskCustomFields(clickup, createdTaskId, customFields, key, result);
          if (customFields.length > 0 && shouldVerifyCreatedCustomFields()) {
            await verifyTaskCustomFields(clickup, createdTaskId, customFields, key, result);
          }
          const assigneeField = customFields.find(
            field => normalizeCell(field?.fieldName) === WORK_ORDERS_TASK_FIELD_NAMES.assignee
          );
          if (resolvedAssignee && assigneeField?.id && reserveAssigneeVerificationSlot()) {
            await verifyAssigneeFieldValue(clickup, createdTaskId, assigneeField.id, resolvedAssignee, key);
          }
          console.log(`[WorkOrders] Task created: ${key}`);
        }
        result.created += 1;
      } else {
        if (!isCompleteStatus(existingTask?.status?.status || existingTask?.status, completedStatusNames)) {
          const changedTaskPayload = buildChangedTaskPayload(existingTask, taskPayload);
          const changedCustomFields = customFields.filter(field => hasCustomFieldChanged(existingTask, field));
          if (changedCustomFields.length > 0) {
            const changedNames = changedCustomFields
              .map(field => normalizeCell(field?.fieldName))
              .filter(Boolean)
              .join(', ');
            console.log(`[WorkOrders] Changed custom fields for ${key}: ${changedNames}`);
          }

          if (Object.keys(changedTaskPayload).length === 0 && changedCustomFields.length === 0) {
            console.log(`[WorkOrders] Task skipped (unchanged): ${key}`);
            result.skippedUnchanged += 1;
            return;
          }

          if (Object.keys(changedTaskPayload).length > 0) {
            await clickup.request('PUT', `/task/${existingTask.id}`, {
              data: changedTaskPayload
            });
          }

          if (changedCustomFields.length > 0) {
            await applyTaskCustomFields(clickup, existingTask.id, changedCustomFields, key, result);
            if (shouldVerifyUpdatedCustomFields()) {
              await verifyTaskCustomFields(clickup, existingTask.id, changedCustomFields, key, result);
            }
          }
          const assigneeField = changedCustomFields.find(
            field => normalizeCell(field?.fieldName) === WORK_ORDERS_TASK_FIELD_NAMES.assignee
          );
          if (resolvedAssignee && assigneeField?.id && reserveAssigneeVerificationSlot()) {
            await verifyAssigneeFieldValue(clickup, existingTask.id, assigneeField.id, resolvedAssignee, key);
          }
          console.log(`[WorkOrders] Task updated: ${key}`);
          result.updated += 1;
        } else {
          console.log(`[WorkOrders] Task skipped (status preserved): ${key}`);
        }
      }
    } catch (error) {
      const message =
        error?.response?.data?.err ||
        error?.response?.data?.error ||
        error?.message ||
        String(error);
      result.errors.push(`ClickUp sync failed for ${key}: ${message}`);
    }
  }, clickupConcurrency);

  const latestKeys = new Set(uniqueFilteredRows.map(row => buildTaskKey(row)).filter(Boolean));
  for (const [key, task] of taskByKey.entries()) {
    if (latestKeys.has(key)) continue;
    if (isCompleteStatus(task?.status?.status || task?.status, completedStatusNames)) continue;
    try {
      await clickup.updateTaskStatus(task.id, CLICKUP_COMPLETE_STATUS);
      console.log(`[WorkOrders] Task completed (no longer active): ${key}`);
      result.closed += 1;
    } catch (error) {
      const message =
        error?.response?.data?.err ||
        error?.response?.data?.error ||
        error?.message ||
        String(error);
      result.errors.push(`ClickUp close failed for ${key}: ${message}`);
    }
  }

  if (Array.isArray(summary.errors) && result.errors.length > 0) {
    summary.errors.push(...result.errors);
  }

  return {
    ...result,
    filteredRows: uniqueFilteredRows
  };
}

async function syncWorkOrdersRowsToSheet({ authClient, spreadsheetId, latestRows, sheetName = DEFAULT_WORK_ORDERS_SHEET_NAME }) {
  const sheets = await getSheetsClient(authClient);
  await ensureSheetExists(sheets, spreadsheetId, sheetName);

  console.log('[WorkOrders] Google Sheet read started');
  const existing = await readExistingRows(sheets, spreadsheetId, sheetName);

  const existingMap = new Map();
  existing.rows.forEach(row => {
    const key = buildSheetRowKey(row);
    if (!key) return;
    existingMap.set(key, row);
  });

  const latestMap = new Map();
  latestRows.forEach(rawRow => {
    const row = toSheetRowObject(rawRow);
    const key = buildSheetRowKey(row);
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

async function readWorkOrdersRowsFromSheet({ authClient, spreadsheetId, sheetName = DEFAULT_WORK_ORDERS_SHEET_NAME }) {
  const sheets = await getSheetsClient(authClient);
  await ensureSheetExists(sheets, spreadsheetId, sheetName);
  const existing = await readExistingRows(sheets, spreadsheetId, sheetName);
  return existing.rows || [];
}

async function runClickUpSyncFromSheet({
  authClient,
  spreadsheetId,
  sheetName = DEFAULT_WORK_ORDERS_SHEET_NAME,
  clickupToken = '',
  clickupListId = ''
}) {
  const summary = {
    rowsRead: 0,
    tasksCreated: 0,
    tasksUpdated: 0,
    tasksCompleted: 0,
    quoteRowsRemovedFromSheet: 0,
    skippedCompleteQuoteNumbers: [],
    verifiedTasks: 0,
    verifiedFields: 0,
    verifyMismatches: 0,
    verifyErrors: 0,
    errors: []
  };

  console.log('[WorkOrders] ClickUp sync started');
  const sheetRows = await readWorkOrdersRowsFromSheet({
    authClient,
    spreadsheetId,
    sheetName
  });
  summary.rowsRead = sheetRows.length;

  const clickupResult = await syncRowsToClickUp({
    clickupToken,
    clickupListId,
    latestRows: sheetRows,
    summary
  });

  summary.tasksCreated = Number(clickupResult.created || 0);
  summary.tasksUpdated = Number(clickupResult.updated || 0);
  summary.tasksCompleted = Number(clickupResult.closed || 0);
  summary.quoteRowsRemovedFromSheet = Number(clickupResult.skippedCompleteQuotes || 0);
  summary.skippedCompleteQuoteNumbers = Array.isArray(clickupResult.skippedCompleteQuoteNumbers)
    ? [...clickupResult.skippedCompleteQuoteNumbers]
    : [];
  summary.verifiedTasks = Number(clickupResult.verifiedTasks || 0);
  summary.verifiedFields = Number(clickupResult.verifiedFields || 0);
  summary.verifyMismatches = Number(clickupResult.verifyMismatches || 0);
  summary.verifyErrors = Number(clickupResult.verifyErrors || 0);

  if (Array.isArray(clickupResult.filteredRows) && clickupResult.filteredRows.length !== sheetRows.length) {
    await syncWorkOrdersRowsToSheet({
      authClient,
      spreadsheetId,
      latestRows: clickupResult.filteredRows,
      sheetName
    });
    if (summary.quoteRowsRemovedFromSheet > 0) {
      console.log(
        `[WorkOrders] Quote completed and removed from sheet: count=${summary.quoteRowsRemovedFromSheet}`
      );
    }
  }

  console.log(
    `[WorkOrders] ClickUp sync completed: created=${summary.tasksCreated}, updated=${summary.tasksUpdated}, completed=${summary.tasksCompleted}, quoteRemoved=${summary.quoteRowsRemovedFromSheet}, verifiedTasks=${summary.verifiedTasks}, verifiedFields=${summary.verifiedFields}, verifyMismatches=${summary.verifyMismatches}, verifyErrors=${summary.verifyErrors}`
  );
  return summary;
}

async function runWorkOrdersSync({
  authClient,
  spreadsheetId,
  sheetName = DEFAULT_WORK_ORDERS_SHEET_NAME,
  driveAuthClient = null,
  driveFolderId = '',
  driveServiceAccountKeyPath = '',
  imageUploadFallback = '',
  clickupToken = '',
  clickupListId = '',
  onProgress = null
}) {
  const emitProgress = (message, partialSummary = {}) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({
        message,
        summary: {
          stage: normalizeCell(partialSummary.stage),
          ...partialSummary
        }
      });
    } catch (_) {
      // Best-effort progress event; never fail the sync because UI logging failed.
    }
  };

  const summary = {
    fetched: 0,
    quoteRowsSuppressedBeforeSheet: 0,
    inserted: 0,
    updated: 0,
    removed: 0,
    imagesUploaded: 0,
    imagesSkipped: 0,
    clickupTasksCreated: 0,
    clickupTasksUpdated: 0,
    clickupTasksCompleted: 0,
    clickupRowsSkippedCompleteOverride: 0,
    verifiedTasks: 0,
    verifiedFields: 0,
    verifyMismatches: 0,
    verifyErrors: 0,
    errors: []
  };

  console.log('[WorkOrders] Work Orders sync started');
  console.log('[WorkOrders] Powerlink SQL query started');
  emitProgress('Powerlink query started', { stage: 'powerlink_query' });
  let rows = [];
  try {
    rows = await fetchWorkOrderRows();
    summary.fetched = rows.length;
    console.log(`[WorkOrders] Powerlink SQL query completed. fetched=${rows.length}`);
    emitProgress('Powerlink query completed', {
      stage: 'powerlink_query',
      fetched: rows.length
    });
  } catch (error) {
    const message = `Powerlink SQL query failed: ${error.message}`;
    console.error(`[WorkOrders] ${message}`);
    summary.errors.push(message);
    emitProgress('Powerlink query failed', {
      stage: 'powerlink_query',
      error: error.message
    });
    throw Object.assign(new Error(message), { summary });
  }

  if (normalizeCell(clickupToken) && normalizeCell(clickupListId)) {
    try {
      const clickup = new ClickUpService({
        token: clickupToken,
        listId: clickupListId
      });
      const clickupList = await clickup.getList();
      const completedStatusNames = getCompletedStatusNamesFromList(clickupList);
      const cachedCompletedQuoteNumbers = loadCompletedQuoteNumberCache();
      const clickupQuoteState = await getQuoteCompletionStateFromClickUp(clickup, completedStatusNames);
      const liveCompletedQuoteNumbers = clickupQuoteState?.completed instanceof Set
        ? clickupQuoteState.completed
        : new Set();
      const liveOpenQuoteNumbers = clickupQuoteState?.open instanceof Set
        ? clickupQuoteState.open
        : new Set();
      const completedQuoteNumbers = mergeCompletedQuoteNumbers(
        cachedCompletedQuoteNumbers,
        liveCompletedQuoteNumbers
      );
      liveOpenQuoteNumbers.forEach(quoteNumber => {
        completedQuoteNumbers.delete(normalizeCell(quoteNumber));
      });

      const mergedCompletedQuoteNumbers = Array.from(completedQuoteNumbers);
      if (mergedCompletedQuoteNumbers.length > 0 || cachedCompletedQuoteNumbers.size > 0) {
        saveCompletedQuoteNumberCache(mergedCompletedQuoteNumbers);
      }

      if (completedQuoteNumbers.size > 0) {
        const beforeCount = rows.length;
        rows = rows.filter(row => {
          if (!isQuoteRow(row)) return true;
          const quoteNumber = normalizeCell(row['W/O or Quote Number']);
          return !quoteNumber || !completedQuoteNumbers.has(quoteNumber);
        });
        summary.quoteRowsSuppressedBeforeSheet = beforeCount - rows.length;
        if (summary.quoteRowsSuppressedBeforeSheet > 0) {
          console.log(
            `[WorkOrders] Completed quotes suppressed before sheet sync: count=${summary.quoteRowsSuppressedBeforeSheet}`
          );
        }
      }
    } catch (error) {
      console.warn(`[WorkOrders] Completed quote suppression check failed: ${error?.message || error}`);
    }
  }

  console.log('[WorkOrders] Image upload started');
  emitProgress('Image conversion started', {
    stage: 'image_conversion',
    fetched: rows.length
  });
  setDriveImageRuntimeConfig({
    authClient: driveAuthClient || null,
    driveFolderId,
    serviceAccountKeyPath: driveServiceAccountKeyPath,
    fallback: imageUploadFallback
  });
  const driveConfigStatus = getDriveConfigStatus();
  if (!driveConfigStatus.ok) {
    const warning = `Drive image upload disabled: ${driveConfigStatus.message}`;
    summary.errors.push(warning);
    console.warn(`[WorkOrders] ${warning}`);
  }
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
  emitProgress('Image conversion completed', {
    stage: 'image_conversion',
    imagesUploaded: stats.uploaded,
    imagesCached: stats.cached,
    imagesMissing: stats.missing,
    imagesFailed: stats.failed
  });

  try {
    emitProgress('Google Sheet sync started', {
      stage: 'google_sheet_sync'
    });
    const sheetSyncResult = await syncWorkOrdersRowsToSheet({
      authClient,
      spreadsheetId,
      latestRows: rows,
      sheetName
    });
    summary.inserted = sheetSyncResult.inserted;
    summary.updated = sheetSyncResult.updated;
    summary.removed = sheetSyncResult.removed;
    emitProgress('Google Sheet sync completed', {
      stage: 'google_sheet_sync',
      inserted: summary.inserted,
      updated: summary.updated,
      removed: summary.removed
    });
  } catch (error) {
    const message = `Google Sheets sync failed: ${error.message}`;
    console.error(`[WorkOrders] ${message}`);
    summary.errors.push(message);
    emitProgress('Google Sheet sync failed', {
      stage: 'google_sheet_sync',
      error: error.message
    });
    throw Object.assign(new Error(message), { summary });
  }

  try {
    emitProgress('ClickUp sync started', {
      stage: 'clickup_sync'
    });
    const clickupSummary = await runClickUpSyncFromSheet({
      authClient,
      spreadsheetId,
      sheetName,
      clickupToken,
      clickupListId
    });
    summary.clickupTasksCreated = Number(clickupSummary.tasksCreated || 0);
    summary.clickupTasksUpdated = Number(clickupSummary.tasksUpdated || 0);
    summary.clickupTasksCompleted = Number(clickupSummary.tasksCompleted || 0);
    summary.clickupRowsSkippedCompleteOverride = Number(clickupSummary.quoteRowsRemovedFromSheet || 0);
    summary.verifiedTasks = Number(clickupSummary.verifiedTasks || 0);
    summary.verifiedFields = Number(clickupSummary.verifiedFields || 0);
    summary.verifyMismatches = Number(clickupSummary.verifyMismatches || 0);
    summary.verifyErrors = Number(clickupSummary.verifyErrors || 0);

    if (Array.isArray(clickupSummary.skippedCompleteQuoteNumbers) && clickupSummary.skippedCompleteQuoteNumbers.length > 0) {
      const cache = loadCompletedQuoteNumberCache();
      const merged = mergeCompletedQuoteNumbers(cache, clickupSummary.skippedCompleteQuoteNumbers);
      saveCompletedQuoteNumberCache(Array.from(merged));
      console.log(
        `[WorkOrders] Cached completed quote numbers updated from ClickUp sync: count=${clickupSummary.skippedCompleteQuoteNumbers.length}`
      );
    }

    emitProgress('ClickUp sync completed', {
      stage: 'clickup_sync',
      tasksCreated: summary.clickupTasksCreated,
      tasksUpdated: summary.clickupTasksUpdated,
      tasksCompleted: summary.clickupTasksCompleted,
      verifiedFields: summary.verifiedFields,
      verifyMismatches: summary.verifyMismatches,
      verifyErrors: summary.verifyErrors
    });
    if (!normalizeCell(clickupToken) || !normalizeCell(clickupListId)) {
      console.warn('[WorkOrders] ClickUp sync skipped: missing token/list configuration');
      emitProgress('ClickUp sync skipped: missing token/list configuration', {
        stage: 'clickup_sync',
        skipped: true,
        reason: 'missing_clickup_config'
      });
    }
  } catch (error) {
    const message = `ClickUp sync failed: ${error.message}`;
    console.error(`[WorkOrders] ${message}`);
    summary.errors.push(message);
    emitProgress('ClickUp sync failed', {
      stage: 'clickup_sync',
      error: error.message
    });
  }

  console.log('[WorkOrders] Work Orders sync completed');
  return summary;
}

module.exports = {
  WORK_ORDERS_HEADERS,
  DEFAULT_WORK_ORDERS_SHEET_NAME,
  buildRecordKey,
  readWorkOrdersRowsFromSheet,
  runClickUpSyncFromSheet,
  syncWorkOrdersRowsToSheet,
  runWorkOrdersSync
};
