const axios = require('axios');
const { loadEnv } = require('../config/loadEnv');
const AirtableService = require('../services/airtableService');
const AirtableSchemaService = require('../services/airtableSchemaService');
const { getInventoryConfig, saveInventoryConfig } = require('../config/configStore');

loadEnv();

const DEFAULT_TABLE_NAME = 'eBay Listings (API)';
const DEFAULT_FETCH_LIMIT = 200;
const DEFAULT_PAGE_SIZE = 100;
const BATCH_SIZE = 10;
const USER_ACCESS_TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const PRIMARY_KEY_FIELD = 'eBay Item ID';
const LEGACY_PRIMARY_KEY_FIELD = 'Record Key';
const LEGACY_MOCK_TABLE_NAME = 'eBay Listings (API) (Mock)';
const IPN_FIELD = 'c: partshunter203 ebay MOTORS interchange part number';
const MPN_FIELD = 'c: partshunter203 ebay MOTORS manufacturer part number';
const PART_NUMBER_FIELD = 'c: partshunter203 ebay MOTORS part number';
const ECOMMERCE_DESC_FIELD = 'c: partshunter203 ebay MOTORS e commerce description';

const UPSERT_FIELDS = [
  PRIMARY_KEY_FIELD,
  'Title',
  'SKU',
  'Listing Date',
  'IPN (Interchange Part Number)',
  'eBay Category_ID',
  'VIN Number',
  'Item Description',
  'Full listing description HTML',
  'SEO Keywords',
  'Promoted Rate',
  'Package Length',
  'Package Width',
  'Package Height',
  'Package Weight',
  'Package Weight Unit',
  'Condition',
  'Warranty',
  'Brand',
  'Item Specifics - All C: values relevant to item',
  ECOMMERCE_DESC_FIELD,
  'Item ID',
  'Offer ID',
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

const EBAY_INVENTORY_SCOPE_CANDIDATES = [
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.inventory'
];

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeOAuthToken(value) {
  return normalizeText(value)
    .replace(/^bearer\s+/i, '')
    .replace(/^['"]+|['"]+$/g, '');
}

function parseEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  const text = normalizeText(value);
  if (!text) return 0;
  if (/^\d+$/.test(text)) {
    const asNum = Number(text);
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum < 1000000000000 ? asNum * 1000 : asNum;
    }
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeFieldKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeEnvironment(value) {
  return normalizeText(value).toLowerCase() === 'production' ? 'production' : 'sandbox';
}

function normalizeSandboxTableName(value) {
  const text = normalizeText(value);
  if (!text) return DEFAULT_TABLE_NAME;
  return text.toLowerCase() === LEGACY_MOCK_TABLE_NAME.toLowerCase()
    ? DEFAULT_TABLE_NAME
    : text;
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
  const authHeader = normalizeText(error?.response?.headers?.['www-authenticate'] || '');
  if (status === 400 && String(data?.error || '').trim().toLowerCase() === 'invalid_scope') {
    return (
      'HTTP 400: invalid_scope. Sell Inventory endpoint requires a user token scope. ' +
      'Use a sandbox user access token (phase5EbayUserAccessToken / EBAY_USER_ACCESS_TOKEN) or configure OAuth authorization-code flow.'
    );
  }
  if (status === 401) {
    const authDetail = authHeader ? ` (${authHeader})` : '';
    return (
      `HTTP 401: Unauthorized eBay access token${authDetail}. ` +
      'Token is invalid/expired or environment does not match. ' +
      'Set sandbox user token + refresh token and let app auto-refresh before import.'
    );
  }
  const detail =
    (Array.isArray(data?.errors) && data.errors.length > 0
      ? data.errors
          .map(err => normalizeText(err?.message || err?.longMessage || err?.errorId || ''))
          .filter(Boolean)
          .join(' | ')
      : '') ||
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

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  let lastScopeError = null;

  for (const scope of EBAY_INVENTORY_SCOPE_CANDIDATES) {
    const body = new URLSearchParams();
    body.append('grant_type', 'client_credentials');
    body.append('scope', scope);

    try {
      const response = await client.post(getIdentityTokenUrl(config.environment), body.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`
        }
      });
      const token = normalizeText(response?.data?.access_token);
      if (!token) throw new Error('eBay OAuth token response did not include access_token.');
      return token;
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      const code = String(error?.response?.data?.error || '').trim().toLowerCase();
      if (status === 400 && code === 'invalid_scope') {
        lastScopeError = error;
        continue;
      }
      throw error;
    }
  }

  if (lastScopeError) throw lastScopeError;
  throw new Error('eBay OAuth token request failed for all supported inventory scopes.');
}

async function requestUserAccessTokenFromRefreshToken(client, config = {}) {
  const environment = normalizeEnvironment(config.environment);
  const clientId = normalizeText(config.clientId);
  const clientSecret = normalizeText(config.clientSecret);
  const refreshToken = normalizeOAuthToken(config.refreshToken);
  const scope = normalizeText(config.scope || '');

  if (!clientId) throw new Error('Missing eBay App ID / Client ID for refresh_token flow.');
  if (!clientSecret) throw new Error('Missing eBay Cert ID / Client Secret for refresh_token flow.');
  if (!refreshToken) throw new Error('Missing eBay Refresh Token.');

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams();
  body.append('grant_type', 'refresh_token');
  body.append('refresh_token', refreshToken);
  if (scope) {
    body.append('scope', scope);
  }

  const response = await client.post(getIdentityTokenUrl(environment), body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`
    }
  });
  const accessToken = normalizeOAuthToken(response?.data?.access_token);
  const tokenType = normalizeText(response?.data?.token_type || '');
  const expiresIn = Number(response?.data?.expires_in || 0) || 0;
  if (!accessToken) throw new Error('eBay refresh_token response did not include access_token.');
  return {
    accessToken,
    tokenType,
    expiresIn,
    issuedAtMs: Date.now()
  };
}

async function resolveUserAccessToken(client, config = {}, progressCallback = () => {}) {
  const environment = normalizeEnvironment(config.environment);
  const existingToken = normalizeOAuthToken(config.userAccessToken);
  const refreshToken = normalizeOAuthToken(config.refreshToken);
  const issuedAtMs = parseEpochMs(config.userAccessTokenIssuedAt);
  const tokenAgeMs = issuedAtMs > 0 ? Math.max(0, Date.now() - issuedAtMs) : Number.MAX_SAFE_INTEGER;
  const tokenFresh = Boolean(existingToken) && issuedAtMs > 0 && tokenAgeMs < USER_ACCESS_TOKEN_MAX_AGE_MS;
  const canRefresh = Boolean(refreshToken && config.clientId && config.clientSecret);

  if (tokenFresh) {
    return {
      accessToken: existingToken,
      authMode: 'user_access_token',
      refreshed: false,
      issuedAtMs
    };
  }

  if (canRefresh) {
    emitProgress(progressCallback, {
      stage: 'ebaysandbox_auth',
      percent: 7,
      counts: null,
      message: `Refreshing eBay ${environment} user access token from refresh token...`
    });

    const refreshed = await requestUserAccessTokenFromRefreshToken(client, {
      environment,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken,
      scope: config.refreshScope
    });

    const stored = getInventoryConfig('phase2Config') || {};
    saveInventoryConfig('phase2Config', {
      ...stored,
      phase5EbayEnvironment: environment,
      phase5EbayUserAccessToken: refreshed.accessToken,
      phase5EbayUserAccessTokenIssuedAt: new Date(refreshed.issuedAtMs).toISOString(),
      phase5EbayUserAccessTokenExpiresIn: refreshed.expiresIn,
      phase5EbayRefreshToken: refreshToken
    });

    return {
      accessToken: refreshed.accessToken,
      authMode: 'refresh_token',
      refreshed: true,
      issuedAtMs: refreshed.issuedAtMs,
      expiresIn: refreshed.expiresIn,
      tokenType: refreshed.tokenType
    };
  }

  if (existingToken) {
    return {
      accessToken: existingToken,
      authMode: 'user_access_token',
      refreshed: false,
      issuedAtMs: issuedAtMs || 0
    };
  }

  return {
    accessToken: '',
    authMode: 'client_credentials',
    refreshed: false,
    issuedAtMs: 0
  };
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

async function fetchOfferIndex(
  client,
  config = {},
  accessToken = '',
  summary = {},
  progressCallback = () => {},
  skus = []
) {
  const offersBySku = new Map();
  const pageSize = toNumber(config.pageSize, 25, 1, 25);
  const fetchLimit = toNumber(config.fetchLimit, DEFAULT_FETCH_LIMIT, 1, 5000);
  const base = getSellApiBase(config.environment);
  let seen = 0;
  const uniqueSkus = Array.from(new Set((Array.isArray(skus) ? skus : []).map(normalizeText).filter(Boolean))).slice(0, fetchLimit);
  if (uniqueSkus.length === 0) {
    return offersBySku;
  }

  for (let i = 0; i < uniqueSkus.length; i += 1) {
    const sku = uniqueSkus[i];
    let offset = 0;

    while (true) {
      try {
        const response = await client.get(`${base}/sell/inventory/v1/offer`, {
          params: { sku, limit: pageSize, offset },
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
          const offerSku = normalizeText(offer?.sku || sku);
          if (!offerSku) continue;
          const nextValue = {
            offerId: normalizeText(offer?.offerId),
            listingId: pickListingId(offer),
            price: pickPriceValue(offer),
            currency: pickPriceCurrency(offer),
            categoryId: pickCategoryId(offer)
          };
          const prev = offersBySku.get(offerSku);
          if (!prev) {
            offersBySku.set(offerSku, nextValue);
            continue;
          }
          if (!prev.listingId && nextValue.listingId) prev.listingId = nextValue.listingId;
          if (!prev.offerId && nextValue.offerId) prev.offerId = nextValue.offerId;
          if (!prev.price && nextValue.price) prev.price = nextValue.price;
          if (!prev.currency && nextValue.currency) prev.currency = nextValue.currency;
          if (!prev.categoryId && nextValue.categoryId) prev.categoryId = nextValue.categoryId;
          offersBySku.set(offerSku, prev);
        }

        const count = toNumber(data.count, offers.length, 0, Number.MAX_SAFE_INTEGER);
        const total = toNumber(data.total, 0, 0, Number.MAX_SAFE_INTEGER);
        offset += Math.max(count, offers.length);
        if (total > 0 && offset >= total) break;
        if (offers.length < pageSize) break;
      } catch (error) {
        const status = Number(error?.response?.status || 0);
        if (status === 404) break;
        throw error;
      }
    }

    summary.offersFetched = seen;
    emitProgress(progressCallback, {
      stage: 'ebaysandbox_fetch_offers',
      percent: Math.min(68, 56 + Math.floor(((i + 1) / Math.max(1, uniqueSkus.length)) * 12)),
      counts: summary,
      message: `Fetched offers for ${i + 1}/${uniqueSkus.length} SKU(s); offers=${seen}, mapped SKUs=${offersBySku.size}.`
    });
  }

  return offersBySku;
}

async function ensureTableAndFields(schemaService, tableName = '', dryRun = true) {
  const tables = await schemaService.listTables();
  let table = (tables || []).find(t => normalizeText(t?.name).toLowerCase() === tableName.toLowerCase());

  if (!table) {
    return {
      tableId: '',
      createdTable: false,
      createdFields: [],
      existingFields: new Set()
    };
  }

  const existing = new Set((table.fields || []).map(f => normalizeText(f?.name)).filter(Boolean));

  return {
    tableId: normalizeText(table.id),
    createdTable: false,
    createdFields: [],
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

function getAspectValues(aspects = {}, keys = []) {
  if (!aspects || typeof aspects !== 'object') return [];
  const entries = Object.entries(aspects);
  for (const key of keys) {
    const target = normalizeText(key).toLowerCase();
    if (!target) continue;
    const match = entries.find(([name]) => normalizeText(name).toLowerCase() === target);
    if (!match) continue;
    const raw = match[1];
    if (Array.isArray(raw)) {
      return raw.map(value => normalizeText(value)).filter(Boolean);
    }
    const text = normalizeText(raw);
    return text ? [text] : [];
  }
  return [];
}

function firstAspectValue(aspects = {}, keys = []) {
  const values = getAspectValues(aspects, keys);
  return values.length > 0 ? values[0] : '';
}

function toCSpecificsText(aspects = {}, manufacturerPart = '', interchangePart = '', partNumber = '') {
  const out = {};
  for (const [name, raw] of Object.entries(aspects || {})) {
    if (!/^c:/i.test(normalizeText(name))) continue;
    if (Array.isArray(raw)) {
      const vals = raw.map(v => normalizeText(v)).filter(Boolean);
      if (vals.length > 0) out[name] = vals;
      continue;
    }
    const text = normalizeText(raw);
    if (text) out[name] = [text];
  }

  if (manufacturerPart && !out[MPN_FIELD]) out[MPN_FIELD] = [manufacturerPart];
  if (interchangePart && !out[IPN_FIELD]) out[IPN_FIELD] = [interchangePart];
  if (partNumber && !out[PART_NUMBER_FIELD]) out[PART_NUMBER_FIELD] = [partNumber];

  if (Object.keys(out).length === 0) return '';
  try {
    return JSON.stringify(out);
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

function toDimensionText(item = {}, key = '') {
  return normalizeText(item?.packageWeightAndSize?.dimensions?.[key] || '');
}

function toWeightValueText(item = {}) {
  return normalizeText(item?.packageWeightAndSize?.weight?.value || '');
}

function toWeightUnitText(item = {}) {
  return normalizeText(item?.packageWeightAndSize?.weight?.unit || '');
}

function buildSeoKeywords(parts = []) {
  return Array.from(new Set((Array.isArray(parts) ? parts : []).map(v => normalizeText(v)).filter(Boolean))).join(', ');
}

function extractUnknownFieldNames(error) {
  const names = new Set();
  const addFromText = value => {
    const text = normalizeText(value);
    if (!text) return;
    const re = /Unknown field name:\s*"([^"]+)"/gi;
    let match = re.exec(text);
    while (match) {
      const name = normalizeText(match[1]);
      if (name) names.add(name);
      match = re.exec(text);
    }
  };

  const data = error?.response?.data;
  if (Array.isArray(data?.errors)) {
    for (const item of data.errors) {
      addFromText(item?.message);
      addFromText(item?.longMessage);
    }
  }
  if (data && typeof data.error === 'object') {
    addFromText(data?.error?.message);
    addFromText(data?.error?.type);
  } else {
    addFromText(data?.error);
  }
  addFromText(data?.message);
  addFromText(error?.message);
  return Array.from(names);
}

function removeUnknownFieldsFromRows(rows = [], unknownNames = []) {
  const targetNames = new Set((Array.isArray(unknownNames) ? unknownNames : []).map(v => normalizeText(v)).filter(Boolean));
  if (targetNames.size === 0) return 0;
  const targetNorms = new Set(Array.from(targetNames).map(name => normalizeFieldKey(name)).filter(Boolean));
  let removedCount = 0;

  for (const row of rows) {
    const source = row?.fields && typeof row.fields === 'object' ? row.fields : {};
    const next = {};
    for (const [name, value] of Object.entries(source)) {
      const exactMatch = targetNames.has(name);
      const normMatch = targetNorms.has(normalizeFieldKey(name));
      if (exactMatch || normMatch) {
        removedCount += 1;
        continue;
      }
      next[name] = value;
    }
    row.fields = next;
  }
  return removedCount;
}

function alignFieldsToExisting(fields = {}, existingFields = new Set()) {
  const out = {};
  if (!(existingFields instanceof Set) || existingFields.size === 0) {
    return { ...fields };
  }
  const existingByNormalized = new Map();
  for (const name of existingFields) {
    const norm = normalizeFieldKey(name);
    if (!norm || existingByNormalized.has(norm)) continue;
    existingByNormalized.set(norm, name);
  }
  for (const [name, value] of Object.entries(fields || {})) {
    const norm = normalizeFieldKey(name);
    const resolved = existingFields.has(name)
      ? name
      : (existingByNormalized.get(norm) || '');
    if (!resolved) continue;
    out[resolved] = value;
  }
  const primaryNorm = normalizeFieldKey(PRIMARY_KEY_FIELD);
  const existingPrimaryField = existingByNormalized.get(primaryNorm) || '';
  if (existingPrimaryField && fields[PRIMARY_KEY_FIELD] && !Object.prototype.hasOwnProperty.call(out, existingPrimaryField)) {
    out[existingPrimaryField] = fields[PRIMARY_KEY_FIELD];
  }
  if (!existingPrimaryField && fields[PRIMARY_KEY_FIELD] && !Object.prototype.hasOwnProperty.call(out, PRIMARY_KEY_FIELD)) {
    out[PRIMARY_KEY_FIELD] = fields[PRIMARY_KEY_FIELD];
  }
  return out;
}

function buildUpsertFields(
  item = {},
  offer = {},
  environment = 'sandbox',
  hasIpnField = false,
  hasLegacyPrimaryField = false,
  existingFieldNames = new Set()
) {
  const sku = normalizeText(item?.sku);
  const aspects = item?.product?.aspects || {};
  const listingId = normalizeText(offer?.listingId);
  const offerId = normalizeText(offer?.offerId);
  const title = normalizeText(item?.product?.title);
  const description = normalizeText(item?.product?.description || item?.conditionDescription);
  const quantity = toQuantityText(item);
  const price = normalizeText(offer?.price);
  const currency = normalizeText(offer?.currency);
  const categoryId = toCategoryText(item, offer);
  const manufacturerPart = firstAspectValue(aspects, ['Manufacturer Part Number', MPN_FIELD, 'MPN']);
  const interchangePart = firstAspectValue(aspects, ['Interchange Part Number', IPN_FIELD, 'IPN']);
  const partNumber = firstAspectValue(aspects, ['Part Number', PART_NUMBER_FIELD, 'Manufacturer Part Number', 'MPN']);
  const warranty = firstAspectValue(aspects, ['Warranty']);
  const brand = firstAspectValue(aspects, ['Brand']);
  const vin = firstAspectValue(aspects, ['VIN #', 'VIN Number', 'VIN']);
  const condition = normalizeText(item?.condition);
  const packageLength = toDimensionText(item, 'length');
  const packageWidth = toDimensionText(item, 'width');
  const packageHeight = toDimensionText(item, 'height');
  const packageWeight = toWeightValueText(item);
  const packageWeightUnit = toWeightUnitText(item);
  const itemSpecificsText = stringifyAspects(aspects);
  const cSpecificsText = toCSpecificsText(aspects, manufacturerPart, interchangePart, partNumber);
  const seoKeywords = buildSeoKeywords([brand, manufacturerPart, interchangePart, partNumber]);
  const listingDate = new Date().toISOString();
  const primaryId = normalizeText(
    listingId || `${environment.toUpperCase()}-SKU-${sku}`
  );
  if (!primaryId) return null;

  const fields = {
    [PRIMARY_KEY_FIELD]: primaryId,
    Title: title,
    SKU: sku,
    'Listing Date': listingDate,
    'IPN (Interchange Part Number)': interchangePart,
    'eBay Category_ID': categoryId,
    'VIN Number': vin,
    'Item Description': description,
    'Full listing description HTML': description,
    'SEO Keywords': seoKeywords,
    'Promoted Rate': '',
    'Package Length': packageLength,
    'Package Width': packageWidth,
    'Package Height': packageHeight,
    'Package Weight': packageWeight,
    'Package Weight Unit': packageWeightUnit,
    Condition: condition,
    Warranty: warranty,
    Brand: brand,
    'Item Specifics - All C: values relevant to item': cSpecificsText,
    [ECOMMERCE_DESC_FIELD]: description,
    'Item ID': listingId,
    'Offer ID': offerId,
    Description: description,
    'Item Specifics': itemSpecificsText,
    Quantity: quantity,
    Price: price,
    Currency: currency,
    'eBay Category ID': categoryId,
    Source: 'eBay Inventory API',
    'eBay Environment': environment,
    'Last Synced At': new Date().toISOString()
  };
  if (hasLegacyPrimaryField) {
    fields[LEGACY_PRIMARY_KEY_FIELD] = primaryId;
  }
  if (hasIpnField && interchangePart) {
    fields[IPN_FIELD] = interchangePart;
  } else if (hasIpnField && sku) {
    fields[IPN_FIELD] = sku;
  }
  if (manufacturerPart) {
    fields[MPN_FIELD] = manufacturerPart;
  }
  if (partNumber) {
    fields[PART_NUMBER_FIELD] = partNumber;
  }
  return alignFieldsToExisting(fields, existingFieldNames);
}

async function flushBatch(airtableService, tableName, rows = [], summary = {}, dryRun = true) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  if (dryRun) {
    summary.recordsPlanned += rows.length;
    return;
  }
  const payloadRows = rows.map(row => ({ fields: { ...(row?.fields || {}) } }));
  const skippedUnknown = new Set();
  let attempts = 0;

  while (true) {
    try {
      const data = await airtableService.request('PATCH', `/${encodeURIComponent(tableName)}`, {
        data: {
          records: payloadRows,
          typecast: true,
          performUpsert: {
            fieldsToMergeOn: [PRIMARY_KEY_FIELD]
          }
        }
      });
      const written = Array.isArray(data?.records) ? data.records.length : 0;
      summary.recordsWritten += written;
      if (skippedUnknown.size > 0) {
        summary.errors.push(
          `Skipped unknown Airtable field(s): ${Array.from(skippedUnknown).join(', ')}`
        );
      }
      return;
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      const unknownFields = extractUnknownFieldNames(error);
      if (status !== 422 || unknownFields.length === 0) {
        throw error;
      }
      const removed = removeUnknownFieldsFromRows(payloadRows, unknownFields);
      if (removed === 0 || attempts >= 6) {
        throw error;
      }
      unknownFields.forEach(name => skippedUnknown.add(name));
      attempts += 1;
    }
  }
}

async function runEbaySandboxInventoryImport(options = {}, progressCallback = () => {}) {
  const stored = getInventoryConfig('phase2Config') || {};
  const runOptions = { ...stored, ...options };
  const environment = normalizeEnvironment(runOptions.phase5EbayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox');
  const dryRun =
    typeof runOptions.ebaySandboxDryRun === 'boolean'
      ? runOptions.ebaySandboxDryRun
      : true;
  const tableName = normalizeSandboxTableName(runOptions.ebaySandboxTableName || DEFAULT_TABLE_NAME);
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
  const userAccessToken = normalizeOAuthToken(
    runOptions.phase5EbayUserAccessToken || process.env.EBAY_USER_ACCESS_TOKEN || ''
  );
  const refreshToken = normalizeOAuthToken(
    runOptions.phase5EbayRefreshToken || process.env.EBAY_REFRESH_TOKEN || ''
  );
  const userAccessTokenIssuedAt = normalizeText(
    runOptions.phase5EbayUserAccessTokenIssuedAt ||
      runOptions.phase5EbayAccessTokenIssuedAt ||
      process.env.EBAY_USER_ACCESS_TOKEN_ISSUED_AT ||
      ''
  );
  const refreshScope = normalizeText(
    runOptions.phase5EbayRefreshScope || process.env.EBAY_REFRESH_SCOPE || ''
  );

  if (!airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (!airtableBaseId) throw new Error('Missing AIRTABLE_BASE_ID.');
  if (refreshToken && (!clientId || !clientSecret)) {
    throw new Error('Refresh-token auth requires eBay App ID (Client ID) and eBay Cert ID (Client Secret).');
  }
  if (!userAccessToken && !refreshToken) {
    if (!clientId) throw new Error('Missing eBay App ID / Client ID.');
    if (!devId) throw new Error('Missing eBay Dev ID.');
    if (!clientSecret) throw new Error('Missing eBay Cert ID / Client Secret.');
    if (!ruName) throw new Error('Missing eBay RuName.');
  }

  const summary = {
    dryRun,
    environment,
    authMode: userAccessToken || refreshToken ? 'user_access_token' : 'client_credentials',
    userTokenRefreshed: false,
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
    message: userAccessToken || refreshToken
      ? `Resolving eBay ${environment} user access token...`
      : `Authenticating with eBay ${environment}...`
  });

  const httpClient = axios.create({ timeout: 30000 });
  const tokenResolution = await resolveUserAccessToken(
    httpClient,
    {
      environment,
      clientId,
      clientSecret,
      userAccessToken,
      refreshToken,
      userAccessTokenIssuedAt,
      refreshScope
    },
    progressCallback
  );
  let accessToken = tokenResolution.accessToken;
  summary.authMode = tokenResolution.authMode || summary.authMode;
  summary.userTokenRefreshed = tokenResolution.refreshed === true;
  if (!accessToken) {
    accessToken = await requestAccessToken(httpClient, {
      environment,
      clientId,
      clientSecret
    });
    summary.authMode = 'client_credentials';
    summary.userTokenRefreshed = false;
  }
  let activeAccessToken = accessToken;

  emitProgress(progressCallback, {
    stage: 'ebaysandbox_fetch_items',
    percent: 20,
    counts: summary,
    message: `Fetching inventory items from eBay ${environment}...`
  });
  let inventoryItems = [];
  try {
    inventoryItems = await fetchInventoryItems(
      httpClient,
      { environment, fetchLimit, pageSize },
      activeAccessToken,
      summary,
      progressCallback
    );
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    const canRefresh = Boolean(refreshToken && clientId && clientSecret);
    if (!(status === 401 && canRefresh)) {
      throw error;
    }
    emitProgress(progressCallback, {
      stage: 'ebaysandbox_auth',
      percent: 9,
      counts: summary,
      message: `Access token rejected by eBay ${environment}; refreshing token and retrying...`
    });
    const refreshed = await requestUserAccessTokenFromRefreshToken(httpClient, {
      environment,
      clientId,
      clientSecret,
      refreshToken,
      scope: refreshScope
    });
    const stored = getInventoryConfig('phase2Config') || {};
    saveInventoryConfig('phase2Config', {
      ...stored,
      phase5EbayEnvironment: environment,
      phase5EbayUserAccessToken: refreshed.accessToken,
      phase5EbayUserAccessTokenIssuedAt: new Date(refreshed.issuedAtMs).toISOString(),
      phase5EbayUserAccessTokenExpiresIn: refreshed.expiresIn,
      phase5EbayRefreshToken: refreshToken
    });
    activeAccessToken = refreshed.accessToken;
    summary.authMode = 'refresh_token';
    summary.userTokenRefreshed = true;
    inventoryItems = await fetchInventoryItems(
      httpClient,
      { environment, fetchLimit, pageSize },
      activeAccessToken,
      summary,
      progressCallback
    );
  }

  emitProgress(progressCallback, {
    stage: 'ebaysandbox_fetch_offers',
    percent: 56,
    counts: summary,
    message: `Fetching offers from eBay ${environment}...`
  });
  const offersBySku = await fetchOfferIndex(
    httpClient,
    { environment, fetchLimit, pageSize },
    activeAccessToken,
    summary,
    progressCallback,
    inventoryItems.map(item => normalizeText(item?.sku))
  );

  emitProgress(progressCallback, {
    stage: 'ebaysandbox_prepare_table',
    percent: 70,
    counts: summary,
    message: `Ensuring Airtable table '${tableName}'...`
  });
  const schemaService = new AirtableSchemaService({ token: airtableToken, baseId: airtableBaseId });
  const ensure = await ensureTableAndFields(schemaService, tableName, dryRun);
  if (!ensure.tableId) {
    throw new Error(`Airtable table '${tableName}' not found. Create/select this table first.`);
  }
  if (!ensure.existingFields.has(PRIMARY_KEY_FIELD)) {
    throw new Error(
      `Airtable table '${tableName}' is missing required column '${PRIMARY_KEY_FIELD}'. Add it once, then re-run import.`
    );
  }
  summary.tableCreated = Boolean(ensure.createdTable);
  summary.fieldsCreated = Array.isArray(ensure.createdFields) ? ensure.createdFields.length : 0;
  const hasIpnField = ensure.existingFields.has(IPN_FIELD);
  const hasLegacyPrimaryField = ensure.existingFields.has(LEGACY_PRIMARY_KEY_FIELD);

  const airtableService = new AirtableService({ token: airtableToken, baseId: airtableBaseId });
  const records = [];
  for (let i = 0; i < inventoryItems.length; i += 1) {
    const item = inventoryItems[i] || {};
    const sku = normalizeText(item?.sku);
    const offer = sku ? offersBySku.get(sku) || {} : {};
    const fields = buildUpsertFields(
      item,
      offer,
      environment,
      hasIpnField,
      hasLegacyPrimaryField,
      ensure.existingFields
    );
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
