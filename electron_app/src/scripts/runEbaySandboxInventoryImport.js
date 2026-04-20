const axios = require('axios');
const { loadEnv } = require('../config/loadEnv');
const AirtableService = require('../services/airtableService');
const AirtableSchemaService = require('../services/airtableSchemaService');
const { getInventoryConfig } = require('../config/configStore');

loadEnv();

const DEFAULT_TABLE_NAME = 'eBay Listings (API) (Mock)';
const DEFAULT_FETCH_LIMIT = 200;
const DEFAULT_PAGE_SIZE = 100;
const BATCH_SIZE = 10;
const PRIMARY_KEY_FIELD = 'Record Key';
const IPN_FIELD = 'c: partshunter203 ebay MOTORS interchange part number';

const UPSERT_FIELDS = [
  PRIMARY_KEY_FIELD,
  'SKU',
  'Item ID',
  'Offer ID',
  'Product Title(New)',
  'Description',
  'Item Specifics',
  'Quantity',
  'Price',
  'Currency',
  'eBay Category ID',
  'Source',
  'eBay Environment',
  'Last Synced At'
];

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeEnvironment(value) {
  return normalizeText(value).toLowerCase() === 'production' ? 'production' : 'sandbox';
}

function toNumber(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function emitProgress(progressCallback, payload = {}) {
  if (typeof progressCallback === 'function') {
    progressCallback(payload);
  }
}

function formatError(error) {
  const status = error?.response?.status;
  const data = error?.response?.data;
  const detail =
    data?.errors?.[0]?.message ||
    data?.error_description ||
    data?.message ||
    data?.error ||
    error?.message ||
    String(error);
  return status ? `HTTP ${status}: ${detail}` : String(detail);
}

function getIdentityTokenUrl(environment = 'sandbox') {
  return environment === 'production'
    ? 'https://api.ebay.com/identity/v1/oauth2/token'
    : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';
}

function getSellApiBase(environment = 'sandbox') {
  return environment === 'production'
    ? 'https://api.ebay.com'
    : 'https://api.sandbox.ebay.com';
}

async function requestAccessToken(client, config = {}) {
  const clientId = normalizeText(config.clientId);
  const clientSecret = normalizeText(config.clientSecret);
  if (!clientId) throw new Error('Missing eBay App ID / Client ID.');
  if (!clientSecret) throw new Error('Missing eBay Cert ID / Client Secret.');

  const body = new URLSearchParams();
  body.append('grant_type', 'client_credentials');
  body.append(
    'scope',
    [
      'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.inventory'
    ].join(' ')
  );

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await client.post(getIdentityTokenUrl(config.environment), body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`
    }
  });
  const token = normalizeText(response?.data?.access_token);
  if (!token) throw new Error('eBay OAuth token response did not include access_token.');
  return token;
}

async function fetchInventoryItems(client, config = {}, accessToken = '', summary = {}, progressCallback = () => {}) {
  const all = [];
  const pageSize = toNumber(config.pageSize, DEFAULT_PAGE_SIZE, 1, 200);
  const fetchLimit = toNumber(config.fetchLimit, DEFAULT_FETCH_LIMIT, 1, 5000);
  const base = getSellApiBase(config.environment);
  let offset = 0;

  while (all.length < fetchLimit) {
    const limit = Math.min(pageSize, fetchLimit - all.length);
    const response = await client.get(`${base}/sell/inventory/v1/inventory_item`, {
      params: { limit, offset },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    });
    const data = response?.data || {};
    const rows = Array.isArray(data.inventoryItems)
      ? data.inventoryItems
      : Array.isArray(data.inventoryItem)
        ? data.inventoryItem
        : Array.isArray(data.items)
          ? data.items
          : [];
    if (rows.length === 0) break;

    all.push(...rows);
    summary.inventoryItemsFetched = all.length;
    emitProgress(progressCallback, {
      stage: 'ebaysandbox_fetch_items',
      percent: Math.min(55, 20 + Math.floor((all.length / Math.max(1, fetchLimit)) * 35)),
      counts: summary,
      message: `Fetched ${all.length} inventory item(s) from eBay ${config.environment}.`
    });

    const count = toNumber(data.count, rows.length, 0, Number.MAX_SAFE_INTEGER);
    const total = toNumber(data.total, 0, 0, Number.MAX_SAFE_INTEGER);
    offset += Math.max(count, rows.length);
    if (total > 0 && offset >= total) break;
    if (rows.length < limit) break;
  }

  return all.slice(0, fetchLimit);
}

function pickListingId(offer = {}) {
  return normalizeText(
    offer?.listingId ||
      offer?.listing?.listingId ||
      offer?.listing?.itemId ||
      offer?.itemId ||
      ''
  );
}

function pickPriceValue(offer = {}) {
  return normalizeText(
    offer?.pricingSummary?.price?.value ||
      offer?.pricingSummary?.priceValue ||
      offer?.price?.value ||
      ''
  );
}

function pickPriceCurrency(offer = {}) {
  return normalizeText(
    offer?.pricingSummary?.price?.currency ||
      offer?.pricingSummary?.currency ||
      offer?.price?.currency ||
      ''
  );
}

function pickCategoryId(offer = {}) {
  return normalizeText(
    offer?.categoryId ||
      offer?.listingPolicies?.categoryId ||
      ''
  );
}

async function fetchOfferIndex(client, config = {}, accessToken = '', summary = {}, progressCallback = () => {}) {
  const offersBySku = new Map();
  const pageSize = toNumber(config.pageSize, DEFAULT_PAGE_SIZE, 1, 200);
  const fetchLimit = toNumber(config.fetchLimit, DEFAULT_FETCH_LIMIT, 1, 5000);
  const base = getSellApiBase(config.environment);
  let offset = 0;
  let seen = 0;

  while (seen < fetchLimit) {
    const limit = Math.min(pageSize, fetchLimit - seen);
    const response = await client.get(`${base}/sell/inventory/v1/offer`, {
      params: { limit, offset },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    });
    const data = response?.data || {};
    const offers = Array.isArray(data.offers) ? data.offers : [];
    if (offers.length === 0) break;
    seen += offers.length;

    for (const offer of offers) {
      const sku = normalizeText(offer?.sku);
      if (!sku) continue;
      const nextValue = {
        offerId: normalizeText(offer?.offerId),
        listingId: pickListingId(offer),
        price: pickPriceValue(offer),
        currency: pickPriceCurrency(offer),
        categoryId: pickCategoryId(offer)
      };
      const prev = offersBySku.get(sku);
      if (!prev) {
        offersBySku.set(sku, nextValue);
        continue;
      }
      if (!prev.listingId && nextValue.listingId) prev.listingId = nextValue.listingId;
      if (!prev.offerId && nextValue.offerId) prev.offerId = nextValue.offerId;
      if (!prev.price && nextValue.price) prev.price = nextValue.price;
      if (!prev.currency && nextValue.currency) prev.currency = nextValue.currency;
      if (!prev.categoryId && nextValue.categoryId) prev.categoryId = nextValue.categoryId;
      offersBySku.set(sku, prev);
    }

    summary.offersFetched = seen;
    emitProgress(progressCallback, {
      stage: 'ebaysandbox_fetch_offers',
      percent: Math.min(68, 56 + Math.floor((seen / Math.max(1, fetchLimit)) * 12)),
      counts: summary,
      message: `Fetched ${seen} offer row(s); mapped SKUs: ${offersBySku.size}.`
    });

    const count = toNumber(data.count, offers.length, 0, Number.MAX_SAFE_INTEGER);
    const total = toNumber(data.total, 0, 0, Number.MAX_SAFE_INTEGER);
    offset += Math.max(count, offers.length);
    if (total > 0 && offset >= total) break;
    if (offers.length < limit) break;
  }

  return offersBySku;
}

async function ensureTableAndFields(schemaService, tableName = '', dryRun = true) {
  const tables = await schemaService.listTables();
  let table = (tables || []).find(t => normalizeText(t?.name).toLowerCase() === tableName.toLowerCase());
  let createdTable = false;

  if (!table && !dryRun) {
    table = await schemaService.createTable({
      name: tableName,
      fields: [{ name: PRIMARY_KEY_FIELD, type: 'singleLineText' }]
    });
    createdTable = true;
  }

  if (!table) {
    return {
      tableId: '',
      createdTable: false,
      createdFields: [],
      existingFields: new Set()
    };
  }

  const existing = new Set((table.fields || []).map(f => normalizeText(f?.name)).filter(Boolean));
  const createdFields = [];
  if (!dryRun) {
    for (const fieldName of UPSERT_FIELDS) {
      if (existing.has(fieldName)) continue;
      await schemaService.createField(table.id, { name: fieldName, type: 'multilineText' });
      existing.add(fieldName);
      createdFields.push(fieldName);
    }
  }

  return {
    tableId: normalizeText(table.id),
    createdTable,
    createdFields,
    existingFields: existing
  };
}

function stringifyAspects(aspects = {}) {
  if (!aspects || typeof aspects !== 'object') return '';
  try {
    return JSON.stringify(aspects);
  } catch (_) {
    return '';
  }
}

function toQuantityText(item = {}) {
  return normalizeText(
    item?.availability?.shipToLocationAvailability?.quantity ||
      item?.availability?.pickupAtLocationAvailability?.[0]?.quantity ||
      ''
  );
}

function toCategoryText(item = {}, offer = {}) {
  return normalizeText(
    offer?.categoryId ||
      item?.product?.categoryId ||
      ''
  );
}

function buildUpsertFields(item = {}, offer = {}, environment = 'sandbox', hasIpnField = false) {
  const sku = normalizeText(item?.sku);
  const listingId = normalizeText(offer?.listingId);
  const offerId = normalizeText(offer?.offerId);
  const title = normalizeText(item?.product?.title);
  const description = normalizeText(item?.product?.description || item?.conditionDescription);
  const quantity = toQuantityText(item);
  const price = normalizeText(offer?.price);
  const currency = normalizeText(offer?.currency);
  const categoryId = toCategoryText(item, offer);
  const recordKey = normalizeText(
    listingId ? `${environment.toUpperCase()}-ITEM-${listingId}` : `${environment.toUpperCase()}-SKU-${sku}`
  );
  if (!recordKey) return null;

  const fields = {
    [PRIMARY_KEY_FIELD]: recordKey,
    SKU: sku,
    'Item ID': listingId,
    'Offer ID': offerId,
    'Product Title(New)': title,
    Description: description,
    'Item Specifics': stringifyAspects(item?.product?.aspects || {}),
    Quantity: quantity,
    Price: price,
    Currency: currency,
    'eBay Category ID': categoryId,
    Source: 'eBay Inventory API',
    'eBay Environment': environment,
    'Last Synced At': new Date().toISOString()
  };
  if (hasIpnField && sku) {
    fields[IPN_FIELD] = sku;
  }
  return fields;
}

async function flushBatch(airtableService, tableName, rows = [], summary = {}, dryRun = true) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  if (dryRun) {
    summary.recordsPlanned += rows.length;
    return;
  }
  const data = await airtableService.request('PATCH', `/${encodeURIComponent(tableName)}`, {
    data: {
      records: rows,
      typecast: true,
      performUpsert: {
        fieldsToMergeOn: [PRIMARY_KEY_FIELD]
      }
    }
  });
  const written = Array.isArray(data?.records) ? data.records.length : 0;
  summary.recordsWritten += written;
}

async function runEbaySandboxInventoryImport(options = {}, progressCallback = () => {}) {
  const stored = getInventoryConfig('phase2Config') || {};
  const runOptions = { ...stored, ...options };
  const environment = normalizeEnvironment(runOptions.phase5EbayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox');
  const dryRun =
    typeof runOptions.ebaySandboxDryRun === 'boolean'
      ? runOptions.ebaySandboxDryRun
      : true;
  const tableName = normalizeText(
    runOptions.ebaySandboxTableName ||
      runOptions.phase5ListingsTable ||
      runOptions.ebayMockTableName ||
      DEFAULT_TABLE_NAME
  );
  const fetchLimit = toNumber(
    runOptions.ebaySandboxFetchLimit || process.env.EBAY_SANDBOX_FETCH_LIMIT || DEFAULT_FETCH_LIMIT,
    DEFAULT_FETCH_LIMIT,
    1,
    5000
  );
  const pageSize = toNumber(
    runOptions.ebaySandboxPageSize || process.env.EBAY_SANDBOX_PAGE_SIZE || DEFAULT_PAGE_SIZE,
    DEFAULT_PAGE_SIZE,
    1,
    200
  );
  const airtableToken = normalizeText(runOptions.airtableToken || process.env.AIRTABLE_TOKEN || '');
  const airtableBaseId = normalizeText(runOptions.airtableBaseId || process.env.AIRTABLE_BASE_ID || '');
  const clientId = normalizeText(runOptions.phase5EbayClientId || process.env.EBAY_CLIENT_ID || '');
  const devId = normalizeText(runOptions.phase5EbayDevId || process.env.EBAY_DEV_ID || '');
  const clientSecret = normalizeText(runOptions.phase5EbayClientSecret || process.env.EBAY_CLIENT_SECRET || '');
  const ruName = normalizeText(runOptions.phase5EbayRuName || process.env.EBAY_RUNAME || '');

  if (!airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (!airtableBaseId) throw new Error('Missing AIRTABLE_BASE_ID.');
  if (!clientId) throw new Error('Missing eBay App ID / Client ID.');
  if (!devId) throw new Error('Missing eBay Dev ID.');
  if (!clientSecret) throw new Error('Missing eBay Cert ID / Client Secret.');
  if (!ruName) throw new Error('Missing eBay RuName.');

  const summary = {
    dryRun,
    environment,
    tableName,
    fetchLimit,
    pageSize,
    inventoryItemsFetched: 0,
    offersFetched: 0,
    recordsPlanned: 0,
    recordsWritten: 0,
    skippedInvalidRows: 0,
    fieldsCreated: 0,
    tableCreated: false,
    errors: []
  };

  emitProgress(progressCallback, {
    stage: 'ebaysandbox_auth',
    percent: 5,
    counts: summary,
    message: `Authenticating with eBay ${environment}...`
  });

  const httpClient = axios.create({ timeout: 30000 });
  const accessToken = await requestAccessToken(httpClient, {
    environment,
    clientId,
    clientSecret
  });

  emitProgress(progressCallback, {
    stage: 'ebaysandbox_fetch_items',
    percent: 20,
    counts: summary,
    message: `Fetching inventory items from eBay ${environment}...`
  });
  const inventoryItems = await fetchInventoryItems(
    httpClient,
    { environment, fetchLimit, pageSize },
    accessToken,
    summary,
    progressCallback
  );

  emitProgress(progressCallback, {
    stage: 'ebaysandbox_fetch_offers',
    percent: 56,
    counts: summary,
    message: `Fetching offers from eBay ${environment}...`
  });
  const offersBySku = await fetchOfferIndex(
    httpClient,
    { environment, fetchLimit, pageSize },
    accessToken,
    summary,
    progressCallback
  );

  emitProgress(progressCallback, {
    stage: 'ebaysandbox_prepare_table',
    percent: 70,
    counts: summary,
    message: `Ensuring Airtable table '${tableName}'...`
  });
  const schemaService = new AirtableSchemaService({ token: airtableToken, baseId: airtableBaseId });
  const ensure = await ensureTableAndFields(schemaService, tableName, dryRun);
  summary.tableCreated = Boolean(ensure.createdTable || ensure.tableId);
  summary.fieldsCreated = Array.isArray(ensure.createdFields) ? ensure.createdFields.length : 0;
  const hasIpnField = ensure.existingFields.has(IPN_FIELD);

  const airtableService = new AirtableService({ token: airtableToken, baseId: airtableBaseId });
  const records = [];
  for (let i = 0; i < inventoryItems.length; i += 1) {
    const item = inventoryItems[i] || {};
    const sku = normalizeText(item?.sku);
    const offer = sku ? offersBySku.get(sku) || {} : {};
    const fields = buildUpsertFields(item, offer, environment, hasIpnField);
    if (!fields) {
      summary.skippedInvalidRows += 1;
      continue;
    }
    records.push({ fields });

    if (records.length >= BATCH_SIZE) {
      await flushBatch(airtableService, tableName, records.splice(0, records.length), summary, dryRun);
    }

    if (i === 0 || (i + 1) % 25 === 0 || i + 1 === inventoryItems.length) {
      emitProgress(progressCallback, {
        stage: 'ebaysandbox_import_rows',
        percent: Math.min(96, 72 + Math.floor(((i + 1) / Math.max(1, inventoryItems.length)) * 24)),
        counts: summary,
        message:
          `Importing rows ${i + 1}/${inventoryItems.length} ` +
          `(planned=${summary.recordsPlanned}, written=${summary.recordsWritten}, skipped=${summary.skippedInvalidRows})`
      });
    }
  }

  if (records.length > 0) {
    await flushBatch(airtableService, tableName, records.splice(0, records.length), summary, dryRun);
  }

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: summary,
    message: `eBay ${environment} inventory import completed (${dryRun ? 'dry run' : 'write run'}).`
  });
  return summary;
}

module.exports = {
  runEbaySandboxInventoryImport
};
