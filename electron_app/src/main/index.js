const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { loadEnv } = require('../config/loadEnv');
loadEnv();

const {
  saveDbConfig,
  getDbConfig,
  clearDbConfig,
  saveWebhookConfig,
  getWebhookConfig,
  clearWebhookConfig,
  saveReportingConfig,
  getReportingConfig,
  saveInventoryConfig,
  getInventoryConfig
} = require('../config/configStore');

const { initDb, initDbWindowsAuth } = require('../services/db');
// Reporting services
const { getInvoices, getSalespeople } = require('../services/reportingService');
const { generateExcelFile } = require('../services/excelService');
const { initialize: initSheets, writeToRawTab } = require('../services/sheetsService');
const { startSchedule, stopSchedule, resumeSchedule, logExecution, getExecutionLogs, executeScheduledJob } = require('../services/scheduleService');
const {
  runWorkOrdersSync,
  runClickUpSyncFromSheet,
  DEFAULT_WORK_ORDERS_SHEET_NAME
} = require('../services/workOrdersGoogleSheetsSync');
const {
  startWorkOrdersSchedule,
  stopWorkOrdersSchedule,
  resumeWorkOrdersSchedule,
  executeWorkOrdersScheduledJob,
  getWorkOrdersExecutionLogs,
  logWorkOrdersExecution,
  clearWorkOrdersExecutionLogs
} = require('../services/workOrdersScheduleService');
const oauth2Service = require('../services/oauth2Service');
const { runPhase2, buildPhase2Config } = require('../services/phase2Service');
const { runPhase3, buildPhase3Config, PARTSHUNTER_STORE_ID } = require('../services/phase3Service');
const { runPhase4Mirroring, buildPhase4Config, MIRROR_STATE_KEY } = require('../services/phase4MirroringService');
const { runItemSpecificTableSync } = require('../scripts/syncItemSpecificTables');
const { runPhase4RulesPopulate } = require('../scripts/runPhase4RulesPopulate');
const { runPhase4BLite, runPhase4BWritebackOnly, runPhase4CMFWritebackOnly, runPhase4CMF, runPhase4DListing } = require('../scripts/runPhase4BLite');
const { runPhase6Fitment } = require('../scripts/runPhase6Fitment');
const { runPhase72FitmentImage } = require('../scripts/runPhase72FitmentImage');
const { runPhase74TitleDescription } = require('../scripts/runPhase74TitleDescription');
const { runEbayMockImport } = require('../scripts/runEbayMockImport');
const { runEbaySandboxInventoryImport } = require('../scripts/runEbaySandboxInventoryImport');
const { runPhase5PublishApproved } = require('../services/phase5Service');
const { Phase5PublishLogService } = require('../services/phase5PublishLogService');
const {
  validateBatchGovernanceSchema,
  getBatchSummaries,
  setBatchStatus: setPhase5BatchStatus,
  getBatchListings
} = require('../services/phase5BatchGovernanceService');
const { createBatchFromListings } = require('../services/batchCreationService');
const {
  startPhase5AutoPushSchedule,
  stopPhase5AutoPushSchedule,
  runPhase5AutoPushNow,
  getPhase5AutoPushScheduleStatus
} = require('../services/phase5AutoPushScheduleService');
const ClickUpService = require('../services/clickupService');
const AirtableService = require('../services/airtableService');
const phase2WritebackPoller = require('../services/phase2WritebackPollerService');
const phase2AutoRunService = require('../services/phase2AutoRunService');

let mainWindow;
let phase4WritebackInterval = null;
let isPhase4WritebackPollerRunning = false;
let dbReady = false;
const LEGACY_EBAY_MOCK_TABLE = 'eBay Listings (API) (Mock)';
const DEFAULT_EBAY_SANDBOX_TABLE = 'eBay Listings (API)';
const DEFAULT_EBAY_LISTINGS_TABLE = 'eBay Listings (API)';
const DEFAULT_EBAY_FETCH_PAGING_MODE = 'first_page';
const DEFAULT_PHASE74_TITLE_RULES_PROMPT = [
  'eBay Title Rules Prompt',
  'Master Instructions - Follow Exactly',
  '1) Required title structure:',
  '[YEAR RANGE] [MAKE] [MODEL] [PART] [SIDE] [KEY DETAIL] OEM',
  '2) Title constraints:',
  '- Title length must be 65 to 80 characters.',
  '- Title must end with OEM.',
  '- OEM must appear once only, and only at the end.',
  '- Keep title clean, natural, and human-readable.',
  '- No keyword stuffing.',
  '3) Never change or remove:',
  '- Year must remain present after processing.',
  '- Make must not be changed.',
  '- Model must not be changed.',
  '4) Year handling:',
  '- Convert 2-digit ranges to 4-digit ranges (05-07 => 2005-2007, 13-19 => 2013-2019).',
  '- If year is missing, do not guess. Leave unchanged or flag for review in reasoningSummary.',
  '5) Title cleaning:',
  '- Remove SKU/stock numbers (especially suffix-like IDs).',
  '- Remove OEM Part text and Used Auto text.',
  '- Remove extra uses of Part.',
  '- Keep exactly one OEM at end.',
  '6) Side standardization (mandatory):',
  '- Driver side => Driver Left LH',
  '- Passenger side => Passenger Right RH',
  '7) SEO part name replacements (mandatory when applicable):',
  '- Accelerator Parts => Gas Pedal or Accelerator Pedal',
  '- Anti-Lock Brake Part => ABS Module or ABS Pump or Hydraulic Unit',
  '- Inside Mirror => Rear View Mirror',
  '- Throttle Valve Assembly => Throttle Body',
  '- Fuel Vapor Canister => EVAP Charcoal Canister',
  '- Audio Equipment Radio => Radio',
  '- Chassis ECM (590) => choose best single fit: ECM or ECU or PCM',
  '- Never stack duplicate synonyms.',
  '8) Extra optimization:',
  '- Optionally add Tested or OEM Tested when relevant.',
  '- Keep wording readable and non-spammy.',
  '9) No duplicate titles (hard rule):',
  '- Title must be unique against provided existingTitles.',
  '- If duplicate, apply controlled variation only.',
  '- Never alter year/make/model for uniqueness.',
  '10) Length control:',
  '- If too long, trim extra descriptors.',
  '- If too short, add relevant detail like Tested, Assembly, or Unit.',
  '11) Final checks before output:',
  '- Year present or flagged.',
  '- Make unchanged.',
  '- Model unchanged.',
  '- No SKU/junk text.',
  '- Side format standardized if side exists.',
  '- SEO replacements applied where relevant.',
  '- Ends with OEM once only.',
  '- 65-80 chars.',
  '- Clean/readable.',
  '- Unique against existingTitles.'
].join('\n');

function resolvePhase74TitleRulesPrompt(...candidates) {
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }
  return DEFAULT_PHASE74_TITLE_RULES_PROMPT;
}

function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return defaultValue;
}

function normalizeEbayFetchPagingMode(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'continue' || text === 'continue_from_last_page' || text === 'resume') {
    return 'continue_from_last_page';
  }
  return DEFAULT_EBAY_FETCH_PAGING_MODE;
}

function resolveEbaySandboxTableName(...candidates) {
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (!text) continue;
    return text.toLowerCase() === LEGACY_EBAY_MOCK_TABLE.toLowerCase()
      ? DEFAULT_EBAY_SANDBOX_TABLE
      : text;
  }
  return DEFAULT_EBAY_SANDBOX_TABLE;
}

function resolveListingsTableName(...candidates) {
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (!text) continue;
    return text.toLowerCase() === LEGACY_EBAY_MOCK_TABLE.toLowerCase()
      ? DEFAULT_EBAY_LISTINGS_TABLE
      : text;
  }
  return DEFAULT_EBAY_LISTINGS_TABLE;
}

function normalizeEbayEnvironment(value) {
  return String(value || '').trim().toLowerCase() === 'production' ? 'production' : 'sandbox';
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeUpperIpn(value) {
  return normalizeText(value).toUpperCase();
}

function parseIpnList(value) {
  if (Array.isArray(value)) {
    return value.map(item => normalizeUpperIpn(item)).filter(Boolean);
  }
  const text = String(value || '');
  if (!text.trim()) return [];
  return text
    .split(/[\n,\t;|]+/)
    .map(item => normalizeUpperIpn(item))
    .filter(Boolean);
}

function chunkArray(values = [], size = 25) {
  const list = Array.isArray(values) ? values : [];
  const next = [];
  const chunkSize = Math.max(1, Number(size) || 25);
  for (let i = 0; i < list.length; i += chunkSize) {
    next.push(list.slice(i, i + chunkSize));
  }
  return next;
}

function escapeAirtableFormulaValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildIpnFilterFormula(fieldName = '', ipns = []) {
  const name = normalizeText(fieldName);
  const clauses = (Array.isArray(ipns) ? ipns : [])
    .map(ipn => normalizeUpperIpn(ipn))
    .filter(Boolean)
    .map(ipn => `{${name}}="${escapeAirtableFormulaValue(ipn)}"`);
  if (clauses.length === 0) return '';
  if (clauses.length === 1) return clauses[0];
  return `OR(${clauses.join(',')})`;
}

async function fetchAirtableRowsByIpnSet({
  airtableService,
  tableName,
  ipnFieldName,
  ipns,
  selectFields = []
}) {
  const rows = [];
  const normalized = Array.from(
    new Set((Array.isArray(ipns) ? ipns : []).map(item => normalizeUpperIpn(item)).filter(Boolean))
  );
  for (const batch of chunkArray(normalized, 25)) {
    const formula = buildIpnFilterFormula(ipnFieldName, batch);
    if (!formula) continue;
    let offset = null;
    do {
      const params = {
        filterByFormula: formula
      };
      if (offset) params.offset = offset;
      if (Array.isArray(selectFields) && selectFields.length > 0) {
        params.fields = selectFields;
      }
      const data = await airtableService.request('GET', `/${encodeURIComponent(tableName)}`, { params });
      rows.push(...(Array.isArray(data?.records) ? data.records : []));
      offset = data?.offset || null;
    } while (offset);
  }
  return rows;
}

function hasPopulatedValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(normalizeText(value));
}

function summarizeBatchGaps({
  batchIpns = [],
  listingRows = [],
  masterRows = []
}) {
  const targetIpns = Array.from(
    new Set((Array.isArray(batchIpns) ? batchIpns : []).map(item => normalizeUpperIpn(item)).filter(Boolean))
  );
  const listingRowsByIpn = new Map();
  for (const row of listingRows) {
    const ipn = normalizeUpperIpn(row?.fields?.['IPN (Interchange Part Number)']);
    if (!ipn) continue;
    if (!listingRowsByIpn.has(ipn)) listingRowsByIpn.set(ipn, []);
    listingRowsByIpn.get(ipn).push(row);
  }
  const masterByIpn = new Map();
  for (const row of masterRows) {
    const ipn = normalizeUpperIpn(row?.fields?.IPN);
    if (!ipn || masterByIpn.has(ipn)) continue;
    masterByIpn.set(ipn, row);
  }

  const missingFitmentIpns = [];
  const missingFitmentImageIpns = [];
  const missingTitleDescriptionIpns = [];
  const missingListingRowsIpns = [];
  const missingMasterRowsIpns = [];

  for (const ipn of targetIpns) {
    const listingRowsForIpn = listingRowsByIpn.get(ipn) || [];
    if (listingRowsForIpn.length === 0) {
      missingListingRowsIpns.push(ipn);
      missingTitleDescriptionIpns.push(ipn);
    } else {
      const hasAnyMissingListingOutput = listingRowsForIpn.some(row => {
        const fields = row?.fields || {};
        const title = normalizeText(fields['Item Title']);
        const description = normalizeText(fields['Item Description']);
        return !title || !description;
      });
      if (hasAnyMissingListingOutput) missingTitleDescriptionIpns.push(ipn);
    }

    const master = masterByIpn.get(ipn);
    if (!master) {
      missingMasterRowsIpns.push(ipn);
      missingFitmentIpns.push(ipn);
      missingFitmentImageIpns.push(ipn);
      continue;
    }

    const fitment = normalizeText(master?.fields?.['Part Fitment']);
    if (!fitment) missingFitmentIpns.push(ipn);

    const fitmentImage = master?.fields?.['Fitment Image'];
    if (!hasPopulatedValue(fitmentImage)) {
      missingFitmentImageIpns.push(ipn);
    }
  }

  return {
    batchIpnsCount: targetIpns.length,
    missingFitmentIpns: Array.from(new Set(missingFitmentIpns)),
    missingFitmentImageIpns: Array.from(new Set(missingFitmentImageIpns)),
    missingTitleDescriptionIpns: Array.from(new Set(missingTitleDescriptionIpns)),
    missingListingRowsIpns: Array.from(new Set(missingListingRowsIpns)),
    missingMasterRowsIpns: Array.from(new Set(missingMasterRowsIpns))
  };
}

async function evaluateBatchOutputGaps({
  airtableService,
  listingsTable,
  masterTable,
  batchIpns
}) {
  const listingRows = await fetchAirtableRowsByIpnSet({
    airtableService,
    tableName: listingsTable,
    ipnFieldName: 'IPN (Interchange Part Number)',
    ipns: batchIpns,
    selectFields: [
      'IPN (Interchange Part Number)',
      'Item Title',
      'Item Description'
    ]
  });
  const masterRows = await fetchAirtableRowsByIpnSet({
    airtableService,
    tableName: masterTable,
    ipnFieldName: 'IPN',
    ipns: batchIpns,
    selectFields: [
      'IPN',
      'Part Fitment',
      'Fitment Image'
    ]
  });
  return summarizeBatchGaps({
    batchIpns,
    listingRows,
    masterRows
  });
}

function buildPhase5PublishLogService(config = {}) {
  return new Phase5PublishLogService({
    enabled: config.phase5SheetsLogEnabled ?? process.env.PHASE5_SHEETS_LOG_ENABLED ?? 'false',
    spreadsheetId: config.phase5SheetsLogSpreadsheetId || process.env.PHASE5_SHEETS_LOG_SPREADSHEET_ID || '',
    tabName: config.phase5SheetsLogTabName || process.env.PHASE5_SHEETS_LOG_TAB || 'Log',
    authContext: config.phase5SheetsLogAuthContext || process.env.PHASE5_SHEETS_LOG_AUTH_CONTEXT || 'inventory'
  });
}

async function attachPhase5PublishedState(config = {}, contextLabel = 'phase5') {
  const publishLogService = buildPhase5PublishLogService(config);
  if (!publishLogService.isConfigured()) {
    return {
      ...config,
      phase5PublishedIdentities: [],
      phase5PublishedPayloadHashes: []
    };
  }
  try {
    const state = await publishLogService.fetchPublishedState();
    return {
      ...config,
      phase5PublishedIdentities: Array.isArray(state?.identities) ? state.identities : [],
      phase5PublishedPayloadHashes: Array.isArray(state?.payloadHashes) ? state.payloadHashes : []
    };
  } catch (error) {
    console.warn(
      `[${contextLabel}] Failed to load published state from Phase 5 Sheets log: ${error?.message || error}`
    );
    return {
      ...config,
      phase5PublishedIdentities: [],
      phase5PublishedPayloadHashes: []
    };
  }
}

function stripPhase5LocalPublishedCache(config = {}) {
  const next = { ...(config || {}) };
  delete next.phase5PublishedIdentities;
  delete next.phase5PublishedPayloadHashes;
  return next;
}

function normalizeEbayCredentialSet(raw = {}) {
  return {
    phase5EbayClientId: normalizeText(raw.phase5EbayClientId || ''),
    phase5EbayDevId: normalizeText(raw.phase5EbayDevId || ''),
    phase5EbayClientSecret: normalizeText(raw.phase5EbayClientSecret || ''),
    phase5EbayRuName: normalizeText(raw.phase5EbayRuName || ''),
    phase5EbayRefreshToken: normalizeText(raw.phase5EbayRefreshToken || ''),
    phase5EbayUserAccessToken: normalizeText(raw.phase5EbayUserAccessToken || ''),
    phase5EbayRefreshScope: normalizeText(raw.phase5EbayRefreshScope || ''),
    phase5EbayUserAccessTokenIssuedAt: normalizeText(raw.phase5EbayUserAccessTokenIssuedAt || '')
  };
}

function hasAnyEbayCredentialValue(set = {}) {
  if (!set || typeof set !== 'object') return false;
  return [
    'phase5EbayClientId',
    'phase5EbayDevId',
    'phase5EbayClientSecret',
    'phase5EbayRuName',
    'phase5EbayRefreshToken',
    'phase5EbayUserAccessToken',
    'phase5EbayRefreshScope',
    'phase5EbayUserAccessTokenIssuedAt'
  ].some(key => Boolean(normalizeText(set[key] || '')));
}

function getLegacyEbayCredentialSet(stored = {}) {
  return normalizeEbayCredentialSet({
    phase5EbayClientId: stored.phase5EbayClientId || process.env.EBAY_CLIENT_ID || '',
    phase5EbayDevId: stored.phase5EbayDevId || process.env.EBAY_DEV_ID || '',
    phase5EbayClientSecret: stored.phase5EbayClientSecret || process.env.EBAY_CLIENT_SECRET || '',
    phase5EbayRuName: stored.phase5EbayRuName || process.env.EBAY_RUNAME || '',
    phase5EbayRefreshToken: stored.phase5EbayRefreshToken || process.env.EBAY_REFRESH_TOKEN || '',
    phase5EbayUserAccessToken: stored.phase5EbayUserAccessToken || process.env.EBAY_USER_ACCESS_TOKEN || '',
    phase5EbayRefreshScope: stored.phase5EbayRefreshScope || process.env.EBAY_REFRESH_SCOPE || '',
    phase5EbayUserAccessTokenIssuedAt:
      stored.phase5EbayUserAccessTokenIssuedAt || process.env.EBAY_USER_ACCESS_TOKEN_ISSUED_AT || ''
  });
}

function getEnvSpecificEbayCredentialSet(env = 'sandbox', stored = {}) {
  const upper = env === 'production' ? 'PRODUCTION' : 'SANDBOX';
  return normalizeEbayCredentialSet({
    phase5EbayClientId: process.env[`EBAY_${upper}_CLIENT_ID`] || '',
    phase5EbayDevId: process.env[`EBAY_${upper}_DEV_ID`] || '',
    phase5EbayClientSecret: process.env[`EBAY_${upper}_CLIENT_SECRET`] || '',
    phase5EbayRuName: process.env[`EBAY_${upper}_RUNAME`] || '',
    phase5EbayRefreshToken: process.env[`EBAY_${upper}_REFRESH_TOKEN`] || '',
    phase5EbayUserAccessToken: process.env[`EBAY_${upper}_USER_ACCESS_TOKEN`] || '',
    phase5EbayRefreshScope: process.env[`EBAY_${upper}_REFRESH_SCOPE`] || '',
    phase5EbayUserAccessTokenIssuedAt: process.env[`EBAY_${upper}_USER_ACCESS_TOKEN_ISSUED_AT`] || ''
  });
}

function getEbayCredentialSets(stored = {}) {
  const selectedEnvironment = normalizeEbayEnvironment(
    stored.phase5EbayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox'
  );
  const legacy = getLegacyEbayCredentialSet(stored);
  const rawSets =
    stored.phase5EbayCredentialSets && typeof stored.phase5EbayCredentialSets === 'object'
      ? stored.phase5EbayCredentialSets
      : {};

  const sandboxBase = normalizeEbayCredentialSet({
    ...getEnvSpecificEbayCredentialSet('sandbox', stored),
    ...(rawSets.sandbox || {})
  });
  const productionBase = normalizeEbayCredentialSet({
    ...getEnvSpecificEbayCredentialSet('production', stored),
    ...(rawSets.production || {})
  });

  if (hasAnyEbayCredentialValue(legacy)) {
    if (selectedEnvironment === 'production' && !hasAnyEbayCredentialValue(productionBase)) {
      Object.assign(productionBase, legacy);
    }
    if (selectedEnvironment === 'sandbox' && !hasAnyEbayCredentialValue(sandboxBase)) {
      Object.assign(sandboxBase, legacy);
    }
  }

  return {
    sandbox: normalizeEbayCredentialSet(sandboxBase),
    production: normalizeEbayCredentialSet(productionBase)
  };
}

function normalizeAndAttachEbayCredentials(existing = {}, incoming = {}) {
  const merged = {
    ...existing,
    ...incoming
  };
  const selectedEnvironment = normalizeEbayEnvironment(
    merged.phase5EbayEnvironment || existing.phase5EbayEnvironment || 'sandbox'
  );
  const existingSets = getEbayCredentialSets(existing);
  const incomingSets =
    incoming.phase5EbayCredentialSets && typeof incoming.phase5EbayCredentialSets === 'object'
      ? incoming.phase5EbayCredentialSets
      : {};

  const sets = {
    sandbox: normalizeEbayCredentialSet({
      ...existingSets.sandbox,
      ...(incomingSets.sandbox || {})
    }),
    production: normalizeEbayCredentialSet({
      ...existingSets.production,
      ...(incomingSets.production || {})
    })
  };

  const flatCredentialKeys = [
    'phase5EbayClientId',
    'phase5EbayDevId',
    'phase5EbayClientSecret',
    'phase5EbayRuName',
    'phase5EbayRefreshToken',
    'phase5EbayUserAccessToken',
    'phase5EbayRefreshScope',
    'phase5EbayUserAccessTokenIssuedAt'
  ];
  const hasFlatOverrides = flatCredentialKeys.some(key =>
    Object.prototype.hasOwnProperty.call(incoming, key)
  );

  if (hasFlatOverrides) {
    sets[selectedEnvironment] = normalizeEbayCredentialSet({
      ...sets[selectedEnvironment],
      phase5EbayClientId: Object.prototype.hasOwnProperty.call(incoming, 'phase5EbayClientId')
        ? incoming.phase5EbayClientId
        : sets[selectedEnvironment].phase5EbayClientId,
      phase5EbayDevId: Object.prototype.hasOwnProperty.call(incoming, 'phase5EbayDevId')
        ? incoming.phase5EbayDevId
        : sets[selectedEnvironment].phase5EbayDevId,
      phase5EbayClientSecret: Object.prototype.hasOwnProperty.call(incoming, 'phase5EbayClientSecret')
        ? incoming.phase5EbayClientSecret
        : sets[selectedEnvironment].phase5EbayClientSecret,
      phase5EbayRuName: Object.prototype.hasOwnProperty.call(incoming, 'phase5EbayRuName')
        ? incoming.phase5EbayRuName
        : sets[selectedEnvironment].phase5EbayRuName,
      phase5EbayRefreshToken: Object.prototype.hasOwnProperty.call(incoming, 'phase5EbayRefreshToken')
        ? incoming.phase5EbayRefreshToken
        : sets[selectedEnvironment].phase5EbayRefreshToken,
      phase5EbayUserAccessToken: Object.prototype.hasOwnProperty.call(incoming, 'phase5EbayUserAccessToken')
        ? incoming.phase5EbayUserAccessToken
        : sets[selectedEnvironment].phase5EbayUserAccessToken,
      phase5EbayRefreshScope: Object.prototype.hasOwnProperty.call(incoming, 'phase5EbayRefreshScope')
        ? incoming.phase5EbayRefreshScope
        : sets[selectedEnvironment].phase5EbayRefreshScope,
      phase5EbayUserAccessTokenIssuedAt: Object.prototype.hasOwnProperty.call(incoming, 'phase5EbayUserAccessTokenIssuedAt')
        ? incoming.phase5EbayUserAccessTokenIssuedAt
        : sets[selectedEnvironment].phase5EbayUserAccessTokenIssuedAt
    });
  }

  const active = sets[selectedEnvironment] || normalizeEbayCredentialSet({});
  merged.phase5EbayEnvironment = selectedEnvironment;
  merged.phase5EbayCredentialSets = sets;
  merged.phase5EbayClientId = active.phase5EbayClientId;
  merged.phase5EbayDevId = active.phase5EbayDevId;
  merged.phase5EbayClientSecret = active.phase5EbayClientSecret;
  merged.phase5EbayRuName = active.phase5EbayRuName;
  merged.phase5EbayRefreshToken = active.phase5EbayRefreshToken;
  merged.phase5EbayUserAccessToken = active.phase5EbayUserAccessToken;
  merged.phase5EbayRefreshScope = active.phase5EbayRefreshScope;
  merged.phase5EbayUserAccessTokenIssuedAt = active.phase5EbayUserAccessTokenIssuedAt;
  return merged;
}

function formatDetailedErrorMessage(error) {
  const status = error?.response?.status;
  const payload = error?.response?.data;
  const detailFromErrors = Array.isArray(payload?.errors)
    ? payload.errors
        .map(item => String(item?.longMessage || item?.message || item?.errorId || '').trim())
        .filter(Boolean)
        .join(' | ')
    : '';
  const detail =
    detailFromErrors ||
    payload?.error_description ||
    payload?.message ||
    payload?.error?.message ||
    payload?.error?.type ||
    payload?.error ||
    error?.message ||
    'Unknown error';
  return status ? `HTTP ${status}: ${detail}` : String(detail);
}

