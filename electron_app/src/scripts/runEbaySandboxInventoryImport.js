const axios = require('axios');
const { loadEnv } = require('../config/loadEnv');
const AirtableService = require('../services/airtableService');
const AirtableSchemaService = require('../services/airtableSchemaService');
const { getInventoryConfig, saveInventoryConfig } = require('../config/configStore');
const {
  filterSpecificsByAllowlist,
  loadRulesLogicAllowlist,
  resolveRulesLogicTableName
} = require('../services/rulesLogicService');
const { asIdentitySet, isPublishedIdentity } = require('../services/phase5IdentityService');
const { Phase5PublishLogService } = require('../services/phase5PublishLogService');
const { buildListingPayloadHash, parseCsvList } = require('../services/phase5GovernanceService');

loadEnv();

const DEFAULT_TABLE_NAME = 'eBay Listings (API)';
const DEFAULT_FETCH_LIMIT = 200;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_FETCH_PAGING_MODE = 'first_page';
const BATCH_SIZE = 10;
const USER_ACCESS_TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const PRIMARY_KEY_FIELD = 'SKU';
const LEGACY_PRIMARY_KEY_FIELD = 'Record Key';
const LEGACY_MOCK_TABLE_NAME = 'eBay Listings (API) (Mock)';
const IPN_FIELD = 'c: partshunter203 ebay MOTORS interchange part number';
const MPN_FIELD = 'c: partshunter203 ebay MOTORS manufacturer part number';
const PART_NUMBER_FIELD = 'c: partshunter203 ebay MOTORS part number';
const ECOMMERCE_DESC_FIELD = 'c: partshunter203 ebay MOTORS e commerce description';
const PHASE74_ITEM_TITLE_FIELD = 'Item Title';
const PHASE74_ITEM_DESCRIPTION_FIELD = 'Item Description';
const RAW_ITEM_JSON_FIELD = 'Raw eBay Item JSON';
const RAW_OFFER_JSON_FIELD = 'Raw eBay Offer JSON';
const LISTING_STATUS_FIELD = 'Listing Status';
const MISSING_DETECTED_FIELD = 'Ended/Missing Detected At';
const ACTIVE_LISTING_STATUS_VALUE = 'Active';
const ENDED_LISTING_STATUS_VALUE = 'Ended';
const EBAY_TRADING_COMPATIBILITY_LEVEL = '1271';
const EBAY_TRADING_DEFAULT_SITE_ID = '0';