function emitInventoryAutoChainLog(text, level = 'info') {
  const message = String(text || '').trim();
  if (!message) return;

  if (level === 'error') {
    console.error(message);
  } else {
    console.log(message);
  }

  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send('inventory:auto-chain-log', {
        at: new Date().toISOString(),
        level,
        message
      });
    }
  } catch (_) {}
}

const PHASE4_MASTER_LOAD_LOG_EVERY_ROWS = 5000;

function normalizeMasterIpn(value) {
  return normalizeText(value).toUpperCase();
}

async function buildPhase4SharedMasterContext(baseConfig = {}, hooks = {}) {
  const cfg = baseConfig && typeof baseConfig === 'object' ? baseConfig : {};
  const onProgress = typeof hooks?.onProgress === 'function' ? hooks.onProgress : () => {};

  const airtableToken = normalizeText(cfg.airtableToken || process.env.AIRTABLE_TOKEN || '');
  const masterBaseId = normalizeText(cfg.airtableBaseId || process.env.AIRTABLE_BASE_ID || '');
  const masterTable = normalizeText(cfg.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table');
  if (!airtableToken || !masterBaseId || !masterTable) {
    return null;
  }

  const masterService = new AirtableService({
    token: airtableToken,
    baseId: masterBaseId,
    masterTable
  });

  onProgress(`Loading shared Master Parts context from '${masterTable}'...`);
  const masterRows = [];
  let offset = null;
  let page = 0;
  let nextLogAt = PHASE4_MASTER_LOAD_LOG_EVERY_ROWS;
  do {
    const params = {};
    if (offset) params.offset = offset;
    const data = await masterService.request('GET', `/${encodeURIComponent(masterTable)}`, { params });
    const batch = Array.isArray(data?.records) ? data.records : [];
    masterRows.push(...batch);
    page += 1;
    offset = data?.offset || null;
    if (!offset || masterRows.length >= nextLogAt) {
      while (masterRows.length >= nextLogAt) {
        nextLogAt += PHASE4_MASTER_LOAD_LOG_EVERY_ROWS;
      }
      onProgress(`Loading shared Master Parts context... loaded=${masterRows.length} rows (page ${page})`);
    }
  } while (offset);

  const masterByIpn = new Map();
  const masterIpnSet = new Set();
  for (const row of masterRows) {
    const ipn = normalizeMasterIpn(row?.fields?.IPN);
    if (!ipn) continue;
    masterIpnSet.add(ipn);
    if (!masterByIpn.has(ipn)) masterByIpn.set(ipn, row);
  }

  onProgress(`Shared Master Parts context ready: rows=${masterRows.length}, uniqueIpns=${masterIpnSet.size}`);
  return {
    masterTable,
    masterRows,
    masterByIpn,
    masterIpnSet
  };
}

async function runPostEbayListingsAutomation(baseConfig = {}, hooks = {}) {
  const runtime = baseConfig && typeof baseConfig === 'object' ? baseConfig : {};
  const persisted = getInventoryConfig('phase2Config') || {};
  const stored = {
    ...persisted,
    ...runtime
  };
  const summary = {};
  const firstNonEmpty = (...values) => {
    for (const value of values) {
      const text = normalizeText(value);
      if (text) return text;
    }
    return '';
  };
  const emitStepProgress = (stage, percent, message) => {
    if (typeof hooks?.onProgress !== 'function') return;
    try {
      hooks.onProgress({
        stage,
        percent,
        counts: summary,
        message
      });
    } catch (_) {}
  };
  const buildPostImportProgressBridge = (postImportStage, phaseLabel, options = {}) => {
    const minPercent = Number(options.minPercent || 99);
    const logIntervalMs = Number(options.logIntervalMs || 2000);
    let lastUiEmitAt = 0;
    let lastUiMessage = '';
    let lastLogAt = 0;
    let lastLogMessage = '';
    return payload => {
      const progress = payload && typeof payload === 'object' ? payload : {};
      const stage = normalizeText(progress.stage).toLowerCase();
      const incomingPercent = Number(progress.percent);
      const percent = Number.isFinite(incomingPercent)
        ? Math.max(minPercent, Math.min(100, incomingPercent))
        : minPercent;
      const message = normalizeText(progress.message) || `Running ${phaseLabel}...`;
      const now = Date.now();
      const terminalStage = stage === 'completed' || stage === 'error';
      const shouldEmitUi =
        terminalStage ||
        !lastUiMessage ||
        message !== lastUiMessage ||
        now - lastUiEmitAt >= 800;
      if (shouldEmitUi) {
        lastUiEmitAt = now;
        lastUiMessage = message;
        emitStepProgress(postImportStage, percent, message);
      }

      const shouldLog =
        terminalStage ||
        !lastLogMessage ||
        message !== lastLogMessage ||
        now - lastLogAt >= logIntervalMs;
      if (shouldLog) {
        lastLogAt = now;
        lastLogMessage = message;
        emitInventoryAutoChainLog(`Post-import automation: ${phaseLabel} -> ${message}`);
      }
    };
  };

  emitStepProgress('ebaysandbox_post_import_start', 99, 'Post-import automation started.');
  emitInventoryAutoChainLog('Post-import automation started: Phase4-Mirror -> Phase4A -> Phase4B -> Phase4C -> Phase4D -> Phase6 -> Phase7.2 -> Phase7.4');

  const listingsTable = resolveListingsTableName(
    runtime.phase4DListingsTable,
    persisted.phase4DListingsTable,
    runtime.phase6ListingsTable,
    persisted.phase6ListingsTable,
    runtime.phase74ListingsTable,
    persisted.phase74ListingsTable,
    runtime.ebaySandboxTableName,
    persisted.ebaySandboxTableName,
    runtime.phase5ListingsTable,
    persisted.phase5ListingsTable,
    process.env.PHASE6_LISTINGS_TABLE,
    process.env.PHASE74_LISTINGS_TABLE,
    DEFAULT_EBAY_LISTINGS_TABLE
  );

  emitStepProgress('ebaysandbox_post_import_batch', 99, 'Creating listing batches from imported listings...');
  summary.phase5BatchCreation = await createBatchFromListings({
    ...stored,
    phase5ListingsTable: listingsTable,
    phase4DListingsTable: listingsTable
  });
  emitInventoryAutoChainLog(
    `Post-import automation: Batch creation completed ` +
      `(status=${summary.phase5BatchCreation?.status || 'unknown'}, ` +
      `batches=${summary.phase5BatchCreation?.batchesCreated || 0}, ` +
      `linked=${summary.phase5BatchCreation?.linkedRecords || 0}, ` +
      `failed=${summary.phase5BatchCreation?.failedRecords || 0})`
  );
  if (summary.phase5BatchCreation?.success === false) {
    emitInventoryAutoChainLog(
      `Post-import automation: Batch creation returned non-success ` +
        `(message=${summary.phase5BatchCreation?.message || 'unknown'})`,
      'error'
    );
  }
  const batchDiagnostics = summary.phase5BatchCreation?.diagnostics || {};
  const noBatchCandidates =
    String(summary.phase5BatchCreation?.status || '').toLowerCase() === 'nocandidates' ||
    Number(summary.phase5BatchCreation?.linkedRecords || 0) <= 0;
  if (noBatchCandidates) {
    const detail =
      `Post-import automation skipped: batch creation returned no eligible candidates ` +
      `(status=${summary.phase5BatchCreation?.status || 'unknown'}, ` +
      `totalRows=${Number(batchDiagnostics.totalRows || 0)}, ` +
      `excludedAlreadyLinked=${Number(batchDiagnostics.excludedAlreadyLinked || 0)}, ` +
      `excludedAlreadyPublished=${Number(batchDiagnostics.excludedAlreadyPublished || 0)}, ` +
      `candidates=${Number(batchDiagnostics.candidates || 0)}).`;
    summary.blocked = true;
    summary.message = detail;
    emitStepProgress('ebaysandbox_post_import_skipped_no_candidates', 100, detail);
    emitInventoryAutoChainLog(detail);
    return summary;
  }

  const phase4RulesDriveFile = String(
    firstNonEmpty(runtime.phase4RulesDriveFile, persisted.phase4RulesDriveFile) ||
      process.env.PHASE4_RULES_DRIVE_FILE ||
      process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
      ''
  ).trim();
  const phase4OpenAiKey = String(firstNonEmpty(runtime.openaiApiKey, persisted.openaiApiKey) || process.env.OPENAI_API_KEY || '').trim();
  const phase4BListId = String(
    firstNonEmpty(runtime.phase4BClickupListId, persisted.phase4BClickupListId) || process.env.PHASE4B_CLICKUP_LIST_ID || ''
  ).trim();
  const phase4CListId = String(
    firstNonEmpty(runtime.phase4CClickupListId, persisted.phase4CClickupListId) ||
      process.env.PHASE4C_CLICKUP_LIST_ID ||
      phase4BListId
  ).trim();
  const resolvedAirtableToken = firstNonEmpty(runtime.airtableToken, persisted.airtableToken, process.env.AIRTABLE_TOKEN);
  const resolvedAirtableBaseId = firstNonEmpty(runtime.airtableBaseId, persisted.airtableBaseId, process.env.AIRTABLE_BASE_ID);
  const resolvedItemSpecificsBaseId = firstNonEmpty(runtime.itemSpecificsBaseId, persisted.itemSpecificsBaseId);
  const resolvedClickupToken = firstNonEmpty(runtime.clickupToken, persisted.clickupToken, process.env.CLICKUP_TOKEN);
  const chainBaseBase = {
    ...stored,
    airtableToken: resolvedAirtableToken,
    airtableBaseId: resolvedAirtableBaseId,
    itemSpecificsBaseId: resolvedItemSpecificsBaseId,
    clickupToken: resolvedClickupToken,
    openaiApiKey: phase4OpenAiKey,
    phase4BClickupListId: phase4BListId,
    phase4CClickupListId: phase4CListId,
    phase4RulesDriveFile
  };
  const chainBase = await attachPhase5PublishedState(chainBaseBase, 'post-import');
  const missingPhase4Config = [];
  if (!resolvedAirtableToken) missingPhase4Config.push('airtableToken');
  if (!resolvedAirtableBaseId) missingPhase4Config.push('airtableBaseId');
  if (!resolvedItemSpecificsBaseId) missingPhase4Config.push('itemSpecificsBaseId');
  if (!resolvedClickupToken) missingPhase4Config.push('clickupToken');
  if (!phase4RulesDriveFile) missingPhase4Config.push('phase4RulesDriveFile');
  if (!phase4OpenAiKey) missingPhase4Config.push('openaiApiKey');
  if (!phase4BListId) missingPhase4Config.push('phase4BClickupListId');
  if (!phase4CListId) missingPhase4Config.push('phase4CClickupListId');
  if (missingPhase4Config.length > 0) {
    const detail = `Post-import automation blocked: missing Phase 4 config (${missingPhase4Config.join(', ')})`;
    summary.blocked = true;
    summary.message = detail;
    summary.missingPhase4Config = missingPhase4Config;
    emitStepProgress('ebaysandbox_post_import_blocked', 100, detail);
    emitInventoryAutoChainLog(detail, 'error');
    return summary;
  }

  let sharedMasterContext = null;
  emitStepProgress('ebaysandbox_post_import_phase4_master_context', 99, 'Preparing shared Master Parts context...');
  try {
    sharedMasterContext = await buildPhase4SharedMasterContext(chainBase, {
      onProgress: message => {
        emitStepProgress('ebaysandbox_post_import_phase4_master_context', 99, message);
        emitInventoryAutoChainLog(`Post-import automation: Phase 4 shared master -> ${message}`);
      }
    });
  } catch (error) {
    emitInventoryAutoChainLog(
      `Post-import automation: shared Master Parts context failed (${error?.message || error}); continuing with per-phase loading.`,
      'error'
    );
  }

  emitStepProgress('ebaysandbox_post_import_phase4mirror', 99, 'Running Phase 4 Mirror...');
  const phase4MirrorDryRun =
    typeof stored.phase4DryRun === 'boolean'
      ? stored.phase4DryRun
      : false;
  summary.phase4Mirror = await runPhase4Mirroring({
    ...chainBase,
    dryRun: phase4MirrorDryRun,
    authContext: 'inventory',
    phase4SharedMasterRows: sharedMasterContext?.masterRows
  }, buildPostImportProgressBridge('ebaysandbox_post_import_phase4mirror', 'Phase 4 Mirror'));
  emitInventoryAutoChainLog(
    `Post-import automation: Phase 4 Mirror completed ` +
      `(created=${summary.phase4Mirror?.ipnRowsCreated || 0}, ` +
      `existing=${summary.phase4Mirror?.ipnRowsAlreadyPresent || 0}, ` +
      `mpnWritten=${summary.phase4Mirror?.manufacturerValuesWritten || 0})`
  );

  emitStepProgress('ebaysandbox_post_import_phase4a', 99, 'Running Phase 4A...');

  const rulesDryRun =
    typeof stored.phase4RulesDryRun === 'boolean'
      ? stored.phase4RulesDryRun
      : false;
  summary.phase4A = await runPhase4RulesPopulate({
    ...chainBase,
    dryRun: rulesDryRun,
    execute: !rulesDryRun,
    ruleTypes: ['F'],
    authContext: 'inventory',
    rulesDriveFile: phase4RulesDriveFile,
    globalDefaultsTable: String(
      stored.phase4GlobalDefaultsTable ||
        process.env.PHASE4_GLOBAL_DEFAULTS_TABLE ||
        'Fixed Item Specifics (Global Defaults)'
    ).trim(),
    logicSheetName: String(stored.phase4RulesLogicSheet || 'Logic').trim(),
    phase4SharedMasterRows: sharedMasterContext?.masterRows,
    phase4SharedMasterIpnSet: sharedMasterContext?.masterIpnSet
  }, buildPostImportProgressBridge('ebaysandbox_post_import_phase4a', 'Phase 4A'));
  emitInventoryAutoChainLog(`Post-import automation: Phase 4A completed (updated=${summary.phase4A?.fixedFieldsUpdated || 0})`);

  emitStepProgress('ebaysandbox_post_import_phase4b', 99, 'Running Phase 4B-lite...');
  const bliteDryRun =
    typeof stored.phase4BLiteDryRun === 'boolean'
      ? stored.phase4BLiteDryRun
      : false;
  summary.phase4B = await runPhase4BLite({
    ...chainBase,
    dryRun: bliteDryRun,
    execute: !bliteDryRun,
    authContext: 'inventory',
    rulesDriveFile: phase4RulesDriveFile,
    logicSheetName: String(stored.phase4RulesLogicSheet || 'Logic').trim(),
    testTableName: '',
    testMaxTables: 0,
    openaiApiKey: phase4OpenAiKey,
    openaiModel: String(stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
    openaiBaseUrl: String(stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
    phase4BClickupListName: String(stored.phase4BClickupListName || '').trim(),
    phase4BClickupListId: phase4BListId,
    clickupOpenStatus: String(
      stored.phase4BClickupOpenStatus ||
        process.env.PHASE4B_CLICKUP_OPEN_STATUS ||
        'To Do'
    ).trim(),
    phase4SharedMasterRows: sharedMasterContext?.masterRows,
    phase4SharedMasterByIpn: sharedMasterContext?.masterByIpn
  }, buildPostImportProgressBridge('ebaysandbox_post_import_phase4b', 'Phase 4B-lite'));
  emitInventoryAutoChainLog(
    `Post-import automation: Phase 4B completed ` +
      `(vmfUpdated=${summary.phase4B?.vmfFieldsUpdated || 0}, vmfTasksCreated=${summary.phase4B?.vmfTasksCreated || 0})`
  );

  emitStepProgress('ebaysandbox_post_import_phase4c', 99, 'Running Phase 4C...');
  const cmfDryRun =
    typeof stored.phase4CMFDryRun === 'boolean'
      ? stored.phase4CMFDryRun
      : false;
  summary.phase4C = await runPhase4CMF({
    ...chainBase,
    dryRun: cmfDryRun,
    execute: !cmfDryRun,
    authContext: 'inventory',
    rulesDriveFile: phase4RulesDriveFile,
    logicSheetName: String(stored.phase4RulesLogicSheet || 'Logic').trim(),
    phase4CClickupListName: String(
      stored.phase4CClickupListName || stored.phase4BClickupListName || ''
    ).trim(),
    phase4CClickupListId: phase4CListId,
    phase4CClickupOpenStatus: String(
      stored.phase4CClickupOpenStatus ||
        stored.phase4BClickupOpenStatus ||
        process.env.PHASE4C_CLICKUP_OPEN_STATUS ||
        process.env.PHASE4B_CLICKUP_OPEN_STATUS ||
        'To Do'
    ).trim()
  }, buildPostImportProgressBridge('ebaysandbox_post_import_phase4c', 'Phase 4C'));
  emitInventoryAutoChainLog(
    `Post-import automation: Phase 4C completed ` +
      `(mfTasksCreated=${summary.phase4C?.mfTasksCreated || 0}, mfWritebacksCompleted=${summary.phase4C?.mfWritebacksCompleted || 0})`
  );

  emitStepProgress('ebaysandbox_post_import_phase4d', 99, 'Running Phase 4D...');
  const dDryRun =
    typeof stored.phase4DDryRun === 'boolean'
      ? stored.phase4DDryRun
      : false;
  summary.phase4D = await runPhase4DListing({
    ...chainBase,
    dryRun: dDryRun,
    execute: !dDryRun,
    authContext: 'inventory',
    rulesDriveFile: phase4RulesDriveFile,
    logicSheetName: String(stored.phase4RulesLogicSheet || 'Logic').trim(),
    phase4GlobalDefaultsTable: String(
      stored.phase4GlobalDefaultsTable ||
        process.env.PHASE4_GLOBAL_DEFAULTS_TABLE ||
        'Fixed Item Specifics (Global Defaults)'
    ).trim(),
    phase4DListingsTable: listingsTable,
    phase4DTestIpn: '',
    openaiApiKey: phase4OpenAiKey,
    openaiModel: String(stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
    openaiBaseUrl: String(stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
    phase4SharedMasterRows: sharedMasterContext?.masterRows,
    phase4SharedMasterByIpn: sharedMasterContext?.masterByIpn
  }, buildPostImportProgressBridge('ebaysandbox_post_import_phase4d', 'Phase 4D'));
  emitInventoryAutoChainLog(
    `Post-import automation: Phase 4D completed ` +
      `(table='${summary.phase4D?.listingsTable || listingsTable}', writes=${summary.phase4D?.totalWrites || 0}, listingsEligible=${summary.phase4D?.listingsEligible || 0})`
  );
  if (Array.isArray(summary.phase4D?.sampleOutputs) && summary.phase4D.sampleOutputs.length > 0) {
    summary.phase4D.sampleOutputs.slice(0, 10).forEach(line => {
      emitInventoryAutoChainLog(`Post-import automation: Phase 4D write -> ${line}`);
    });
    if (summary.phase4D.sampleOutputs.length > 10) {
      emitInventoryAutoChainLog(
        `Post-import automation: Phase 4D write -> ${summary.phase4D.sampleOutputs.length - 10} more write sample(s) not shown.`
      );
    }
  }

  emitStepProgress('ebaysandbox_post_import_phase6', 99, 'Running Phase 6 fitment extraction...');
  summary.phase6 = await runPhase6Fitment({
    ...chainBase,
    phase6ListingsTable: listingsTable,
    phaseSharedMasterTable: sharedMasterContext?.masterTable,
    phaseSharedMasterRows: sharedMasterContext?.masterRows,
    phaseSharedMasterByIpn: sharedMasterContext?.masterByIpn,
    airtableMasterTable: String(stored.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table').trim(),
    openaiApiKey: String(stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
    openaiModel: String(stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
    openaiBaseUrl: String(stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
    phase6PromptCacheEnabled:
      String(stored.phase6PromptCacheEnabled ?? process.env.PHASE6_PROMPT_CACHE_ENABLED ?? 'true').trim().toLowerCase() !==
      'false',
    phase6PromptCacheKey: String(
      stored.phase6PromptCacheKey ||
        process.env.PHASE6_PROMPT_CACHE_KEY ||
        process.env.OPENAI_PROMPT_CACHE_KEY ||
        'phase6_fitment_v1'
    ).trim(),
    phase6TestIpns: '',
    phase6MaxIpns: 0,
    sampleLimit: Number(stored.phase6SampleLimit || process.env.PHASE6_SAMPLE_LIMIT || 20) || 20
  }, buildPostImportProgressBridge('ebaysandbox_post_import_phase6', 'Phase 6'));
  emitInventoryAutoChainLog(`Post-import automation: Phase 6 completed (updated=${summary.phase6?.masterPartsUpdated || 0})`);

  emitStepProgress('ebaysandbox_post_import_phase72', 99, 'Running Phase 7.2 fitment image generation...');
  summary.phase72 = await runPhase72FitmentImage({
    ...chainBase,
    phaseSharedMasterTable: sharedMasterContext?.masterTable,
    phaseSharedMasterRows: sharedMasterContext?.masterRows,
    phaseSharedMasterByIpn: sharedMasterContext?.masterByIpn,
    phase72MasterTable: String(
      stored.phase72MasterTable || stored.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table'
    ).trim(),
    phase72DriveFolderId: String(stored.phase72DriveFolderId || process.env.PHASE72_DRIVE_FOLDER_ID || '').trim(),
    phase72TestIpns: '',
    phase72MaxIpns: 0,
    phase72ForceRegenerate:
      String(stored.phase72ForceRegenerate ?? process.env.PHASE72_FORCE_REGENERATE ?? 'false').trim().toLowerCase() === 'true',
    sampleLimit: Number(stored.phase72SampleLimit || process.env.PHASE72_SAMPLE_LIMIT || 20) || 20
  }, buildPostImportProgressBridge('ebaysandbox_post_import_phase72', 'Phase 7.2'));
  emitInventoryAutoChainLog(
    `Post-import automation: Phase 7.2 completed ` +
      `(generated=${summary.phase72?.fitmentImagesGenerated || 0}, alreadyPresent=${summary.phase72?.fitmentImagesAlreadyPresent || 0})`
  );

  emitStepProgress('ebaysandbox_post_import_phase74', 99, 'Running Phase 7.4 title/description generation...');
  summary.phase74 = await runPhase74TitleDescription({
    ...chainBase,
    phaseSharedMasterTable: sharedMasterContext?.masterTable,
    phaseSharedMasterRows: sharedMasterContext?.masterRows,
    phaseSharedMasterByIpn: sharedMasterContext?.masterByIpn,
    phase74ListingsTable: listingsTable,
    airtableMasterTable: String(stored.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table').trim(),
    openaiApiKey: String(stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
    openaiModel: String(stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
    phase74TitleRulesPrompt: resolvePhase74TitleRulesPrompt(
      stored.phase74TitleRulesPrompt,
      process.env.PHASE74_TITLE_RULES_PROMPT
    ),
    openaiBaseUrl: String(stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
    phase74PromptCacheEnabled:
      String(stored.phase74PromptCacheEnabled ?? process.env.PHASE74_PROMPT_CACHE_ENABLED ?? 'true').trim().toLowerCase() !==
      'false',
    phase74PromptCacheKey: String(
      stored.phase74PromptCacheKey ||
        process.env.PHASE74_PROMPT_CACHE_KEY ||
        process.env.OPENAI_PROMPT_CACHE_KEY ||
        'phase74_title_description_v1'
    ).trim(),
    phase74TestIpns: '',
    phase74MaxListings: 0,
    sampleLimit: Number(stored.phase74SampleLimit || process.env.PHASE74_SAMPLE_LIMIT || 20) || 20
  }, buildPostImportProgressBridge('ebaysandbox_post_import_phase74', 'Phase 7.4'));
  emitInventoryAutoChainLog(
    `Post-import automation: Phase 7.4 completed ` +
      `(titles=${summary.phase74?.titleGenerated || 0}, descriptions=${summary.phase74?.descriptionGenerated || 0}, ` +
      `writesAttempted=${summary.phase74?.writesAttempted || 0}, writesSucceeded=${summary.phase74?.writesSucceeded || 0}, ` +
      `writesFailed=${summary.phase74?.writeFailures || 0})`
  );

  const batchIpns = Array.from(
    new Set(
      parseIpnList(runtime.ebaySandboxBatchIpns || stored.ebaySandboxBatchIpns || [])
    )
  );
  const retryPasses = Math.max(
    0,
    Number(
      runtime.ebaySandboxPostImportRetryPasses ||
      stored.ebaySandboxPostImportRetryPasses ||
      process.env.EBAY_SANDBOX_POST_IMPORT_RETRY_PASSES ||
      2
    ) || 0
  );
  summary.batchCompletionGuard = {
    enabled: batchIpns.length > 0,
    batchIpnsCount: batchIpns.length,
    retryPasses,
    strict:
      String(
        runtime.ebaySandboxRequireCompleteBatch ??
          stored.ebaySandboxRequireCompleteBatch ??
          process.env.EBAY_SANDBOX_REQUIRE_COMPLETE_BATCH ??
          'true'
      ).trim().toLowerCase() !== 'false',
    passes: [],
    resolved: false
  };

  if (batchIpns.length > 0 && resolvedAirtableToken && resolvedAirtableBaseId) {
    const airtableService = new AirtableService({
      token: resolvedAirtableToken,
      baseId: resolvedAirtableBaseId,
      masterTable: String(stored.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table').trim()
    });
    const masterTableName = String(stored.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table').trim();

    emitStepProgress('ebaysandbox_post_import_guard', 99, 'Verifying batch completeness for Phase 6 / 7.2 / 7.4 outputs...');
    emitInventoryAutoChainLog(
      `Post-import automation: batch completeness guard started (batchIpns=${batchIpns.length}, retryPasses=${retryPasses})`
    );

    let finalGaps = await evaluateBatchOutputGaps({
      airtableService,
      listingsTable,
      masterTable: masterTableName,
      batchIpns
    });

    for (let pass = 1; pass <= retryPasses; pass += 1) {
      const passSummary = {
        pass,
        before: {
          missingFitment: finalGaps.missingFitmentIpns.length,
          missingFitmentImage: finalGaps.missingFitmentImageIpns.length,
          missingTitleDescription: finalGaps.missingTitleDescriptionIpns.length,
          missingListingRows: finalGaps.missingListingRowsIpns.length,
          missingMasterRows: finalGaps.missingMasterRowsIpns.length
        }
      };
      summary.batchCompletionGuard.passes.push(passSummary);

      const fitmentImageParityAcceptable =
        passSummary.before.missingFitment > 0 &&
        passSummary.before.missingFitment === passSummary.before.missingFitmentImage &&
        passSummary.before.missingTitleDescription === 0;
      const nothingMissing =
        passSummary.before.missingFitment === 0 &&
        passSummary.before.missingFitmentImage === 0 &&
        passSummary.before.missingTitleDescription === 0;
      if (nothingMissing || fitmentImageParityAcceptable) {
        summary.batchCompletionGuard.resolved = true;
        summary.batchCompletionGuard.acceptedByFitmentImageParity = Boolean(fitmentImageParityAcceptable);
        emitInventoryAutoChainLog(
          fitmentImageParityAcceptable
            ? `Post-import automation: batch completeness guard accepted by fitment/image parity before retry pass ${pass}.`
            : `Post-import automation: batch completeness guard resolved before retry pass ${pass}.`
        );
        break;
      }

      emitInventoryAutoChainLog(
        `Post-import automation: batch guard pass ${pass} before rerun ` +
          `(fitmentMissing=${passSummary.before.missingFitment}, ` +
          `imageMissing=${passSummary.before.missingFitmentImage}, ` +
          `titleDescMissing=${passSummary.before.missingTitleDescription})`
      );

      if (finalGaps.missingFitmentIpns.length > 0) {
        emitStepProgress('ebaysandbox_post_import_guard', 99, `Batch guard pass ${pass}: rerunning Phase 6 for missing fitment...`);
        passSummary.phase6Retry = await runPhase6Fitment({
          ...chainBase,
          phase6ListingsTable: listingsTable,
          phaseSharedMasterTable: sharedMasterContext?.masterTable,
          phaseSharedMasterRows: sharedMasterContext?.masterRows,
          phaseSharedMasterByIpn: sharedMasterContext?.masterByIpn,
          airtableMasterTable: masterTableName,
          openaiApiKey: String(stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
          openaiModel: String(stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
          openaiBaseUrl: String(stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
          phase6PromptCacheEnabled:
            String(stored.phase6PromptCacheEnabled ?? process.env.PHASE6_PROMPT_CACHE_ENABLED ?? 'true').trim().toLowerCase() !==
            'false',
          phase6PromptCacheKey: String(
            stored.phase6PromptCacheKey ||
              process.env.PHASE6_PROMPT_CACHE_KEY ||
              process.env.OPENAI_PROMPT_CACHE_KEY ||
              'phase6_fitment_v1'
          ).trim(),
          phase6TestIpns: finalGaps.missingFitmentIpns.join(','),
          phase6MaxIpns: 0,
          sampleLimit: Number(stored.phase6SampleLimit || process.env.PHASE6_SAMPLE_LIMIT || 20) || 20
        }, buildPostImportProgressBridge('ebaysandbox_post_import_guard', `Batch Guard Phase 6 pass ${pass}`));
      }

      const phase72RetryIpns = Array.from(
        new Set([...finalGaps.missingFitmentImageIpns, ...finalGaps.missingFitmentIpns])
      );
      if (phase72RetryIpns.length > 0) {
        emitStepProgress('ebaysandbox_post_import_guard', 99, `Batch guard pass ${pass}: rerunning Phase 7.2 for missing fitment images...`);
        passSummary.phase72Retry = await runPhase72FitmentImage({
          ...chainBase,
          phaseSharedMasterTable: sharedMasterContext?.masterTable,
          phaseSharedMasterRows: sharedMasterContext?.masterRows,
          phaseSharedMasterByIpn: sharedMasterContext?.masterByIpn,
          phase72MasterTable: String(
            stored.phase72MasterTable || stored.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table'
          ).trim(),
          phase72DriveFolderId: String(stored.phase72DriveFolderId || process.env.PHASE72_DRIVE_FOLDER_ID || '').trim(),
          phase72TestIpns: phase72RetryIpns.join(','),
          phase72MaxIpns: 0,
          phase72ForceRegenerate:
            String(stored.phase72ForceRegenerate ?? process.env.PHASE72_FORCE_REGENERATE ?? 'false').trim().toLowerCase() === 'true',
          sampleLimit: Number(stored.phase72SampleLimit || process.env.PHASE72_SAMPLE_LIMIT || 20) || 20
        }, buildPostImportProgressBridge('ebaysandbox_post_import_guard', `Batch Guard Phase 7.2 pass ${pass}`));
      }

      if (finalGaps.missingTitleDescriptionIpns.length > 0) {
        emitStepProgress('ebaysandbox_post_import_guard', 99, `Batch guard pass ${pass}: rerunning Phase 7.4 for missing title/description...`);
        passSummary.phase74Retry = await runPhase74TitleDescription({
          ...chainBase,
          phaseSharedMasterTable: sharedMasterContext?.masterTable,
          phaseSharedMasterRows: sharedMasterContext?.masterRows,
          phaseSharedMasterByIpn: sharedMasterContext?.masterByIpn,
          phase74ListingsTable: listingsTable,
          airtableMasterTable: masterTableName,
          openaiApiKey: String(stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
          openaiModel: String(stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
          phase74TitleRulesPrompt: resolvePhase74TitleRulesPrompt(
            stored.phase74TitleRulesPrompt,
            process.env.PHASE74_TITLE_RULES_PROMPT
          ),
          openaiBaseUrl: String(stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
          phase74PromptCacheEnabled:
            String(stored.phase74PromptCacheEnabled ?? process.env.PHASE74_PROMPT_CACHE_ENABLED ?? 'true').trim().toLowerCase() !==
            'false',
          phase74PromptCacheKey: String(
            stored.phase74PromptCacheKey ||
              process.env.PHASE74_PROMPT_CACHE_KEY ||
              process.env.OPENAI_PROMPT_CACHE_KEY ||
              'phase74_title_description_v1'
          ).trim(),
          phase74TestIpns: finalGaps.missingTitleDescriptionIpns.join(','),
          phase74MaxListings: 0,
          sampleLimit: Number(stored.phase74SampleLimit || process.env.PHASE74_SAMPLE_LIMIT || 20) || 20
        }, buildPostImportProgressBridge('ebaysandbox_post_import_guard', `Batch Guard Phase 7.4 pass ${pass}`));
      }

      finalGaps = await evaluateBatchOutputGaps({
        airtableService,
        listingsTable,
        masterTable: masterTableName,
        batchIpns
      });
      passSummary.after = {
        missingFitment: finalGaps.missingFitmentIpns.length,
        missingFitmentImage: finalGaps.missingFitmentImageIpns.length,
        missingTitleDescription: finalGaps.missingTitleDescriptionIpns.length,
        missingListingRows: finalGaps.missingListingRowsIpns.length,
        missingMasterRows: finalGaps.missingMasterRowsIpns.length
      };

      emitInventoryAutoChainLog(
        `Post-import automation: batch guard pass ${pass} after rerun ` +
          `(fitmentMissing=${passSummary.after.missingFitment}, ` +
          `imageMissing=${passSummary.after.missingFitmentImage}, ` +
          `titleDescMissing=${passSummary.after.missingTitleDescription})`
      );
    }

    summary.batchCompletionGuard.unresolved = {
      missingFitmentIpns: finalGaps.missingFitmentIpns.slice(0, 200),
      missingFitmentImageIpns: finalGaps.missingFitmentImageIpns.slice(0, 200),
      missingTitleDescriptionIpns: finalGaps.missingTitleDescriptionIpns.slice(0, 200),
      missingListingRowsIpns: finalGaps.missingListingRowsIpns.slice(0, 200),
      missingMasterRowsIpns: finalGaps.missingMasterRowsIpns.slice(0, 200)
    };
    const fitmentImageParityAcceptable =
      finalGaps.missingFitmentIpns.length > 0 &&
      finalGaps.missingFitmentIpns.length === finalGaps.missingFitmentImageIpns.length &&
      finalGaps.missingTitleDescriptionIpns.length === 0;
    summary.batchCompletionGuard.acceptedByFitmentImageParity = Boolean(fitmentImageParityAcceptable);
    summary.batchCompletionGuard.resolved =
      (
        finalGaps.missingFitmentIpns.length === 0 &&
        finalGaps.missingFitmentImageIpns.length === 0 &&
        finalGaps.missingTitleDescriptionIpns.length === 0
      ) ||
      fitmentImageParityAcceptable;

    if (summary.batchCompletionGuard.resolved) {
      if (fitmentImageParityAcceptable) {
        emitInventoryAutoChainLog(
          `Post-import automation: batch completeness guard accepted by fitment/image parity ` +
            `(fitment=${finalGaps.missingFitmentIpns.length}, image=${finalGaps.missingFitmentImageIpns.length}, titleDesc=${finalGaps.missingTitleDescriptionIpns.length}).`
        );
      } else {
        emitInventoryAutoChainLog('Post-import automation: batch completeness guard resolved all missing outputs.');
      }
    } else {
      emitInventoryAutoChainLog(
        `Post-import automation: batch completeness guard finished with unresolved items ` +
          `(fitment=${finalGaps.missingFitmentIpns.length}, ` +
          `image=${finalGaps.missingFitmentImageIpns.length}, ` +
          `titleDesc=${finalGaps.missingTitleDescriptionIpns.length}).`,
        'error'
      );
      if (summary.batchCompletionGuard.strict) {
        throw new Error(
          `Batch completeness guard failed: unresolved outputs remain ` +
            `(fitment=${finalGaps.missingFitmentIpns.length}, ` +
            `image=${finalGaps.missingFitmentImageIpns.length}, ` +
            `titleDesc=${finalGaps.missingTitleDescriptionIpns.length}).`
        );
      }
    }
  } else {
    emitInventoryAutoChainLog(
      batchIpns.length === 0
        ? 'Post-import automation: batch completeness guard skipped (no batch IPNs reported by sandbox import).'
        : 'Post-import automation: batch completeness guard skipped (missing Airtable credentials).',
      batchIpns.length === 0 ? 'info' : 'error'
    );
  }

  emitStepProgress('ebaysandbox_post_import_complete', 100, 'Post-import automation completed.');
  emitInventoryAutoChainLog('Post-import automation completed: Phase4 -> Phase6 -> Phase7.2 -> Phase7.4');
  return summary;
}

/* ---------------------------
   WINDOWS INSTALLER SAFETY
---------------------------- */
if (require('electron-squirrel-startup')) {
  app.quit();
}

/* ---------------------------
   PAGE LOADERS (ONLY PLACE!)
---------------------------- */
function loadSetup() {
  mainWindow.loadFile(path.join(__dirname, '../renderer/pages/shared/setup.html'));
}

function loadDashboard() {
  mainWindow.loadFile(path.join(__dirname, '../renderer/pages/main-dashboard.html'));
}

/* ---------------------------
   IPC HANDLERS
---------------------------- */
ipcMain.handle('save-db-config', async (_, config) => {
  try {
    saveDbConfig(config);
    
    // Use appropriate connection method based on auth type
    if (config.authType === 'windows') {
      await initDbWindowsAuth(config.server, config.database);
    } else {
      await initDb();
    }
    
    dbReady = true;

    // Let frontend handle navigation (setup.html redirects to reporting.html)
    // Don't force webhook page here

    return { success: true };
  } catch (err) {
    dbReady = false;
    return { success: false, message: err.message };
  }
});

ipcMain.handle('test-windows-auth', async (_, config) => {
  try {
    const sql = require('mssql/msnodesqlv8');
    
    console.log(`🔐 Testing Windows Auth connection to ${config.server}...`);
    console.log(`💾 Database: ${config.database}`);
    
    const poolConfig = {
      connectionString: `Driver={ODBC Driver 18 for SQL Server};Server=${config.server};Database=${config.database};Trusted_Connection=yes;TrustServerCertificate=yes;Connection Timeout=30;`,
      connectionTimeout: 30000,
      requestTimeout: 30000,
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
      }
    };
    
    const pool = new sql.ConnectionPool(poolConfig);
    pool.on('error', err => {
      console.error('❌ Pool error:', err.message);
    });
    
    console.log('⏳ Connecting...');
    await pool.connect();
    console.log('✅ Connected! Testing query...');
    
    const result = await pool.request().query('SELECT @@VERSION as version');
    console.log('✅ Query successful');
    
    await pool.close();
    
    return { success: true, message: 'Connection successful!' };
  } catch (err) {
    console.error('❌ Raw error:', err);
    console.error('❌ Error type:', typeof err);
    console.error('❌ Error constructor:', err?.constructor?.name);
    
    let errorMsg = 'Unknown error';
    
    if (err?.originalError) {
      console.error('❌ Original error:', err.originalError);
      errorMsg = String(err.originalError);
    } else if (err?.message && err.message !== '[object Object]') {
      errorMsg = String(err.message);
    } else if (typeof err === 'string') {
      errorMsg = err;
    } else {
      console.error('❌ Error properties:', {
        code: err?.code,
        state: err?.state,
        sqlState: err?.sqlState,
        number: err?.number
      });
      try {
        errorMsg = JSON.stringify(err);
      } catch {
        errorMsg = String(err);
      }
    }
    
    console.error('❌ Final error message:', errorMsg);
    return { success: false, message: errorMsg };
  }
});

ipcMain.handle('test-db-connection', async (_, config) => {
  try {
    const sql = require('mssql/msnodesqlv8');  // Use Windows ODBC driver
    
    // Use server name exactly as provided (SSMS uses just "STR" without port)
    let serverName = config.server.trim();
    
    console.log(`🔐 Testing connection to ${serverName}...`);
    console.log(`👤 User: ${config.user}`);
    console.log(`💾 Database: ${config.database}`);
    
    const poolConfig = {
      connectionString: `Driver={ODBC Driver 18 for SQL Server};Server=${serverName};Database=${config.database};Uid=${config.user};Pwd=${config.password};Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=30;`,
      connectionTimeout: 30000,
      requestTimeout: 30000,
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
      }
    };
    
    const pool = new sql.ConnectionPool(poolConfig);
    pool.on('error', err => {
      console.error('❌ Pool error:', err.message);
    });
    
    console.log('⏳ Connecting...');
    await pool.connect();
    console.log('✅ Connected! Testing query...');
    
    const result = await pool.request().query('SELECT @@VERSION as version');
    console.log('✅ Query successful');
    
    await pool.close();
    
    return { success: true, message: 'Connection successful!' };
  } catch (err) {
    console.error('❌ Raw error:', err);
    console.error('❌ Error type:', typeof err);
    console.error('❌ Error constructor:', err?.constructor?.name);
    
    // Try to extract the real error message
    let errorMsg = 'Unknown error';
    
    // Check if there's an underlying ODBC error
    if (err?.originalError) {
      console.error('❌ Original error:', err.originalError);
      errorMsg = String(err.originalError);
    } else if (err?.message && err.message !== '[object Object]') {
      errorMsg = String(err.message);
    } else if (typeof err === 'string') {
      errorMsg = err;
    } else {
      // Try to extract info from the error object itself
      console.error('❌ Error properties:', {
        code: err?.code,
        state: err?.state,
        sqlState: err?.sqlState,
        number: err?.number
      });
      try {
        errorMsg = JSON.stringify(err);
      } catch {
        errorMsg = String(err);
      }
    }
    
    console.error('❌ Final error message:', errorMsg);
    return { success: false, message: errorMsg };
  }
});

ipcMain.handle('save-webhook', async (_, url) => {
  if (!url) return { success: false, message: 'Webhook required' };

  saveWebhookConfig(url);

  return { success: true, message: 'Webhook saved successfully!' };
});

ipcMain.handle('get-webhook-config', async () => {
  return getWebhookConfig();
});

ipcMain.handle('reset-config', async () => {
  dbReady = false;
  clearDbConfig();
  clearWebhookConfig();

  return { success: true };
});

/* ---------------------------
   REPORTING IPC HANDLERS
---------------------------- */

// Get salespeople list
ipcMain.handle('reporting-get-salespeople', async () => {
  if (!dbReady) throw new Error('DB not ready');
  return await getSalespeople();
});

// Manual Excel export
ipcMain.handle('reporting-export-excel', async (_, params) => {
  if (!dbReady) throw new Error('DB not ready');

  try {
    const data = await getInvoices(params);
    const result = await generateExcelFile(data, mainWindow);
    
    logExecution('Manual', result.success, result.message);
    
    return result;
  } catch (error) {
    // Convert technical database errors to user-friendly messages
    let userMessage = error.message;
    
    if (error.message.includes('Invalid object name') || 
        error.message.includes('table not found') ||
        error.message.includes('does not exist')) {
      userMessage = 'Database table not found. Please check your database configuration.';
    } else if (error.message.includes('Login failed') || 
               error.message.includes('Cannot open database')) {
      userMessage = 'Database connection failed. Please check your database credentials.';
    } else if (error.message.includes('timeout')) {
      userMessage = 'Database request timed out. Please try again.';
    }
    
    const errorMsg = `Export failed: ${userMessage}`;
    logExecution('Manual', false, errorMsg);
    return { success: false, message: errorMsg };
  }
});

// Save scheduled download
ipcMain.handle('reporting-save-schedule', async (_, scheduleConfig) => {
  try {
    // Check if user is authenticated with Google
    const isAuthenticated = await oauth2Service.isAuthenticated('reporting');
    if (!isAuthenticated) {
      return {
        success: false,
        message: 'Please connect to Google Sheets first using the Connect button.'
      };
    }

    // Validate spreadsheet ID is provided
    if (!scheduleConfig.spreadsheetId) {
      return {
        success: false,
        message: 'Google Sheet ID is required. Please enter your Google Sheets ID.'
      };
    }

    // Initialize Google Sheets with OAuth2 client
    try {
      const authClient = await oauth2Service.getAuthenticatedClient('reporting');
      await initSheets(authClient);
    } catch (err) {
      return {
        success: false,
        message: `Failed to initialize Google Sheets: ${err.message}`
      };
    }

    // Test the spreadsheet ID - try to access it
    try {
      const { google } = require('googleapis');
      const authClient = await oauth2Service.getAuthenticatedClient('reporting');
      const sheets = google.sheets({ version: 'v4', auth: authClient });
      
      // Try to get spreadsheet metadata to verify access
      const response = await sheets.spreadsheets.get({
        spreadsheetId: scheduleConfig.spreadsheetId
      });
      
      console.log(`✅ Successfully verified access to sheet: ${response.data.properties.title}`);
      
      // Check if RAW tab exists
      const sheetNames = response.data.sheets.map(s => s.properties.title);
      if (!sheetNames.includes('RAW')) {
        return {
          success: false,
          message: 'The spreadsheet does not have a "RAW" tab. Please create a sheet named "RAW" in your Google Spreadsheet first.'
        };
      }
      
      console.log('✅ RAW tab found');
      
    } catch (err) {
      return {
        success: false,
        message: `Failed to access Google Sheet: ${err.message}. Please verify the Sheet ID is correct and you have access to it.`
      };
    }

    // Save spreadsheet ID to config
    saveReportingConfig('spreadsheetId', scheduleConfig.spreadsheetId);

    // Start the schedule with received config (already includes spreadsheetId)
    const started = startSchedule(scheduleConfig);

    if (started) {
      return {
        success: true,
        message: `Schedule activated: ${scheduleConfig.frequency} at midnight`
      };
    } else {
      return {
        success: false,
        message: 'Failed to start schedule'
      };
    }

  } catch (error) {
    return {
      success: false,
      message: error.message
    };
  }
});

// Cancel schedule
ipcMain.handle('reporting-cancel-schedule', async () => {
  try {
    stopSchedule();
    return {
      success: true,
      message: 'Schedule cancelled successfully'
    };
  } catch (error) {
    return {
      success: false,
      message: error.message
    };
  }
});

// Get current schedule
ipcMain.handle('reporting-get-schedule', async () => {
  return getReportingConfig('activeSchedule') || null;
});

// Get saved spreadsheet ID
ipcMain.handle('reporting-get-sheet-id', async () => {
  return getReportingConfig('spreadsheetId') || null;
});

// Get execution logs
ipcMain.handle('reporting-get-logs', async (_, limit) => {
  return getExecutionLogs(limit);
});

// Test schedule immediately
ipcMain.handle('reporting-test-schedule', async () => {
  try {
    if (!dbReady) {
      return {
        success: false,
        message: 'Database not ready'
      };
    }

    const schedule = getReportingConfig('activeSchedule');
    
    if (!schedule) {
      return {
        success: false,
        message: 'No active schedule found. Please save a schedule first.'
      };
    }

    console.log('Testing schedule immediately...');
    
    // Check if user is authenticated with Google
    const isAuthenticated = await oauth2Service.isAuthenticated('reporting');
    if (!isAuthenticated) {
      return {
        success: false,
        message: 'Please connect to Google Sheets first using the Connect button.'
      };
    }

    // Initialize Google Sheets with OAuth2 client
    const spreadsheetId = schedule.spreadsheetId;
    try {
      const authClient = await oauth2Service.getAuthenticatedClient('reporting');
      await initSheets(authClient);
      console.log('Google Sheets initialized for test');
    } catch (initErr) {
      return {
        success: false,
        message: `Failed to initialize Google Sheets: ${initErr.message}`
      };
    }

    // Verify spreadsheet access and RAW tab
    const hasAccess = await require('../services/sheetsService').verifyAccess(spreadsheetId);
    if (!hasAccess) {
      return {
        success: false,
        message: 'Cannot access the spreadsheet. Verify the Spreadsheet ID and sharing permissions.'
      };
    }

    const rawExists = await require('../services/sheetsService').rawTabExists(spreadsheetId);
    if (!rawExists) {
      return {
        success: false,
        message: 'RAW tab not found. Create a sheet named RAW (uppercase).'
      };
    }

    const result = await executeScheduledJob(schedule);
    
    return {
      success: result.success,
      message: result.success 
        ? `Schedule executed successfully! ${result.message}` 
        : `Schedule execution failed: ${result.message}`
    };
  } catch (error) {
    console.error('Test schedule error:', error);
    return {
      success: false,
      message: `Test failed: ${error.message}`
    };
  }
});

/* ---------------------------
   WORK ORDERS IPC HANDLERS
---------------------------- */

ipcMain.handle('workorders-run-now', async (_, options = {}) => {
  try {
    if (!dbReady) {
      return {
        success: false,
        message: 'Database not ready'
      };
    }

    const isAuthenticated = await oauth2Service.isAuthenticated('reporting');
    if (!isAuthenticated) {
      return {
        success: false,
        message: 'Please connect to Google Sheets first using the Connect button.'
      };
    }

    const spreadsheetId = String(
      options.spreadsheetId ||
      getReportingConfig('workOrdersSpreadsheetId') ||
      ''
    ).trim();
    const sheetName = String(
      options.sheetName ||
      getReportingConfig('workOrdersSheetName') ||
      DEFAULT_WORK_ORDERS_SHEET_NAME
    ).trim() || DEFAULT_WORK_ORDERS_SHEET_NAME;
    const driveFolderId = String(
      options.googleDriveFolderId ||
      getReportingConfig('workOrdersDriveFolderId') ||
      process.env.GOOGLE_DRIVE_IMAGE_FOLDER_ID ||
      ''
    ).trim();
    const driveServiceAccountKeyPath = String(
      options.googleDriveServiceAccountKeyPath ||
      getReportingConfig('workOrdersDriveServiceAccountKeyPath') ||
      process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_PATH ||
      ''
    ).trim();
    const imageUploadFallback = String(
      options.imageUploadFallback ||
      getReportingConfig('workOrdersImageUploadFallback') ||
      process.env.IMAGE_UPLOAD_FALLBACK ||
      'blank'
    ).trim();
    const phase2Config = getInventoryConfig('phase2Config') || {};
    const clickupToken = String(
      options.clickupToken ||
      getReportingConfig('workOrdersClickupToken') ||
      phase2Config.clickupToken ||
      process.env.CLICKUP_TOKEN ||
      ''
    ).trim();
    const clickupListId = String(
      options.workOrdersClickupListId ||
      options.clickupListId ||
      getReportingConfig('workOrdersClickupListId') ||
      phase2Config.clickupListId ||
      process.env.WORK_ORDERS_CLICKUP_LIST_ID ||
      ''
    ).trim();

    if (!spreadsheetId) {
      return {
        success: false,
        message: 'Google Sheet ID is required for Work Orders sync.'
      };
    }

    logWorkOrdersExecution(true, 'Manual Work Orders sync started', {
      trigger: 'manual_workorders',
      startedAt: new Date().toISOString()
    });

    const authClient = await oauth2Service.getAuthenticatedClient('reporting');
    let driveAuthClient = null;
    try {
      driveAuthClient = await oauth2Service.getAuthenticatedClient('inventory');
    } catch (_) {
      driveAuthClient = await oauth2Service.getAuthenticatedClient('reporting');
    }
    const summary = await runWorkOrdersSync({
      authClient,
      driveAuthClient,
      spreadsheetId,
      sheetName,
      driveFolderId,
      driveServiceAccountKeyPath,
      imageUploadFallback,
      clickupToken,
      clickupListId,
      onProgress: ({ message, summary: progressSummary }) => {
        logWorkOrdersExecution(true, message, {
          trigger: 'manual_workorders',
          event: 'progress',
          ...(progressSummary || {})
        });
      }
    });

    saveReportingConfig('workOrdersSpreadsheetId', spreadsheetId);
    saveReportingConfig('workOrdersSheetName', sheetName);
    saveReportingConfig('workOrdersDriveFolderId', driveFolderId);
    saveReportingConfig('workOrdersDriveServiceAccountKeyPath', driveServiceAccountKeyPath);
    saveReportingConfig('workOrdersImageUploadFallback', imageUploadFallback);
    saveReportingConfig('workOrdersClickupListId', clickupListId);
    logWorkOrdersExecution(true, 'Manual Work Orders sync completed', {
      trigger: 'manual_workorders',
      event: 'run_completed',
      ...summary
    });

    return {
      success: true,
      message: `Work Orders sync completed. Inserted=${summary.inserted}, Updated=${summary.updated}, Removed=${summary.removed}`,
      summary
    };
  } catch (error) {
    const summary = error?.summary || null;
    logWorkOrdersExecution(false, `Manual Work Orders sync failed: ${error.message}`, summary);
    return {
      success: false,
      message: `Work Orders sync failed: ${error.message}`,
      summary
    };
  }
});

ipcMain.handle('workorders-save-schedule', async (_, scheduleConfig = {}) => {
  try {
    if (!dbReady) {
      return {
        success: false,
        message: 'Database not ready'
      };
    }

    const isAuthenticated = await oauth2Service.isAuthenticated('reporting');
    if (!isAuthenticated) {
      return {
        success: false,
        message: 'Please connect to Google Sheets first using the Connect button.'
      };
    }

    const spreadsheetId = String(scheduleConfig.spreadsheetId || '').trim();
    if (!spreadsheetId) {
      return {
        success: false,
        message: 'Google Sheet ID is required.'
      };
    }

    const frequency = String(scheduleConfig.frequency || '').trim();
    if (!['every_1_minute', 'every_3_minutes', 'every_5_minutes'].includes(frequency)) {
      return {
        success: false,
        message: 'Invalid Work Orders frequency. Use Every 1, 3, or 5 minutes.'
      };
    }

    const sheetName = String(
      scheduleConfig.sheetName || getReportingConfig('workOrdersSheetName') || DEFAULT_WORK_ORDERS_SHEET_NAME
    ).trim() || DEFAULT_WORK_ORDERS_SHEET_NAME;
    const driveFolderId = String(
      scheduleConfig.googleDriveFolderId ||
      getReportingConfig('workOrdersDriveFolderId') ||
      process.env.GOOGLE_DRIVE_IMAGE_FOLDER_ID ||
      ''
    ).trim();
    const driveServiceAccountKeyPath = String(
      scheduleConfig.googleDriveServiceAccountKeyPath ||
      getReportingConfig('workOrdersDriveServiceAccountKeyPath') ||
      process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_PATH ||
      ''
    ).trim();
    const imageUploadFallback = String(
      scheduleConfig.imageUploadFallback ||
      getReportingConfig('workOrdersImageUploadFallback') ||
      process.env.IMAGE_UPLOAD_FALLBACK ||
      'blank'
    ).trim();
    const phase2Config = getInventoryConfig('phase2Config') || {};
    const clickupToken = String(
      scheduleConfig.clickupToken ||
      getReportingConfig('workOrdersClickupToken') ||
      phase2Config.clickupToken ||
      process.env.CLICKUP_TOKEN ||
      ''
    ).trim();
    const clickupListId = String(
      scheduleConfig.workOrdersClickupListId ||
      scheduleConfig.clickupListId ||
      getReportingConfig('workOrdersClickupListId') ||
      phase2Config.clickupListId ||
      process.env.WORK_ORDERS_CLICKUP_LIST_ID ||
      ''
    ).trim();

    try {
      const { google } = require('googleapis');
      const authClient = await oauth2Service.getAuthenticatedClient('reporting');
      const sheets = google.sheets({ version: 'v4', auth: authClient });
      await sheets.spreadsheets.get({
        spreadsheetId
      });
    } catch (error) {
      return {
        success: false,
        message: `Failed to access Google Sheet: ${error.message}`
      };
    }

    const configToSave = {
      dataType: 'workorders',
      frequency,
      endDate: scheduleConfig.endDate || null,
      spreadsheetId,
      sheetName,
      driveFolderId,
      driveServiceAccountKeyPath,
      imageUploadFallback,
      clickupToken,
      clickupListId
    };

    saveReportingConfig('workOrdersSpreadsheetId', spreadsheetId);
    saveReportingConfig('workOrdersSheetName', sheetName);
    saveReportingConfig('workOrdersDriveFolderId', driveFolderId);
    saveReportingConfig('workOrdersDriveServiceAccountKeyPath', driveServiceAccountKeyPath);
    saveReportingConfig('workOrdersImageUploadFallback', imageUploadFallback);
    saveReportingConfig('workOrdersClickupListId', clickupListId);
    startWorkOrdersSchedule(configToSave);

    return {
      success: true,
      message: `Work Orders schedule activated: ${frequency.replaceAll('_', ' ')}`
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to save Work Orders schedule: ${error.message}`
    };
  }
});

ipcMain.handle('workorders-cancel-schedule', async () => {
  try {
    stopWorkOrdersSchedule();
    return {
      success: true,
      message: 'Work Orders schedule cancelled successfully'
    };
  } catch (error) {
    return {
      success: false,
      message: error.message
    };
  }
});

ipcMain.handle('workorders-get-schedule', async () => {
  return getReportingConfig('workOrdersActiveSchedule') || null;
});

ipcMain.handle('workorders-get-sheet-id', async () => {
  return getReportingConfig('workOrdersSpreadsheetId') || null;
});

ipcMain.handle('workorders-get-drive-folder-id', async () => {
  return getReportingConfig('workOrdersDriveFolderId') || process.env.GOOGLE_DRIVE_IMAGE_FOLDER_ID || null;
});

ipcMain.handle('workorders-get-clickup-list-id', async () => {
  const phase2Config = getInventoryConfig('phase2Config') || {};
  return (
    getReportingConfig('workOrdersClickupListId') ||
    phase2Config.clickupListId ||
    process.env.WORK_ORDERS_CLICKUP_LIST_ID ||
    null
  );
});

ipcMain.handle('workorders-get-logs', async (_, limit) => {
  return getWorkOrdersExecutionLogs(limit);
});

ipcMain.handle('workorders-clear-logs', async () => {
  try {
    clearWorkOrdersExecutionLogs();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      message: `Failed to clear Work Orders execution logs: ${error.message}`
    };
  }
});

ipcMain.handle('workorders-test-schedule', async () => {
  try {
    if (!dbReady) {
      return {
        success: false,
        message: 'Database not ready'
      };
    }

    const schedule = getReportingConfig('workOrdersActiveSchedule');
    if (!schedule) {
      return {
        success: false,
        message: 'No active Work Orders schedule found. Please save a schedule first.'
      };
    }

    const result = await executeWorkOrdersScheduledJob(schedule);
    return {
      success: Boolean(result?.success),
      message: result?.success
        ? `Work Orders schedule test completed. Inserted=${result.summary?.inserted || 0}, Updated=${result.summary?.updated || 0}, Removed=${result.summary?.removed || 0}`
        : `Work Orders schedule test failed: ${result?.message || 'Unknown error'}`,
      summary: result?.summary || null
    };
  } catch (error) {
    return {
      success: false,
      message: `Work Orders schedule test failed: ${error.message}`,
      summary: error?.summary || null
    };
  }
});

ipcMain.handle('workorders-clickup-sync-now', async (_, options = {}) => {
  try {
    if (!dbReady) {
      return {
        success: false,
        message: 'Database not ready'
      };
    }

    const isAuthenticated = await oauth2Service.isAuthenticated('reporting');
    if (!isAuthenticated) {
      return {
        success: false,
        message: 'Please connect to Google Sheets first using the Connect button.'
      };
    }

    const phase2Config = getInventoryConfig('phase2Config') || {};
    const spreadsheetId = String(
      options.spreadsheetId ||
      getReportingConfig('workOrdersSpreadsheetId') ||
      ''
    ).trim();
    const sheetName = String(
      options.sheetName ||
      getReportingConfig('workOrdersSheetName') ||
      DEFAULT_WORK_ORDERS_SHEET_NAME
    ).trim() || DEFAULT_WORK_ORDERS_SHEET_NAME;
    const clickupToken = String(
      options.clickupToken ||
      getReportingConfig('workOrdersClickupToken') ||
      phase2Config.clickupToken ||
      process.env.CLICKUP_TOKEN ||
      ''
    ).trim();
    const clickupListId = String(
      options.workOrdersClickupListId ||
      options.clickupListId ||
      getReportingConfig('workOrdersClickupListId') ||
      phase2Config.clickupListId ||
      process.env.WORK_ORDERS_CLICKUP_LIST_ID ||
      ''
    ).trim();

    if (!spreadsheetId) {
      return {
        success: false,
        message: 'Google Sheet ID is required for ClickUp sync.'
      };
    }

    logWorkOrdersExecution(true, 'Manual ClickUp sync started', {
      trigger: 'manual_clickup',
      startedAt: new Date().toISOString()
    });

    const authClient = await oauth2Service.getAuthenticatedClient('reporting');
    const summary = await runClickUpSyncFromSheet({
      authClient,
      spreadsheetId,
      sheetName,
      clickupToken,
      clickupListId
    });
    logWorkOrdersExecution(true, 'Manual ClickUp sync completed', {
      trigger: 'manual_clickup',
      ...summary
    });

    return {
      success: true,
      message:
        `ClickUp sync completed. Created=${summary.tasksCreated}, ` +
        `Updated=${summary.tasksUpdated}, Completed=${summary.tasksCompleted}, ` +
        `QuoteRemoved=${summary.quoteRowsRemovedFromSheet}`,
      summary
    };
  } catch (error) {
    logWorkOrdersExecution(false, `Manual ClickUp sync failed: ${error.message}`, error?.summary || null);
    return {
      success: false,
      message: `ClickUp sync failed: ${error.message}`
    };
  }
});

// OAuth2 handlers (Reporting / Milestone 11)
ipcMain.handle('oauth2-get-auth-url', async () => {
  try {
    // Return the auth URL string directly
    return oauth2Service.getAuthUrl('reporting');
  } catch (error) {
    throw error;
  }
});

ipcMain.handle('oauth2-exchange-code', async (_, code) => {
  try {
    await oauth2Service.getTokensFromCode(code, 'reporting');
    return {
      success: true,
      message: 'Successfully connected to Google!'
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to connect: ${error.message}`
    };
  }
});

ipcMain.handle('oauth2-get-user-info', async () => {
  try {
    if (!oauth2Service.isAuthenticated('reporting')) {
      return null;
    }

    // Return plain user info object
    const userInfo = await oauth2Service.getUserInfo('reporting');
    return userInfo;
  } catch (error) {
    throw error;
  }
});

ipcMain.handle('oauth2-is-authenticated', async () => {
  // Return a simple boolean so renderer can do `if (isAuthenticated)`
  return oauth2Service.isAuthenticated('reporting');
});

ipcMain.handle('oauth2-disconnect', async () => {
  try {
    oauth2Service.disconnect('reporting');
    return {
      success: true,
      message: 'Disconnected from Google'
    };
  } catch (error) {
    return {
      success: false,
      message: error.message
    };
  }
});

// OAuth2 handlers (Inventory / Milestone 1)
ipcMain.handle('oauth2-inventory-get-auth-url', async () => {
  try {
    return oauth2Service.getAuthUrl('inventory');
  } catch (error) {
    throw error;
  }
});

ipcMain.handle('oauth2-inventory-get-user-info', async () => {
  try {
    if (!oauth2Service.isAuthenticated('inventory')) {
      return null;
    }
    return await oauth2Service.getUserInfo('inventory');
  } catch (error) {
    throw error;
  }
});

ipcMain.handle('oauth2-inventory-is-authenticated', async () => {
  return oauth2Service.isAuthenticated('inventory');
});

ipcMain.handle('oauth2-inventory-get-auth-source', async () => {
  return oauth2Service.getAuthSource('inventory');
});

ipcMain.handle('oauth2-inventory-disconnect', async () => {
  try {
    oauth2Service.disconnect('inventory');
    return {
      success: true,
      message: 'Disconnected from Google'
    };
  } catch (error) {
    return {
      success: false,
      message: error.message
    };
  }
});

/* ---------------------------
   INVENTORY GOOGLE SHEETS HANDLERS - PHASE 1
---------------------------- */
const { getAllInventory } = require('../services/inventoryService');
const { testSheetsConnection, validateAndExtractSpreadsheetId } = require('../services/googleSheetsInventoryService');
const { 
  startInventorySchedule, 
  stopInventorySchedule, 
  executeInventoryPush,
  setPostPushHook,
  getScheduleStatus,
  getExecutionLogs: getInventoryLogs,
  clearExecutionLogs: clearInventoryLogs,
  initializeSchedule: initInventorySchedule
} = require('../services/inventoryScheduleService');

setPostPushHook(async payload => {
  const phase2Result = await phase2AutoRunService.onPhase1PushSuccess(payload);
  if (phase2Result?.skipped) {
    emitInventoryAutoChainLog(
      `Phase3 auto-run skipped after Phase1 push: Phase2 did not run (reason=${phase2Result.reason || 'unknown'})`
    );
    return;
  }

  const stored = getInventoryConfig('phase2Config') || {};
  const phase3Config = buildPhase3Config(stored);
  const hasPhase3MinimumConfig =
    Boolean(phase3Config?.sheetId) &&
    Boolean(phase3Config?.tabName) &&
    Boolean(phase3Config?.airtableToken) &&
    Boolean(phase3Config?.airtableBaseId) &&
    Boolean(phase3Config?.shipstationApiKey) &&
    Boolean(phase3Config?.shipstationApiSecret);

  if (!hasPhase3MinimumConfig) {
    emitInventoryAutoChainLog('Phase3 auto-run skipped after Phase2 success: missing Phase3 config');
    return;
  }

  try {
    const phase3Summary = await runPhase3(phase3Config, () => {});
    emitInventoryAutoChainLog(
      `Phase3 auto-run completed after Phase1+Phase2 success ` +
        `(shipmentsFetched=${phase3Summary?.shipmentsFetched || 0}, ` +
        `skusMappedToIpn=${phase3Summary?.skusMappedToIpn || 0}, ` +
        `ipnsUpdated=${phase3Summary?.ipnsUpdated || 0}, ` +
        `dryRun=${Boolean(phase3Config?.phase3DryRun)})`
    );

    const phase4Config = buildPhase4Config({
      ...stored,
      sheetId: payload?.spreadsheetId || stored.sheetId || stored.spreadsheetId || '',
      tabName: payload?.worksheetName || stored.tabName || stored.worksheetName || ''
    });
    const hasPhase4MinimumConfig =
      Boolean(phase4Config?.airtableToken) &&
      Boolean(phase4Config?.masterBaseId) &&
      Boolean(phase4Config?.itemSpecificsBaseId) &&
      Boolean(phase4Config?.sheetId) &&
      Boolean(phase4Config?.tabName);

    if (!hasPhase4MinimumConfig) {
      emitInventoryAutoChainLog('Phase4 mirroring skipped after Phase3 success: missing Phase4 config');
      emitInventoryAutoChainLog('Nightly auto-run chain completed at Phase3 by configuration.');
      return;
    }

    try {
      const phase4Summary = await runPhase4Mirroring({
        ...stored,
        sheetId: phase4Config.sheetId,
        tabName: phase4Config.tabName,
        airtableToken: phase4Config.airtableToken,
        airtableBaseId: phase4Config.masterBaseId,
        itemSpecificsBaseId: phase4Config.itemSpecificsBaseId,
        phase4DryRun: phase4Config.dryRun,
        phase4IncrementalEnabled: phase4Config.incrementalEnabled,
        authContext: 'inventory'
      }, () => {});
      emitInventoryAutoChainLog(
        `Phase4 mirroring auto-run completed after Phase3 success ` +
          `(masterScanned=${phase4Summary?.masterRecordsScanned || 0}, ` +
          `eligible=${phase4Summary?.masterRecordsEligible || 0}, ` +
          `created=${phase4Summary?.ipnRowsCreated || 0}, ` +
          `mpnWritten=${phase4Summary?.manufacturerValuesWritten || 0}, ` +
          `dryRun=${Boolean(phase4Config?.dryRun)})`
      );
      emitInventoryAutoChainLog('Nightly auto-run chain completed at Phase4 by configuration.');
    } catch (error) {
      emitInventoryAutoChainLog(
        `Phase4 mirroring failed after Phase3 success: ${error.message}`,
        'error'
      );
      emitInventoryAutoChainLog('Nightly auto-run chain completed at Phase3 by configuration.');
    }
  } catch (error) {
    emitInventoryAutoChainLog(
      `Phase3 auto-run failed after Phase2 success: ${error.message}`,
      'error'
    );
  }
});

// Test Google Sheets connection
ipcMain.handle('inventory-sheets-test', async (_, spreadsheetId, worksheetName) => {
  try {
    const result = await testSheetsConnection(spreadsheetId, worksheetName);
    return result;
  } catch (error) {
    return {
      success: false,
      message: `Test failed: ${error.message}`
    };
  }
});

// Validate and extract spreadsheet ID from URL
ipcMain.handle('inventory-sheets-validate-url', async (_, sheetsUrl) => {
  try {
    const result = validateAndExtractSpreadsheetId(sheetsUrl);
    return result;
  } catch (error) {
    return {
      success: false,
      message: `URL validation failed: ${error.message}`
    };
  }
});

// Save Google Sheets configuration
ipcMain.handle('inventory-sheets-save-config', async (_, spreadsheetId, worksheetName) => {
  try {
    const { saveInventoryConfig } = require('../config/configStore');
    saveInventoryConfig('spreadsheetId', spreadsheetId);
    saveInventoryConfig('worksheetName', worksheetName);
    
    return {
      success: true,
      message: 'Google Sheets configuration saved successfully'
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to save: ${error.message}`
    };
  }
});

// Start inventory Google Sheets schedule
ipcMain.handle('inventory-sheets-start', async (_, spreadsheetId, worksheetName) => {
  try {
    const isAuthenticated = await oauth2Service.isAuthenticated('inventory');
    if (!isAuthenticated) {
      return {
        success: false,
        message: 'Please connect to Google Sheets first using the Connect button.'
      };
    }

    const started = startInventorySchedule(spreadsheetId, worksheetName);
    
    if (started) {
      return {
        success: true,
        message: 'Schedule started successfully. Inventory data will be written to Google Sheets daily at midnight.'
      };
    } else {
      return {
        success: false,
        message: 'Failed to start schedule'
      };
    }
  } catch (error) {
    return {
      success: false,
      message: `Failed to start schedule: ${error.message}`
    };
  }
});

// Stop inventory Google Sheets schedule
ipcMain.handle('inventory-sheets-stop', async () => {
  try {
    stopInventorySchedule();
    
    return {
      success: true,
      message: 'Schedule stopped successfully'
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to stop schedule: ${error.message}`
    };
  }
});

// Push inventory to Google Sheets now (manual test)
ipcMain.handle('inventory-sheets-push-now', async (event, spreadsheetId, worksheetName) => {
  try {
    const isAuthenticated = await oauth2Service.isAuthenticated('inventory');
    if (!isAuthenticated) {
      return {
        success: false,
        message: 'Please connect to Google Sheets first using the Connect button.'
      };
    }

    const result = await executeInventoryPush(
      spreadsheetId,
      worksheetName,
      progress => {
        event.sender.send('inventory-sheets:progress', {
          stage: String(progress?.stage || 'running'),
          percent: Number(progress?.percent || 0),
          message: String(progress?.message || '')
        });
      }
    );
    return result;
  } catch (error) {
    return {
      success: false,
      message: `Push failed: ${error.message}`
    };
  }
});

// Get schedule status
ipcMain.handle('inventory-sheets-get-status', async () => {
  try {
    const status = getScheduleStatus();
    return status;
  } catch (error) {
    return {
      active: false,
      spreadsheetId: null,
      worksheetName: null
    };
  }
});

// Get execution logs
ipcMain.handle('inventory-sheets-get-logs', async () => {
  try {
    const logs = getInventoryLogs();
    return logs;
  } catch (error) {
    return [];
  }
});

ipcMain.handle('inventory-sheets-clear-logs', async () => {
  try {
    clearInventoryLogs();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      message: `Failed to clear execution logs: ${error.message}`
    };
  }
});

/* ---------------------------
   PHASE 2 HANDLERS (GOOGLE SHEETS -> AIRTABLE)
---------------------------- */
function buildPhase2WritebackConfig(overrides = {}) {
  const stored = getInventoryConfig('phase2Config') || {};
  const merged = buildPhase2Config({
    ...stored,
    ...overrides
  });
  const normalizedCategoryTable = String(merged.airtableCategoryTable || '').trim();
  const resolvedCategoryTable =
    normalizedCategoryTable.toLowerCase() === 'category names'
      ? 'Category Definitions'
      : normalizedCategoryTable || 'Category Definitions';

  return {
    clickupToken: merged.clickupToken,
    clickupListId: merged.clickupListId,
    airtableToken: merged.airtableToken,
    airtableBaseId: merged.airtableBaseId,
    airtableMasterTable: merged.airtableMasterTable,
    airtableCategoryTable: resolvedCategoryTable,
    clickupResolvedCategoryFieldName: merged.clickupResolvedCategoryFieldName,
    clickupStatusDetermined: merged.clickupStatusDetermined,
    clickupStatusCompleted: merged.clickupStatusCompleted,
    clickupStatusNeedsReview: merged.clickupStatusNeedsReview,
    clickupStatusWritebackError: merged.clickupStatusWritebackError,
    categoryLinkFieldName: merged.categoryLinkFieldName,
    pollIntervalMinutes: Number(merged.writebackPollIntervalMinutes || process.env.WRITEBACK_POLL_INTERVAL_MINUTES || 5) || 5,
    enabled: true
  };
}

function stopPhase4WritebackPoller() {
  if (phase4WritebackInterval) {
    clearInterval(phase4WritebackInterval);
    phase4WritebackInterval = null;
  }
}

function startPhase4WritebackPoller() {
  stopPhase4WritebackPoller();

  phase4WritebackInterval = setInterval(async () => {
    if (isPhase4WritebackPollerRunning) return;
    isPhase4WritebackPollerRunning = true;
    try {
      const vmfSummary = await runPhase4BWritebackOnly({}, () => {});
      const mfSummary = await runPhase4CMFWritebackOnly({}, () => {});

      const vmfFound = vmfSummary?.vmfDeterminedTasksFound || 0;
      const vmfWritten = vmfSummary?.vmfDeterminedWritebackSucceeded || 0;
      const vmfClosed = vmfSummary?.vmfDeterminedTasksClosed || 0;
      const vmfFailed = vmfSummary?.vmfDeterminedWritebackFailed || 0;
      const mfWritten = mfSummary?.mfWritebacksCompleted || 0;
      const mfSkipped = mfSummary?.mfWritebacksSkippedAlreadyFilled || 0;
      const mfErrors = Array.isArray(mfSummary?.errors) ? mfSummary.errors.length : 0;

      if (vmfFound > 0 || vmfWritten > 0 || vmfClosed > 0 || mfWritten > 0 || mfSkipped > 0 || mfErrors > 0) {
        console.log(
          `Phase4 writeback poller: ` +
            `VMF(found=${vmfFound}, writeback=${vmfWritten}, closed=${vmfClosed}, failed=${vmfFailed}) ` +
            `MF(writeback=${mfWritten}, skippedAlreadyFilled=${mfSkipped}, errors=${mfErrors})`
        );
      }
    } catch (error) {
      console.error(`Phase4 writeback poller failed: ${formatDetailedErrorMessage(error)}`);
    } finally {
      isPhase4WritebackPollerRunning = false;
    }
  }, 60 * 1000);
}

ipcMain.handle('phase2-get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  const phase5EbayEnvironment = normalizeEbayEnvironment(
    stored.phase5EbayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox'
  );
  const phase5EbayCredentialSets = getEbayCredentialSets({
    ...stored,
    phase5EbayEnvironment
  });
  const activePhase5EbayCredentials = phase5EbayCredentialSets[phase5EbayEnvironment] || normalizeEbayCredentialSet({});
  const merged = buildPhase2Config(stored);
  const phase3Config = buildPhase3Config(stored);

  return {
    sheetId: merged.sheetId || '',
    tabName: merged.tabName || '',
    airtableBaseId: merged.airtableBaseId || '',
    airtableMasterTable: merged.airtableMasterTable || 'Master Parts Table',
    airtableCategoryTable: merged.airtableCategoryTable || 'Category Definitions',
    clickupListId: merged.clickupListId || '',
    phase2AutoRunEnabled: Boolean(merged.phase2AutoRunEnabled),
    phase2AutoRunPollMinutes: Number(merged.phase2AutoRunPollMinutes || 3),
    phase2AutoRunCooldownMinutes: Number(merged.phase2AutoRunCooldownMinutes || 5),
    phase2WritebackEnabled: true,
    writebackPollIntervalMinutes:
      Number(merged.writebackPollIntervalMinutes || process.env.WRITEBACK_POLL_INTERVAL_MINUTES || 5) || 5,
    clickupResolvedCategoryFieldName: merged.clickupResolvedCategoryFieldName || 'Category Identifier Selection',
    clickupStatusDetermined: merged.clickupStatusDetermined || 'Category Determined',
    clickupStatusCompleted: merged.clickupStatusCompleted || 'Completed',
    clickupStatusNeedsReview: merged.clickupStatusNeedsReview || 'Needs Review',
    clickupStatusWritebackError: merged.clickupStatusWritebackError || 'Writeback Error',
    categoryLinkFieldName: merged.categoryLinkFieldName || 'Category Definitions Link',
    shipstationApiKey: stored.shipstationApiKey || phase3Config.shipstationApiKey || '',
    shipstationApiSecret: stored.shipstationApiSecret || phase3Config.shipstationApiSecret || '',
    shipstationStoreId: Number(phase3Config.shipstationStoreId || PARTSHUNTER_STORE_ID),
    phase3LookbackDays: Number(phase3Config.phase3LookbackDays || 90),
    phase3DryRun: Boolean(phase3Config.phase3DryRun),
    itemSpecificsBaseId: stored.itemSpecificsBaseId || '',
    phase4RulesDriveFile: stored.phase4RulesDriveFile || process.env.PHASE4_RULES_DRIVE_FILE || process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE || '',
    phase4RulesLogicSheet: stored.phase4RulesLogicSheet || process.env.PHASE4_LOGIC_SHEET || 'Logic',
    phase4GlobalDefaultsTable: stored.phase4GlobalDefaultsTable || process.env.PHASE4_GLOBAL_DEFAULTS_TABLE || 'Fixed Item Specifics (Global Defaults)',
    phase4RulesDryRun:
      typeof stored.phase4RulesDryRun === 'boolean'
        ? stored.phase4RulesDryRun
        : true,
    phase4BLiteDryRun:
      typeof stored.phase4BLiteDryRun === 'boolean'
        ? stored.phase4BLiteDryRun
        : true,
    testTableName: '',
    testMaxTables: 0,
    openaiApiKey: stored.openaiApiKey || '',
    openaiModel: stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano',
    phase74TitleRulesPrompt: resolvePhase74TitleRulesPrompt(
      stored.phase74TitleRulesPrompt,
      process.env.PHASE74_TITLE_RULES_PROMPT
    ),
    openaiBaseUrl: stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '',
    phase4BClickupOpenStatus:
      stored.phase4BClickupOpenStatus || process.env.PHASE4B_CLICKUP_OPEN_STATUS || 'To Do',
    phase4BClickupListName:
      stored.phase4BClickupListName || '',
    phase4BClickupListId:
      stored.phase4BClickupListId || process.env.PHASE4B_CLICKUP_LIST_ID || '',
    ebayMockCsvPath: stored.ebayMockCsvPath || '',
    ebayMockTableName: stored.ebayMockTableName || 'eBay Listings (API) (Mock)',
    ebayMockDryRun:
      typeof stored.ebayMockDryRun === 'boolean'
        ? stored.ebayMockDryRun
        : true,
    ebaySandboxTableName: resolveEbaySandboxTableName(
      stored.ebaySandboxTableName,
      stored.phase5ListingsTable,
      stored.ebayMockTableName
    ),
    ebaySandboxFetchLimit: Number(stored.ebaySandboxFetchLimit || 200) || 200,
    ebaySandboxFetchPagingMode: normalizeEbayFetchPagingMode(
      stored.ebaySandboxFetchPagingMode || stored.ebaySandboxFetchMode || DEFAULT_EBAY_FETCH_PAGING_MODE
    ),
    ebaySandboxNextFetchPageByEnvironment:
      stored.ebaySandboxNextFetchPageByEnvironment && typeof stored.ebaySandboxNextFetchPageByEnvironment === 'object'
        ? stored.ebaySandboxNextFetchPageByEnvironment
        : { sandbox: 1, production: 1 },
    ebaySandboxDryRun:
      typeof stored.ebaySandboxDryRun === 'boolean'
        ? stored.ebaySandboxDryRun
        : true,
    phase5ListingsTable: String(stored.phase5ListingsTable || stored.ebaySandboxTableName || 'eBay Listings (API)').trim(),
    phase5Mode: String(stored.phase5Mode || 'A').trim().toUpperCase() === 'B' ? 'B' : 'A',
    phase5ApprovalFieldName: String(stored.phase5ApprovalFieldName || '').trim(),
    phase5GroupFieldName: String(stored.phase5GroupFieldName || '').trim(),
    phase5GroupValue: String(stored.phase5GroupValue || '').trim(),
    phase5SchemaCsvPath: String(stored.phase5SchemaCsvPath || '').trim(),
    phase5EnforceBatchApproval:
      String(stored.phase5EnforceBatchApproval ?? 'true').trim().toLowerCase() !== 'false',
    phase5EnforceListingApproval:
      String(stored.phase5EnforceListingApproval ?? 'false').trim().toLowerCase() === 'true',
    phase5BatchesTable: String(stored.phase5BatchesTable || 'Listing Batches').trim(),
    phase5BatchStatusFieldName: String(stored.phase5BatchStatusFieldName || 'Batch Status').trim(),
    phase5BatchApprovedValue: String(stored.phase5BatchApprovedValue || 'Approved').trim(),
    phase5BatchLinkFieldName: String(stored.phase5BatchLinkFieldName || '').trim(),
    phase5RequiredCategoryIdFieldName: String(stored.phase5RequiredCategoryIdFieldName || '').trim(),
    phase5RequiredTitleFieldName: String(stored.phase5RequiredTitleFieldName || '').trim(),
    phase5RequiredDescriptionFieldName: String(stored.phase5RequiredDescriptionFieldName || '').trim(),
    phase5RequiredItemSpecificsFieldName: String(stored.phase5RequiredItemSpecificsFieldName || '').trim(),
    phase5RequiredItemSpecificFieldNames: String(stored.phase5RequiredItemSpecificFieldNames || '').trim(),
    phase5BlockedFieldName: String(stored.phase5BlockedFieldName || '').trim(),
    phase5ClickupExceptionFieldName: String(stored.phase5ClickupExceptionFieldName || '').trim(),
    phase5ClickupResolvedValues: String(stored.phase5ClickupResolvedValues || 'resolved,done,closed,complete').trim(),
    phase5PublishStatusFieldName: String(stored.phase5PublishStatusFieldName || '').trim(),
    phase5PublishedAtFieldName: String(stored.phase5PublishedAtFieldName || '').trim(),
    phase5PublishRunIdFieldName: String(stored.phase5PublishRunIdFieldName || '').trim(),
    phase5PayloadHashFieldName: String(stored.phase5PayloadHashFieldName || '').trim(),
    phase5PayloadHashFields: String(stored.phase5PayloadHashFields || '').trim(),
    phase5PublishedLogPendingValue: String(stored.phase5PublishedLogPendingValue || 'Published (Log Pending)').trim(),
    phase5SheetsLogEnabled:
      String(stored.phase5SheetsLogEnabled ?? 'false').trim().toLowerCase() === 'true',
    phase5SheetsLogSpreadsheetId: String(stored.phase5SheetsLogSpreadsheetId || '').trim(),
    phase5SheetsLogTabName: String(stored.phase5SheetsLogTabName || 'Log').trim(),
    phase5SheetsLogAuthContext: String(stored.phase5SheetsLogAuthContext || 'inventory').trim(),
    phase5LiveCompareEnabled:
      String(stored.phase5LiveCompareEnabled ?? 'false').trim().toLowerCase() === 'true',
    phase5LiveCompareApiUrl: String(stored.phase5LiveCompareApiUrl || '').trim(),
    phase5LiveCompareApiKey: String(stored.phase5LiveCompareApiKey || '').trim(),
    phase5TestBatchRecordIds: String(stored.phase5TestBatchRecordIds || '').trim(),
    phase5AutoPushEnabled:
      String(stored.phase5AutoPushEnabled ?? 'false').trim().toLowerCase() === 'true',
    phase5AutoPushCron: String(stored.phase5AutoPushCron || '0 * * * *').trim(),
    phase5AutoPushTimezone: String(stored.phase5AutoPushTimezone || '').trim(),
    phase5AutoPushEligibilityFieldName: String(stored.phase5AutoPushEligibilityFieldName || '').trim(),
    phase5AutoPushEligibilityValues: String(stored.phase5AutoPushEligibilityValues || '').trim(),
    phase5EbayEnvironment,
    phase5EbayCredentialSets,
    ebayListingsSourceApi:
      ['auto', 'trading', 'inventory'].includes(String(stored.ebayListingsSourceApi || '').trim().toLowerCase())
        ? String(stored.ebayListingsSourceApi || '').trim().toLowerCase()
        : 'auto',
    ebaySandboxFetchPagingMode: normalizeEbayFetchPagingMode(
      stored.ebaySandboxFetchPagingMode || stored.ebaySandboxFetchMode || DEFAULT_EBAY_FETCH_PAGING_MODE
    ),
    ebaySandboxNextFetchPageByEnvironment:
      stored.ebaySandboxNextFetchPageByEnvironment && typeof stored.ebaySandboxNextFetchPageByEnvironment === 'object'
        ? stored.ebaySandboxNextFetchPageByEnvironment
        : { sandbox: 1, production: 1 },
    phase5EbayClientId: activePhase5EbayCredentials.phase5EbayClientId,
    phase5EbayDevId: activePhase5EbayCredentials.phase5EbayDevId,
    phase5EbayClientSecret: activePhase5EbayCredentials.phase5EbayClientSecret,
    phase5EbayRuName: activePhase5EbayCredentials.phase5EbayRuName,
    phase5EbayUserAccessToken: activePhase5EbayCredentials.phase5EbayUserAccessToken,
    phase5EbayRefreshToken: activePhase5EbayCredentials.phase5EbayRefreshToken,
    phase5EbayRefreshScope: activePhase5EbayCredentials.phase5EbayRefreshScope,
    phase5EbayUserAccessTokenIssuedAt: activePhase5EbayCredentials.phase5EbayUserAccessTokenIssuedAt,
    airtableToken: stored.airtableToken || '',
    clickupToken: stored.clickupToken || ''
  };
});

ipcMain.handle('phase2-save-config', async (_, configPayload = {}) => {
  const existing = getInventoryConfig('phase2Config') || {};
  const merged = normalizeAndAttachEbayCredentials(existing, configPayload);

  saveInventoryConfig('phase2Config', stripPhase5LocalPublishedCache(merged));
  return { success: true, message: 'Phase 2 configuration saved.' };
});

ipcMain.handle('phase2-get-activity-logs', async () => {
  return getInventoryConfig('phase2ActivityLogs') || [];
});

ipcMain.handle('phase2-append-activity-log', async (_, entry = {}) => {
  const logs = getInventoryConfig('phase2ActivityLogs') || [];
  const normalized = {
    time: String(entry.time || new Date().toLocaleTimeString()),
    text: String(entry.text || '').trim(),
    level: String(entry.level || 'info')
  };
  if (!normalized.text) {
    return { success: false, message: 'Log text is required.' };
  }
  logs.unshift(normalized);
  if (logs.length > 300) logs.length = 300;
  saveInventoryConfig('phase2ActivityLogs', logs);
  return { success: true };
});

ipcMain.handle('phase2-clear-activity-logs', async () => {
  saveInventoryConfig('phase2ActivityLogs', []);
  return { success: true };
});

ipcMain.handle('phase2-clear-task-cache', async () => {
  saveInventoryConfig('phase2TaskCache', {});
  return { success: true, message: 'Phase 2 task cache cleared.' };
});

ipcMain.handle('phase2-writeback-start', async (_, options = {}) => {
  try {
    const config = buildPhase2WritebackConfig(options);
    const status = phase2WritebackPoller.start(config);
    return { success: true, status };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('phase2-writeback-stop', async () => {
  try {
    const status = phase2WritebackPoller.stop();
    return { success: true, status };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('phase2-writeback-status', async () => {
  return phase2WritebackPoller.getStatus();
});

ipcMain.handle('phase2-writeback-run-once', async (_, options = {}) => {
  try {
    const config = buildPhase2WritebackConfig(options);
    const result = await phase2WritebackPoller.executeOnce(config);
    return { success: true, result };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('phase2-autorun-status', async () => {
  return phase2AutoRunService.getStatus();
});

ipcMain.handle('phase2-autorun-start', async (_, options = {}) => {
  try {
    const status = phase2AutoRunService.start(options);
    return { success: true, status };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('phase2-autorun-stop', async () => {
  try {
    const status = phase2AutoRunService.stop();
    return { success: true, status };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('phase2-autorun-run-now', async () => {
  try {
    const result = await phase2AutoRunService.trigger('manual_run_now', { force: true });
    return { success: true, result };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('phase2-fetch-clickup-lists', async (_, token = '') => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const resolvedToken = String(token || '').trim() || String(stored.clickupToken || '').trim();
    if (!resolvedToken) {
      return {
        success: false,
        message: 'ClickUp token is required to fetch lists.',
        lists: []
      };
    }

    const clickupService = new ClickUpService({ token: resolvedToken });
    const lists = await clickupService.fetchAllLists();
    return { success: true, lists };
  } catch (error) {
    const message =
      error?.response?.data?.err ||
      error?.response?.data?.error ||
      error?.message ||
      'Failed to fetch ClickUp lists.';
    return { success: false, message, lists: [] };
  }
});

ipcMain.handle('phase2-fetch-airtable-bases', async (_, token = '') => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const resolvedToken = String(token || '').trim() || String(stored.airtableToken || '').trim();
    if (!resolvedToken) {
      return {
        success: false,
        message: 'Airtable token is required to fetch bases.',
        bases: []
      };
    }

    const bases = await AirtableService.fetchAllBases(resolvedToken);
    return { success: true, bases };
  } catch (error) {
    const message =
      error?.response?.data?.error?.message ||
      error?.response?.data?.error ||
      error?.message ||
      'Failed to fetch Airtable bases.';
    return { success: false, message, bases: [] };
  }
});

ipcMain.handle('phase2-validate-clickup-config', async (_, payload = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const token = String(payload.clickupToken || stored.clickupToken || '').trim();
    const listId = String(payload.clickupListId || stored.clickupListId || '').trim();
    if (!token || !listId) {
      return { success: false, message: 'ClickUp token and list ID are required.' };
    }

    const clickupService = new ClickUpService({ token, listId });
    const list = await clickupService.getList();
    return {
      success: true,
      list: {
        id: String(list?.id || listId),
        name: String(list?.name || 'Unknown List')
      }
    };
  } catch (error) {
    const message =
      error?.response?.data?.err ||
      error?.response?.data?.error ||
      error?.message ||
      'Failed to validate ClickUp list access.';
    return { success: false, message };
  }
});

ipcMain.handle('phase2-validate-airtable-config', async (_, payload = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const token = String(payload.airtableToken || stored.airtableToken || '').trim();
    const baseId = String(payload.airtableBaseId || stored.airtableBaseId || '').trim();
    const masterTable = String(payload.airtableMasterTable || stored.airtableMasterTable || 'Master Parts Table').trim();
    const categoryTable = String(payload.airtableCategoryTable || stored.airtableCategoryTable || 'Category Definitions').trim();
    if (!token || !baseId) {
      return { success: false, message: 'Airtable token and base ID are required.' };
    }

    const airtableService = new AirtableService({
      token,
      baseId,
      masterTable,
      categoryTable
    });
    const result = await airtableService.validateConfig();
    return { success: true, result };
  } catch (error) {
    const message =
      error?.response?.data?.error?.message ||
      error?.response?.data?.error ||
      error?.message ||
      'Failed to validate Airtable base access.';
    return { success: false, message };
  }
});

ipcMain.handle('phase2-run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptionsBase = {
      ...stored,
      ...options
    };

    const summary = await runPhase2(runOptions, progress => {
      event.sender.send('phase2-progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase2-progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });

    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase3:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  const merged = buildPhase3Config(stored);

  return {
    sheetId: merged.sheetId || '',
    tabName: merged.tabName || '',
    airtableBaseId: merged.airtableBaseId || '',
    airtableMasterTable: merged.airtableMasterTable || 'Master Parts Table',
    airtableToken: stored.airtableToken || merged.airtableToken || '',
    shipstationApiKey: stored.shipstationApiKey || merged.shipstationApiKey || '',
    shipstationApiSecret: stored.shipstationApiSecret || merged.shipstationApiSecret || '',
    shipstationStoreId: Number(merged.shipstationStoreId || PARTSHUNTER_STORE_ID),
    phase3LookbackDays: Number(merged.phase3LookbackDays || 90),
    phase3DryRun: Boolean(merged.phase3DryRun)
  };
});

ipcMain.handle('phase3:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptions = {
      ...stored,
      ...options
    };

    const summary = await runPhase3(runOptions, progress => {
      event.sender.send('phase3:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    event.sender.send('phase3:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message: error.message
    });

    return {
      success: false,
      message: error.message
    };
  }
});

ipcMain.handle('phase4:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  const merged = buildPhase4Config(stored);
  const state = getInventoryConfig(MIRROR_STATE_KEY) || {};

  return {
    airtableToken: stored.airtableToken || merged.airtableToken || '',
    masterBaseId: merged.masterBaseId || '',
    masterTable: merged.masterTable || 'Master Parts Table',
    itemSpecificsBaseId: merged.itemSpecificsBaseId || '',
    incrementalEnabled: Boolean(merged.incrementalEnabled),
    dryRun: Boolean(merged.dryRun),
    lastMirrorRunAt: state?.lastMirrorRunAt || '',
    lastRunStatus: state?.lastRunStatus || ''
  };
});

ipcMain.handle('phase4:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptions = {
      ...stored,
      ...options
    };

    const summary = await runPhase4Mirroring(runOptions, progress => {
      event.sender.send('phase4:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase4:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });

    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase4rules:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  return {
    rulesDriveFile:
      String(
        stored.phase4RulesDriveFile ||
          process.env.PHASE4_RULES_DRIVE_FILE ||
          process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
          ''
      ).trim(),
    globalDefaultsTable:
      String(
        stored.phase4GlobalDefaultsTable ||
          process.env.PHASE4_GLOBAL_DEFAULTS_TABLE ||
          'Fixed Item Specifics (Global Defaults)'
      ).trim(),
    logicSheetName: String(stored.phase4RulesLogicSheet || process.env.PHASE4_LOGIC_SHEET || 'Logic').trim(),
    dryRun:
      typeof stored.phase4RulesDryRun === 'boolean'
        ? stored.phase4RulesDryRun
        : true,
    authContext: 'inventory'
  };
});

ipcMain.handle('phase4rules:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const dryRun =
      typeof options.phase4RulesDryRun === 'boolean'
        ? options.phase4RulesDryRun
        : typeof stored.phase4RulesDryRun === 'boolean'
          ? stored.phase4RulesDryRun
          : true;
    const runOptions = {
      ...stored,
      ...options,
      dryRun,
      execute: !dryRun,
      ruleTypes: ['F'],
      authContext: 'inventory',
      rulesDriveFile:
        String(
          options.phase4RulesDriveFile ||
            stored.phase4RulesDriveFile ||
            process.env.PHASE4_RULES_DRIVE_FILE ||
            process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
            ''
        ).trim(),
      globalDefaultsTable: String(
        options.phase4GlobalDefaultsTable ||
          stored.phase4GlobalDefaultsTable ||
          process.env.PHASE4_GLOBAL_DEFAULTS_TABLE ||
          'Fixed Item Specifics (Global Defaults)'
      ).trim(),
      logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim()
    };

    const summary = await runPhase4RulesPopulate(runOptions, progress => {
      event.sender.send('phase4rules:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase4rules:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase4blite:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  return {
    rulesDriveFile:
      String(
        stored.phase4RulesDriveFile ||
          process.env.PHASE4_RULES_DRIVE_FILE ||
          process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
          ''
      ).trim(),
    logicSheetName: String(stored.phase4RulesLogicSheet || process.env.PHASE4_LOGIC_SHEET || 'Logic').trim(),
    dryRun:
      typeof stored.phase4BLiteDryRun === 'boolean'
        ? stored.phase4BLiteDryRun
        : true,

    testTableName: String(stored.testTableName || process.env.PHASE4B_TEST_TABLE_NAME || '').trim(),
    testIpn: String(stored.phase4BTestIpn || process.env.PHASE4B_TEST_IPN || '').trim(),
    testMaxTables: 0,
    openaiApiKey: String(stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
    openaiModel: String(stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
    openaiBaseUrl: String(stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
    clickupListName: String(stored.phase4BClickupListName || '').trim(),
    clickupListId: String(
      stored.phase4BClickupListId ||
        process.env.PHASE4B_CLICKUP_LIST_ID ||
        ''
    ).trim(),
    clickupOpenStatus:
      String(stored.phase4BClickupOpenStatus || process.env.PHASE4B_CLICKUP_OPEN_STATUS || 'To Do').trim(),
    authContext: 'inventory'
  };
});

ipcMain.handle('phase4blite:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const dryRun =
      typeof options.phase4BLiteDryRun === 'boolean'
        ? options.phase4BLiteDryRun
        : typeof stored.phase4BLiteDryRun === 'boolean'
          ? stored.phase4BLiteDryRun
          : true;

    const runOptionsBase = {
      ...stored,
      ...options,
      dryRun,
      execute: !dryRun,
      authContext: 'inventory',
      rulesDriveFile:
        String(
          options.phase4RulesDriveFile ||
            stored.phase4RulesDriveFile ||
            process.env.PHASE4_RULES_DRIVE_FILE ||
            process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
            ''
        ).trim(),
      logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim(),
      testTableName: String(options.testTableName || stored.testTableName || process.env.PHASE4B_TEST_TABLE_NAME || '').trim(),
      phase4BTestIpn: String(options.phase4BTestIpn || stored.phase4BTestIpn || process.env.PHASE4B_TEST_IPN || '').trim(),
      testMaxTables: 0,
      openaiApiKey: String(options.openaiApiKey || stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
      openaiModel: String(options.openaiModel || stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
      openaiBaseUrl: String(options.openaiBaseUrl || stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
      phase4BClickupListName: String(
        options.phase4BClickupListName || stored.phase4BClickupListName || ''
      ).trim(),
      phase4BClickupListId: String(
        options.phase4BClickupListId ||
          stored.phase4BClickupListId ||
          process.env.PHASE4B_CLICKUP_LIST_ID ||
          ''
      ).trim(),
      clickupOpenStatus: String(
        options.phase4BClickupOpenStatus ||
          stored.phase4BClickupOpenStatus ||
          process.env.PHASE4B_CLICKUP_OPEN_STATUS ||
          'To Do'
      ).trim()
    };
    const runOptions = await attachPhase5PublishedState(runOptionsBase, 'phase4blite:run');

    const summary = await runPhase4BLite(runOptions, progress => {
      event.sender.send('phase4blite:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase4blite:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase4cmf:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  return {
    rulesDriveFile:
      String(
        stored.phase4RulesDriveFile ||
          process.env.PHASE4_RULES_DRIVE_FILE ||
          process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
          ''
      ).trim(),
    logicSheetName: String(stored.phase4RulesLogicSheet || process.env.PHASE4_LOGIC_SHEET || 'Logic').trim(),
    dryRun:
      typeof stored.phase4CMFDryRun === 'boolean'
        ? stored.phase4CMFDryRun
        : true,
    testTableName: '',
    testMaxTables: 0,
    clickupListName: String(stored.phase4CClickupListName || stored.phase4BClickupListName || '').trim(),
    clickupListId: String(
      stored.phase4CClickupListId ||
        stored.phase4BClickupListId ||
        process.env.PHASE4C_CLICKUP_LIST_ID ||
        process.env.PHASE4B_CLICKUP_LIST_ID ||
        ''
    ).trim(),
    clickupOpenStatus: String(
      stored.phase4CClickupOpenStatus ||
        stored.phase4BClickupOpenStatus ||
        process.env.PHASE4C_CLICKUP_OPEN_STATUS ||
        process.env.PHASE4B_CLICKUP_OPEN_STATUS ||
        'To Do'
    ).trim(),
    authContext: 'inventory'
  };
});

ipcMain.handle('phase4cmf:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const dryRun =
      typeof options.phase4CMFDryRun === 'boolean'
        ? options.phase4CMFDryRun
        : typeof stored.phase4CMFDryRun === 'boolean'
          ? stored.phase4CMFDryRun
          : true;
    const runOptions = {
      ...stored,
      ...options,
      dryRun,
      execute: !dryRun,
      authContext: 'inventory',
      rulesDriveFile:
        String(
          options.phase4RulesDriveFile ||
            stored.phase4RulesDriveFile ||
            process.env.PHASE4_RULES_DRIVE_FILE ||
            process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
            ''
        ).trim(),
      logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim(),
      testTableName: '',
      testMaxTables: 0,
      phase4CClickupListName: String(
        options.phase4CClickupListName ||
          stored.phase4CClickupListName ||
          stored.phase4BClickupListName ||
          ''
      ).trim(),
      phase4CClickupListId: String(
        options.phase4CClickupListId ||
          stored.phase4CClickupListId ||
          stored.phase4BClickupListId ||
          process.env.PHASE4C_CLICKUP_LIST_ID ||
          process.env.PHASE4B_CLICKUP_LIST_ID ||
          ''
      ).trim(),
      phase4CClickupOpenStatus: String(
        options.phase4CClickupOpenStatus ||
          stored.phase4CClickupOpenStatus ||
          stored.phase4BClickupOpenStatus ||
          process.env.PHASE4C_CLICKUP_OPEN_STATUS ||
          process.env.PHASE4B_CLICKUP_OPEN_STATUS ||
          'To Do'
      ).trim()
    };

    const summary = await runPhase4CMF(runOptions, progress => {
      event.sender.send('phase4cmf:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase4cmf:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase4d:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  return {
    rulesDriveFile:
      String(
        stored.phase4RulesDriveFile ||
          process.env.PHASE4_RULES_DRIVE_FILE ||
          process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
          ''
      ).trim(),
    logicSheetName: String(stored.phase4RulesLogicSheet || process.env.PHASE4_LOGIC_SHEET || 'Logic').trim(),
    dryRun:
      typeof stored.phase4DDryRun === 'boolean'
        ? stored.phase4DDryRun
        : true,
    listingsTableName: resolveListingsTableName(
      stored.phase4DListingsTable,
      process.env.PHASE4D_LISTINGS_TABLE,
      DEFAULT_EBAY_LISTINGS_TABLE
    ),
    testIpn: String(stored.phase4DTestIpn || process.env.PHASE4D_TEST_IPN || '').trim(),
    openaiModel: String(stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
    authContext: 'inventory'
  };
});

ipcMain.handle('phase4d:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const dryRun =
      typeof options.phase4DDryRun === 'boolean'
        ? options.phase4DDryRun
        : typeof stored.phase4DDryRun === 'boolean'
          ? stored.phase4DDryRun
          : true;
    const runOptionsBase = {
      ...stored,
      ...options,
      dryRun,
      execute: !dryRun,
      authContext: 'inventory',
      rulesDriveFile:
        String(
          options.phase4RulesDriveFile ||
            stored.phase4RulesDriveFile ||
            process.env.PHASE4_RULES_DRIVE_FILE ||
            process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
            ''
        ).trim(),
      logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim(),
      phase4GlobalDefaultsTable: String(
        options.phase4GlobalDefaultsTable ||
          stored.phase4GlobalDefaultsTable ||
          process.env.PHASE4_GLOBAL_DEFAULTS_TABLE ||
          'Fixed Item Specifics (Global Defaults)'
      ).trim(),
      phase4DListingsTable: resolveListingsTableName(
        options.phase4DListingsTable,
        stored.phase4DListingsTable,
        process.env.PHASE4D_LISTINGS_TABLE,
        DEFAULT_EBAY_LISTINGS_TABLE
      ),
      phase4DTestIpn: String(options.phase4DTestIpn || stored.phase4DTestIpn || process.env.PHASE4D_TEST_IPN || '').trim(),
      testTableName: '',
      testMaxTables: 0,
      openaiApiKey: String(options.openaiApiKey || stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
      openaiModel: String(options.openaiModel || stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
      openaiBaseUrl: String(options.openaiBaseUrl || stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim()
    };

    const runOptions = await attachPhase5PublishedState(runOptionsBase, 'phase4d:run');
    event.sender.send('phase4d:progress', {
      stage: 'phase4d_load_rules',
      percent: 1,
      counts: null,
      message: 'Starting Phase 4D run...'
    });

    const summary = await runPhase4DListing(runOptions, progress => {
      event.sender.send('phase4d:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase4d:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase4pipeline:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runMirror = options.phase4RunMirror !== false;
    const run4A = options.phase4Run4A !== false;
    const run4B = options.phase4Run4B !== false;
    const run4C = options.phase4Run4C !== false;
    const run4D = options.phase4Run4D !== false;

    const phases = [];
    if (runMirror) phases.push('mirror');
    if (run4A) phases.push('4a');
    if (run4B) phases.push('4b');
    if (run4C) phases.push('4c');
    if (run4D) phases.push('4d');
    if (phases.length === 0) {
      return { success: false, message: 'Select at least one Phase 4 subphase.' };
    }

    const phaseSummary = {};
    const progressBase = 2;
    const progressSpan = 96;
    const segment = Math.max(1, Math.floor(progressSpan / phases.length));
    let phaseIndex = 0;

    const mapProgress = (innerPercent = 0) =>
      Math.min(
        98,
        progressBase + phaseIndex * segment + Math.floor((Math.max(0, Math.min(100, Number(innerPercent || 0))) / 100) * segment)
      );

    event.sender.send('phase4pipeline:progress', {
      stage: 'phase4pipeline_start',
      percent: 1,
      counts: null,
      message: `Starting Phase 4 pipeline (${phases.join(' -> ')})...`
    });

    let sharedMasterContext = null;
    if (run4A || run4B || run4D) {
      event.sender.send('phase4pipeline:progress', {
        stage: 'phase4pipeline_shared_master',
        percent: mapProgress(2),
        counts: null,
        message: '[Shared] Preparing Master Parts cache for Phase 4 chain...'
      });
      try {
        const sharedConfig = {
          ...stored,
          ...options,
          airtableToken: String(options.airtableToken || stored.airtableToken || process.env.AIRTABLE_TOKEN || '').trim(),
          airtableBaseId: String(options.airtableBaseId || stored.airtableBaseId || process.env.AIRTABLE_BASE_ID || '').trim(),
          airtableMasterTable: String(stored.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table').trim()
        };
        sharedMasterContext = await buildPhase4SharedMasterContext(sharedConfig, {
          onProgress: message => {
            event.sender.send('phase4pipeline:progress', {
              stage: 'phase4pipeline_shared_master',
              percent: mapProgress(2),
              counts: null,
              message: `[Shared] ${message}`
            });
          }
        });
      } catch (error) {
        event.sender.send('phase4pipeline:progress', {
          stage: 'phase4pipeline_shared_master',
          percent: mapProgress(2),
          counts: null,
          message: `[Shared] Master cache unavailable (${error?.message || error}); falling back to per-phase loading.`
        });
      }
    }

    if (runMirror) {
      const mirrorOptions = {
        ...stored,
        ...options,
        authContext: 'inventory',
        itemSpecificsBaseId: String(options.itemSpecificsBaseId || stored.itemSpecificsBaseId || '').trim(),
        dryRun:
          typeof options.phase4DryRun === 'boolean'
            ? options.phase4DryRun
            : true,
        incrementalEnabled:
          typeof options.phase4IncrementalEnabled === 'boolean'
            ? options.phase4IncrementalEnabled
            : true
      };
      const mirrorSummary = await runPhase4Mirroring(mirrorOptions, progress => {
        event.sender.send('phase4pipeline:progress', {
          ...progress,
          stage: `phase4pipeline_mirror_${String(progress?.stage || 'running')}`,
          percent: mapProgress(progress?.percent),
          message: `[Mirror] ${String(progress?.message || '').trim()}`
        });
      });
      phaseSummary.mirror = mirrorSummary || {};
      phaseIndex += 1;
    }

    if (run4A) {
      const rulesDryRun =
        typeof options.phase4RulesDryRun === 'boolean'
          ? options.phase4RulesDryRun
          : typeof stored.phase4RulesDryRun === 'boolean'
            ? stored.phase4RulesDryRun
            : true;
      const rulesOptions = {
        ...stored,
        ...options,
        dryRun: rulesDryRun,
        execute: !rulesDryRun,
        ruleTypes: ['F'],
        authContext: 'inventory',
        rulesDriveFile:
          String(
            options.phase4RulesDriveFile ||
              stored.phase4RulesDriveFile ||
              process.env.PHASE4_RULES_DRIVE_FILE ||
              process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
              ''
          ).trim(),
        globalDefaultsTable: String(
          options.phase4GlobalDefaultsTable ||
            stored.phase4GlobalDefaultsTable ||
            process.env.PHASE4_GLOBAL_DEFAULTS_TABLE ||
            'Fixed Item Specifics (Global Defaults)'
        ).trim(),
        logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim(),
        phase4SharedMasterRows: sharedMasterContext?.masterRows,
        phase4SharedMasterIpnSet: sharedMasterContext?.masterIpnSet
      };
      const phase4ASummary = await runPhase4RulesPopulate(rulesOptions, progress => {
        event.sender.send('phase4pipeline:progress', {
          ...progress,
          stage: `phase4pipeline_4a_${String(progress?.stage || 'running')}`,
          percent: mapProgress(progress?.percent),
          message: `[4A] ${String(progress?.message || '').trim()}`
        });
      });
      phaseSummary.phase4A = phase4ASummary || {};
      phaseIndex += 1;
    }

    if (run4B) {
      const bliteDryRun =
        typeof options.phase4BLiteDryRun === 'boolean'
          ? options.phase4BLiteDryRun
          : typeof stored.phase4BLiteDryRun === 'boolean'
            ? stored.phase4BLiteDryRun
            : true;
      const bliteOptionsBase = {
        ...stored,
        ...options,
        dryRun: bliteDryRun,
        execute: !bliteDryRun,
        authContext: 'inventory',
        rulesDriveFile:
          String(
            options.phase4RulesDriveFile ||
              stored.phase4RulesDriveFile ||
              process.env.PHASE4_RULES_DRIVE_FILE ||
              process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
              ''
          ).trim(),
        logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim(),
        testTableName: '',
        testMaxTables: 0,
        openaiApiKey: String(options.openaiApiKey || stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
        openaiModel: String(options.openaiModel || stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
        openaiBaseUrl: String(options.openaiBaseUrl || stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
        phase4BClickupListName: String(
          options.phase4BClickupListName || stored.phase4BClickupListName || ''
        ).trim(),
        phase4BClickupListId: String(
          options.phase4BClickupListId ||
            stored.phase4BClickupListId ||
            process.env.PHASE4B_CLICKUP_LIST_ID ||
            ''
        ).trim(),
        clickupOpenStatus: String(
          options.phase4BClickupOpenStatus ||
            stored.phase4BClickupOpenStatus ||
            process.env.PHASE4B_CLICKUP_OPEN_STATUS ||
            'To Do'
        ).trim(),
        phase4SharedMasterRows: sharedMasterContext?.masterRows,
        phase4SharedMasterByIpn: sharedMasterContext?.masterByIpn
      };
      const bliteOptions = await attachPhase5PublishedState(bliteOptionsBase, 'phase4pipeline:4b');
      const phase4BSummary = await runPhase4BLite(bliteOptions, progress => {
        event.sender.send('phase4pipeline:progress', {
          ...progress,
          stage: `phase4pipeline_4b_${String(progress?.stage || 'running')}`,
          percent: mapProgress(progress?.percent),
          message: `[4B] ${String(progress?.message || '').trim()}`
        });
      });
      phaseSummary.phase4B = phase4BSummary || {};
      phaseIndex += 1;
    }

    if (run4C) {
      const cmfDryRun =
        typeof options.phase4CMFDryRun === 'boolean'
          ? options.phase4CMFDryRun
          : typeof stored.phase4CMFDryRun === 'boolean'
            ? stored.phase4CMFDryRun
            : true;
      const cmfOptions = {
        ...stored,
        ...options,
        dryRun: cmfDryRun,
        execute: !cmfDryRun,
        authContext: 'inventory',
        rulesDriveFile:
          String(
            options.phase4RulesDriveFile ||
              stored.phase4RulesDriveFile ||
              process.env.PHASE4_RULES_DRIVE_FILE ||
              process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
              ''
          ).trim(),
        logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim(),
        phase4CClickupListName: String(
          options.phase4CClickupListName || stored.phase4CClickupListName || ''
        ).trim(),
        phase4CClickupListId: String(
          options.phase4CClickupListId ||
            stored.phase4CClickupListId ||
            process.env.PHASE4C_CLICKUP_LIST_ID ||
            ''
        ).trim(),
        phase4CClickupOpenStatus: String(
          options.phase4CClickupOpenStatus ||
            stored.phase4CClickupOpenStatus ||
            process.env.PHASE4C_CLICKUP_OPEN_STATUS ||
            'To Do'
        ).trim()
      };
      const phase4CSummary = await runPhase4CMF(cmfOptions, progress => {
        event.sender.send('phase4pipeline:progress', {
          ...progress,
          stage: `phase4pipeline_4c_${String(progress?.stage || 'running')}`,
          percent: mapProgress(progress?.percent),
          message: `[4C] ${String(progress?.message || '').trim()}`
        });
      });
      phaseSummary.phase4C = phase4CSummary || {};
      phaseIndex += 1;
    }

    if (run4D) {
      const dDryRun =
        typeof options.phase4DDryRun === 'boolean'
          ? options.phase4DDryRun
          : typeof stored.phase4DDryRun === 'boolean'
            ? stored.phase4DDryRun
            : true;
      const dOptionsBase = {
        ...stored,
        ...options,
        dryRun: dDryRun,
        execute: !dDryRun,
        authContext: 'inventory',
        rulesDriveFile:
          String(
            options.phase4RulesDriveFile ||
              stored.phase4RulesDriveFile ||
              process.env.PHASE4_RULES_DRIVE_FILE ||
              process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
              ''
          ).trim(),
        logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim(),
        phase4GlobalDefaultsTable: String(
          options.phase4GlobalDefaultsTable ||
            stored.phase4GlobalDefaultsTable ||
            process.env.PHASE4_GLOBAL_DEFAULTS_TABLE ||
            'Fixed Item Specifics (Global Defaults)'
        ).trim(),
        phase4DListingsTable: resolveListingsTableName(
          options.phase4DListingsTable,
          stored.phase4DListingsTable,
          process.env.PHASE4D_LISTINGS_TABLE,
          DEFAULT_EBAY_LISTINGS_TABLE
        ),
        phase4DTestIpn: String(options.phase4DTestIpn || stored.phase4DTestIpn || process.env.PHASE4D_TEST_IPN || '').trim(),
        openaiApiKey: String(options.openaiApiKey || stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
        openaiModel: String(options.openaiModel || stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
        openaiBaseUrl: String(options.openaiBaseUrl || stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
        phase4SharedMasterRows: sharedMasterContext?.masterRows,
        phase4SharedMasterByIpn: sharedMasterContext?.masterByIpn
      };
      const dOptions = await attachPhase5PublishedState(dOptionsBase, 'phase4pipeline:4d');
      const phase4DSummary = await runPhase4DListing(dOptions, progress => {
        event.sender.send('phase4pipeline:progress', {
          ...progress,
          stage: `phase4pipeline_4d_${String(progress?.stage || 'running')}`,
          percent: mapProgress(progress?.percent),
          message: `[4D] ${String(progress?.message || '').trim()}`
        });
      });
      phaseSummary.phase4D = phase4DSummary || {};
    }

    event.sender.send('phase4pipeline:progress', {
      stage: 'completed',
      percent: 100,
      counts: phaseSummary,
      message: 'Phase 4 pipeline completed.'
    });

    return {
      success: true,
      summary: phaseSummary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase4pipeline:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase6:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  return {
    listingsTableName: resolveListingsTableName(
      stored.phase6ListingsTable,
      process.env.PHASE6_LISTINGS_TABLE,
      DEFAULT_EBAY_LISTINGS_TABLE
    ),
    masterTableName: String(stored.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table').trim(),
    openaiModel: String(stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
    promptCacheEnabled:
      String(stored.phase6PromptCacheEnabled ?? process.env.PHASE6_PROMPT_CACHE_ENABLED ?? 'true').trim().toLowerCase() !==
      'false',
    promptCacheKey: String(
      stored.phase6PromptCacheKey || process.env.PHASE6_PROMPT_CACHE_KEY || process.env.OPENAI_PROMPT_CACHE_KEY || 'phase6_fitment_v1'
    ).trim(),
    testIpns: String(stored.phase6TestIpns || process.env.PHASE6_TEST_IPNS || '').trim(),
    maxIpns: Number(stored.phase6MaxIpns || process.env.PHASE6_MAX_IPNS || 0) || 0,
    sampleLimit: Number(stored.phase6SampleLimit || process.env.PHASE6_SAMPLE_LIMIT || 20) || 20
  };
});

ipcMain.handle('phase6:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptions = {
      ...stored,
      ...options,
      phase6ListingsTable: resolveListingsTableName(
        options.phase6ListingsTable,
        stored.phase6ListingsTable,
        process.env.PHASE6_LISTINGS_TABLE,
        DEFAULT_EBAY_LISTINGS_TABLE
      ),
      airtableMasterTable: String(
        options.airtableMasterTable || stored.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table'
      ).trim(),
      openaiApiKey: String(options.openaiApiKey || stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
      openaiModel: String(options.openaiModel || stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
      openaiBaseUrl: String(options.openaiBaseUrl || stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
      phase6PromptCacheEnabled:
        String(options.phase6PromptCacheEnabled ?? stored.phase6PromptCacheEnabled ?? process.env.PHASE6_PROMPT_CACHE_ENABLED ?? 'true')
          .trim()
          .toLowerCase() !== 'false',
      phase6PromptCacheKey: String(
        options.phase6PromptCacheKey ||
          stored.phase6PromptCacheKey ||
          process.env.PHASE6_PROMPT_CACHE_KEY ||
          process.env.OPENAI_PROMPT_CACHE_KEY ||
          'phase6_fitment_v1'
      ).trim(),
      phase6TestIpns: String(
        options.phase6TestIpns || stored.phase6TestIpns || process.env.PHASE6_TEST_IPNS || ''
      ).trim(),
      phase6MaxIpns: Number(
        options.phase6MaxIpns || stored.phase6MaxIpns || process.env.PHASE6_MAX_IPNS || 0
      ) || 0,
      sampleLimit: Number(options.sampleLimit || stored.phase6SampleLimit || process.env.PHASE6_SAMPLE_LIMIT || 20) || 20
    };

    event.sender.send('phase6:progress', {
      stage: 'phase6_scan_listings',
      percent: 1,
      counts: null,
      message: 'Starting Phase 6 fitment extraction...'
    });

    const summary = await runPhase6Fitment(runOptions, progress => {
      event.sender.send('phase6:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase6:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase72:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  return {
    masterTableName: String(stored.phase72MasterTable || stored.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table').trim(),
    driveFolderId: String(stored.phase72DriveFolderId || process.env.PHASE72_DRIVE_FOLDER_ID || '').trim(),
    testIpns: String(stored.phase72TestIpns || process.env.PHASE72_TEST_IPNS || '').trim(),
    maxIpns: Number(stored.phase72MaxIpns || process.env.PHASE72_MAX_IPNS || 0) || 0,
    forceRegenerate:
      String(stored.phase72ForceRegenerate ?? process.env.PHASE72_FORCE_REGENERATE ?? 'false').trim().toLowerCase() === 'true',
    sampleLimit: Number(stored.phase72SampleLimit || process.env.PHASE72_SAMPLE_LIMIT || 20) || 20
  };
});

ipcMain.handle('phase72:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptions = {
      ...stored,
      ...options,
      phase72MasterTable: String(
        options.phase72MasterTable || stored.phase72MasterTable || stored.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table'
      ).trim(),
      phase72DriveFolderId: String(
        options.phase72DriveFolderId || stored.phase72DriveFolderId || process.env.PHASE72_DRIVE_FOLDER_ID || ''
      ).trim(),
      phase72TestIpns: String(
        options.phase72TestIpns || stored.phase72TestIpns || process.env.PHASE72_TEST_IPNS || ''
      ).trim(),
      phase72MaxIpns: Number(
        options.phase72MaxIpns || stored.phase72MaxIpns || process.env.PHASE72_MAX_IPNS || 0
      ) || 0,
      phase72ForceRegenerate:
        String(options.phase72ForceRegenerate ?? stored.phase72ForceRegenerate ?? process.env.PHASE72_FORCE_REGENERATE ?? 'false')
          .trim()
          .toLowerCase() === 'true',
      sampleLimit: Number(options.sampleLimit || stored.phase72SampleLimit || process.env.PHASE72_SAMPLE_LIMIT || 20) || 20
    };

    event.sender.send('phase72:progress', {
      stage: 'phase72_load_master',
      percent: 1,
      counts: null,
      message: 'Starting Phase 7.2 fitment image generation...'
    });

    const summary = await runPhase72FitmentImage(runOptions, progress => {
      event.sender.send('phase72:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase72:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase74:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  return {
    listingsTableName: resolveListingsTableName(
      stored.phase74ListingsTable,
      stored.phase6ListingsTable,
      stored.ebayMockTableName,
      process.env.PHASE74_LISTINGS_TABLE,
      DEFAULT_EBAY_LISTINGS_TABLE
    ),
    masterTableName: String(stored.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table').trim(),
    openaiModel: String(stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
    promptCacheEnabled:
      String(stored.phase74PromptCacheEnabled ?? process.env.PHASE74_PROMPT_CACHE_ENABLED ?? 'true').trim().toLowerCase() !==
      'false',
    promptCacheKey: String(
      stored.phase74PromptCacheKey || process.env.PHASE74_PROMPT_CACHE_KEY || process.env.OPENAI_PROMPT_CACHE_KEY || 'phase74_title_description_v1'
    ).trim(),
    titleRulesPrompt: resolvePhase74TitleRulesPrompt(
      stored.phase74TitleRulesPrompt,
      process.env.PHASE74_TITLE_RULES_PROMPT
    ),
    testIpns: String(stored.phase74TestIpns || process.env.PHASE74_TEST_IPNS || '').trim(),
    maxListings: Number(stored.phase74MaxListings || process.env.PHASE74_MAX_LISTINGS || 0) || 0,
    sampleLimit: Number(stored.phase74SampleLimit || process.env.PHASE74_SAMPLE_LIMIT || 20) || 20
  };
});

ipcMain.handle('phase74:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptionsBase = {
      ...stored,
      ...options,
      phase74ListingsTable: resolveListingsTableName(
        options.phase74ListingsTable,
        stored.phase74ListingsTable,
        stored.phase6ListingsTable,
        stored.ebayMockTableName,
        process.env.PHASE74_LISTINGS_TABLE,
        DEFAULT_EBAY_LISTINGS_TABLE
      ),
      airtableMasterTable: String(
        options.airtableMasterTable || stored.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table'
      ).trim(),
      openaiApiKey: String(options.openaiApiKey || stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
      openaiModel: String(options.openaiModel || stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
      phase74TitleRulesPrompt: resolvePhase74TitleRulesPrompt(
        options.phase74TitleRulesPrompt,
        stored.phase74TitleRulesPrompt,
        process.env.PHASE74_TITLE_RULES_PROMPT
      ),
      openaiBaseUrl: String(options.openaiBaseUrl || stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
      phase74PromptCacheEnabled:
        String(options.phase74PromptCacheEnabled ?? stored.phase74PromptCacheEnabled ?? process.env.PHASE74_PROMPT_CACHE_ENABLED ?? 'true')
          .trim()
          .toLowerCase() !== 'false',
      phase74PromptCacheKey: String(
        options.phase74PromptCacheKey ||
          stored.phase74PromptCacheKey ||
          process.env.PHASE74_PROMPT_CACHE_KEY ||
          process.env.OPENAI_PROMPT_CACHE_KEY ||
          'phase74_title_description_v1'
      ).trim(),
      phase74TestIpns: String(
        options.phase74TestIpns || stored.phase74TestIpns || process.env.PHASE74_TEST_IPNS || ''
      ).trim(),
      phase74MaxListings: Number(
        options.phase74MaxListings || stored.phase74MaxListings || process.env.PHASE74_MAX_LISTINGS || 0
      ) || 0,
      sampleLimit: Number(options.sampleLimit || stored.phase74SampleLimit || process.env.PHASE74_SAMPLE_LIMIT || 20) || 20
    };
    const runOptions = await attachPhase5PublishedState(runOptionsBase, 'phase74:run');

    event.sender.send('phase74:progress', {
      stage: 'phase74_prepare',
      percent: 1,
      counts: null,
      message: 'Starting Phase 7.4 title/description generation...'
    });

    const summary = await runPhase74TitleDescription(runOptions, progress => {
      event.sender.send('phase74:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase74:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase5:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  const phase5EbayEnvironment = normalizeEbayEnvironment(
    stored.phase5EbayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox'
  );
  const phase5EbayCredentialSets = getEbayCredentialSets({
    ...stored,
    phase5EbayEnvironment
  });
  const activePhase5EbayCredentials = phase5EbayCredentialSets[phase5EbayEnvironment] || normalizeEbayCredentialSet({});
  return {
    phase5Mode: String(stored.phase5Mode || 'A').trim().toUpperCase() === 'B' ? 'B' : 'A',
    phase5AutoPushEnabled:
      String(stored.phase5AutoPushEnabled ?? 'false').trim().toLowerCase() === 'true',
    phase5AutoPushCron: String(stored.phase5AutoPushCron || '0 * * * *').trim(),
    phase5AutoPushTimezone: String(stored.phase5AutoPushTimezone || '').trim(),
    phase5AutoPushEligibilityFieldName: String(stored.phase5AutoPushEligibilityFieldName || '').trim(),
    phase5AutoPushEligibilityValues: String(stored.phase5AutoPushEligibilityValues || '').trim(),
    phase5EbayEnvironment,
    phase5EbayCredentialSets,
    ebayListingsSourceApi:
      ['auto', 'trading', 'inventory'].includes(String(stored.ebayListingsSourceApi || '').trim().toLowerCase())
        ? String(stored.ebayListingsSourceApi || '').trim().toLowerCase()
        : 'auto',
    phase5EbayClientId: activePhase5EbayCredentials.phase5EbayClientId,
    phase5EbayDevId: activePhase5EbayCredentials.phase5EbayDevId,
    phase5EbayClientSecret: activePhase5EbayCredentials.phase5EbayClientSecret,
    phase5EbayRuName: activePhase5EbayCredentials.phase5EbayRuName,
    phase5EbayUserAccessToken: activePhase5EbayCredentials.phase5EbayUserAccessToken,
    phase5EbayRefreshToken: activePhase5EbayCredentials.phase5EbayRefreshToken,
    phase5EbayRefreshScope: activePhase5EbayCredentials.phase5EbayRefreshScope,
    phase5EbayUserAccessTokenIssuedAt: activePhase5EbayCredentials.phase5EbayUserAccessTokenIssuedAt,
    phase5AutoPushStatus: getPhase5AutoPushScheduleStatus(),
    phase5EnforceBatchApproval:
      String(stored.phase5EnforceBatchApproval ?? 'true').trim().toLowerCase() !== 'false',
    phase5EnforceListingApproval:
      String(stored.phase5EnforceListingApproval ?? 'false').trim().toLowerCase() === 'true',
    phase5BatchesTable: String(stored.phase5BatchesTable || 'Listing Batches').trim(),
    phase5BatchStatusFieldName: String(stored.phase5BatchStatusFieldName || 'Batch Status').trim(),
    phase5BatchApprovedValue: String(stored.phase5BatchApprovedValue || 'Approved').trim(),
    phase5BatchLinkFieldName: String(stored.phase5BatchLinkFieldName || '').trim(),
    phase5RequiredCategoryIdFieldName: String(stored.phase5RequiredCategoryIdFieldName || '').trim(),
    phase5RequiredTitleFieldName: String(stored.phase5RequiredTitleFieldName || '').trim(),
    phase5RequiredDescriptionFieldName: String(stored.phase5RequiredDescriptionFieldName || '').trim(),
    phase5RequiredItemSpecificsFieldName: String(stored.phase5RequiredItemSpecificsFieldName || '').trim(),
    phase5RequiredItemSpecificFieldNames: String(stored.phase5RequiredItemSpecificFieldNames || '').trim(),
    phase5BlockedFieldName: String(stored.phase5BlockedFieldName || '').trim(),
    phase5ClickupExceptionFieldName: String(stored.phase5ClickupExceptionFieldName || '').trim(),
    phase5ClickupResolvedValues: String(stored.phase5ClickupResolvedValues || 'resolved,done,closed,complete').trim(),
    phase5PublishStatusFieldName: String(stored.phase5PublishStatusFieldName || '').trim(),
    phase5PublishedAtFieldName: String(stored.phase5PublishedAtFieldName || '').trim(),
    phase5PublishRunIdFieldName: String(stored.phase5PublishRunIdFieldName || '').trim(),
    phase5PayloadHashFieldName: String(stored.phase5PayloadHashFieldName || '').trim(),
    phase5PayloadHashFields: String(stored.phase5PayloadHashFields || '').trim(),
    phase5PublishedLogPendingValue: String(stored.phase5PublishedLogPendingValue || 'Published (Log Pending)').trim(),
    phase5SheetsLogEnabled:
      String(stored.phase5SheetsLogEnabled ?? 'false').trim().toLowerCase() === 'true',
    phase5SheetsLogSpreadsheetId: String(stored.phase5SheetsLogSpreadsheetId || '').trim(),
    phase5SheetsLogTabName: String(stored.phase5SheetsLogTabName || 'Log').trim(),
    phase5SheetsLogAuthContext: String(stored.phase5SheetsLogAuthContext || 'inventory').trim(),
    phase5LiveCompareEnabled:
      String(stored.phase5LiveCompareEnabled ?? 'false').trim().toLowerCase() === 'true',
    phase5LiveCompareApiUrl: String(stored.phase5LiveCompareApiUrl || '').trim(),
    phase5LiveCompareApiKey: String(stored.phase5LiveCompareApiKey || '').trim(),
    phase5TestBatchRecordIds: String(stored.phase5TestBatchRecordIds || '').trim(),
    listingsTableName: String(
      stored.phase5ListingsTable || stored.ebaySandboxTableName || 'eBay Listings (API)'
    ).trim(),
    approvalFieldName: String(stored.phase5ApprovalFieldName || '').trim(),
    groupFieldName: String(stored.phase5GroupFieldName || '').trim(),
    groupValue: String(stored.phase5GroupValue || '').trim(),
    schemaCsvPath: String(stored.phase5SchemaCsvPath || '').trim()
  };
});

ipcMain.handle('phase5:testPublishLogConfig', async (_, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptions = {
      ...stored,
      ...options
    };
    const publishLogService = new Phase5PublishLogService({
      enabled: runOptions.phase5SheetsLogEnabled ?? process.env.PHASE5_SHEETS_LOG_ENABLED ?? 'false',
      spreadsheetId: runOptions.phase5SheetsLogSpreadsheetId || process.env.PHASE5_SHEETS_LOG_SPREADSHEET_ID || '',
      tabName: runOptions.phase5SheetsLogTabName || process.env.PHASE5_SHEETS_LOG_TAB || 'Log',
      authContext: runOptions.phase5SheetsLogAuthContext || process.env.PHASE5_SHEETS_LOG_AUTH_CONTEXT || 'inventory'
    });
    const enabled = String(runOptions.phase5SheetsLogEnabled ?? 'false').trim().toLowerCase() === 'true';
    const oauthConnected = oauth2Service.isAuthenticated(publishLogService.authContext);
    if (!enabled) {
      return {
        success: true,
        result: {
          enabled: false,
          configured: false,
          oauthConnected,
          spreadsheetId: publishLogService.spreadsheetId,
          tabName: publishLogService.tabName,
          authContext: publishLogService.authContext
        },
        message: 'Phase 5 Sheets publish log is disabled.'
      };
    }
    if (!publishLogService.spreadsheetId) {
      return {
        success: false,
        result: {
          enabled: true,
          configured: false,
          oauthConnected,
          spreadsheetId: publishLogService.spreadsheetId,
          tabName: publishLogService.tabName,
          authContext: publishLogService.authContext
        },
        message: 'Phase 5 Sheets publish log spreadsheet ID is required.'
      };
    }
    if (!oauthConnected) {
      return {
        success: false,
        result: {
          enabled: true,
          configured: true,
          oauthConnected: false,
          spreadsheetId: publishLogService.spreadsheetId,
          tabName: publishLogService.tabName,
          authContext: publishLogService.authContext
        },
        message: `Google OAuth is not connected for context '${publishLogService.authContext}'.`
      };
    }

    const rows = await publishLogService.fetchLogRows();
    return {
      success: true,
      result: {
        enabled: true,
        configured: publishLogService.isConfigured(),
        oauthConnected: true,
        spreadsheetId: publishLogService.spreadsheetId,
        tabName: publishLogService.tabName,
        authContext: publishLogService.authContext,
        rowCount: Array.isArray(rows) ? Math.max(0, rows.length - 1) : 0
      },
      message: 'Phase 5 Sheets publish log configuration is valid.'
    };
  } catch (error) {
    return {
      success: false,
      message: formatDetailedErrorMessage(error)
    };
  }
});

ipcMain.handle('phase5:validateBatchSchema', async (_, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptions = {
      ...stored,
      ...options
    };
    const result = await validateBatchGovernanceSchema(runOptions);
    return {
      success: !!result?.ok,
      result,
      message: result?.message || (result?.ok ? 'Batch schema is valid.' : 'Batch schema validation failed.')
    };
  } catch (error) {
    return {
      success: false,
      message: formatDetailedErrorMessage(error)
    };
  }
});

ipcMain.handle('phase5:getBatchSummaries', async (_, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptions = {
      ...stored,
      ...options
    };
    const result = await getBatchSummaries(runOptions);
    return {
      success: true,
      ...result
    };
  } catch (error) {
    return {
      success: false,
      message: formatDetailedErrorMessage(error),
      batches: []
    };
  }
});

ipcMain.handle('phase5:getBatchListings', async (_, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptions = {
      ...stored,
      ...options
    };
    const result = await getBatchListings(runOptions);
    const allListings = Array.isArray(result?.listings) ? result.listings : [];
    const parsedPageSize = Number(options.pageSize);
    const pageSize = Math.max(
      1,
      Math.min(500, Number.isFinite(parsedPageSize) ? parsedPageSize : allListings.length || 200)
    );
    const parsedCursor = Number.parseInt(String(options.cursor || '0'), 10);
    const start = Number.isFinite(parsedCursor) && parsedCursor > 0 ? parsedCursor : 0;
    const end = Math.min(allListings.length, start + pageSize);
    const listings = allListings.slice(start, end);
    const hasMore = end < allListings.length;

    return {
      success: true,
      ...result,
      total: Number(result?.total || allListings.length) || allListings.length,
      listings,
      hasMore,
      nextCursor: hasMore ? String(end) : ''
    };
  } catch (error) {
    return {
      success: false,
      message: formatDetailedErrorMessage(error),
      listings: [],
      total: 0,
      hasMore: false,
      nextCursor: ''
    };
  }
});

ipcMain.handle('phase5:setBatchStatus', async (_, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptions = {
      ...stored,
      ...options
    };
    const result = await setPhase5BatchStatus(runOptions);
    return {
      success: true,
      ...result
    };
  } catch (error) {
    return {
      success: false,
      message: formatDetailedErrorMessage(error)
    };
  }
});

ipcMain.handle('phase5:createBatchFromListings', async (_, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptions = {
      ...stored,
      ...options
    };
    const result = await createBatchFromListings(runOptions);
    return {
      success: !!result?.success,
      ...result
    };
  } catch (error) {
    return {
      success: false,
      message: formatDetailedErrorMessage(error)
    };
  }
});

ipcMain.handle('phase5:publishApproved', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const phase5Mode = String(options.phase5Mode || stored.phase5Mode || 'A').trim().toUpperCase() === 'B' ? 'B' : 'A';
    if (phase5Mode === 'B') {
      throw new Error('Phase 5 Option B is scheduled auto-push. Use Start Auto-Push or Run Auto-Push Now.');
    }
    stopPhase5AutoPushSchedule();
    const runOptionsBase = {
      ...stored,
      ...options,
      dryRun: false,
      phase5Mode,
      phase5ListingsTable: String(
        options.phase5ListingsTable || stored.phase5ListingsTable || stored.ebaySandboxTableName || 'eBay Listings (API)'
      ).trim(),
      phase5ApprovalFieldName: String(options.phase5ApprovalFieldName || stored.phase5ApprovalFieldName || '').trim(),
      phase5GroupFieldName: String(options.phase5GroupFieldName || stored.phase5GroupFieldName || '').trim(),
      phase5GroupValue: String(options.phase5GroupValue || stored.phase5GroupValue || '').trim(),
      phase5SchemaCsvPath: String(options.phase5SchemaCsvPath || stored.phase5SchemaCsvPath || '').trim(),
      phase5EbayEnvironment: String(options.phase5EbayEnvironment || stored.phase5EbayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox')
        .trim()
        .toLowerCase() === 'production' ? 'production' : 'sandbox',
      phase5EbayClientId: String(options.phase5EbayClientId || stored.phase5EbayClientId || process.env.EBAY_CLIENT_ID || '').trim(),
      phase5EbayDevId: String(options.phase5EbayDevId || stored.phase5EbayDevId || process.env.EBAY_DEV_ID || '').trim(),
      phase5EbayClientSecret: String(
        options.phase5EbayClientSecret || stored.phase5EbayClientSecret || process.env.EBAY_CLIENT_SECRET || ''
      ).trim(),
      phase5EbayRuName: String(options.phase5EbayRuName || stored.phase5EbayRuName || process.env.EBAY_RUNAME || '').trim()
    };
    const runOptions = await attachPhase5PublishedState(runOptionsBase, 'phase5:publishApproved');

    event.sender.send('phase5:progress', {
      stage: 'phase5_load_schema',
      percent: 1,
      counts: null,
      message: `Starting Phase 5 ${runOptions.phase5Mode === 'B' ? 'Option B' : 'Option A'} run...`
    });

    const summary = await runPhase5PublishApproved(runOptions, progress => {
      event.sender.send('phase5:progress', progress);
    });

    const merged = {
      ...stored,
      ...options,
      phase5Mode: 'A',
      phase5AutoPushActive: false,
      phase5ListingsTable: runOptions.phase5ListingsTable,
      phase5ApprovalFieldName: runOptions.phase5ApprovalFieldName,
      phase5GroupFieldName: runOptions.phase5GroupFieldName,
      phase5GroupValue: runOptions.phase5GroupValue,
      phase5SchemaCsvPath: runOptions.phase5SchemaCsvPath,
      phase5EbayEnvironment: runOptions.phase5EbayEnvironment,
      phase5EbayClientId: runOptions.phase5EbayClientId,
      phase5EbayDevId: runOptions.phase5EbayDevId,
      phase5EbayClientSecret: runOptions.phase5EbayClientSecret,
      phase5EbayRuName: runOptions.phase5EbayRuName
    };
    saveInventoryConfig('phase2Config', stripPhase5LocalPublishedCache(merged));

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase5:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase5:dryRunPublishApproved', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const phase5Mode = String(options.phase5Mode || stored.phase5Mode || 'A').trim().toUpperCase() === 'B' ? 'B' : 'A';
    if (phase5Mode === 'B') {
      throw new Error('Phase 5 Option B is scheduled auto-push. Use Run Auto-Push Now for deterministic eligibility checks.');
    }
    stopPhase5AutoPushSchedule();
    const runOptionsBase = {
      ...stored,
      ...options,
      dryRun: true,
      phase5Mode,
      phase5ListingsTable: String(
        options.phase5ListingsTable || stored.phase5ListingsTable || stored.ebaySandboxTableName || 'eBay Listings (API)'
      ).trim(),
      phase5ApprovalFieldName: String(options.phase5ApprovalFieldName || stored.phase5ApprovalFieldName || '').trim(),
      phase5GroupFieldName: String(options.phase5GroupFieldName || stored.phase5GroupFieldName || '').trim(),
      phase5GroupValue: String(options.phase5GroupValue || stored.phase5GroupValue || '').trim(),
      phase5SchemaCsvPath: String(options.phase5SchemaCsvPath || stored.phase5SchemaCsvPath || '').trim(),
      phase5EbayEnvironment: String(options.phase5EbayEnvironment || stored.phase5EbayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox')
        .trim()
        .toLowerCase() === 'production' ? 'production' : 'sandbox',
      phase5EbayClientId: String(options.phase5EbayClientId || stored.phase5EbayClientId || process.env.EBAY_CLIENT_ID || '').trim(),
      phase5EbayDevId: String(options.phase5EbayDevId || stored.phase5EbayDevId || process.env.EBAY_DEV_ID || '').trim(),
      phase5EbayClientSecret: String(
        options.phase5EbayClientSecret || stored.phase5EbayClientSecret || process.env.EBAY_CLIENT_SECRET || ''
      ).trim(),
      phase5EbayRuName: String(options.phase5EbayRuName || stored.phase5EbayRuName || process.env.EBAY_RUNAME || '').trim()
    };
    const runOptions = await attachPhase5PublishedState(runOptionsBase, 'phase5:dryRunPublishApproved');

    event.sender.send('phase5:progress', {
      stage: 'phase5_load_schema',
      percent: 1,
      counts: null,
      message: `Starting Phase 5 dry run (${runOptions.phase5Mode === 'B' ? 'Option B' : 'Option A'})...`
    });

    const summary = await runPhase5PublishApproved(runOptions, progress => {
      event.sender.send('phase5:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase5:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase5:startAutoPush', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptionsBase = {
      ...stored,
      ...options,
      dryRun: false,
      phase5Mode: 'B',
      phase5AutoPushEnabled: true,
      phase5AutoPushCron: String(options.phase5AutoPushCron || stored.phase5AutoPushCron || '0 * * * *').trim(),
      phase5AutoPushTimezone: String(options.phase5AutoPushTimezone || stored.phase5AutoPushTimezone || '').trim(),
      phase5AutoPushEligibilityFieldName: String(
        options.phase5AutoPushEligibilityFieldName || stored.phase5AutoPushEligibilityFieldName || ''
      ).trim(),
      phase5AutoPushEligibilityValues: String(
        options.phase5AutoPushEligibilityValues || stored.phase5AutoPushEligibilityValues || ''
      ).trim(),
      phase5EbayEnvironment: String(options.phase5EbayEnvironment || stored.phase5EbayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox')
        .trim()
        .toLowerCase() === 'production' ? 'production' : 'sandbox',
      phase5EbayClientId: String(options.phase5EbayClientId || stored.phase5EbayClientId || process.env.EBAY_CLIENT_ID || '').trim(),
      phase5EbayDevId: String(options.phase5EbayDevId || stored.phase5EbayDevId || process.env.EBAY_DEV_ID || '').trim(),
      phase5EbayClientSecret: String(
        options.phase5EbayClientSecret || stored.phase5EbayClientSecret || process.env.EBAY_CLIENT_SECRET || ''
      ).trim(),
      phase5EbayRuName: String(options.phase5EbayRuName || stored.phase5EbayRuName || process.env.EBAY_RUNAME || '').trim(),
      phase5ListingsTable: String(
        options.phase5ListingsTable || stored.phase5ListingsTable || stored.ebaySandboxTableName || 'eBay Listings (API)'
      ).trim(),
      phase5ApprovalFieldName: String(options.phase5ApprovalFieldName || stored.phase5ApprovalFieldName || '').trim(),
      phase5GroupFieldName: String(options.phase5GroupFieldName || stored.phase5GroupFieldName || '').trim(),
      phase5GroupValue: String(options.phase5GroupValue || stored.phase5GroupValue || '').trim(),
      phase5SchemaCsvPath: String(options.phase5SchemaCsvPath || stored.phase5SchemaCsvPath || '').trim()
    };
    const runOptions = await attachPhase5PublishedState(runOptionsBase, 'phase5:startAutoPush');

    const execute = async ({ trigger }) => {
      try {
        if (event?.sender && !event.sender.isDestroyed()) {
          event.sender.send('phase5:progress', {
            stage: 'phase5_publish',
            percent: 1,
            counts: null,
            message: `Phase 5 Option B tick started (${trigger}).`
          });
        }
      } catch (_) {}
      const runOptionsForTick = await attachPhase5PublishedState(runOptionsBase, 'phase5:startAutoPush:tick');
      const summary = await runPhase5PublishApproved(runOptionsForTick, progress => {
        try {
          if (event?.sender && !event.sender.isDestroyed()) {
            event.sender.send('phase5:progress', progress);
          }
        } catch (_) {}
      });
      const merged = {
        ...stored,
        ...options,
        phase5Mode: 'B',
        phase5AutoPushEnabled: true,
        phase5AutoPushCron: runOptionsBase.phase5AutoPushCron,
        phase5AutoPushTimezone: runOptionsBase.phase5AutoPushTimezone,
        phase5AutoPushEligibilityFieldName: runOptionsBase.phase5AutoPushEligibilityFieldName,
        phase5AutoPushEligibilityValues: runOptionsBase.phase5AutoPushEligibilityValues,
        phase5EbayEnvironment: runOptionsBase.phase5EbayEnvironment,
        phase5EbayClientId: runOptionsBase.phase5EbayClientId,
        phase5EbayDevId: runOptionsBase.phase5EbayDevId,
        phase5EbayClientSecret: runOptionsBase.phase5EbayClientSecret,
        phase5EbayRuName: runOptionsBase.phase5EbayRuName,
        phase5ListingsTable: runOptionsBase.phase5ListingsTable,
        phase5ApprovalFieldName: runOptionsBase.phase5ApprovalFieldName,
        phase5GroupFieldName: runOptionsBase.phase5GroupFieldName,
        phase5GroupValue: runOptionsBase.phase5GroupValue,
        phase5SchemaCsvPath: runOptionsBase.phase5SchemaCsvPath,
        phase5AutoPushActive: true
      };
      saveInventoryConfig('phase2Config', stripPhase5LocalPublishedCache(merged));
      return { success: true, summary };
    };

    const status = startPhase5AutoPushSchedule(
      {
        cronExpression: runOptions.phase5AutoPushCron,
        timezone: runOptions.phase5AutoPushTimezone
      },
      execute
    );

    saveInventoryConfig('phase2Config', stripPhase5LocalPublishedCache({
      ...stored,
      ...options,
      phase5Mode: 'B',
      phase5AutoPushEnabled: true,
      phase5AutoPushActive: true,
      phase5AutoPushCron: runOptions.phase5AutoPushCron,
      phase5AutoPushTimezone: runOptions.phase5AutoPushTimezone,
      phase5AutoPushEligibilityFieldName: runOptions.phase5AutoPushEligibilityFieldName,
      phase5AutoPushEligibilityValues: runOptions.phase5AutoPushEligibilityValues,
      phase5EbayEnvironment: runOptions.phase5EbayEnvironment,
      phase5EbayClientId: runOptions.phase5EbayClientId,
      phase5EbayDevId: runOptions.phase5EbayDevId,
      phase5EbayClientSecret: runOptions.phase5EbayClientSecret,
      phase5EbayRuName: runOptions.phase5EbayRuName
    }));

    return { success: true, status };
  } catch (error) {
    return { success: false, message: formatDetailedErrorMessage(error) };
  }
});

ipcMain.handle('phase5:stopAutoPush', async () => {
  try {
    stopPhase5AutoPushSchedule();
    const stored = getInventoryConfig('phase2Config') || {};
    saveInventoryConfig('phase2Config', stripPhase5LocalPublishedCache({
      ...stored,
      phase5AutoPushActive: false
    }));
    return { success: true, status: getPhase5AutoPushScheduleStatus() };
  } catch (error) {
    return { success: false, message: formatDetailedErrorMessage(error) };
  }
});

ipcMain.handle('phase5:getAutoPushStatus', async () => {
  return getPhase5AutoPushScheduleStatus();
});

ipcMain.handle('phase5:testEbayCredentials', async (_, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const resolved = normalizeAndAttachEbayCredentials(stored, options);
    const publishService = new (require('../services/phase5EbayPublishService').Phase5EbayPublishService)({
      ebayEnvironment: resolved.phase5EbayEnvironment,
      ebayClientId: resolved.phase5EbayClientId,
      ebayDevId: resolved.phase5EbayDevId,
      ebayClientSecret: resolved.phase5EbayClientSecret,
      ebayRuName: resolved.phase5EbayRuName,
      ebayUserAccessToken: resolved.phase5EbayUserAccessToken,
      ebayRefreshToken: resolved.phase5EbayRefreshToken,
      ebayUserAccessTokenIssuedAt: resolved.phase5EbayUserAccessTokenIssuedAt
    });

    const result = await publishService.testCredentials();
    let toSave = normalizeAndAttachEbayCredentials(stored, options);
    if (result?.success && result?.userAccessToken) {
      toSave = normalizeAndAttachEbayCredentials(toSave, {
        phase5EbayEnvironment: resolved.phase5EbayEnvironment,
        phase5EbayUserAccessToken: String(result.userAccessToken || '').trim(),
        phase5EbayUserAccessTokenIssuedAt: String(result.issuedAt || new Date().toISOString()).trim(),
        phase5EbayUserAccessTokenExpiresIn: Number(result.expiresIn || 0) || 0
      });
      delete result.userAccessToken;
    }
    saveInventoryConfig('phase2Config', stripPhase5LocalPublishedCache(toSave));
    return {
      success: true,
      result
    };
  } catch (error) {
    return {
      success: false,
      message: formatDetailedErrorMessage(error)
    };
  }
});

ipcMain.handle('phase5:runAutoPushNow', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptionsBase = {
      ...stored,
      ...options,
      dryRun: false,
      phase5Mode: 'B',
      phase5AutoPushEnabled: true,
      phase5AutoPushEligibilityFieldName: String(
        options.phase5AutoPushEligibilityFieldName || stored.phase5AutoPushEligibilityFieldName || ''
      ).trim(),
      phase5AutoPushEligibilityValues: String(
        options.phase5AutoPushEligibilityValues || stored.phase5AutoPushEligibilityValues || ''
      ).trim(),
      phase5EbayEnvironment: String(options.phase5EbayEnvironment || stored.phase5EbayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox')
        .trim()
        .toLowerCase() === 'production' ? 'production' : 'sandbox',
      phase5EbayClientId: String(options.phase5EbayClientId || stored.phase5EbayClientId || process.env.EBAY_CLIENT_ID || '').trim(),
      phase5EbayDevId: String(options.phase5EbayDevId || stored.phase5EbayDevId || process.env.EBAY_DEV_ID || '').trim(),
      phase5EbayClientSecret: String(
        options.phase5EbayClientSecret || stored.phase5EbayClientSecret || process.env.EBAY_CLIENT_SECRET || ''
      ).trim(),
      phase5EbayRuName: String(options.phase5EbayRuName || stored.phase5EbayRuName || process.env.EBAY_RUNAME || '').trim(),
      phase5ListingsTable: String(
        options.phase5ListingsTable || stored.phase5ListingsTable || stored.ebaySandboxTableName || 'eBay Listings (API)'
      ).trim(),
      phase5ApprovalFieldName: String(options.phase5ApprovalFieldName || stored.phase5ApprovalFieldName || '').trim(),
      phase5GroupFieldName: String(options.phase5GroupFieldName || stored.phase5GroupFieldName || '').trim(),
      phase5GroupValue: String(options.phase5GroupValue || stored.phase5GroupValue || '').trim(),
      phase5SchemaCsvPath: String(options.phase5SchemaCsvPath || stored.phase5SchemaCsvPath || '').trim()
    };
    const runOptions = await attachPhase5PublishedState(runOptionsBase, 'phase5:runAutoPushNow');

    const result = await runPhase5AutoPushNow(async () => {
      const summary = await runPhase5PublishApproved(runOptions, progress => {
        event.sender.send('phase5:progress', progress);
      });
      saveInventoryConfig('phase2Config', stripPhase5LocalPublishedCache({
        ...stored,
        ...options,
        phase5Mode: 'B',
        phase5AutoPushEnabled: true,
        phase5EbayEnvironment: runOptions.phase5EbayEnvironment,
        phase5EbayClientId: runOptions.phase5EbayClientId,
        phase5EbayDevId: runOptions.phase5EbayDevId,
        phase5EbayClientSecret: runOptions.phase5EbayClientSecret,
        phase5EbayRuName: runOptions.phase5EbayRuName
      }));
      return { success: true, summary };
    });

    return {
      success: !!result?.success,
      summary: result?.summary || null,
      message: result?.message || ''
    };
  } catch (error) {
    return { success: false, message: formatDetailedErrorMessage(error) };
  }
});

ipcMain.handle('phase4combined:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const rulesDryRun =
      typeof options.phase4RulesDryRun === 'boolean'
        ? options.phase4RulesDryRun
        : typeof stored.phase4RulesDryRun === 'boolean'
          ? stored.phase4RulesDryRun
          : true;
    const bliteDryRun =
      typeof options.phase4BLiteDryRun === 'boolean'
        ? options.phase4BLiteDryRun
        : typeof stored.phase4BLiteDryRun === 'boolean'
          ? stored.phase4BLiteDryRun
          : true;

    const rulesRunOptions = {
      ...stored,
      ...options,
      dryRun: rulesDryRun,
      execute: !rulesDryRun,
      ruleTypes: ['F'],
      authContext: 'inventory',
      rulesDriveFile:
        String(
          options.phase4RulesDriveFile ||
            stored.phase4RulesDriveFile ||
            process.env.PHASE4_RULES_DRIVE_FILE ||
            process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
            ''
        ).trim(),
      globalDefaultsTable: String(
        options.phase4GlobalDefaultsTable ||
          stored.phase4GlobalDefaultsTable ||
          process.env.PHASE4_GLOBAL_DEFAULTS_TABLE ||
          'Fixed Item Specifics (Global Defaults)'
      ).trim(),
      logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim()
    };

    event.sender.send('phase4combined:progress', {
      stage: 'phase4combined_start',
      percent: 1,
      counts: null,
      message: 'Starting Phase 4 combined run (4A -> 4B-lite).'
    });

    let sharedMasterContext = null;
    try {
      const sharedConfig = {
        ...stored,
        ...options,
        airtableToken: String(options.airtableToken || stored.airtableToken || process.env.AIRTABLE_TOKEN || '').trim(),
        airtableBaseId: String(options.airtableBaseId || stored.airtableBaseId || process.env.AIRTABLE_BASE_ID || '').trim(),
        airtableMasterTable: String(stored.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table').trim()
      };
      sharedMasterContext = await buildPhase4SharedMasterContext(sharedConfig, {
        onProgress: message => {
          event.sender.send('phase4combined:progress', {
            stage: 'phase4combined_shared_master',
            percent: 2,
            counts: null,
            message: `[Shared] ${message}`
          });
        }
      });
    } catch (error) {
      event.sender.send('phase4combined:progress', {
        stage: 'phase4combined_shared_master',
        percent: 2,
        counts: null,
        message: `[Shared] Master cache unavailable (${error?.message || error}); falling back to per-phase loading.`
      });
    }
    rulesRunOptions.phase4SharedMasterRows = sharedMasterContext?.masterRows;
    rulesRunOptions.phase4SharedMasterIpnSet = sharedMasterContext?.masterIpnSet;

    const phase4ASummary = await runPhase4RulesPopulate(rulesRunOptions, progress => {
      const innerPercent = Number(progress?.percent || 0);
      const mappedPercent = Math.max(1, Math.min(49, Math.floor((innerPercent / 100) * 49)));
      event.sender.send('phase4combined:progress', {
        ...progress,
        stage: `phase4combined_4a_${String(progress?.stage || 'running')}`,
        percent: mappedPercent,
        message: `[4A] ${String(progress?.message || '').trim()}`
      });
    });

    const bliteRunOptionsBase = {
      ...stored,
      ...options,
      dryRun: bliteDryRun,
      execute: !bliteDryRun,
      authContext: 'inventory',
      rulesDriveFile:
        String(
          options.phase4RulesDriveFile ||
            stored.phase4RulesDriveFile ||
            process.env.PHASE4_RULES_DRIVE_FILE ||
            process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
            ''
        ).trim(),
      logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim(),
      testTableName: '',
      testMaxTables: 0,
      openaiApiKey: String(options.openaiApiKey || stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
      openaiModel: String(options.openaiModel || stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-5.4-nano').trim(),
      openaiBaseUrl: String(options.openaiBaseUrl || stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
      phase4BClickupListName: String(
        options.phase4BClickupListName || stored.phase4BClickupListName || ''
      ).trim(),
      phase4BClickupListId: String(
        options.phase4BClickupListId ||
          stored.phase4BClickupListId ||
          process.env.PHASE4B_CLICKUP_LIST_ID ||
          ''
      ).trim(),
      clickupOpenStatus: String(
        options.phase4BClickupOpenStatus ||
          stored.phase4BClickupOpenStatus ||
          process.env.PHASE4B_CLICKUP_OPEN_STATUS ||
          'To Do'
      ).trim()
    };
    bliteRunOptionsBase.phase4SharedMasterRows = sharedMasterContext?.masterRows;
    bliteRunOptionsBase.phase4SharedMasterByIpn = sharedMasterContext?.masterByIpn;
    const bliteRunOptions = await attachPhase5PublishedState(bliteRunOptionsBase, 'phase4combined:4b');

    const phase4BSummary = await runPhase4BLite(bliteRunOptions, progress => {
      const innerPercent = Number(progress?.percent || 0);
      const mappedPercent = Math.max(50, Math.min(99, 50 + Math.floor((innerPercent / 100) * 49)));
      event.sender.send('phase4combined:progress', {
        ...progress,
        stage: `phase4combined_4b_${String(progress?.stage || 'running')}`,
        percent: mappedPercent,
        message: `[4B-lite] ${String(progress?.message || '').trim()}`
      });
    });

    const summary = {
      phase4A: phase4ASummary || {},
      phase4BLite: phase4BSummary || {}
    };

    event.sender.send('phase4combined:progress', {
      stage: 'completed',
      percent: 100,
      counts: summary,
      message: 'Phase 4 combined run completed.'
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase4combined:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('ebaymock:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  return {
    csvPath: String(stored.ebayMockCsvPath || '').trim(),
    tableName: String(stored.ebayMockTableName || 'eBay Listings (API) (Mock)').trim(),
    dryRun:
      typeof stored.ebayMockDryRun === 'boolean'
        ? stored.ebayMockDryRun
        : true
  };
});

ipcMain.handle('ebaymock:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const dryRun =
      typeof options.ebayMockDryRun === 'boolean'
        ? options.ebayMockDryRun
        : typeof stored.ebayMockDryRun === 'boolean'
          ? stored.ebayMockDryRun
          : true;
    const runOptionsBase = {
      ...stored,
      ...options,
      dryRun,
      csvPath: String(options.ebayMockCsvPath || stored.ebayMockCsvPath || '').trim(),
      tableName: String(
        options.ebayMockTableName || stored.ebayMockTableName || 'eBay Listings (API) (Mock)'
      ).trim()
    };
    const runOptions = await attachPhase5PublishedState(runOptionsBase, 'ebaymock:run');

    const summary = await runEbayMockImport(runOptions, progress => {
      event.sender.send('ebaymock:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('ebaymock:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('ebaysandbox:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  const phase5EbayEnvironment = normalizeEbayEnvironment(
    stored.phase5EbayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox'
  );
  const nextByEnv =
    stored.ebaySandboxNextFetchPageByEnvironment && typeof stored.ebaySandboxNextFetchPageByEnvironment === 'object'
      ? stored.ebaySandboxNextFetchPageByEnvironment
      : { sandbox: 1, production: 1 };
  const nextFetchPage = Number(nextByEnv[phase5EbayEnvironment] || 1) || 1;
  return {
    tableName: resolveEbaySandboxTableName(
      stored.ebaySandboxTableName,
      stored.phase5ListingsTable,
      stored.ebayMockTableName
    ),
    fetchLimit: Number(stored.ebaySandboxFetchLimit || 200) || 200,
    fetchPagingMode: normalizeEbayFetchPagingMode(
      stored.ebaySandboxFetchPagingMode || stored.ebaySandboxFetchMode || DEFAULT_EBAY_FETCH_PAGING_MODE
    ),
    nextFetchPage,
    nextFetchPageByEnvironment: nextByEnv,
    dryRun:
      typeof stored.ebaySandboxDryRun === 'boolean'
        ? stored.ebaySandboxDryRun
        : true
  };
});

ipcMain.handle('ebaysandbox:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const dryRun =
      typeof options.ebaySandboxDryRun === 'boolean'
        ? options.ebaySandboxDryRun
        : typeof stored.ebaySandboxDryRun === 'boolean'
          ? stored.ebaySandboxDryRun
          : true;
    const runOptionsBase = {
      ...stored,
      ...options,
      dryRun,
      ebaySandboxDryRun: dryRun,
      ebaySandboxTableName: resolveEbaySandboxTableName(
        options.ebaySandboxTableName,
        stored.ebaySandboxTableName,
        stored.phase5ListingsTable,
        stored.ebayMockTableName
      ),
      ebaySandboxFetchLimit: Number(options.ebaySandboxFetchLimit || stored.ebaySandboxFetchLimit || 200) || 200,
      ebaySandboxFetchPagingMode: normalizeEbayFetchPagingMode(
        options.ebaySandboxFetchPagingMode ||
          options.ebaySandboxFetchMode ||
          stored.ebaySandboxFetchPagingMode ||
          stored.ebaySandboxFetchMode ||
          DEFAULT_EBAY_FETCH_PAGING_MODE
      )
    };
    const runOptions = await attachPhase5PublishedState(runOptionsBase, 'ebaysandbox:run');

    const summary = await runEbaySandboxInventoryImport(runOptions, progress => {
      event.sender.send('ebaysandbox:progress', progress);
    });

    const autoRunPostImport =
      String(
        runOptions.ebaySandboxAutoRunPostImportPhases ??
          stored.ebaySandboxAutoRunPostImportPhases ??
          process.env.EBAY_SANDBOX_AUTO_RUN_POST_IMPORT_PHASES ??
          'true'
      )
        .trim()
        .toLowerCase() !== 'false';
    const wroteListingRows = Number(summary?.recordsWritten || 0) > 0;
    const batchIpns = Array.isArray(summary?.ebaySandboxBatchIpns)
      ? summary.ebaySandboxBatchIpns.map(value => normalizeUpperIpn(value)).filter(Boolean)
      : [];
    const hasFetchedBatchIpns = batchIpns.length > 0;

    if (!dryRun && autoRunPostImport && (wroteListingRows || hasFetchedBatchIpns)) {
      event.sender.send('ebaysandbox:progress', {
        stage: 'ebaysandbox_post_import',
        percent: 99,
        counts: summary,
        message: 'Starting post-import automation: Phase4 -> Phase6 -> Phase7.2 -> Phase7.4...'
      });

      try {
        const postImportSummary = await runPostEbayListingsAutomation({
          ...runOptions,
          phase4DListingsTable: resolveListingsTableName(
            runOptions.phase4DListingsTable,
            runOptions.ebaySandboxTableName,
            runOptions.phase6ListingsTable,
            runOptions.phase74ListingsTable,
            DEFAULT_EBAY_LISTINGS_TABLE
          ),
          phase6ListingsTable: resolveListingsTableName(
            runOptions.phase6ListingsTable,
            runOptions.ebaySandboxTableName,
            runOptions.phase4DListingsTable,
            runOptions.phase74ListingsTable,
            DEFAULT_EBAY_LISTINGS_TABLE
          ),
          phase74ListingsTable: resolveListingsTableName(
            runOptions.phase74ListingsTable,
            runOptions.ebaySandboxTableName,
            runOptions.phase6ListingsTable,
            runOptions.phase4DListingsTable,
            DEFAULT_EBAY_LISTINGS_TABLE
          ),
          ebaySandboxBatchIpns: batchIpns
        }, {
          onProgress: payload => {
            event.sender.send('ebaysandbox:progress', payload);
          }
        });
        summary.postImportAutomation = postImportSummary;
        if (postImportSummary?.blocked) {
          event.sender.send('ebaysandbox:progress', {
            stage: 'ebaysandbox_post_import_blocked',
            percent: 100,
            counts: summary,
            message: postImportSummary?.message || 'Post-import automation blocked by missing configuration.'
          });
        } else {
          event.sender.send('ebaysandbox:progress', {
            stage: 'ebaysandbox_post_import',
            percent: 100,
            counts: summary,
            message: 'Post-import automation completed: Phase4 -> Phase6 -> Phase7.2 -> Phase7.4.'
          });
        }
      } catch (automationError) {
        const detail = formatDetailedErrorMessage(automationError);
        summary.postImportAutomationError = detail;
        emitInventoryAutoChainLog(`Post-import automation failed: ${detail}`, 'error');
        event.sender.send('ebaysandbox:progress', {
          stage: 'ebaysandbox_post_import_failed',
          percent: 100,
          counts: summary,
          message: `Post-import automation failed: ${detail}`
        });
      }
    } else if (!dryRun && autoRunPostImport && !wroteListingRows && !hasFetchedBatchIpns) {
      const reason =
        `Post-import automation skipped: no new listing rows were written and no batch IPNs were detected ` +
        `(recordsWritten=${Number(summary?.recordsWritten || 0)}, recordsPlanned=${Number(summary?.recordsPlanned || 0)}, batchIpns=${batchIpns.length}).`;
      emitInventoryAutoChainLog(reason);
      event.sender.send('ebaysandbox:progress', {
        stage: 'ebaysandbox_post_import_skipped_no_writes',
        percent: 100,
        counts: summary,
        message: reason
      });
    }

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('ebaysandbox:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('item-specific-sync:run', async (event, options = {}) => {
  try {
    const summary = await runItemSpecificTableSync(options, progress => {
      event.sender.send('item-specific-sync:progress', progress);
    });
    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('item-specific-sync:progress', {
      stage: 'error',
      at: new Date().toISOString(),
      message
    });
    return {
      success: false,
      message
    };
  }
});

/* ---------------------------
   WINDOW CREATION (STRICT)
---------------------------- */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
    },
  });

  const dbConfig = getDbConfig();
  const webhook = getWebhookConfig();

  console.log('Startup:', {
    db: !!dbConfig,
    webhook: !!webhook
  });

  // 🚦 STRICT ROUTING - Show page immediately
  if (!dbConfig) {
    return loadSetup();
  }

  // Missing webhook should not block app startup; users can configure it from dashboard flows.
  if (!webhook) {
    console.log('Webhook not configured, continuing to dashboard.');
  }

  // Initialize DB asynchronously in background AFTER loading dashboard
  loadDashboard();
  
  // Try to init DB after a short delay so UI renders first
  setImmediate(async () => {
    try {
      if (dbConfig.authType === 'windows') {
        await initDbWindowsAuth(dbConfig.server, dbConfig.database);
      } else {
        await initDb();
      }
      dbReady = true;
      console.log('✅ DB ready');
      
      // Resume any active reporting schedules
      resumeSchedule();
      resumeWorkOrdersSchedule();
      
      // Initialize inventory webhook schedule if it was previously active
      initInventorySchedule();

      // Resume Phase 5 Option B scheduled auto-push if it was active
      try {
        const storedPhase2 = getInventoryConfig('phase2Config') || {};
        const shouldResumePhase5AutoPush =
          String(storedPhase2.phase5Mode || 'A').trim().toUpperCase() === 'B' &&
          String(storedPhase2.phase5AutoPushEnabled ?? 'false').trim().toLowerCase() === 'true' &&
          String(storedPhase2.phase5AutoPushActive ?? 'false').trim().toLowerCase() === 'true';
        if (shouldResumePhase5AutoPush) {
          const runOptionsBase = {
            ...storedPhase2,
            dryRun: false,
            phase5Mode: 'B',
            phase5AutoPushEnabled: true,
            phase5ListingsTable: String(
              storedPhase2.phase5ListingsTable || storedPhase2.ebaySandboxTableName || 'eBay Listings (API)'
            ).trim(),
            phase5ApprovalFieldName: String(storedPhase2.phase5ApprovalFieldName || '').trim(),
            phase5GroupFieldName: String(storedPhase2.phase5GroupFieldName || '').trim(),
            phase5GroupValue: String(storedPhase2.phase5GroupValue || '').trim(),
            phase5SchemaCsvPath: String(storedPhase2.phase5SchemaCsvPath || '').trim(),
            phase5AutoPushEligibilityFieldName: String(storedPhase2.phase5AutoPushEligibilityFieldName || '').trim(),
            phase5AutoPushEligibilityValues: String(storedPhase2.phase5AutoPushEligibilityValues || '').trim(),
            phase5EbayEnvironment: String(storedPhase2.phase5EbayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox')
              .trim()
              .toLowerCase() === 'production' ? 'production' : 'sandbox',
            phase5EbayClientId: String(storedPhase2.phase5EbayClientId || process.env.EBAY_CLIENT_ID || '').trim(),
            phase5EbayDevId: String(storedPhase2.phase5EbayDevId || process.env.EBAY_DEV_ID || '').trim(),
            phase5EbayClientSecret: String(storedPhase2.phase5EbayClientSecret || process.env.EBAY_CLIENT_SECRET || '').trim(),
            phase5EbayRuName: String(storedPhase2.phase5EbayRuName || process.env.EBAY_RUNAME || '').trim()
          };
          const runOptions = await attachPhase5PublishedState(runOptionsBase, 'phase5:resumeAutoPush');
          startPhase5AutoPushSchedule(
            {
              cronExpression: String(storedPhase2.phase5AutoPushCron || '0 * * * *').trim(),
              timezone: String(storedPhase2.phase5AutoPushTimezone || '').trim()
            },
            async () => {
              const summary = await runPhase5PublishApproved(runOptions, progress => {
                if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
                  mainWindow.webContents.send('phase5:progress', progress);
                }
              });
              const fresh = getInventoryConfig('phase2Config') || {};
              saveInventoryConfig('phase2Config', stripPhase5LocalPublishedCache({
                ...fresh,
                phase5Mode: 'B',
                phase5AutoPushEnabled: true,
                phase5AutoPushActive: true
              }));
              return { success: true, summary };
            }
          );
          console.log('Phase5 Option B auto-push schedule resumed.');
        }
      } catch (phase5ResumeError) {
        console.error('Phase5 auto-push resume failed:', phase5ResumeError.message);
      }

      const writebackConfig = buildPhase2WritebackConfig();
      if (parseBoolean(writebackConfig.enabled, false)) {
        phase2WritebackPoller.start(writebackConfig);
        console.log(
          `Phase2 write-back poller started (${Number(writebackConfig.pollIntervalMinutes) || 5} min interval)`
        );
      }
      startPhase4WritebackPoller();
      console.log('Phase4 writeback poller started (1 min interval)');
    } catch (err) {
      console.error('❌ DB init failed:', err.message);
      dbReady = false;
    }
  });
}

/* ---------------------------
   APP LIFECYCLE
---------------------------- */

// Start OAuth2 callback server
const http = require('http');
const url = require('url');
const { shell } = require('electron');

http.createServer(async (req, res) => {
  const queryUrl = url.parse(req.url, true);
  const code = queryUrl.query.code;
  const state = queryUrl.query.state;
  const authContext = state === 'inventory' ? 'inventory' : 'reporting';

  if (code) {
    // Exchange code for tokens
    try {
      await oauth2Service.getTokensFromCode(code, authContext);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <head><title>Authorization Successful</title></head>
          <body style="font-family: Arial; text-align: center; padding: 50px;">
            <h2 style="color: green;">Authorization Successful!</h2>
            <p>You can close this window and return to the app.</p>
            <p>The window will close automatically in 5 seconds...</p>
            <script>setTimeout(() => window.close(), 5000);</script>
          </body>
        </html>
      `);
      
      // Send message to renderer to update UI
      if (mainWindow) {
        if (authContext === 'inventory') {
          mainWindow.webContents.send('oauth2-authorized-inventory');
        } else {
          mainWindow.webContents.send('oauth2-authorized');
        }
      }
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <head><title>Authorization Failed</title></head>
          <body style="font-family: Arial; text-align: center; padding: 50px;">
            <h2 style="color: red;">Authorization Failed</h2>
            <p>${error.message}</p>
            <p>The window will close automatically in 5 seconds...</p>
            <script>setTimeout(() => window.close(), 5000);</script>
          </body>
        </html>
      `);
    }
  } else {
    res.writeHead(400);
    res.end('No authorization code received');
  }
}).listen(9999, () => {
  console.log('OAuth2 callback server listening on http://localhost:9999');
});

app.whenReady().then(createWindow);

app.on('before-quit', () => {
  phase2AutoRunService.stop();
  phase2WritebackPoller.stop();
  stopPhase4WritebackPoller();
  stopWorkOrdersSchedule();
});

app.on('window-all-closed', () => {
  phase2AutoRunService.stop();
  phase2WritebackPoller.stop();
  stopPhase4WritebackPoller();
  stopWorkOrdersSchedule();
  if (process.platform !== 'darwin') app.quit();
});