const UPSERT_FIELDS = [
  PRIMARY_KEY_FIELD,
  'Title',
  'Listing Date',
  'IPN (Interchange Part Number)',
  'eBay Category_ID',
  'VIN Number',
  'Full listing description HTML',
  'SEO Keywords',
  'Promoted Rate',
  'Package Length (ShipStation)',
  'Package Width (ShipStation)',
  'Package Height (ShipStation)',
  'Package Weight (ShipStation)',
  'Package Weight Unit',
  'Condition',
  'Condition ID',
  'Condition Display Name',
  'Warranty',
  'Brand',
  'Category Name',
  'Item Specifics - All C: values relevant to item',
  'Picture URLs',
  'Compatibility',
  'Shipping Package Details',
  'Return Policy',
  'Seller Profiles',
  ECOMMERCE_DESC_FIELD,
  RAW_ITEM_JSON_FIELD,
  RAW_OFFER_JSON_FIELD,
  'Item ID',
  'Offer ID',
  'Description',
  'Item Specifics',
  'Quantity',
  'Price',
  'Currency',
  'eBay Category ID',
  LISTING_STATUS_FIELD,
  'Source',
  'eBay Environment',
  MISSING_DETECTED_FIELD,
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

function parseJsonObject(value) {
  if (!value && value !== 0) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function parseRulesLogicPrefixFromIpn(value = '') {
  const text = normalizeText(value);
  if (!text) return '';
  const firstSegment = normalizeText(text.split('-')[0]);
  if (/^\d{3}$/.test(firstSegment)) return firstSegment;
  const match = text.match(/^(\d{3})/);
  return match && match[1] ? match[1] : firstSegment;
}

function buildFilteredSpecificsPayloads(itemSpecificsObject = {}, cSpecificsObject = {}, allowlistContext = null) {
  const filteredItem = filterSpecificsByAllowlist(itemSpecificsObject || {}, allowlistContext || new Map());
  const filteredC = filterSpecificsByAllowlist(cSpecificsObject || {}, allowlistContext || new Map());
  return {
    itemSpecifics: filteredItem.filtered || {},
    cSpecifics: filteredC.filtered || {},
    skippedNames: Array.from(new Set([...(filteredItem.skipped || []), ...(filteredC.skipped || [])]))
  };
}

function decodeXmlEntities(value = '') {
  const text = String(value || '');
  if (!text) return '';
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(value = '') {
  const cleaned = String(value || '')
    // XML 1.0 valid chars: tab, CR, LF, and #x20-#xD7FF, #xE000-#xFFFD
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, '');
  return cleaned
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toRegexTagName(tag = '') {
  return String(tag || '')
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTagValue(xml = '', tagName = '') {
  const source = String(xml || '');
  const tag = toRegexTagName(tagName);
  if (!source || !tag) return '';
  const match = source.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return decodeXmlEntities(match?.[1] || '');
}

function extractTagValues(xml = '', tagName = '') {
  const source = String(xml || '');
  const tag = toRegexTagName(tagName);
  if (!source || !tag) return [];
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let match = re.exec(source);
  while (match) {
    const next = decodeXmlEntities(match[1] || '');
    if (next) out.push(next);
    match = re.exec(source);
  }
  return out;
}

function extractTagBlocks(xml = '', tagName = '') {
  const source = String(xml || '');
  const tag = toRegexTagName(tagName);
  if (!source || !tag) return [];
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'gi');
  let match = re.exec(source);
  while (match) {
    out.push(String(match[0] || ''));
    match = re.exec(source);
  }
  return out;
}

function extractTagAttribute(xml = '', tagName = '', attributeName = '') {
  const source = String(xml || '');
  const tag = toRegexTagName(tagName);
  const attr = toRegexTagName(attributeName);
  if (!source || !tag || !attr) return '';
  const openTag = source.match(new RegExp(`<${tag}(\\s[^>]*)?>`, 'i'));
  const attrMatch = String(openTag?.[1] || '').match(new RegExp(`${attr}\\s*=\\s*"([^"]*)"`, 'i'));
  return decodeXmlEntities(attrMatch?.[1] || '');
}

function hasFieldByNormalizedName(existingFields = new Set(), fieldName = '') {
  if (!(existingFields instanceof Set)) return false;
  const target = normalizeFieldKey(fieldName);
  if (!target) return false;
  for (const name of existingFields) {
    if (normalizeFieldKey(name) === target) return true;
  }
  return false;
}

function resolvePrimaryKeyFromFields(fields = {}) {
  return normalizeText(
    fields[PRIMARY_KEY_FIELD] ||
      fields.SKU ||
      fields[LEGACY_PRIMARY_KEY_FIELD] ||
      fields['Record Key'] ||
      ''
  );
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

function normalizeDestinationMode(value, sourceEnvironment = 'sandbox') {
  const mode = normalizeText(value).toLowerCase();
  if (mode === 'sandbox' || mode === 'both' || mode === 'airtable') {
    return mode;
  }
  return normalizeEnvironment(sourceEnvironment) === 'production' ? 'sandbox' : 'airtable';
}

function normalizeFetchPagingMode(value = '') {
  const text = normalizeText(value).toLowerCase();
  if (text === 'continue' || text === 'continue_from_last_page' || text === 'resume') {
    return 'continue_from_last_page';
  }
  return DEFAULT_FETCH_PAGING_MODE;
}

function isActiveListingStatus(value = '') {
  const text = normalizeText(value).toLowerCase();
  return !text || text === 'active';
}

function isEndedListingStatus(value = '') {
  const text = normalizeText(value).toLowerCase();
  return text === 'ended' || text === 'completed' || text === 'deleted' || text === 'removed' || text === 'inactive';
}

const EBAY_CREDENTIAL_FIELDS = [
  'phase5EbayClientId',
  'phase5EbayDevId',
  'phase5EbayClientSecret',
  'phase5EbayRuName',
  'phase5EbayRefreshToken',
  'phase5EbayUserAccessToken',
  'phase5EbayRefreshScope',
  'phase5EbayUserAccessTokenIssuedAt'
];

function hasAnyEbayCredentialValue(value = {}) {
  if (!value || typeof value !== 'object') return false;
  return EBAY_CREDENTIAL_FIELDS.some(field => Boolean(normalizeText(value[field] || '')));
}

function applyEbayCredentialsForEnvironment(runOptions = {}, environment = 'sandbox') {
  const targetEnvironment = normalizeEnvironment(environment);
  const sets =
    runOptions.phase5EbayCredentialSets && typeof runOptions.phase5EbayCredentialSets === 'object'
      ? runOptions.phase5EbayCredentialSets
      : {};
  const activeSet =
    sets[targetEnvironment] && typeof sets[targetEnvironment] === 'object'
      ? sets[targetEnvironment]
      : {};

  if (!hasAnyEbayCredentialValue(activeSet)) {
    return {
      ...runOptions,
      phase5EbayEnvironment: targetEnvironment
    };
  }

  const next = {
    ...runOptions,
    phase5EbayEnvironment: targetEnvironment
  };
  for (const field of EBAY_CREDENTIAL_FIELDS) {
    next[field] = normalizeText(activeSet[field] || runOptions[field] || '');
  }
  return next;
}

function getNextFetchPageStateMap(runOptions = {}) {
  const raw = runOptions.ebaySandboxNextFetchPageByEnvironment;
  if (!raw || typeof raw !== 'object') {
    return { sandbox: 1, production: 1 };
  }
  const sandbox = Math.max(1, toPositiveInteger(raw.sandbox, 1, 1, 1000000));
  const production = Math.max(1, toPositiveInteger(raw.production, 1, 1, 1000000));
  return { sandbox, production };
}

function toNumber(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function delay(ms = 0) {
  const waitMs = Math.max(0, Number(ms) || 0);
  return new Promise(resolve => setTimeout(resolve, waitMs));
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
  if (status === 403) {
    return (
      'HTTP 403: Insufficient permissions. User token may not include required scope/permissions for this API. ' +
      'For production listing pulls, prefer Trading API mode with a seller user token.'
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

function getTradingApiUrl(environment = 'sandbox') {
  return environment === 'production'
    ? 'https://api.ebay.com/ws/api.dll'
    : 'https://api.sandbox.ebay.com/ws/api.dll';
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

  if (existingToken && (!canRefresh || tokenFresh)) {
    return {
      accessToken: existingToken,
      authMode: 'user_access_token',
      refreshed: false,
      issuedAtMs: issuedAtMs || 0,
      tokenFresh
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

function buildGetMyeBaySellingRequestXml({ entriesPerPage = 200, pageNumber = 1 } = {}) {
  const perPage = toNumber(entriesPerPage, 200, 1, 200);
  const page = toNumber(pageNumber, 1, 1, 1000000);
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">' +
    '<ActiveList>' +
    '<Include>true</Include>' +
    '<Pagination>' +
    `<EntriesPerPage>${escapeXml(String(perPage))}</EntriesPerPage>` +
    `<PageNumber>${escapeXml(String(page))}</PageNumber>` +
    '</Pagination>' +
    '</ActiveList>' +
    '<DetailLevel>ReturnAll</DetailLevel>' +
    '</GetMyeBaySellingRequest>'
  );
}

function parseTradingApiItems(responseXml = '') {
  const activeListBlock = extractTagBlocks(responseXml, 'ActiveList')[0] || responseXml;
  const itemArrayBlock = extractTagBlocks(activeListBlock, 'ItemArray')[0] || activeListBlock;
  const itemBlocks = extractTagBlocks(itemArrayBlock, 'Item');
  const out = [];

  for (const itemXml of itemBlocks) {
    const itemId = normalizeText(extractTagValue(itemXml, 'ItemID'));
    const sku = normalizeText(extractTagValue(itemXml, 'SKU') || extractTagValue(itemXml, 'CustomLabel') || itemId);
    if (!sku) continue;

    const aspects = {};
    for (const nv of extractTagBlocks(itemXml, 'NameValueList')) {
      const name = normalizeText(extractTagValue(nv, 'Name'));
      const values = extractTagValues(nv, 'Value').map(value => normalizeText(value)).filter(Boolean);
      if (name && values.length > 0) {
        aspects[name] = values;
      }
    }

    const priceBlock = extractTagBlocks(itemXml, 'CurrentPrice')[0] || '';
    const priceValue = normalizeText(extractTagValue(itemXml, 'CurrentPrice'));
    const currency = normalizeText(extractTagAttribute(priceBlock, 'CurrentPrice', 'currencyID'));
    const categoryId = normalizeText(extractTagValue(itemXml, 'CategoryID'));
    const quantity = normalizeText(extractTagValue(itemXml, 'Quantity'));
    const title = normalizeText(extractTagValue(itemXml, 'Title'));
    const description = normalizeText(extractTagValue(itemXml, 'Description'));
    const condition = normalizeText(extractTagValue(itemXml, 'ConditionDisplayName') || extractTagValue(itemXml, 'ConditionID'));
    const listingStatus = normalizeText(extractTagValue(itemXml, 'ListingStatus') || extractTagValue(itemXml, 'Status'));

    out.push({
      item: {
        sku,
        listingStatus: listingStatus || ACTIVE_LISTING_STATUS_VALUE,
        condition,
        conditionDescription: '',
        product: {
          title,
          description,
          aspects,
          categoryId
        },
        availability: {
          shipToLocationAvailability: {
            quantity
          }
        }
      },
      offer: {
        offerId: '',
        listingId: itemId,
        price: priceValue,
        currency,
        categoryId
      }
    });
  }

  return out;
}

function getTradingApiErrorText(responseXml = '', fallback = '') {
  const errors = [];
  for (const err of extractTagBlocks(responseXml, 'Errors')) {
    const longMessage = normalizeText(extractTagValue(err, 'LongMessage'));
    const shortMessage = normalizeText(extractTagValue(err, 'ShortMessage'));
    const code = normalizeText(extractTagValue(err, 'ErrorCode'));
    const detail = [code, longMessage || shortMessage].filter(Boolean).join(': ');
    if (detail) errors.push(detail);
  }
  if (errors.length > 0) return errors.join(' | ');
  return normalizeText(fallback || extractTagValue(responseXml, 'Message') || 'Trading API request failed.');
}

function getTradingApiErrorCode(responseXml = '') {
  const firstError = extractTagBlocks(responseXml, 'Errors')[0] || '';
  return normalizeText(extractTagValue(firstError, 'ErrorCode'));
}

function isTradingTokenValidationError(error) {
  const code = normalizeText(error?.code || '');
  if (code === '931') return true;
  const message = normalizeText(error?.message || '').toLowerCase();
  return message.includes('error 931') || message.includes('validation of the authentication token');
}

function isTradingInvalidIafTokenResponse(responseXml = '') {
  const code = normalizeText(getTradingApiErrorCode(responseXml));
  if (code === '931' || code === '21916984') return true;
  const message = normalizeText(getTradingApiErrorText(responseXml, '')).toLowerCase();
  return (
    message.includes('iaf token supplied is invalid') ||
    message.includes('auth token is invalid') ||
    message.includes('validation of the authentication token')
  );
}

function isRetryableTransportError(error) {
  const code = normalizeText(error?.code || '').toUpperCase();
  const message = normalizeText(error?.message || '').toLowerCase();
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED' || code === 'EPIPE') return true;
  return message.includes('socket hang up') || message.includes('network error');
}

function getTradingAck(responseXml = '') {
  return normalizeText(extractTagValue(responseXml, 'Ack'));
}

function isTradingAckSuccess(ack = '') {
  const normalized = normalizeText(ack).toLowerCase();
  return normalized === 'success' || normalized === 'warning';
}

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNameValueListBlock(parentXml = '') {
  const map = {};
  for (const block of extractTagBlocks(parentXml, 'NameValueList')) {
    const name = normalizeText(extractTagValue(block, 'Name'));
    if (!name) continue;
    const values = extractTagValues(block, 'Value').map(v => normalizeText(v)).filter(Boolean);
    if (values.length > 0) {
      map[name] = values;
    }
  }
  return map;
}

function parseBulkListingsFromGetMyeBaySellingResponse(responseXml = '') {
  const activeListBlock = extractTagBlocks(responseXml, 'ActiveList')[0] || responseXml;
  const itemArrayBlock = extractTagBlocks(activeListBlock, 'ItemArray')[0] || activeListBlock;
  const itemBlocks = extractTagBlocks(itemArrayBlock, 'Item');
  const out = [];

  for (const itemXml of itemBlocks) {
    const currentPrice =
      normalizeText(extractTagValue(itemXml, 'CurrentPrice')) ||
      normalizeText(extractTagValue(itemXml, 'ConvertedCurrentPrice'));
    out.push({
      ebayItemId: normalizeText(extractTagValue(itemXml, 'ItemID')),
      sku: normalizeText(extractTagValue(itemXml, 'SKU') || extractTagValue(itemXml, 'CustomLabel')),
      title: normalizeText(extractTagValue(itemXml, 'Title')),
      quantity: toNumberOrNull(extractTagValue(itemXml, 'Quantity')),
      quantityAvailable: toNumberOrNull(
        extractTagValue(itemXml, 'QuantityAvailableHint') || extractTagValue(itemXml, 'QuantityAvailable')
      ),
      currentPrice,
      listingStatus: normalizeText(
        extractTagValue(itemXml, 'ListingStatus') || extractTagValue(itemXml, 'Status')
      ),
      viewItemUrl: normalizeText(extractTagValue(itemXml, 'ViewItemURL')),
      galleryUrl: normalizeText(extractTagValue(itemXml, 'GalleryURL'))
    });
  }

  const totalPages = toNumber(extractTagValue(activeListBlock, 'TotalNumberOfPages'), 0, 0, 1000000);
  return {
    listings: out,
    totalPages
  };
}

function buildGetItemRequestXml(ebayItemId = '') {
  const itemId = normalizeText(ebayItemId);
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">' +
    `<ItemID>${escapeXml(itemId)}</ItemID>` +
    '<DetailLevel>ReturnAll</DetailLevel>' +
    '<IncludeItemSpecifics>true</IncludeItemSpecifics>' +
    '<IncludeItemCompatibilityList>true</IncludeItemCompatibilityList>' +
    '<IncludeWatchCount>true</IncludeWatchCount>' +
    '</GetItemRequest>'
  );
}

function parseItemCompatibility(itemXml = '') {
  const listBlock = extractTagBlocks(itemXml, 'ItemCompatibilityList')[0] || '';
  const compatBlocks = extractTagBlocks(listBlock, 'Compatibility');
  return compatBlocks.map(block => {
    const specifics = parseNameValueListBlock(block);
    return {
      compatibilityNotes: normalizeText(extractTagValue(block, 'CompatibilityNotes')),
      compatibilityNameValueList: specifics
    };
  });
}

function parseDeepListingFromGetItemResponse(responseXml = '') {
  const itemBlock = extractTagBlocks(responseXml, 'Item')[0] || '';
  const currentPriceBlock = extractTagBlocks(itemBlock, 'CurrentPrice')[0] || '';
  const price =
    normalizeText(extractTagValue(itemBlock, 'CurrentPrice')) ||
    normalizeText(extractTagValue(itemBlock, 'ConvertedCurrentPrice'));
  const primaryCategoryBlock = extractTagBlocks(itemBlock, 'PrimaryCategory')[0] || '';
  const pictureDetailsBlock = extractTagBlocks(itemBlock, 'PictureDetails')[0] || '';
  const itemSpecificsBlock = extractTagBlocks(itemBlock, 'ItemSpecifics')[0] || '';
  const shippingPackageDetailsBlock = extractTagBlocks(itemBlock, 'ShippingPackageDetails')[0] || '';
  const weightMajorBlock = extractTagBlocks(shippingPackageDetailsBlock, 'WeightMajor')[0] || '';
  const weightMinorBlock = extractTagBlocks(shippingPackageDetailsBlock, 'WeightMinor')[0] || '';
  const returnPolicyBlock = extractTagBlocks(itemBlock, 'ReturnPolicy')[0] || '';
  const sellerProfilesBlock = extractTagBlocks(itemBlock, 'SellerProfiles')[0] || '';

  return {
    ebayItemId: normalizeText(extractTagValue(itemBlock, 'ItemID')),
    sku: normalizeText(extractTagValue(itemBlock, 'SKU') || extractTagValue(itemBlock, 'CustomLabel')),
    title: normalizeText(extractTagValue(itemBlock, 'Title')),
    descriptionHtml: normalizeText(extractTagValue(itemBlock, 'Description')),
    categoryId: normalizeText(extractTagValue(primaryCategoryBlock, 'CategoryID') || extractTagValue(itemBlock, 'CategoryID')),
    categoryName: normalizeText(extractTagValue(primaryCategoryBlock, 'CategoryName') || extractTagValue(itemBlock, 'CategoryName')),
    conditionId: normalizeText(extractTagValue(itemBlock, 'ConditionID')),
    conditionDisplayName: normalizeText(extractTagValue(itemBlock, 'ConditionDisplayName')),
    currentPrice: price,
    currency: normalizeText(extractTagAttribute(currentPriceBlock, 'CurrentPrice', 'currencyID')),
    quantity: toNumberOrNull(extractTagValue(itemBlock, 'Quantity')),
    quantitySold: toNumberOrNull(extractTagValue(itemBlock, 'QuantitySold')),
    listingStatus: normalizeText(extractTagValue(itemBlock, 'ListingStatus')),
    viewItemUrl: normalizeText(extractTagValue(itemBlock, 'ViewItemURL')),
    pictureUrls: extractTagValues(pictureDetailsBlock, 'PictureURL').map(value => normalizeText(value)).filter(Boolean),
    itemSpecifics: parseNameValueListBlock(itemSpecificsBlock),
    compatibility: parseItemCompatibility(itemBlock),
    shippingPackageDetails: {
      packageDepth: normalizeText(extractTagValue(shippingPackageDetailsBlock, 'PackageDepth')),
      packageLength: normalizeText(extractTagValue(shippingPackageDetailsBlock, 'PackageLength')),
      packageWidth: normalizeText(extractTagValue(shippingPackageDetailsBlock, 'PackageWidth')),
      weightMajor: normalizeText(extractTagValue(shippingPackageDetailsBlock, 'WeightMajor')),
      weightMajorUnit: normalizeText(extractTagAttribute(weightMajorBlock, 'WeightMajor', 'unit')),
      weightMinor: normalizeText(extractTagValue(shippingPackageDetailsBlock, 'WeightMinor')),
      weightMinorUnit: normalizeText(extractTagAttribute(weightMinorBlock, 'WeightMinor', 'unit')),
      shippingIrregular: normalizeText(extractTagValue(shippingPackageDetailsBlock, 'ShippingIrregular')),
      packageType: normalizeText(extractTagValue(shippingPackageDetailsBlock, 'ShippingPackage'))
    },
    returnPolicy: {
      returnsAcceptedOption: normalizeText(extractTagValue(returnPolicyBlock, 'ReturnsAcceptedOption')),
      refundOption: normalizeText(extractTagValue(returnPolicyBlock, 'RefundOption')),
      returnsWithinOption: normalizeText(extractTagValue(returnPolicyBlock, 'ReturnsWithinOption')),
      shippingCostPaidByOption: normalizeText(extractTagValue(returnPolicyBlock, 'ShippingCostPaidByOption'))
    },
    country: normalizeText(extractTagValue(itemBlock, 'Country')),
    currencyCode: normalizeText(extractTagValue(itemBlock, 'Currency')),
    postalCode: normalizeText(extractTagValue(itemBlock, 'PostalCode')),
    location: normalizeText(extractTagValue(itemBlock, 'Location')),
    listingDuration: normalizeText(extractTagValue(itemBlock, 'ListingDuration')),
    dispatchTimeMax: normalizeText(extractTagValue(itemBlock, 'DispatchTimeMax')),
    sellerProfiles: {
      sellerShippingProfileId: normalizeText(extractTagValue(sellerProfilesBlock, 'ShippingProfileID')),
      sellerReturnProfileId: normalizeText(extractTagValue(sellerProfilesBlock, 'ReturnProfileID')),
      sellerPaymentProfileId: normalizeText(extractTagValue(sellerProfilesBlock, 'PaymentProfileID'))
    }
  };
}

function parseBooleanText(value, fallback = false) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return fallback;
  if (text === 'true' || text === '1' || text === 'yes') return true;
  if (text === 'false' || text === '0' || text === 'no') return false;
  return fallback;
}

function toPositiveInteger(value, fallback = 1, min = 1, max = 1000000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.trunc(parsed);
  if (normalized < min) return min;
  if (normalized > max) return max;
  return normalized;
}

function toMoneyValueString(value, fallback = '0.99') {
  const parsed = Number(String(value || '').replace(/,/g, ''));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed.toFixed(2);
}

function resolveSiteCodeFromSiteId(siteId = '') {
  const value = normalizeText(siteId || EBAY_TRADING_DEFAULT_SITE_ID);
  if (value === '2') return 'Canada';
  if (value === '3') return 'UK';
  if (value === '15') return 'Australia';
  if (value === '77') return 'Germany';
  if (value === '100') return 'eBayMotors';
  return 'US';
}

function resolveSandboxMirrorTradingSiteId(runOptions = {}) {
  return (
    normalizeText(
      runOptions.phase5EbaySandboxSiteId ||
      runOptions.phase5EbaySiteId ||
      process.env.EBAY_SANDBOX_TRADING_SITE_ID ||
      process.env.EBAY_TRADING_SITE_ID ||
      EBAY_TRADING_DEFAULT_SITE_ID
    ) || EBAY_TRADING_DEFAULT_SITE_ID
  );
}

function buildGetUserPreferencesProfilesRequestXml() {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<GetUserPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents">' +
    '<ShowSellerProfilePreferences>true</ShowSellerProfilePreferences>' +
    '</GetUserPreferencesRequest>'
  );
}

function parseTradingSellerProfilesFromUserPreferencesResponse(responseXml = '') {
  const sellerPrefs = extractTagBlocks(responseXml, 'SellerProfilePreferences')[0] || '';
  const optedIn = parseBooleanText(extractTagValue(sellerPrefs, 'SellerProfileOptedIn'));
  const profileBlocks = extractTagBlocks(sellerPrefs, 'SupportedSellerProfile');
  const profiles = profileBlocks.map(block => ({
    profileType: normalizeText(extractTagValue(block, 'ProfileType')).toUpperCase(),
    profileId: normalizeText(extractTagValue(block, 'ProfileID')),
    categoryGroup: normalizeText(extractTagValue(block, 'Name')).toUpperCase(),
    isDefault: parseBooleanText(extractTagValue(block, 'IsDefault'))
  })).filter(entry => entry.profileType && entry.profileId);

  function pickProfileId(profileType = '') {
    const sameType = profiles.filter(entry => entry.profileType === profileType);
    if (sameType.length === 0) return '';
    const preferred = sameType.find(entry => entry.categoryGroup === 'ALL' && entry.isDefault)
      || sameType.find(entry => entry.isDefault)
      || sameType[0];
    return normalizeText(preferred?.profileId);
  }

  return {
    optedIn,
    profiles,
    paymentProfileId: pickProfileId('PAYMENT'),
    returnProfileId: pickProfileId('RETURN_POLICY'),
    shippingProfileId: pickProfileId('SHIPPING')
  };
}

function buildSellerProfilesXmlFragment(profileSelection = {}) {
  const paymentProfileId = normalizeText(profileSelection?.paymentProfileId);
  const returnProfileId = normalizeText(profileSelection?.returnProfileId);
  const shippingProfileId = normalizeText(profileSelection?.shippingProfileId);
  if (!paymentProfileId && !returnProfileId && !shippingProfileId) return '';
  let xml = '<SellerProfiles>';
  if (paymentProfileId) {
    xml +=
      '<SellerPaymentProfile>' +
      `<PaymentProfileID>${escapeXml(paymentProfileId)}</PaymentProfileID>` +
      '</SellerPaymentProfile>';
  }
  if (returnProfileId) {
    xml +=
      '<SellerReturnProfile>' +
      `<ReturnProfileID>${escapeXml(returnProfileId)}</ReturnProfileID>` +
      '</SellerReturnProfile>';
  }
  if (shippingProfileId) {
    xml +=
      '<SellerShippingProfile>' +
      `<ShippingProfileID>${escapeXml(shippingProfileId)}</ShippingProfileID>` +
      '</SellerShippingProfile>';
  }
  xml += '</SellerProfiles>';
  return xml;
}

function buildGeteBayDetailsShippingServicesRequestXml() {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<GeteBayDetailsRequest xmlns="urn:ebay:apis:eBLBaseComponents">' +
    '<DetailName>ShippingServiceDetails</DetailName>' +
    '</GeteBayDetailsRequest>'
  );
}

function buildValidateTestUserRegistrationRequestXml() {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<ValidateTestUserRegistrationRequest xmlns="urn:ebay:apis:eBLBaseComponents">' +
    '<FeedbackScore>500</FeedbackScore>' +
    '</ValidateTestUserRegistrationRequest>'
  );
}

function parseTradingDomesticShippingServiceFromDetailsResponse(responseXml = '') {
  const serviceBlocks = extractTagBlocks(responseXml, 'ShippingServiceDetails');
  const domesticFlat = [];
  const domesticAny = [];

  for (const block of serviceBlocks) {
    const shippingService = normalizeText(extractTagValue(block, 'ShippingService'));
    if (!shippingService) continue;
    const validForSellingText = normalizeText(extractTagValue(block, 'ValidForSellingFlow'));
    const hasValidForSellingTag = /<ValidForSellingFlow(?:\s[^>]*)?>/i.test(block);
    const validForSelling = hasValidForSellingTag && parseBooleanText(validForSellingText, false);
    if (!validForSelling) continue;

    const isInternational = parseBooleanText(extractTagValue(block, 'InternationalService'), false);
    if (isInternational) continue;

    const serviceTypes = extractTagValues(block, 'ServiceType').map(value => normalizeText(value).toUpperCase());
    const isFlat =
      serviceTypes.includes('FLAT') ||
      serviceTypes.includes('FLATDOMESTICCALCULATEDINTERNATIONAL');

    domesticAny.push(shippingService);
    if (isFlat) domesticFlat.push(shippingService);
  }

  return normalizeText(domesticFlat[0] || domesticAny[0] || '');
}

function buildLegacyListingPolicyXmlFragment(context = {}) {
  const shippingService = normalizeText(context?.defaultShippingService);
  const currency = normalizeText(context?.currency || 'USD');
  const quantity = toPositiveInteger(context?.quantity, 1, 1, 999999);
  if (!shippingService) return '';

  const additionalCostXml = quantity > 1
    ? `<ShippingServiceAdditionalCost currencyID="${escapeXml(currency)}">0.00</ShippingServiceAdditionalCost>`
    : '';

  return (
    '<ShippingDetails>' +
    '<ShippingType>Flat</ShippingType>' +
    '<ShippingServiceOptions>' +
    `<ShippingService>${escapeXml(shippingService)}</ShippingService>` +
    '<ShippingServicePriority>1</ShippingServicePriority>' +
    `<ShippingServiceCost currencyID="${escapeXml(currency)}">0.00</ShippingServiceCost>` +
    additionalCostXml +
    '<FreeShipping>true</FreeShipping>' +
    '</ShippingServiceOptions>' +
    '</ShippingDetails>' +
    '<ReturnPolicy>' +
    '<ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption>' +
    '<ReturnsWithinOption>Days_30</ReturnsWithinOption>' +
    '<RefundOption>MoneyBack</RefundOption>' +
    '<ShippingCostPaidByOption>Buyer</ShippingCostPaidByOption>' +
    '</ReturnPolicy>'
  );
}

function buildGetSuggestedCategoriesRequestXml(query = '') {
  const q = normalizeText(query);
  if (!q) return '';
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<GetSuggestedCategoriesRequest xmlns="urn:ebay:apis:eBLBaseComponents">' +
    `<Query>${escapeXml(q.slice(0, 350))}</Query>` +
    '</GetSuggestedCategoriesRequest>'
  );
}

function buildGetCategoryFeaturesConditionRequestXml(categoryId = '') {
  const id = normalizeText(categoryId);
  if (!id) return '';
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<GetCategoryFeaturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">' +
    `<CategoryID>${escapeXml(id)}</CategoryID>` +
    '<DetailLevel>ReturnAll</DetailLevel>' +
    '<FeatureID>ConditionEnabled</FeatureID>' +
    '<FeatureID>ConditionValues</FeatureID>' +
    '</GetCategoryFeaturesRequest>'
  );
}

function parseSuggestedCategoryIdFromResponse(responseXml = '') {
  const suggestedBlock = extractTagBlocks(responseXml, 'SuggestedCategory')[0] || '';
  const categoryBlock = extractTagBlocks(suggestedBlock, 'Category')[0] || suggestedBlock;
  return normalizeText(extractTagValue(categoryBlock, 'CategoryID'));
}

function parseConditionIdsFromCategoryFeaturesResponse(responseXml = '') {
  const ids = [];
  const categoryBlock = extractTagBlocks(responseXml, 'Category')[0] || responseXml;
  const conditionEnabled = normalizeText(extractTagValue(categoryBlock, 'ConditionEnabled')).toLowerCase();
  if (conditionEnabled === 'disabled') {
    return ids;
  }
  const conditionBlocks = extractTagBlocks(categoryBlock, 'Condition');
  for (const block of conditionBlocks) {
    const id = normalizeText(extractTagValue(block, 'ID'));
    if (/^\d+$/.test(id)) ids.push(id);
  }
  return Array.from(new Set(ids));
}

function mapConditionTextToConditionId(text = '') {
  const token = normalizeText(text).toLowerCase();
  if (!token) return '';
  if (token.includes('for parts') || token.includes('not working')) return '7000';
  if (token.includes('acceptable')) return '6000';
  if (token.includes('very good')) return '4000';
  if (token.includes('good')) return '5000';
  if (token.includes('used') || token.includes('pre-owned') || token.includes('pre owned')) return '3000';
  if (token.includes('open box') || token.includes('new other')) return '1500';
  if (token.includes('new') || token.includes('brand new')) return '1000';
  return '';
}

function hasTradingErrorCode(responseXml = '', targetCodes = []) {
  const wanted = new Set(
    (Array.isArray(targetCodes) ? targetCodes : [])
      .map(value => normalizeText(value))
      .filter(Boolean)
  );
  if (wanted.size === 0) return false;
  const errorBlocks = extractTagBlocks(responseXml, 'Errors');
  for (const block of errorBlocks) {
    const code = normalizeText(extractTagValue(block, 'ErrorCode'));
    if (wanted.has(code)) return true;
  }
  return false;
}

function buildShippingPackageDetailsXmlFragment(item = {}) {
  const deep = item?.rawDeepListing && typeof item.rawDeepListing === 'object' ? item.rawDeepListing : {};
  const shipping = deep?.shippingPackageDetails && typeof deep.shippingPackageDetails === 'object'
    ? deep.shippingPackageDetails
    : {};
  const dims = item?.packageWeightAndSize?.dimensions && typeof item.packageWeightAndSize.dimensions === 'object'
    ? item.packageWeightAndSize.dimensions
    : {};
  const weight = item?.packageWeightAndSize?.weight && typeof item.packageWeightAndSize.weight === 'object'
    ? item.packageWeightAndSize.weight
    : {};

  const length = normalizeText(shipping.packageLength || dims.length || '');
  const width = normalizeText(shipping.packageWidth || dims.width || '');
  const depth = normalizeText(shipping.packageDepth || dims.height || '');
  const packageType = normalizeText(shipping.packageType || '');
  const shippingIrregular = normalizeText(shipping.shippingIrregular || '');
  let weightMajor = normalizeText(shipping.weightMajor || '');
  let weightMinor = normalizeText(shipping.weightMinor || '');

  if (!weightMajor && !weightMinor) {
    const rawWeightValue = Number(weight.value);
    const rawWeightUnit = normalizeText(weight.unit || '').toLowerCase();
    if (Number.isFinite(rawWeightValue) && rawWeightValue >= 0) {
      let totalLbs = rawWeightValue;
      if (rawWeightUnit === 'oz' || rawWeightUnit === 'ounce' || rawWeightUnit === 'ounces') {
        totalLbs = rawWeightValue / 16;
      }
      const lbs = Math.floor(totalLbs);
      const oz = Math.round((totalLbs - lbs) * 16);
      if (oz >= 16) {
        weightMajor = String(lbs + 1);
        weightMinor = '0';
      } else {
        weightMajor = String(lbs);
        weightMinor = String(oz);
      }
    }
  }

  const hasAny =
    Boolean(length) ||
    Boolean(width) ||
    Boolean(depth) ||
    Boolean(weightMajor) ||
    Boolean(weightMinor) ||
    Boolean(packageType) ||
    Boolean(shippingIrregular);
  if (!hasAny) return '';

  let xml = '<ShippingPackageDetails><MeasurementUnit>English</MeasurementUnit>';
  if (length) xml += `<PackageLength unit="inches">${escapeXml(length)}</PackageLength>`;
  if (width) xml += `<PackageWidth unit="inches">${escapeXml(width)}</PackageWidth>`;
  if (depth) xml += `<PackageDepth unit="inches">${escapeXml(depth)}</PackageDepth>`;
  if (weightMajor) xml += `<WeightMajor unit="lbs">${escapeXml(weightMajor)}</WeightMajor>`;
  if (weightMinor) xml += `<WeightMinor unit="oz">${escapeXml(weightMinor)}</WeightMinor>`;
  if (packageType) xml += `<ShippingPackage>${escapeXml(packageType)}</ShippingPackage>`;
  if (shippingIrregular) {
    const irregular = normalizeText(shippingIrregular).toLowerCase();
    if (irregular === 'true' || irregular === '1' || irregular === 'yes') {
      xml += '<ShippingIrregular>true</ShippingIrregular>';
    } else if (irregular === 'false' || irregular === '0' || irregular === 'no') {
      xml += '<ShippingIrregular>false</ShippingIrregular>';
    }
  }
  xml += '</ShippingPackageDetails>';
  return xml;
}

function buildTradingAddFixedPriceItemRequestXml(item = {}, offer = {}, context = {}) {
  const compactMode = context.compactMode === true;
  const sku = normalizeText(item?.sku);
  const deep = item?.rawDeepListing && typeof item.rawDeepListing === 'object' ? item.rawDeepListing : {};
  const title = normalizeText(item?.product?.title || deep?.title || '');
  const rawDescription = normalizeText(item?.product?.description || deep?.descriptionHtml || '');
  const description = compactMode ? rawDescription.slice(0, 3500) : rawDescription.slice(0, 20000);
  const categoryId = normalizeText(
    context.overrideCategoryId || item?.product?.categoryId || offer?.categoryId || deep?.categoryId || ''
  );
  const quantity = toPositiveInteger(item?.availability?.shipToLocationAvailability?.quantity, 1, 1, 999999);
  const startPrice = toMoneyValueString(offer?.price || deep?.currentPrice, '0.99');
  const currency = normalizeText(offer?.currency || deep?.currency || deep?.currencyCode || context.defaultCurrency || 'USD');
  const country = normalizeText(deep?.country || context.defaultCountry || 'US');
  const location = normalizeText(deep?.location || context.defaultLocation || '');
  const postalCode = normalizeText(deep?.postalCode || context.defaultPostalCode || '');
  const listingDuration = normalizeText(deep?.listingDuration || context.defaultListingDuration || 'GTC');
  const dispatchTimeMax = toPositiveInteger(deep?.dispatchTimeMax, 1, 1, 30);
  const derivedConditionIdFromText = mapConditionTextToConditionId(
    deep?.conditionDisplayName || item?.condition || ''
  );
  const conditionIdText = normalizeText(
    context.overrideConditionId || deep?.conditionId || derivedConditionIdFromText || context.defaultConditionId || ''
  );
  const pictureUrls = Array.isArray(deep?.pictureUrls)
    ? deep.pictureUrls.map(v => normalizeText(v)).filter(Boolean)
    : (Array.isArray(item?.product?.imageUrls) ? item.product.imageUrls.map(v => normalizeText(v)).filter(Boolean) : []);
  const siteCode = resolveSiteCodeFromSiteId(context.siteId || EBAY_TRADING_DEFAULT_SITE_ID);
  const profilesXml = buildSellerProfilesXmlFragment(context.sellerProfiles || {});
  const legacyPolicyXml = buildLegacyListingPolicyXmlFragment({
    defaultShippingService: context.defaultShippingService,
    currency,
    quantity
  });
  const shippingPackageDetailsXml = buildShippingPackageDetailsXmlFragment(item);
  const listingPolicyXml = profilesXml || legacyPolicyXml;

  if (!sku) {
    return { valid: false, reason: 'missing SKU' };
  }
  if (!title) {
    return { valid: false, reason: `missing title for SKU '${sku}'` };
  }
  if (!description) {
    return { valid: false, reason: `missing description for SKU '${sku}'` };
  }
  if (!categoryId) {
    return { valid: false, reason: `missing category id for SKU '${sku}'` };
  }
  if (!currency) {
    return { valid: false, reason: `missing currency for SKU '${sku}'` };
  }
  if (!country) {
    return { valid: false, reason: `missing country for SKU '${sku}'` };
  }
  if (!location && !postalCode) {
    return { valid: false, reason: `missing item location/postal code for SKU '${sku}'` };
  }
  if (pictureUrls.length === 0) {
    return { valid: false, reason: `missing picture url(s) for SKU '${sku}'` };
  }
  if (!listingPolicyXml) {
    return {
      valid: false,
      reason:
        `sandbox listing policy is missing for SKU '${sku}'. ` +
        'Need either business policy profile IDs or a valid domestic shipping service for fallback.'
    };
  }

  const aspects = item?.product?.aspects && typeof item.product.aspects === 'object'
    ? item.product.aspects
    : {};
  let itemSpecificsXml = '';
  if (!compactMode) {
    for (const [name, values] of Object.entries(aspects)) {
      const aspectName = normalizeText(name);
      const list = Array.isArray(values)
        ? values.map(v => normalizeText(v)).filter(Boolean)
        : [normalizeText(values)].filter(Boolean);
      if (!aspectName || list.length === 0) continue;
      itemSpecificsXml += '<NameValueList>';
      itemSpecificsXml += `<Name>${escapeXml(aspectName)}</Name>`;
      for (const value of list) {
        itemSpecificsXml += `<Value>${escapeXml(value)}</Value>`;
      }
      itemSpecificsXml += '</NameValueList>';
    }
  }
  if (itemSpecificsXml) {
    itemSpecificsXml = `<ItemSpecifics>${itemSpecificsXml}</ItemSpecifics>`;
  }

  let pictureXml = '<PictureDetails>';
  const maxPictures = compactMode ? 1 : 24;
  for (const url of pictureUrls.slice(0, maxPictures)) {
    pictureXml += `<PictureURL>${escapeXml(url)}</PictureURL>`;
  }
  pictureXml += '</PictureDetails>';

  const conditionXml = (!context.omitCondition && /^\d+$/.test(conditionIdText))
    ? `<ConditionID>${escapeXml(conditionIdText)}</ConditionID>`
    : '';
  const locationXml = location ? `<Location>${escapeXml(location)}</Location>` : '';
  const postalXml = postalCode ? `<PostalCode>${escapeXml(postalCode)}</PostalCode>` : '';

  const requestXml =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">' +
    '<ErrorLanguage>en_US</ErrorLanguage>' +
    '<WarningLevel>High</WarningLevel>' +
    '<Item>' +
    `<SKU>${escapeXml(sku)}</SKU>` +
    `<InventoryTrackingMethod>SKU</InventoryTrackingMethod>` +
    `<Site>${escapeXml(siteCode)}</Site>` +
    `<Title>${escapeXml(title.slice(0, 80))}</Title>` +
    `<Description>${escapeXml(description)}</Description>` +
    `<PrimaryCategory><CategoryID>${escapeXml(categoryId)}</CategoryID></PrimaryCategory>` +
    `<StartPrice currencyID="${escapeXml(currency)}">${escapeXml(startPrice)}</StartPrice>` +
    `<CategoryMappingAllowed>true</CategoryMappingAllowed>` +
    `<Country>${escapeXml(country)}</Country>` +
    `<Currency>${escapeXml(currency)}</Currency>` +
    `<ListingType>FixedPriceItem</ListingType>` +
    `<ListingDuration>${escapeXml(listingDuration)}</ListingDuration>` +
    `<Quantity>${escapeXml(String(quantity))}</Quantity>` +
    `<DispatchTimeMax>${escapeXml(String(dispatchTimeMax))}</DispatchTimeMax>` +
    conditionXml +
    locationXml +
    postalXml +
    pictureXml +
    itemSpecificsXml +
    shippingPackageDetailsXml +
    listingPolicyXml +
    '</Item>' +
    '</AddFixedPriceItemRequest>';

  return {
    valid: true,
    sku,
    requestXml
  };
}

function buildTradingImportCollections(syncResult = {}, fetchLimit = 0) {
  const bulkListings = Array.isArray(syncResult?.bulkListings) ? syncResult.bulkListings : [];
  const deepListings = Array.isArray(syncResult?.deepListings) ? syncResult.deepListings : [];
  const deepByItemId = new Map();
  const deepBySku = new Map();

  for (const deep of deepListings) {
    const itemId = normalizeText(deep?.ebayItemId);
    const sku = normalizeText(deep?.sku);
    if (itemId) deepByItemId.set(itemId, deep);
    if (sku && !deepBySku.has(sku)) deepBySku.set(sku, deep);
  }

  const selectedBulk =
    Number(fetchLimit) > 0
      ? bulkListings.filter(item => isActiveListingStatus(item?.listingStatus)).slice(0, Number(fetchLimit))
      : bulkListings.filter(item => isActiveListingStatus(item?.listingStatus));

  const inventoryItems = [];
  const offersBySku = new Map();

  for (const bulk of selectedBulk) {
    const itemId = normalizeText(bulk?.ebayItemId);
    const bulkSku = normalizeText(bulk?.sku);
    const deep = deepByItemId.get(itemId) || deepBySku.get(bulkSku) || null;
    const sku = normalizeText(deep?.sku || bulkSku || itemId);
    if (!sku) continue;

    const quantityValue =
      typeof deep?.quantity === 'number'
        ? deep.quantity
        : typeof bulk?.quantityAvailable === 'number'
          ? bulk.quantityAvailable
          : typeof bulk?.quantity === 'number'
            ? bulk.quantity
            : 0;
    const listingId = normalizeText(deep?.ebayItemId || itemId);
    const listingStatus = normalizeText(deep?.listingStatus || bulk?.listingStatus || ACTIVE_LISTING_STATUS_VALUE);
    if (!isActiveListingStatus(listingStatus)) continue;
    const priceValue = normalizeText(deep?.currentPrice || bulk?.currentPrice);
    const currencyValue = normalizeText(deep?.currency || '');
    const categoryId = normalizeText(deep?.categoryId || '');
    const aspects =
      deep?.itemSpecifics && typeof deep.itemSpecifics === 'object' && !Array.isArray(deep.itemSpecifics)
        ? deep.itemSpecifics
        : {};
    const pictureUrls = Array.isArray(deep?.pictureUrls)
      ? deep.pictureUrls.map(value => normalizeText(value)).filter(Boolean)
      : [];

    inventoryItems.push({
      sku,
      listingStatus: listingStatus || ACTIVE_LISTING_STATUS_VALUE,
      condition: normalizeText(deep?.conditionDisplayName || deep?.conditionId || ''),
      conditionDescription: '',
      rawDeepListing: deep || null,
      product: {
        title: normalizeText(deep?.title || bulk?.title || ''),
        description: normalizeText(deep?.descriptionHtml || ''),
        aspects,
        categoryId,
        imageUrls: pictureUrls
      },
      availability: {
        shipToLocationAvailability: {
          quantity: quantityValue
        }
      }
    });

    offersBySku.set(sku, {
      offerId: '',
      listingId,
      price: priceValue,
      currency: currencyValue,
      categoryId
    });
  }

  return {
    inventoryItems,
    offersBySku
  };
}

async function fetchTradingActiveListings(
  client,
  config = {},
  accessToken = '',
  summary = {},
  progressCallback = () => {}
) {
  const environment = normalizeEnvironment(config.environment);
  const endpoint = getTradingApiUrl(environment);
  const fetchLimit = toNumber(config.fetchLimit, DEFAULT_FETCH_LIMIT, 1, 5000);
  const entriesPerPage = toNumber(config.pageSize, 200, 1, 200);
  const siteId = normalizeText(config.tradingSiteId || EBAY_TRADING_DEFAULT_SITE_ID) || EBAY_TRADING_DEFAULT_SITE_ID;
  const offersBySku = new Map();
  const inventoryItems = [];
  let pageNumber = 1;
  let totalPages = 1;

  while (pageNumber <= totalPages && inventoryItems.length < fetchLimit) {
    const requestXml = buildGetMyeBaySellingRequestXml({
      entriesPerPage,
      pageNumber
    });

    const response = await client.post(endpoint, requestXml, {
      headers: {
        'X-EBAY-API-SITEID': siteId,
        'X-EBAY-API-COMPATIBILITY-LEVEL': EBAY_TRADING_COMPATIBILITY_LEVEL,
        'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
        'X-EBAY-API-IAF-TOKEN': accessToken,
        'Content-Type': 'text/xml'
      },
      responseType: 'text',
      transformResponse: data => data
    });

    const responseXml = String(response?.data || '');
    const ack = normalizeText(extractTagValue(responseXml, 'Ack')).toLowerCase();
    if (ack && !['success', 'warning'].includes(ack)) {
      const error = new Error(`Trading API GetMyeBaySelling failed: ${getTradingApiErrorText(responseXml, `Ack=${ack}`)}`);
      error.code = getTradingApiErrorCode(responseXml);
      throw error;
    }

    const pageRows = parseTradingApiItems(responseXml)
      .filter(row => isActiveListingStatus(row?.item?.listingStatus));
    for (const row of pageRows) {
      if (inventoryItems.length >= fetchLimit) break;
      inventoryItems.push(row.item);
      if (row.item?.sku) {
        offersBySku.set(row.item.sku, row.offer || {});
      }
    }

    summary.inventoryItemsFetched = inventoryItems.length;
    summary.offersFetched = offersBySku.size;
    summary.tradingPagesFetched = pageNumber;
    emitProgress(progressCallback, {
      stage: 'ebaysandbox_fetch_items',
      percent: Math.min(68, 20 + Math.floor((inventoryItems.length / Math.max(1, fetchLimit)) * 48)),
      counts: summary,
      message: `Fetched ${inventoryItems.length} listing(s) via Trading API page ${pageNumber}.`
    });

    const parsedTotalPages = toNumber(extractTagValue(responseXml, 'TotalNumberOfPages'), 0, 0, 1000000);
    totalPages = parsedTotalPages > 0 ? parsedTotalPages : pageNumber;
    if (pageRows.length < entriesPerPage) break;
    pageNumber += 1;
  }

  return {
    inventoryItems: inventoryItems.slice(0, fetchLimit),
    offersBySku,
    pagesFetched: pageNumber - 1,
    totalPages
  };
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
  const createdFields = [];

  if (!dryRun) {
    const fieldSpecs = [
      ...Array.from(new Set(UPSERT_FIELDS.map(name => normalizeText(name)).filter(Boolean))).map(name => {
        if ([RAW_ITEM_JSON_FIELD, RAW_OFFER_JSON_FIELD, 'Item Description', 'Full listing description HTML', 'Description', 'Item Specifics', 'Item Specifics - All C: values relevant to item', 'Picture URLs', 'Compatibility', 'Shipping Package Details', 'Return Policy', 'Seller Profiles', ECOMMERCE_DESC_FIELD].includes(name)) {
          return {
            name,
            type: 'multilineText'
          };
        }
        return {
          name,
          type: 'singleLineText'
        };
      })
    ];

    for (const spec of fieldSpecs) {
      if (hasFieldByNormalizedName(existing, spec.name)) continue;
      try {
        const created = await schemaService.createField(normalizeText(table.id), {
          name: spec.name,
          type: spec.type
        });
        const createdName = normalizeText(created?.name || spec.name);
        if (createdName) {
          existing.add(createdName);
          createdFields.push(createdName);
        }
      } catch (_) {
        // ignore create failures here; downstream upsert logic can still proceed with existing fields
      }
    }
  }

  return {
    tableId: normalizeText(table.id),
    createdTable: false,
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

function stringifyJsonObject(value) {
  if (value === null || typeof value === 'undefined') return '';
  try {
    return JSON.stringify(value);
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

function extractBatchInterchangeIpn(item = {}) {
  const aspects = item?.product?.aspects || {};
  return firstAspectValue(aspects, ['Interchange Part Number', IPN_FIELD, 'IPN']);
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
  const inventoryValue = normalizeText(item?.packageWeightAndSize?.dimensions?.[key] || '');
  if (inventoryValue) return inventoryValue;

  const shippingDetails =
    item?.rawDeepListing?.shippingPackageDetails && typeof item.rawDeepListing.shippingPackageDetails === 'object'
      ? item.rawDeepListing.shippingPackageDetails
      : {};
  if (key === 'length') return normalizeText(shippingDetails.packageLength || '');
  if (key === 'width') return normalizeText(shippingDetails.packageWidth || '');
  if (key === 'height') return normalizeText(shippingDetails.packageHeight || shippingDetails.packageDepth || '');
  return '';
}

function toWeightValueText(item = {}) {
  const inventoryValue = normalizeText(item?.packageWeightAndSize?.weight?.value || '');
  if (inventoryValue) return inventoryValue;

  const shippingDetails =
    item?.rawDeepListing?.shippingPackageDetails && typeof item.rawDeepListing.shippingPackageDetails === 'object'
      ? item.rawDeepListing.shippingPackageDetails
      : {};
  const majorText = normalizeText(shippingDetails.weightMajor || '');
  const minorText = normalizeText(shippingDetails.weightMinor || '');
  const major = Number(majorText);
  const minor = Number(minorText);
  const majorUnit = normalizeText(shippingDetails.weightMajorUnit || '').toLowerCase();
  const minorUnit = normalizeText(shippingDetails.weightMinorUnit || '').toLowerCase();

  if (Number.isFinite(major) && Number.isFinite(minor)) {
    if ((majorUnit === 'lbs' || majorUnit === 'lb' || !majorUnit) && (minorUnit === 'oz' || !minorUnit)) {
      return String(major + minor / 16).replace(/\.?0+$/, '');
    }
    if (major !== 0) return String(major);
    return String(minor);
  }
  if (Number.isFinite(major)) return String(major);
  if (Number.isFinite(minor)) {
    if (minorUnit === 'oz') {
      return String(minor / 16).replace(/\.?0+$/, '');
    }
    return String(minor);
  }
  return '';
}

function toWeightUnitText(item = {}) {
  const inventoryUnit = normalizeText(item?.packageWeightAndSize?.weight?.unit || '');
  if (inventoryUnit) return inventoryUnit;

  const shippingDetails =
    item?.rawDeepListing?.shippingPackageDetails && typeof item.rawDeepListing.shippingPackageDetails === 'object'
      ? item.rawDeepListing.shippingPackageDetails
      : {};
  const majorUnit = normalizeText(shippingDetails.weightMajorUnit || '').toLowerCase();
  const minorUnit = normalizeText(shippingDetails.weightMinorUnit || '').toLowerCase();
  if (majorUnit === 'lbs' || majorUnit === 'lb') return 'lbs';
  if (minorUnit === 'oz') return 'lbs';
  return normalizeText(shippingDetails.weightMajorUnit || shippingDetails.weightMinorUnit || '');
}

function buildSeoKeywords(parts = []) {
  return Array.from(new Set((Array.isArray(parts) ? parts : []).map(v => normalizeText(v)).filter(Boolean))).join(', ');
}

async function runEbayListingSync(options = {}, progressCallback = () => {}) {
  const stored = getInventoryConfig('phase2Config') || {};
  const mergedOptions = { ...stored, ...options };
  const environment = normalizeEnvironment(mergedOptions.phase5EbayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox');
  const runOptions = applyEbayCredentialsForEnvironment(mergedOptions, environment);
  const clientId = normalizeText(runOptions.phase5EbayClientId || process.env.EBAY_CLIENT_ID || '');
  const clientSecret = normalizeText(runOptions.phase5EbayClientSecret || process.env.EBAY_CLIENT_SECRET || '');
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
  const siteId = normalizeText(runOptions.phase5EbaySiteId || process.env.EBAY_TRADING_SITE_ID || EBAY_TRADING_DEFAULT_SITE_ID) || EBAY_TRADING_DEFAULT_SITE_ID;
  const entriesPerPage = 200;
  const pageRetryAttempts = Math.max(1, Number(runOptions.pageRetryAttempts || 3) || 3);
  const getItemConcurrency = Math.max(1, Number(runOptions.getItemConcurrency || 3) || 3);
  const maxBulkListings = Math.max(0, Number(runOptions.maxBulkListings || 0) || 0);
  const fetchPagingMode = normalizeFetchPagingMode(runOptions.ebaySandboxFetchPagingMode || runOptions.ebaySandboxFetchMode);
  const nextFetchPageState = getNextFetchPageStateMap(runOptions);
  const startPage =
    fetchPagingMode === 'continue_from_last_page'
      ? Math.max(1, toPositiveInteger(nextFetchPageState[environment], 1, 1, 1000000))
      : 1;

  if (!userAccessToken && !refreshToken) {
    throw new Error('runEbayListingSync requires eBay user access token or refresh token.');
  }
  if (refreshToken && (!clientId || !clientSecret)) {
    throw new Error('Refresh-token auth requires eBay App ID (Client ID) and eBay Cert ID (Client Secret).');
  }

  emitProgress(progressCallback, {
    stage: 'ebaylisting_auth',
    percent: 3,
    counts: null,
    message: `Resolving eBay ${environment} user token for listing sync...`
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
  let activeAccessToken = normalizeOAuthToken(tokenResolution.accessToken);
  if (!activeAccessToken) {
    throw new Error('runEbayListingSync failed: could not resolve user access token.');
  }

  const tradingApiUrl = getTradingApiUrl(environment);
  const bulkListings = [];
  let pageNumber = startPage;
  let totalPages = Math.max(1, startPage);
  let lastFetchedPage = 0;

  emitProgress(progressCallback, {
    stage: 'ebaylisting_bulk_fetch',
    percent: 8,
    counts: null,
    message:
      `Fetching eBay listings in bulk via GetMyeBaySelling (${environment}) ` +
      `(mode=${fetchPagingMode}, startPage=${startPage})...`
  });

  while (pageNumber <= totalPages && (maxBulkListings <= 0 || bulkListings.length < maxBulkListings)) {
    let lastError = null;
    let responseXml = '';

    for (let attempt = 1; attempt <= pageRetryAttempts; attempt += 1) {
      try {
        const requestXml = buildGetMyeBaySellingRequestXml({
          entriesPerPage,
          pageNumber
        });
        const response = await httpClient.post(tradingApiUrl, requestXml, {
          headers: {
            'X-EBAY-API-SITEID': siteId,
            'X-EBAY-API-COMPATIBILITY-LEVEL': EBAY_TRADING_COMPATIBILITY_LEVEL,
            'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
            'X-EBAY-API-IAF-TOKEN': activeAccessToken,
            'Content-Type': 'text/xml'
          },
          responseType: 'text',
          transformResponse: data => data
        });
        responseXml = String(response?.data || '');
        const ack = getTradingAck(responseXml);
        if (!isTradingAckSuccess(ack)) {
          const ackError = new Error(
            `GetMyeBaySelling failed for page ${pageNumber}: ${getTradingApiErrorText(responseXml, `Ack=${ack || 'n/a'}`)}`
          );
          ackError.code = getTradingApiErrorCode(responseXml);
          throw ackError;
        }
        if (normalizeText(ack).toLowerCase() === 'warning') {
          const warningMessage = `[runEbayListingSync] GetMyeBaySelling page ${pageNumber} returned Ack=Warning`;
          console.warn(warningMessage);
          emitProgress(progressCallback, {
            stage: 'ebaylisting_ack_warning',
            percent: Math.min(45, 18 + Math.floor((pageNumber / Math.max(1, totalPages || 1)) * 20)),
            message: warningMessage
          });
        }
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const canRefresh = Boolean(refreshToken && clientId && clientSecret);
        const status = Number(error?.response?.status || 0);
        const tokenRejected = status === 401 || isTradingTokenValidationError(error);
        if (tokenRejected && canRefresh) {
          const refreshed = await requestUserAccessTokenFromRefreshToken(httpClient, {
            environment,
            clientId,
            clientSecret,
            refreshToken,
            scope: refreshScope
          });
          const storedConfig = getInventoryConfig('phase2Config') || {};
          saveInventoryConfig('phase2Config', {
            ...storedConfig,
            phase5EbayEnvironment: environment,
            phase5EbayUserAccessToken: refreshed.accessToken,
            phase5EbayUserAccessTokenIssuedAt: new Date(refreshed.issuedAtMs).toISOString(),
            phase5EbayUserAccessTokenExpiresIn: refreshed.expiresIn,
            phase5EbayRefreshToken: refreshToken
          });
          activeAccessToken = refreshed.accessToken;
          continue;
        }
        if (attempt < pageRetryAttempts) {
          continue;
        }
      }
    }

    if (lastError) {
      throw lastError;
    }

    const pageParsed = parseBulkListingsFromGetMyeBaySellingResponse(responseXml);
    if (pageParsed.totalPages > 0) {
      totalPages = pageParsed.totalPages;
    }
    lastFetchedPage = pageNumber;
    const pageItemCount = Array.isArray(pageParsed.listings) ? pageParsed.listings.length : 0;
    const remaining = maxBulkListings > 0 ? Math.max(0, maxBulkListings - bulkListings.length) : pageParsed.listings.length;
    bulkListings.push(...(maxBulkListings > 0 ? pageParsed.listings.slice(0, remaining) : pageParsed.listings));
    emitProgress(progressCallback, {
      stage: 'ebaylisting_bulk_fetch',
      percent: Math.min(55, 10 + Math.floor((pageNumber / Math.max(1, totalPages)) * 45)),
      counts: {
        pageNumber,
        totalPages,
        bulkCount: bulkListings.length,
        pageItemCount,
        parsedTotalPages: pageParsed.totalPages || 0
      },
      message:
        `Fetched page ${pageNumber}/${Math.max(totalPages, 1)} ` +
        `(pageItems=${pageItemCount}, bulk listings=${bulkListings.length}, parsedTotalPages=${pageParsed.totalPages || 0}).`
    });
    console.log(
      `[runEbayListingSync] page=${pageNumber} totalPages=${Math.max(totalPages, 1)} ` +
      `pageItems=${pageItemCount} bulkListings=${bulkListings.length} parsedTotalPages=${pageParsed.totalPages || 0}`
    );
    if (maxBulkListings > 0 && bulkListings.length >= maxBulkListings) {
      break;
    }
    pageNumber += 1;
  }

  const nextPageAfterRun =
    lastFetchedPage > 0
      ? (lastFetchedPage >= Math.max(1, totalPages) ? 1 : lastFetchedPage + 1)
      : startPage;

  if (fetchPagingMode === 'continue_from_last_page') {
    const storedConfig = getInventoryConfig('phase2Config') || {};
    const currentMap = getNextFetchPageStateMap(storedConfig);
    saveInventoryConfig('phase2Config', {
      ...storedConfig,
      ebaySandboxNextFetchPageByEnvironment: {
        ...currentMap,
        [environment]: nextPageAfterRun
      }
    });
  }

  const deepListings = [];
  const failedGetItemIds = [];
  const itemIds = Array.from(
    new Set(
      bulkListings
        .map(item => normalizeText(item?.ebayItemId))
        .filter(Boolean)
    )
  );
  let nextIndex = 0;
  let completedCount = 0;

  emitProgress(progressCallback, {
    stage: 'ebaylisting_getitem_fetch',
    percent: 58,
    counts: {
      total: itemIds.length
    },
    message: `Fetching deep listing details via GetItem for ${itemIds.length} listing(s)...`
  });

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= itemIds.length) return;
      const ebayItemId = itemIds[index];
      try {
        const requestXml = buildGetItemRequestXml(ebayItemId);
        const response = await httpClient.post(tradingApiUrl, requestXml, {
          headers: {
            'X-EBAY-API-SITEID': siteId,
            'X-EBAY-API-COMPATIBILITY-LEVEL': EBAY_TRADING_COMPATIBILITY_LEVEL,
            'X-EBAY-API-CALL-NAME': 'GetItem',
            'X-EBAY-API-IAF-TOKEN': activeAccessToken,
            'Content-Type': 'text/xml'
          },
          responseType: 'text',
          transformResponse: data => data
        });
        const responseXml = String(response?.data || '');
        const ack = getTradingAck(responseXml);
        if (!isTradingAckSuccess(ack)) {
          const ackError = new Error(
            `GetItem failed for ItemID ${ebayItemId}: ${getTradingApiErrorText(responseXml, `Ack=${ack || 'n/a'}`)}`
          );
          ackError.code = getTradingApiErrorCode(responseXml);
          throw ackError;
        }
        if (normalizeText(ack).toLowerCase() === 'warning') {
          const warningMessage = `[runEbayListingSync] GetItem ItemID=${ebayItemId} returned Ack=Warning`;
          console.warn(warningMessage);
          emitProgress(progressCallback, {
            stage: 'ebaylisting_getitem_warning',
            percent: Math.min(98, 58 + Math.floor((completedCount / Math.max(1, itemIds.length)) * 40)),
            message: warningMessage
          });
        }
        deepListings.push(parseDeepListingFromGetItemResponse(responseXml));
      } catch (error) {
        failedGetItemIds.push(ebayItemId);
        const errorMessage = `[runEbayListingSync] GetItem failed for ItemID=${ebayItemId}: ${normalizeText(error?.message || error)}`;
        console.warn(errorMessage);
        emitProgress(progressCallback, {
          stage: 'ebaylisting_getitem_error',
          percent: Math.min(98, 58 + Math.floor((completedCount / Math.max(1, itemIds.length)) * 40)),
          message: errorMessage
        });
      } finally {
        completedCount += 1;
        if (completedCount === 1 || completedCount % 25 === 0 || completedCount === itemIds.length) {
          emitProgress(progressCallback, {
            stage: 'ebaylisting_getitem_fetch',
            percent: Math.min(98, 58 + Math.floor((completedCount / Math.max(1, itemIds.length)) * 40)),
            counts: {
              completedCount,
              total: itemIds.length,
              deepCount: deepListings.length,
              failedGetItemCount: failedGetItemIds.length
            },
            message: `GetItem progress ${completedCount}/${itemIds.length} (deep=${deepListings.length}, failed=${failedGetItemIds.length}).`
          });
        }
      }
    }
  }

  const workers = [];
  const workerCount = Math.min(getItemConcurrency, Math.max(1, itemIds.length));
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const result = {
    bulkListings,
    deepListings,
    summary: {
      totalBulkListings: bulkListings.length,
      totalDeepListingsFetched: deepListings.length,
      failedGetItemCount: failedGetItemIds.length,
      fetchPagingMode,
      startPage,
      lastFetchedPage,
      totalPages: Math.max(1, totalPages),
      nextPage: nextPageAfterRun
    }
  };

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: result.summary,
    message:
      `eBay listing sync completed. Bulk=${result.summary.totalBulkListings}, ` +
      `Deep=${result.summary.totalDeepListingsFetched}, FailedGetItem=${result.summary.failedGetItemCount}.`
  });

  return result;
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

function extractComputedFieldNames(error) {
  const names = new Set();
  const addFromText = value => {
    const text = normalizeText(value);
    if (!text) return;
    const re = /Field\s+"([^"]+)"\s+cannot accept a value because the field is computed/gi;
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

function extractIncompatibleValueFieldNames(error) {
  const names = new Set();
  const addFromText = value => {
    const text = normalizeText(value);
    if (!text) return;
    const re = /Field\s+"([^"]+)"\s+cannot accept the provided value/gi;
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

function removePhase74OwnedFieldsFromRows(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let removedCount = 0;
  for (const row of rows) {
    const source = row?.fields && typeof row.fields === 'object' ? row.fields : {};
    for (const fieldName of [PHASE74_ITEM_TITLE_FIELD, PHASE74_ITEM_DESCRIPTION_FIELD]) {
      if (Object.prototype.hasOwnProperty.call(source, fieldName)) {
        delete source[fieldName];
        removedCount += 1;
      }
    }
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

function preserveExistingSpecifics(fields = {}, existingRecordFields = null) {
  if (!existingRecordFields || typeof existingRecordFields !== 'object') {
    return fields;
  }
  const protectedFieldNames = [
    'Item Specifics',
    'Item Specifics - All C: values relevant to item'
  ];
  const next = { ...(fields || {}) };
  for (const fieldName of protectedFieldNames) {
    const existingValue = normalizeText(existingRecordFields[fieldName]);
    if (existingValue) {
      next[fieldName] = existingRecordFields[fieldName];
    }
  }
  return next;
}

function buildUpsertFields(
  item = {},
  offer = {},
  environment = 'sandbox',
  hasIpnField = false,
  hasLegacyPrimaryField = false,
  existingFieldNames = new Set(),
  sourceLabel = 'eBay Inventory API'
) {
  const sku = normalizeText(item?.sku);
  if (!sku) return null;
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
  const deepDetails = item?.rawDeepListing && typeof item.rawDeepListing === 'object' ? item.rawDeepListing : {};
  const condition = normalizeText(item?.condition);
  const conditionId = normalizeText(deepDetails?.conditionId);
  const conditionDisplayName = normalizeText(deepDetails?.conditionDisplayName);
  const categoryName = normalizeText(deepDetails?.categoryName);
  const packageLength = toDimensionText(item, 'length');
  const packageWidth = toDimensionText(item, 'width');
  const packageHeight = toDimensionText(item, 'height');
  const packageWeight = toWeightValueText(item);
  const packageWeightUnit = toWeightUnitText(item);
  const itemSpecificsText = stringifyAspects(aspects);
  const cSpecificsText = toCSpecificsText(aspects, manufacturerPart, interchangePart, partNumber);
  const seoKeywords = buildSeoKeywords([brand, manufacturerPart, interchangePart, partNumber]);
  const listingDate = new Date().toISOString();
  const primaryId = sku;
  if (!primaryId) return null;

  const fields = {
    [PRIMARY_KEY_FIELD]: primaryId,
    Title: title,
    SKU: sku,
    'Listing Date': listingDate,
    'IPN (Interchange Part Number)': interchangePart,
    'eBay Category_ID': categoryId,
    'VIN Number': vin,
    'Full listing description HTML': description,
    'SEO Keywords': seoKeywords,
    'Promoted Rate': '',
    'Package Length (ShipStation)': packageLength,
    'Package Width (ShipStation)': packageWidth,
    'Package Height (ShipStation)': packageHeight,
    'Package Weight (ShipStation)': packageWeight,
    'Package Weight Unit': packageWeightUnit,
    Condition: condition,
    'Condition ID': conditionId,
    'Condition Display Name': conditionDisplayName || condition,
    Warranty: warranty,
    Brand: brand,
    'Category Name': categoryName,
    'Item Specifics - All C: values relevant to item': cSpecificsText,
    'Picture URLs': stringifyJsonObject(deepDetails?.pictureUrls || item?.product?.imageUrls || []),
    Compatibility: stringifyJsonObject(deepDetails?.compatibility || []),
    'Shipping Package Details': stringifyJsonObject(deepDetails?.shippingPackageDetails || {}),
    'Return Policy': stringifyJsonObject(deepDetails?.returnPolicy || {}),
    'Seller Profiles': stringifyJsonObject(deepDetails?.sellerProfiles || {}),
    [ECOMMERCE_DESC_FIELD]: description,
    [RAW_ITEM_JSON_FIELD]: stringifyJsonObject(item?.rawDeepListing || item),
    [RAW_OFFER_JSON_FIELD]: stringifyJsonObject(offer),
    'Item ID': listingId,
    'Offer ID': offerId,
    Description: description,
    'Item Specifics': itemSpecificsText,
    Quantity: quantity,
    Price: price,
    Currency: currency,
    'eBay Category ID': categoryId,
    [LISTING_STATUS_FIELD]: normalizeText(item?.listingStatus || ACTIVE_LISTING_STATUS_VALUE) || ACTIVE_LISTING_STATUS_VALUE,
    Source: sourceLabel,
    'eBay Environment': environment,
    [MISSING_DETECTED_FIELD]: null,
    'Last Synced At': new Date().toISOString()
  };
  if (hasLegacyPrimaryField) {
    fields[LEGACY_PRIMARY_KEY_FIELD] = normalizeText(listingId || primaryId);
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
  // Keep Item Title / Item Description exclusively owned by Phase 7.4 generation.
  removePhase74OwnedFieldsFromRows(payloadRows);
  const skippedUnknown = new Set();
  const skippedComputed = new Set();
  const skippedIncompatible = new Set();
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
      if (skippedComputed.size > 0) {
        summary.errors.push(
          `Skipped computed/non-writable Airtable field(s): ${Array.from(skippedComputed).join(', ')}`
        );
      }
      if (skippedIncompatible.size > 0) {
        summary.errors.push(
          `Skipped incompatible Airtable field value(s): ${Array.from(skippedIncompatible).join(', ')}`
        );
      }
      return;
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      const unknownFields = extractUnknownFieldNames(error);
      const computedFields = extractComputedFieldNames(error);
      const incompatibleFields = extractIncompatibleValueFieldNames(error);
      const removableFields = Array.from(
        new Set([...(unknownFields || []), ...(computedFields || []), ...(incompatibleFields || [])])
      );
      if (status !== 422 || removableFields.length === 0) {
        throw error;
      }
      const removed = removeUnknownFieldsFromRows(payloadRows, removableFields);
      if (removed === 0 || attempts >= 6) {
        throw error;
      }
      unknownFields.forEach(name => skippedUnknown.add(name));
      computedFields.forEach(name => skippedComputed.add(name));
      incompatibleFields.forEach(name => skippedIncompatible.add(name));
      attempts += 1;
    }
  }
}

function shouldReconcileMissingListings(summary = {}, runOptions = {}, environment = 'sandbox', sourceApi = 'trading') {
  const enabled = String(runOptions.ebaySandboxReconcileMissingListings ?? 'true').trim().toLowerCase() !== 'false';
  if (!enabled) return false;
  if (normalizeEnvironment(environment) !== 'sandbox') return false;
  if (sourceApi !== 'trading') return false;
  if (summary.destinationMode !== 'airtable') return false;
  const startPage = Number(summary.fetchStartPage || 0) || 0;
  const lastPage = Number(summary.fetchLastPage || 0) || 0;
  const totalPages = Math.max(1, Number(summary.fetchTotalPages || 1) || 1);
  return startPage === 1 && lastPage >= totalPages;
}

async function markMissingAirtableListingsEnded(
  airtableService,
  tableName,
  existingRows = [],
  activeKeys = new Set(),
  environment = 'sandbox',
  existingFields = new Set(),
  summary = {},
  dryRun = true,
  progressCallback = () => {}
) {
  if (!Array.isArray(existingRows) || existingRows.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  const updates = [];

  for (const row of existingRows) {
    const recordId = normalizeText(row?.id);
    const fields = row?.fields || {};
    const key = resolvePrimaryKeyFromFields(fields);
    if (!recordId || !key || activeKeys.has(key)) continue;

    const rowEnvironment = normalizeEnvironment(fields['eBay Environment'] || environment);
    if (rowEnvironment !== environment) continue;
    if (isEndedListingStatus(fields[LISTING_STATUS_FIELD])) continue;

    const nextFields = alignFieldsToExisting({
      [LISTING_STATUS_FIELD]: ENDED_LISTING_STATUS_VALUE,
      [MISSING_DETECTED_FIELD]: fields[MISSING_DETECTED_FIELD] || now
    }, existingFields);
    if (Object.keys(nextFields).length === 0) continue;
    updates.push({
      id: recordId,
      fields: nextFields
    });
  }

  summary.missingListingsMarkedEnded = Number(summary.missingListingsMarkedEnded || 0);
  summary.missingListingsMarkEndedPlanned = Number(summary.missingListingsMarkEndedPlanned || 0);
  if (updates.length === 0) return;

  if (dryRun) {
    summary.missingListingsMarkEndedPlanned += updates.length;
    return;
  }

  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    const data = await airtableService.request('PATCH', `/${encodeURIComponent(tableName)}`, {
      data: {
        records: batch,
        typecast: true
      }
    });
    summary.missingListingsMarkedEnded += Array.isArray(data?.records) ? data.records.length : 0;
    emitProgress(progressCallback, {
      stage: 'ebaysandbox_reconcile_missing',
      percent: 98,
      counts: summary,
      message:
        `Marking missing sandbox listings as ended: ` +
        `${Math.min(i + batch.length, updates.length)}/${updates.length}.`
    });
  }
}

function resolveSandboxMirrorCredentials(runOptions = {}, fallback = {}) {
  const sandboxSet =
    runOptions?.phase5EbayCredentialSets &&
    typeof runOptions.phase5EbayCredentialSets === 'object' &&
    runOptions.phase5EbayCredentialSets.sandbox &&
    typeof runOptions.phase5EbayCredentialSets.sandbox === 'object'
      ? runOptions.phase5EbayCredentialSets.sandbox
      : {};

  return {
    clientId: normalizeText(
      runOptions.phase5EbaySandboxClientId ||
        sandboxSet.phase5EbayClientId ||
        process.env.EBAY_SANDBOX_CLIENT_ID ||
        fallback.clientId ||
        process.env.EBAY_CLIENT_ID ||
        ''
    ),
    clientSecret: normalizeText(
      runOptions.phase5EbaySandboxClientSecret ||
        sandboxSet.phase5EbayClientSecret ||
        process.env.EBAY_SANDBOX_CLIENT_SECRET ||
        fallback.clientSecret ||
        process.env.EBAY_CLIENT_SECRET ||
        ''
    ),
    userAccessToken: normalizeOAuthToken(
      runOptions.phase5EbaySandboxUserAccessToken ||
        sandboxSet.phase5EbayUserAccessToken ||
        process.env.EBAY_SANDBOX_USER_ACCESS_TOKEN ||
        ''
    ),
    refreshToken: normalizeOAuthToken(
      runOptions.phase5EbaySandboxRefreshToken ||
        sandboxSet.phase5EbayRefreshToken ||
        process.env.EBAY_SANDBOX_REFRESH_TOKEN ||
        ''
    ),
    userAccessTokenIssuedAt: normalizeText(
      runOptions.phase5EbaySandboxUserAccessTokenIssuedAt ||
        sandboxSet.phase5EbayUserAccessTokenIssuedAt ||
        process.env.EBAY_SANDBOX_USER_ACCESS_TOKEN_ISSUED_AT ||
        ''
    ),
    refreshScope: normalizeText(
      runOptions.phase5EbaySandboxRefreshScope ||
        sandboxSet.phase5EbayRefreshScope ||
        process.env.EBAY_SANDBOX_REFRESH_SCOPE ||
        fallback.refreshScope ||
        process.env.EBAY_REFRESH_SCOPE ||
        ''
    )
  };
}

async function mirrorInventoryItemsToSandbox(
  inventoryItems = [],
  offersBySku = new Map(),
  runOptions = {},
  summary = {},
  progressCallback = () => {}
) {
  const mirrorDryRun = summary?.dryRun === true;
  const fallback = {
    clientId: runOptions.phase5EbayClientId || process.env.EBAY_CLIENT_ID || '',
    clientSecret: runOptions.phase5EbayClientSecret || process.env.EBAY_CLIENT_SECRET || '',
    refreshScope: runOptions.phase5EbayRefreshScope || process.env.EBAY_REFRESH_SCOPE || ''
  };
  const creds = resolveSandboxMirrorCredentials(runOptions, fallback);
  if (!creds.userAccessToken && !creds.refreshToken) {
    throw new Error(
      'Sandbox mirror requires sandbox user auth. Provide phase5EbaySandboxUserAccessToken or phase5EbaySandboxRefreshToken.'
    );
  }
  if (creds.refreshToken && (!creds.clientId || !creds.clientSecret)) {
    throw new Error(
      'Sandbox mirror refresh-token auth requires phase5EbaySandboxClientId and phase5EbaySandboxClientSecret.'
    );
  }
  const siteId = resolveSandboxMirrorTradingSiteId(runOptions);
  const httpClient = axios.create({ timeout: 30000 });
  const tokenResolution = await resolveUserAccessToken(
    httpClient,
    {
      environment: 'sandbox',
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      userAccessToken: creds.userAccessToken,
      refreshToken: creds.refreshToken,
      userAccessTokenIssuedAt: creds.userAccessTokenIssuedAt,
      refreshScope: creds.refreshScope
    },
    progressCallback
  );
  let activeAccessToken = normalizeOAuthToken(tokenResolution.accessToken || '');
  if (!activeAccessToken) {
    throw new Error('Sandbox mirror requires a valid sandbox user access token for Trading API writes.');
  }

  async function postTradingRequest(callName = '', requestXml = '', requestOptions = {}) {
    const endpoint = getTradingApiUrl('sandbox');
    const canRefresh = Boolean(creds.refreshToken && creds.clientId && creds.clientSecret);
    const requestSiteId = normalizeText(requestOptions.siteId || siteId) || siteId;
    const requestBody = String(requestXml || '');
    const contentLength = Buffer.byteLength(requestBody, 'utf8');
    const execute = async (token) => {
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await httpClient.post(endpoint, requestBody, {
            headers: {
              'X-EBAY-API-SITEID': requestSiteId,
              'X-EBAY-API-COMPATIBILITY-LEVEL': EBAY_TRADING_COMPATIBILITY_LEVEL,
              'X-EBAY-API-CALL-NAME': callName,
              'X-EBAY-API-IAF-TOKEN': token,
              'Content-Type': 'text/xml',
              'Content-Length': String(contentLength),
              Connection: 'close',
              'Accept-Encoding': 'identity'
            },
            responseType: 'text',
            transformResponse: data => data
          });
        } catch (error) {
          if (!isRetryableTransportError(error) || attempt >= maxAttempts) {
            throw error;
          }
          const waitMs = attempt * 800;
          await delay(waitMs);
        }
      }
      throw new Error('Trading API request failed after retries.');
    };

    try {
      const response = await execute(activeAccessToken);
      let responseXml = String(response?.data || '');
      if (canRefresh && isTradingInvalidIafTokenResponse(responseXml)) {
        const refreshed = await requestUserAccessTokenFromRefreshToken(httpClient, {
          environment: 'sandbox',
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          refreshToken: creds.refreshToken,
          scope: creds.refreshScope
        });
        activeAccessToken = refreshed.accessToken;
        const retryResponse = await execute(activeAccessToken);
        responseXml = String(retryResponse?.data || '');
      }
      return responseXml;
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      const tokenRejected = status === 401 || isTradingTokenValidationError(error);
      if (!(tokenRejected && canRefresh)) throw error;
      const refreshed = await requestUserAccessTokenFromRefreshToken(httpClient, {
        environment: 'sandbox',
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        refreshToken: creds.refreshToken,
        scope: creds.refreshScope
      });
      activeAccessToken = refreshed.accessToken;
      const response = await execute(activeAccessToken);
      return String(response?.data || '');
    }
  }

  const sellerProfileRequestXml = buildGetUserPreferencesProfilesRequestXml();
  const sellerProfileResponseXml = await postTradingRequest('GetUserPreferences', sellerProfileRequestXml);
  const sellerProfileAck = getTradingAck(sellerProfileResponseXml);
  if (!isTradingAckSuccess(sellerProfileAck)) {
    throw new Error(
      `Trading API GetUserPreferences failed for sandbox mirror: ${getTradingApiErrorText(sellerProfileResponseXml, `Ack=${sellerProfileAck || 'n/a'}`)}`
    );
  }
  const sellerProfiles = parseTradingSellerProfilesFromUserPreferencesResponse(sellerProfileResponseXml);
  const hasSellerProfiles = Boolean(
    sellerProfiles.paymentProfileId && sellerProfiles.returnProfileId && sellerProfiles.shippingProfileId
  );
  let defaultShippingService = '';
  if (!hasSellerProfiles) {
    const shippingDetailsRequestXml = buildGeteBayDetailsShippingServicesRequestXml();
    const shippingDetailsResponseXml = await postTradingRequest('GeteBayDetails', shippingDetailsRequestXml);
    const shippingAck = getTradingAck(shippingDetailsResponseXml);
    if (!isTradingAckSuccess(shippingAck)) {
      throw new Error(
        'Sandbox mirror could not resolve business policy profiles and Trading fallback shipping services failed: ' +
        getTradingApiErrorText(shippingDetailsResponseXml, `Ack=${shippingAck || 'n/a'}`)
      );
    }
    defaultShippingService = parseTradingDomesticShippingServiceFromDetailsResponse(shippingDetailsResponseXml);
    if (!defaultShippingService) {
      throw new Error(
        'Sandbox mirror could not resolve business policy profiles and could not find a valid domestic shipping service for legacy fallback.'
      );
    }
    summary.errors.push(
      `Sandbox mirror fallback enabled: business policy profiles not found; using legacy ShippingDetails/ReturnPolicy with service '${defaultShippingService}'.`
    );
  }

  // Sandbox helper: promote/validate test user as seller-capable to avoid add-call failures.
  try {
    const validateRequestXml = buildValidateTestUserRegistrationRequestXml();
    const validateResponseXml = await postTradingRequest('ValidateTestUserRegistration', validateRequestXml);
    const validateAck = getTradingAck(validateResponseXml);
    if (isTradingAckSuccess(validateAck)) {
      summary.errors.push('Sandbox seller validation check completed (ValidateTestUserRegistration).');
    }
  } catch (_) {}

  const defaultCountry = normalizeText(runOptions.phase5EbaySandboxCountry || runOptions.phase5EbayCountry || process.env.EBAY_SANDBOX_COUNTRY || 'US');
  const defaultCurrency = normalizeText(runOptions.phase5EbaySandboxCurrency || runOptions.phase5EbayCurrency || process.env.EBAY_SANDBOX_CURRENCY || 'USD');
  const defaultPostalCode = normalizeText(runOptions.phase5EbaySandboxPostalCode || runOptions.phase5EbayPostalCode || process.env.EBAY_SANDBOX_POSTAL_CODE || '');
  const defaultLocation = normalizeText(runOptions.phase5EbaySandboxLocation || runOptions.phase5EbayLocation || process.env.EBAY_SANDBOX_LOCATION || '');
  const configuredFallbackCategoryId = normalizeText(
    runOptions.phase5EbaySandboxFallbackCategoryId ||
    runOptions.phase5EbayFallbackCategoryId ||
    process.env.EBAY_SANDBOX_FALLBACK_CATEGORY_ID ||
    ''
  );
  const configuredDefaultConditionId = normalizeText(
    runOptions.phase5EbaySandboxDefaultConditionId ||
    runOptions.phase5EbayDefaultConditionId ||
    process.env.EBAY_SANDBOX_DEFAULT_CONDITION_ID ||
    '3000'
  );

  emitProgress(progressCallback, {
    stage: 'ebaysandbox_publish',
    percent: 72,
    counts: summary,
    message:
      `Mirroring ${inventoryItems.length} listing(s) to eBay sandbox via Trading API (AddFixedPriceItem)` +
      `${mirrorDryRun ? ' (dry run)' : ''}...`
  });

  for (let i = 0; i < inventoryItems.length; i += 1) {
    const item = inventoryItems[i] || {};
    const sku = normalizeText(item?.sku);
    const offer = sku ? offersBySku.get(sku) || {} : {};
    const fields = buildUpsertFields(
      item,
      offer,
      'sandbox',
      true,
      true,
      new Set(),
      'eBay Production Mirror'
    );
    if (!fields) {
      summary.skippedInvalidRows += 1;
      continue;
    }

    try {
      const addRequest = buildTradingAddFixedPriceItemRequestXml(item, offer, {
        siteId,
        defaultCountry,
        defaultCurrency,
        defaultPostalCode,
        defaultLocation,
        sellerProfiles: hasSellerProfiles ? sellerProfiles : {},
        defaultShippingService,
        defaultConditionId: configuredDefaultConditionId
      });
      if (!addRequest.valid) {
        summary.skippedInvalidRows += 1;
        summary.errors.push(`Sandbox mirror skipped SKU '${normalizeText(fields.SKU || '')}': ${addRequest.reason}`);
        continue;
      }
      if (mirrorDryRun) {
        summary.sandboxMirrored += 1;
        continue;
      }
      let currentSiteId = siteId;
      let currentCategoryId = normalizeText(
        item?.product?.categoryId || offer?.categoryId || item?.rawDeepListing?.categoryId || configuredFallbackCategoryId
      );
      let responseXml = await postTradingRequest('AddFixedPriceItem', addRequest.requestXml, { siteId: currentSiteId });
      let ack = getTradingAck(responseXml);

      if (!isTradingAckSuccess(ack) && hasTradingErrorCode(responseXml, ['107'])) {
        const motorsSiteId = '100';
        const motorsRetryRequest = buildTradingAddFixedPriceItemRequestXml(item, offer, {
          siteId: motorsSiteId,
          defaultCountry,
          defaultCurrency,
          defaultPostalCode,
          defaultLocation,
          sellerProfiles: hasSellerProfiles ? sellerProfiles : {},
          defaultShippingService,
          defaultConditionId: configuredDefaultConditionId
        });
        if (motorsRetryRequest.valid) {
          const motorsResponseXml = await postTradingRequest(
            'AddFixedPriceItem',
            motorsRetryRequest.requestXml,
            { siteId: motorsSiteId }
          );
          const motorsAck = getTradingAck(motorsResponseXml);
          if (isTradingAckSuccess(motorsAck)) {
            responseXml = motorsResponseXml;
            ack = motorsAck;
            currentSiteId = motorsSiteId;
            summary.errors.push(
              `Sandbox mirror retry for SKU '${normalizeText(fields.SKU || '')}': switched SiteID to 100 (eBayMotors).`
            );
          } else {
            responseXml = motorsResponseXml;
            ack = motorsAck;
            currentSiteId = motorsSiteId;
          }
        }
      }

      if (!isTradingAckSuccess(ack) && hasTradingErrorCode(responseXml, ['107'])) {
        let retryCategoryId = configuredFallbackCategoryId;
        if (!retryCategoryId) {
          const query = normalizeText(item?.product?.title || '');
          const suggestedRequestXml = buildGetSuggestedCategoriesRequestXml(query);
          if (suggestedRequestXml) {
            const suggestedResponseXml = await postTradingRequest('GetSuggestedCategories', suggestedRequestXml);
            const suggestedAck = getTradingAck(suggestedResponseXml);
            if (isTradingAckSuccess(suggestedAck)) {
              retryCategoryId = parseSuggestedCategoryIdFromResponse(suggestedResponseXml);
            }
          }
        }

        if (retryCategoryId) {
          const retryRequest = buildTradingAddFixedPriceItemRequestXml(item, offer, {
            siteId,
            defaultCountry,
            defaultCurrency,
            defaultPostalCode,
            defaultLocation,
            sellerProfiles: hasSellerProfiles ? sellerProfiles : {},
            defaultShippingService,
            overrideCategoryId: retryCategoryId,
            defaultConditionId: configuredDefaultConditionId
          });
          if (retryRequest.valid) {
            responseXml = await postTradingRequest('AddFixedPriceItem', retryRequest.requestXml, { siteId });
            ack = getTradingAck(responseXml);
            currentSiteId = siteId;
            currentCategoryId = retryCategoryId;
            summary.errors.push(
              `Sandbox mirror retry for SKU '${normalizeText(fields.SKU || '')}': category fallback used (${retryCategoryId}).`
            );
          }
        }
      }

      if (!isTradingAckSuccess(ack) && hasTradingErrorCode(responseXml, ['21916884'])) {
        const candidateConditionIds = [];
        const seeded = [
          normalizeText(item?.rawDeepListing?.conditionId || ''),
          mapConditionTextToConditionId(item?.rawDeepListing?.conditionDisplayName || ''),
          mapConditionTextToConditionId(item?.condition || ''),
          configuredDefaultConditionId
        ].filter(Boolean);
        for (const value of seeded) {
          if (!candidateConditionIds.includes(value)) candidateConditionIds.push(value);
        }

        const featuresRequestXml = buildGetCategoryFeaturesConditionRequestXml(currentCategoryId);
        if (featuresRequestXml) {
          const featuresResponseXml = await postTradingRequest('GetCategoryFeatures', featuresRequestXml, {
            siteId: currentSiteId
          });
          const featuresAck = getTradingAck(featuresResponseXml);
          if (isTradingAckSuccess(featuresAck)) {
            const validIds = parseConditionIdsFromCategoryFeaturesResponse(featuresResponseXml);
            for (const id of validIds) {
              if (!candidateConditionIds.includes(id)) candidateConditionIds.push(id);
            }
          }
        }

        for (const conditionId of candidateConditionIds) {
          const conditionRetryRequest = buildTradingAddFixedPriceItemRequestXml(item, offer, {
            siteId: currentSiteId,
            defaultCountry,
            defaultCurrency,
            defaultPostalCode,
            defaultLocation,
            sellerProfiles: hasSellerProfiles ? sellerProfiles : {},
            defaultShippingService,
            overrideCategoryId: currentCategoryId,
            overrideConditionId: conditionId,
            defaultConditionId: configuredDefaultConditionId
          });
          if (!conditionRetryRequest.valid) continue;
          const conditionResponseXml = await postTradingRequest('AddFixedPriceItem', conditionRetryRequest.requestXml, {
            siteId: currentSiteId
          });
          const conditionAck = getTradingAck(conditionResponseXml);
          responseXml = conditionResponseXml;
          ack = conditionAck;
          if (isTradingAckSuccess(conditionAck)) {
            summary.errors.push(
              `Sandbox mirror retry for SKU '${normalizeText(fields.SKU || '')}': condition retry succeeded with ConditionID=${conditionId}.`
            );
            break;
          }
        }
      }

      if (!isTradingAckSuccess(ack)) {
        throw new Error(getTradingApiErrorText(responseXml, `Ack=${ack || 'n/a'}`));
      }
      const mirroredItemId = normalizeText(extractTagValue(responseXml, 'ItemID'));
      if (!mirroredItemId) {
        const callError = getTradingApiErrorText(responseXml, `Ack=${ack || 'n/a'}`);
        throw new Error(callError || 'AddFixedPriceItem did not return ItemID.');
      }
      summary.sandboxMirrored += 1;
      if (normalizeText(ack).toLowerCase() === 'warning') {
        summary.errors.push(
          `Sandbox mirror warning for SKU '${normalizeText(fields.SKU || '')}': ${getTradingApiErrorText(responseXml, 'Ack=Warning')}`
        );
      }
    } catch (error) {
      const canCompactRetry = isRetryableTransportError(error);
      if (canCompactRetry) {
        try {
          const compactRequest = buildTradingAddFixedPriceItemRequestXml(item, offer, {
            siteId,
            defaultCountry,
            defaultCurrency,
            defaultPostalCode,
            defaultLocation,
            sellerProfiles: hasSellerProfiles ? sellerProfiles : {},
            defaultShippingService,
            compactMode: true,
            defaultConditionId: configuredDefaultConditionId
          });
          if (compactRequest.valid) {
            const compactResponseXml = await postTradingRequest('AddFixedPriceItem', compactRequest.requestXml);
            const compactAck = getTradingAck(compactResponseXml);
            if (isTradingAckSuccess(compactAck)) {
              const compactItemId = normalizeText(extractTagValue(compactResponseXml, 'ItemID'));
              if (compactItemId) {
                summary.sandboxMirrored += 1;
                summary.errors.push(
                  `Sandbox mirror retry succeeded for SKU '${normalizeText(fields.SKU || '')}' using compact payload.`
                );
                continue;
              }
            }
          }
        } catch (_) {}
      }
      summary.sandboxMirrorFailed += 1;
      summary.errors.push(`Sandbox mirror failed for SKU '${normalizeText(fields.SKU || '')}': ${formatError(error)}`);
    }

    if (i === 0 || (i + 1) % 10 === 0 || i + 1 === inventoryItems.length) {
      emitProgress(progressCallback, {
        stage: 'ebaysandbox_publish',
        percent: Math.min(98, 72 + Math.floor(((i + 1) / Math.max(1, inventoryItems.length)) * 26)),
        counts: summary,
        message:
          `Mirroring to sandbox ${i + 1}/${inventoryItems.length} ` +
          `(mirrored=${summary.sandboxMirrored}, failed=${summary.sandboxMirrorFailed}, skippedInvalid=${summary.skippedInvalidRows})`
      });
    }
  }
}

async function runEbaySandboxInventoryImport(options = {}, progressCallback = () => {}) {
  const stored = getInventoryConfig('phase2Config') || {};
  const mergedOptions = { ...stored, ...options };
  const environment = normalizeEnvironment(mergedOptions.phase5EbayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox');
  const runOptions = applyEbayCredentialsForEnvironment(mergedOptions, environment);
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
  const sourceApiMode = normalizeText(
    runOptions.ebayListingsSourceApi || process.env.EBAY_LISTINGS_SOURCE_API || 'auto'
  ).toLowerCase();
  const sourceApi =
    sourceApiMode === 'trading' || sourceApiMode === 'inventory'
      ? sourceApiMode
      : 'trading';
  const sourceLabel =
    sourceApi === 'trading'
      ? 'eBay Trading API (GetMyeBaySelling)'
      : 'eBay Inventory API';
  const requestedDestinationMode = normalizeDestinationMode(
    runOptions.ebaySandboxDestination || process.env.EBAY_SANDBOX_IMPORT_DESTINATION || '',
    environment
  );
  // Safety guard:
  // - production imports should mirror to sandbox only
  // - sandbox imports should go to Airtable only (avoid duplicate re-create attempts in same sandbox account)
  const destinationMode = environment === 'production' ? 'sandbox' : 'airtable';
  if (environment === 'sandbox' && destinationMode === 'airtable') {
    runOptions.ebaySandboxFetchPagingMode = DEFAULT_FETCH_PAGING_MODE;
    runOptions.ebaySandboxFetchMode = DEFAULT_FETCH_PAGING_MODE;
  }
  const writeToAirtable = destinationMode === 'airtable' || destinationMode === 'both';
  const writeToSandbox = destinationMode === 'sandbox' || destinationMode === 'both';
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
  const tradingSiteId = normalizeText(
    runOptions.phase5EbaySiteId || process.env.EBAY_TRADING_SITE_ID || EBAY_TRADING_DEFAULT_SITE_ID
  ) || EBAY_TRADING_DEFAULT_SITE_ID;
  const rulesLogicBaseId = normalizeText(
    runOptions.rulesLogicBaseId ||
      process.env.AIRTABLE_RULES_LOGIC_BASE_ID ||
      process.env.RULES_LOGIC_BASE_ID ||
      stored.rulesLogicBaseId ||
      airtableBaseId
  );
  const rulesLogicTableName = resolveRulesLogicTableName(
    runOptions.phase4RulesTableName ||
      runOptions.phase4RulesDriveFile ||
      stored.phase4RulesTableName ||
      stored.phase4RulesDriveFile ||
      process.env.PHASE4_RULES_TABLE ||
      'Rule Logic'
  );
  const rulesLogicAllowlistByPrefix = new Map();
  const getRulesLogicAllowlistForPrefix = async prefix => {
    const key = normalizeText(prefix).toUpperCase();
    if (rulesLogicAllowlistByPrefix.has(key)) return rulesLogicAllowlistByPrefix.get(key);
    const context = await loadRulesLogicAllowlist(
      new AirtableService({ token: airtableToken, baseId: rulesLogicBaseId }),
      rulesLogicTableName,
      prefix
    );
    rulesLogicAllowlistByPrefix.set(key, context);
    return context;
  };

  if (writeToAirtable && !airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (writeToAirtable && !airtableBaseId) throw new Error('Missing AIRTABLE_BASE_ID.');
  if (refreshToken && (!clientId || !clientSecret)) {
    throw new Error('Refresh-token auth requires eBay App ID (Client ID) and eBay Cert ID (Client Secret).');
  }
  if (sourceApi === 'trading' && !userAccessToken && !refreshToken) {
    throw new Error(
      'Trading API import requires eBay user access auth. Provide eBay Refresh Token (recommended) or user access token.'
    );
  }
  if (sourceApi === 'inventory' && !userAccessToken && !refreshToken) {
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
    sourceApi,
    sourceLabel,
    fetchPagingMode: normalizeFetchPagingMode(runOptions.ebaySandboxFetchPagingMode || runOptions.ebaySandboxFetchMode),
    fetchStartPage: 1,
    fetchLastPage: 0,
    fetchTotalPages: 1,
    fetchNextPage: 1,
    destinationMode,
    tradingSiteId,
    tradingPagesFetched: 0,
    inventoryItemsFetched: 0,
    offersFetched: 0,
    ebaySandboxBatchIpns: [],
    ebaySandboxBatchSkus: [],
    recordsPlanned: 0,
    recordsWritten: 0,
    skippedInvalidRows: 0,
    skippedAlreadyPublished: 0,
    removedAlreadyPublished: 0,
    missingListingsMarkedEnded: 0,
    missingListingsMarkEndedPlanned: 0,
    skippedAlreadyUpToDate: 0,
    skippedStagingUnchanged: 0,
    sandboxMirrored: 0,
    sandboxMirrorFailed: 0,
    fieldsCreated: 0,
    tableCreated: false,
    rulesLogicSpecificsFilteredRecords: 0,
    rulesLogicSpecificsSkippedFields: 0,
    errors: []
  };

  emitProgress(progressCallback, {
    stage: 'ebaysandbox_auth',
    percent: 5,
    counts: summary,
    message: userAccessToken || refreshToken
      ? `Resolving eBay ${environment} user access token for ${sourceLabel}...`
      : `Authenticating with eBay ${environment} for ${sourceLabel}...`
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
    if (sourceApi === 'trading') {
      throw new Error(
        'Trading API import requires a user access token. Provide eBay refresh token (recommended) or user access token.'
      );
    }
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
    message:
      sourceApi === 'trading'
        ? `Fetching active listings from eBay ${environment} via Trading API...`
        : `Fetching inventory items from eBay ${environment}...`
  });
  let inventoryItems = [];
  let offersBySku = new Map();
  if (sourceApi === 'trading') {
    const includeGetItemDetails = String(runOptions.ebayTradingIncludeGetItemDetails ?? 'true').trim().toLowerCase() !== 'false';
    try {
      if (includeGetItemDetails) {
        const listingSyncResult = await runEbayListingSync(
          {
            ...runOptions,
            phase5EbayEnvironment: environment,
            phase5EbayClientId: clientId,
            phase5EbayClientSecret: clientSecret,
            phase5EbayUserAccessToken: activeAccessToken,
            phase5EbayRefreshToken: refreshToken,
            phase5EbayRefreshScope: refreshScope,
            phase5EbaySiteId: tradingSiteId,
            maxBulkListings: fetchLimit,
            getItemConcurrency: Number(runOptions.ebayTradingGetItemConcurrency || runOptions.getItemConcurrency || 3) || 3
          },
          progressCallback
        );
        const collections = buildTradingImportCollections(listingSyncResult, fetchLimit);
        inventoryItems = collections.inventoryItems;
        offersBySku = collections.offersBySku;
        summary.inventoryItemsFetched = Number(listingSyncResult?.summary?.totalBulkListings || inventoryItems.length) || inventoryItems.length;
        summary.deepListingsFetched =
          Number(listingSyncResult?.summary?.totalDeepListingsFetched || inventoryItems.length) || inventoryItems.length;
        summary.failedGetItemCount =
          Number(listingSyncResult?.summary?.failedGetItemCount || 0) || 0;
        summary.fetchPagingMode = normalizeFetchPagingMode(
          listingSyncResult?.summary?.fetchPagingMode || runOptions.ebaySandboxFetchPagingMode
        );
        summary.fetchStartPage = Number(listingSyncResult?.summary?.startPage || 1) || 1;
        summary.fetchLastPage = Number(listingSyncResult?.summary?.lastFetchedPage || 0) || 0;
        summary.fetchTotalPages = Number(listingSyncResult?.summary?.totalPages || 1) || 1;
        summary.fetchNextPage = Number(listingSyncResult?.summary?.nextPage || summary.fetchStartPage || 1) || 1;
        summary.offersFetched = offersBySku.size;
        emitProgress(progressCallback, {
          stage: 'ebaysandbox_fetch_offers',
          percent: 68,
          counts: summary,
          message:
            `Fetched deep listing details via GetItem. Deep=${summary.deepListingsFetched || 0}, ` +
            `Failed=${summary.failedGetItemCount || 0}, ` +
            `PageStart=${summary.fetchStartPage || 1}, PageLast=${summary.fetchLastPage || 0}, NextPage=${summary.fetchNextPage || 1}.`
        });
      } else {
        const tradingResult = await fetchTradingActiveListings(
          httpClient,
          { environment, fetchLimit, pageSize, tradingSiteId },
          activeAccessToken,
          summary,
          progressCallback
        );
        inventoryItems = tradingResult.inventoryItems;
        offersBySku = tradingResult.offersBySku;
        summary.tradingPagesFetched = Number(tradingResult.pagesFetched || 0) || 0;
        summary.fetchStartPage = 1;
        summary.fetchLastPage = summary.tradingPagesFetched;
        summary.fetchTotalPages = Math.max(1, Number(tradingResult.totalPages || 1) || 1);
        summary.fetchNextPage = summary.fetchLastPage >= summary.fetchTotalPages ? 1 : summary.fetchLastPage + 1;
      }
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      const canRefresh = Boolean(refreshToken && clientId && clientSecret);
      const tokenRejected = status === 401 || isTradingTokenValidationError(error);
      if (!(tokenRejected && canRefresh)) {
        throw error;
      }
      emitProgress(progressCallback, {
        stage: 'ebaysandbox_auth',
        percent: 9,
        counts: summary,
        message: `Trading API token rejected in ${environment}; refreshing token and retrying...`
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
      if (includeGetItemDetails) {
        const listingSyncResult = await runEbayListingSync(
          {
            ...runOptions,
            phase5EbayEnvironment: environment,
            phase5EbayClientId: clientId,
            phase5EbayClientSecret: clientSecret,
            phase5EbayUserAccessToken: activeAccessToken,
            phase5EbayRefreshToken: refreshToken,
            phase5EbayRefreshScope: refreshScope,
            phase5EbaySiteId: tradingSiteId,
            maxBulkListings: fetchLimit,
            getItemConcurrency: Number(runOptions.ebayTradingGetItemConcurrency || runOptions.getItemConcurrency || 3) || 3
          },
          progressCallback
        );
        const collections = buildTradingImportCollections(listingSyncResult, fetchLimit);
        inventoryItems = collections.inventoryItems;
        offersBySku = collections.offersBySku;
        summary.inventoryItemsFetched = Number(listingSyncResult?.summary?.totalBulkListings || inventoryItems.length) || inventoryItems.length;
        summary.deepListingsFetched =
          Number(listingSyncResult?.summary?.totalDeepListingsFetched || inventoryItems.length) || inventoryItems.length;
        summary.failedGetItemCount =
          Number(listingSyncResult?.summary?.failedGetItemCount || 0) || 0;
        summary.fetchPagingMode = normalizeFetchPagingMode(
          listingSyncResult?.summary?.fetchPagingMode || runOptions.ebaySandboxFetchPagingMode
        );
        summary.fetchStartPage = Number(listingSyncResult?.summary?.startPage || 1) || 1;
        summary.fetchLastPage = Number(listingSyncResult?.summary?.lastFetchedPage || 0) || 0;
        summary.fetchTotalPages = Number(listingSyncResult?.summary?.totalPages || 1) || 1;
        summary.fetchNextPage = Number(listingSyncResult?.summary?.nextPage || summary.fetchStartPage || 1) || 1;
        summary.offersFetched = offersBySku.size;
        emitProgress(progressCallback, {
          stage: 'ebaysandbox_fetch_offers',
          percent: 68,
          counts: summary,
          message:
            `Fetched deep listing details via GetItem. Deep=${summary.deepListingsFetched || 0}, ` +
            `Failed=${summary.failedGetItemCount || 0}, ` +
            `PageStart=${summary.fetchStartPage || 1}, PageLast=${summary.fetchLastPage || 0}, NextPage=${summary.fetchNextPage || 1}.`
        });
      } else {
        const tradingResult = await fetchTradingActiveListings(
          httpClient,
          { environment, fetchLimit, pageSize, tradingSiteId },
          activeAccessToken,
          summary,
          progressCallback
        );
        inventoryItems = tradingResult.inventoryItems;
        offersBySku = tradingResult.offersBySku;
        summary.tradingPagesFetched = Number(tradingResult.pagesFetched || 0) || 0;
        summary.fetchStartPage = 1;
        summary.fetchLastPage = summary.tradingPagesFetched;
        summary.fetchTotalPages = Math.max(1, Number(tradingResult.totalPages || 1) || 1);
        summary.fetchNextPage = summary.fetchLastPage >= summary.fetchTotalPages ? 1 : summary.fetchLastPage + 1;
      }
    }
  } else {
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
    offersBySku = await fetchOfferIndex(
      httpClient,
      { environment, fetchLimit, pageSize },
      activeAccessToken,
      summary,
      progressCallback,
      inventoryItems.map(item => normalizeText(item?.sku))
    );
  }

  summary.ebaySandboxBatchSkus = Array.from(
    new Set(
      (inventoryItems || [])
        .map(item => normalizeText(item?.sku))
        .filter(Boolean)
    )
  );
  summary.ebaySandboxBatchIpns = Array.from(
    new Set(
      (inventoryItems || [])
        .map(item => normalizeText(extractBatchInterchangeIpn(item)).toUpperCase())
        .filter(Boolean)
    )
  );

  if (writeToAirtable) {
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
    if (!hasFieldByNormalizedName(ensure.existingFields, PRIMARY_KEY_FIELD)) {
      throw new Error(
        `Airtable table '${tableName}' is missing required column '${PRIMARY_KEY_FIELD}'. Add it once, then re-run import.`
      );
    }
    summary.tableCreated = Boolean(ensure.createdTable);
    summary.fieldsCreated = Array.isArray(ensure.createdFields) ? ensure.createdFields.length : 0;
    const hasIpnField = hasFieldByNormalizedName(ensure.existingFields, IPN_FIELD);
    const hasLegacyPrimaryField = hasFieldByNormalizedName(ensure.existingFields, LEGACY_PRIMARY_KEY_FIELD);
    const payloadHashFieldName = normalizeText(
      runOptions.phase5PayloadHashFieldName || process.env.PHASE5_PAYLOAD_HASH_FIELD || 'Payload Hash'
    );
    const hasPayloadHashField = payloadHashFieldName
      ? hasFieldByNormalizedName(ensure.existingFields, payloadHashFieldName)
      : false;
    const existingPayloadHashByRecordKey = new Map();
    let publishedIdentityValues = Array.isArray(runOptions.phase5PublishedIdentities)
      ? runOptions.phase5PublishedIdentities
      : [];
    let publishedPayloadHashValues = Array.isArray(runOptions.phase5PublishedPayloadHashes)
      ? runOptions.phase5PublishedPayloadHashes
      : [];
    if (publishedIdentityValues.length === 0 && publishedPayloadHashValues.length === 0) {
      try {
        const logService = new Phase5PublishLogService({
          enabled: runOptions.phase5SheetsLogEnabled ?? 'false',
          spreadsheetId: runOptions.phase5SheetsLogSpreadsheetId || '',
          tabName: runOptions.phase5SheetsLogTabName || 'Log',
          authContext: runOptions.phase5SheetsLogAuthContext || 'inventory'
        });
        if (logService.isConfigured()) {
          const state = await logService.fetchPublishedState();
          publishedIdentityValues = Array.isArray(state?.identities) ? state.identities : [];
          publishedPayloadHashValues = Array.isArray(state?.payloadHashes) ? state.payloadHashes : [];
        }
      } catch (_) {}
    }
    const publishedIdentitySet = asIdentitySet(publishedIdentityValues);
    const publishedPayloadHashSet = new Set(
      publishedPayloadHashValues.map(value => normalizeText(value)).filter(Boolean)
    );
    const payloadHashFields = parseCsvList(runOptions.phase5PayloadHashFields || '');

    const airtableService = new AirtableService({ token: airtableToken, baseId: airtableBaseId });
    const existingRecordFieldsByKey = new Map();
    const existingRecordRowsByKey = new Map();
    let existingRows = [];
    try {
      const existingSelectFields = [
        PRIMARY_KEY_FIELD,
        LEGACY_PRIMARY_KEY_FIELD,
        payloadHashFieldName,
        'Item Specifics',
        'Item Specifics - All C: values relevant to item',
        'Item ID',
        'eBay Environment',
        LISTING_STATUS_FIELD,
        MISSING_DETECTED_FIELD
      ].filter(fieldName => fieldName && hasFieldByNormalizedName(ensure.existingFields, fieldName));
      existingRows = await airtableService.fetchAllRecords(
        tableName,
        existingSelectFields
      );
      for (const row of existingRows) {
        const existingFields = row?.fields || {};
        const recordKey = resolvePrimaryKeyFromFields(existingFields);
        if (!recordKey) continue;
        existingRecordFieldsByKey.set(recordKey, existingFields);
        const rowsForKey = existingRecordRowsByKey.get(recordKey) || [];
        rowsForKey.push(row);
        existingRecordRowsByKey.set(recordKey, rowsForKey);
        if (hasPayloadHashField) {
          const hash = normalizeText(existingFields[payloadHashFieldName]);
          if (!hash) continue;
          existingPayloadHashByRecordKey.set(recordKey, hash);
        }
      }
    } catch (_) {}

    async function deleteExistingPublishedRowsByKey(recordKey, reason = 'published') {
      const key = normalizeText(recordKey);
      if (!key || dryRun) return 0;
      const rowsForKey = existingRecordRowsByKey.get(key) || [];
      let deleted = 0;
      for (const existingRow of rowsForKey) {
        const recordId = normalizeText(existingRow?.id);
        if (!recordId) continue;
        try {
          await airtableService.deleteRecord(tableName, recordId);
          deleted += 1;
          summary.removedAlreadyPublished += 1;
        } catch (error) {
          const detail =
            error?.response?.data?.error?.message ||
            error?.response?.data?.error ||
            error?.message ||
            String(error);
          if (summary.errors.length < 100) {
            summary.errors.push(
              `delete_published_import_row_failed key='${key}' record='${recordId}' reason='${reason}': ${detail}`
            );
          }
        }
      }
      if (deleted > 0) {
        existingRecordRowsByKey.delete(key);
        existingRecordFieldsByKey.delete(key);
        existingPayloadHashByRecordKey.delete(key);
      }
      return deleted;
    }

    const activeRecordKeys = new Set(
      (inventoryItems || [])
        .map(item => normalizeText(item?.sku))
        .filter(Boolean)
    );
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
        ensure.existingFields,
        sourceLabel
      );
      if (!fields) {
        summary.skippedInvalidRows += 1;
        continue;
      }

      if (writeToAirtable) {
        const ipn = normalizeText(fields['IPN (Interchange Part Number)'] || extractBatchInterchangeIpn(item));
        const prefix = parseRulesLogicPrefixFromIpn(ipn);
        const itemSpecificsObject = parseJsonObject(fields['Item Specifics']) || {};
        const cSpecificsObject = parseJsonObject(fields['Item Specifics - All C: values relevant to item']) || {};
        const allowlistContext = await getRulesLogicAllowlistForPrefix(prefix);
        const filteredPayloads = buildFilteredSpecificsPayloads(
          itemSpecificsObject,
          cSpecificsObject,
          allowlistContext
        );
        if (filteredPayloads.skippedNames.length > 0) {
          summary.rulesLogicSpecificsFilteredRecords += 1;
          summary.rulesLogicSpecificsSkippedFields += filteredPayloads.skippedNames.length;
          if (summary.errors.length < 30) {
            summary.errors.push(
              `Rules Logic filtered import specifics ipn='${ipn || 'n/a'}' prefix='${prefix || 'ALL'}' skipped='${filteredPayloads.skippedNames.slice(0, 8).join(', ')}'`
            );
          }
        }
        fields['Item Specifics'] = stringifyJsonObject(filteredPayloads.itemSpecifics);
        fields['Item Specifics - All C: values relevant to item'] = stringifyJsonObject(filteredPayloads.cSpecifics);
        const recordKey = resolvePrimaryKeyFromFields(fields);
        const preservedSpecifics = preserveExistingSpecifics(
          fields,
          existingRecordFieldsByKey.get(recordKey)
        );
        fields['Item Specifics'] = preservedSpecifics['Item Specifics'];
        fields['Item Specifics - All C: values relevant to item'] =
          preservedSpecifics['Item Specifics - All C: values relevant to item'];
      }
      const recordKey = resolvePrimaryKeyFromFields(fields);

      if (isPublishedIdentity(fields, publishedIdentitySet)) {
        summary.skippedAlreadyPublished += 1;
        await deleteExistingPublishedRowsByKey(recordKey, 'published_identity');
        continue;
      }

      const payloadHash = buildListingPayloadHash(fields, {
        includeFieldNames: payloadHashFields,
        categoryIdField: 'eBay Category ID',
        titleField: 'Title',
        descriptionField: 'Description',
        itemSpecificsField: 'Item Specifics',
        quantityField: 'Quantity',
        priceField: 'Price'
      });
      const hashCandidates = new Set(payloadHash ? [payloadHash] : []);
      if (payloadHashFields.length === 0) {
        const compatHash = buildListingPayloadHash(fields, {
          categoryIdField: 'eBay Category ID',
          titleField: 'Title',
          descriptionField: ECOMMERCE_DESC_FIELD,
          itemSpecificsField: 'Item Specifics'
        });
        if (compatHash) hashCandidates.add(compatHash);
        const legacyHash = buildListingPayloadHash(fields, {
          categoryIdField: 'eBay Category ID',
          descriptionField: ECOMMERCE_DESC_FIELD,
          itemSpecificsField: 'Item Specifics'
        });
        if (legacyHash) hashCandidates.add(legacyHash);
      }
      const stagingHash = normalizeText(existingPayloadHashByRecordKey.get(recordKey));

      if (Array.from(hashCandidates).some(hash => publishedPayloadHashSet.has(hash))) {
        summary.skippedAlreadyUpToDate += 1;
        await deleteExistingPublishedRowsByKey(recordKey, 'published_payload_hash');
        continue;
      }
      if (stagingHash && hashCandidates.has(stagingHash)) {
        summary.skippedStagingUnchanged += 1;
        continue;
      }
      if (hasPayloadHashField && payloadHash) {
        fields[payloadHashFieldName] = payloadHash;
        if (recordKey) {
          existingPayloadHashByRecordKey.set(recordKey, payloadHash);
        }
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
            `(planned=${summary.recordsPlanned}, written=${summary.recordsWritten}, skippedInvalid=${summary.skippedInvalidRows}, ` +
            `skippedPublished=${summary.skippedAlreadyPublished}, skippedUpToDate=${summary.skippedAlreadyUpToDate}, ` +
            `stagingUnchanged=${summary.skippedStagingUnchanged})`
        });
      }
    }

    if (records.length > 0) {
      await flushBatch(airtableService, tableName, records.splice(0, records.length), summary, dryRun);
    }

    if (shouldReconcileMissingListings(summary, runOptions, environment, sourceApi)) {
      await markMissingAirtableListingsEnded(
        airtableService,
        tableName,
        existingRows,
        activeRecordKeys,
        environment,
        ensure.existingFields,
        summary,
        dryRun,
        progressCallback
      );
    } else if (environment === 'sandbox' && sourceApi === 'trading') {
      summary.errors.push(
        `Skipped missing-listing reconciliation because the active listing fetch was not a complete page-1 fetch ` +
        `(startPage=${summary.fetchStartPage || 1}, lastPage=${summary.fetchLastPage || 0}, totalPages=${summary.fetchTotalPages || 1}).`
      );
    }
  }

  if (writeToSandbox) {
    await mirrorInventoryItemsToSandbox(inventoryItems, offersBySku, runOptions, summary, progressCallback);
  }

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: summary,
    message:
      `eBay ${environment} inventory import completed (${dryRun ? 'dry run' : 'write run'}). ` +
      `FetchMode=${summary.fetchPagingMode || 'first_page'}, StartPage=${summary.fetchStartPage || 1}, ` +
      `LastPage=${summary.fetchLastPage || 0}, NextPage=${summary.fetchNextPage || 1}.`
  });
  return summary;
}

module.exports = {
  runEbaySandboxInventoryImport,
  runEbayListingSync
};
