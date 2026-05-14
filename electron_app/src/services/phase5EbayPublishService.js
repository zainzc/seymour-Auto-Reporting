const axios = require('axios');
const { retryWithBackoff } = require('../utils/retry');

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeOAuthToken(value) {
  return normalizeText(value)
    .replace(/^bearer\s+/i, '')
    .replace(/^['"]+|['"]+$/g, '');
}

function normalizeFieldKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function getFieldValueByName(fields = {}, name = '') {
  if (!fields || typeof fields !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name];
  const target = normalizeFieldKey(name);
  if (!target) return '';
  const key = Object.keys(fields).find(item => normalizeFieldKey(item) === target);
  if (!key) return '';
  return fields[key];
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

function firstNonEmptyField(fields = {}, candidates = []) {
  for (const name of Array.isArray(candidates) ? candidates : []) {
    const key = normalizeText(name);
    if (!key) continue;
    const value = normalizeText(fields?.[key]);
    if (value) return value;
  }
  return '';
}

function parseNumberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = normalizeText(value).replace(/,/g, '');
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIntegerValue(value, minimum = 0) {
  const parsed = parseNumberValue(value);
  if (!Number.isFinite(parsed)) return null;
  const intValue = Math.trunc(parsed);
  return intValue < minimum ? minimum : intValue;
}

function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = normalizeText(value).toLowerCase();
  if (!text) return defaultValue;
  if (['true', '1', 'yes', 'y', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(text)) return false;
  return defaultValue;
}

function normalizeCondition(value) {
  const text = normalizeText(value);
  if (!text) return '';
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

const SUPPORTED_CONDITION_ENUMS = new Set([
  'NEW',
  'LIKE_NEW',
  'NEW_OTHER',
  'NEW_WITH_DEFECTS',
  'CERTIFIED_REFURBISHED',
  'EXCELLENT_REFURBISHED',
  'VERY_GOOD_REFURBISHED',
  'GOOD_REFURBISHED',
  'SELLER_REFURBISHED',
  'PRE_OWNED_EXCELLENT',
  'USED_EXCELLENT',
  'PRE_OWNED_FAIR',
  'USED_VERY_GOOD',
  'USED_GOOD',
  'USED_ACCEPTABLE',
  'FOR_PARTS_OR_NOT_WORKING'
]);

const CONDITION_ID_TO_ENUM = new Map([
  [1000, 'NEW'],
  [1500, 'NEW_OTHER'],
  [1750, 'NEW_WITH_DEFECTS'],
  [2000, 'CERTIFIED_REFURBISHED'],
  [2010, 'EXCELLENT_REFURBISHED'],
  [2020, 'VERY_GOOD_REFURBISHED'],
  [2030, 'GOOD_REFURBISHED'],
  [2500, 'SELLER_REFURBISHED'],
  [2750, 'LIKE_NEW'],
  [2990, 'PRE_OWNED_EXCELLENT'],
  [3000, 'USED_EXCELLENT'],
  [3010, 'PRE_OWNED_FAIR'],
  [4000, 'USED_VERY_GOOD'],
  [5000, 'USED_GOOD'],
  [6000, 'USED_ACCEPTABLE'],
  [7000, 'FOR_PARTS_OR_NOT_WORKING']
]);

const CONDITION_TEXT_TO_ENUM = new Map([
  ['BRAND_NEW', 'NEW'],
  ['NEW', 'NEW'],
  ['NEW_OTHER', 'NEW_OTHER'],
  ['OPEN_BOX', 'NEW_OTHER'],
  ['NEW_WITH_DEFECTS', 'NEW_WITH_DEFECTS'],
  ['CERTIFIED_REFURBISHED', 'CERTIFIED_REFURBISHED'],
  ['EXCELLENT_REFURBISHED', 'EXCELLENT_REFURBISHED'],
  ['VERY_GOOD_REFURBISHED', 'VERY_GOOD_REFURBISHED'],
  ['GOOD_REFURBISHED', 'GOOD_REFURBISHED'],
  ['SELLER_REFURBISHED', 'SELLER_REFURBISHED'],
  ['LIKE_NEW', 'LIKE_NEW'],
  ['PRE_OWNED_EXCELLENT', 'PRE_OWNED_EXCELLENT'],
  ['PRE_OWNED_FAIR', 'PRE_OWNED_FAIR'],
  ['USED_EXCELLENT', 'USED_EXCELLENT'],
  ['USED_VERY_GOOD', 'USED_VERY_GOOD'],
  ['USED_GOOD', 'USED_GOOD'],
  ['USED_ACCEPTABLE', 'USED_ACCEPTABLE'],
  ['USED', 'USED_GOOD'],
  ['FOR_PARTS_OR_NOT_WORKING', 'FOR_PARTS_OR_NOT_WORKING'],
  ['FOR_PARTS', 'FOR_PARTS_OR_NOT_WORKING'],
  ['NOT_WORKING', 'FOR_PARTS_OR_NOT_WORKING']
]);

function deriveInventoryConditionEnum(listingFields = {}) {
  const conditionId = parseIntegerValue(
    firstNonEmptyField(listingFields, ['Condition ID', 'ConditionID']),
    0
  );
  if (Number.isFinite(conditionId) && CONDITION_ID_TO_ENUM.has(conditionId)) {
    return CONDITION_ID_TO_ENUM.get(conditionId);
  }

  const token = normalizeCondition(
    firstNonEmptyField(listingFields, ['Condition', 'Condition Display Name', 'condition'])
  );
  if (!token) return '';
  if (SUPPORTED_CONDITION_ENUMS.has(token)) return token;
  if (CONDITION_TEXT_TO_ENUM.has(token)) return CONDITION_TEXT_TO_ENUM.get(token);
  return '';
}

function normalizeDimensionUnit(value) {
  const text = normalizeText(value).toUpperCase();
  if (!text) return 'INCH';
  if (text === 'IN' || text === 'INCH' || text === 'INCHES') return 'INCH';
  if (text === 'CM' || text === 'CENTIMETER' || text === 'CENTIMETERS') return 'CENTIMETER';
  return text;
}

function normalizeWeightUnit(value) {
  const text = normalizeText(value).toUpperCase();
  if (!text) return 'POUND';
  if (text === 'LB' || text === 'LBS' || text === 'POUND' || text === 'POUNDS') return 'POUND';
  if (text === 'KG' || text === 'KGS' || text === 'KILOGRAM' || text === 'KILOGRAMS') return 'KILOGRAM';
  return text;
}

const LISTING_PUBLISH_TITLE_FIELD = 'Item Title';
const LISTING_PUBLISH_DESCRIPTION_FIELD = 'Item Description';

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = normalizeText(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_) {}
  return null;
}

function toStringList(value) {
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (item && typeof item === 'object') {
        const url =
          normalizeText(item.url || item.thumbnails?.full?.url || item.thumbnails?.large?.url || '');
        if (url) {
          out.push(url);
          continue;
        }
      }
      const text = normalizeText(item);
      if (text) out.push(text);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const url =
      normalizeText(value.url || value.thumbnails?.full?.url || value.thumbnails?.large?.url || '');
    if (url) return [url];
    const candidate = normalizeText(value.name || value.label || value.value || '');
    return candidate ? [candidate] : [];
  }
  const text = normalizeText(value);
  if (!text) return [];

  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('"') && text.endsWith('"'))) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map(item => normalizeText(item)).filter(Boolean);
      }
      const single = normalizeText(parsed);
      return single ? [single] : [];
    } catch (_) {}
  }

  return text
    .split(/[\n,]+/)
    .map(part => normalizeText(part))
    .filter(Boolean);
}

function mergeAspect(aspects = {}, name = '', rawValue = null) {
  const aspectName = normalizeText(name);
  if (!aspectName) return;
  const values = toStringList(rawValue);
  if (values.length === 0) return;
  const existing = Array.isArray(aspects[aspectName]) ? aspects[aspectName] : [];
  const seen = new Set(existing.map(item => normalizeFieldKey(item)));
  for (const value of values) {
    const key = normalizeFieldKey(value);
    if (!key || seen.has(key)) continue;
    existing.push(value);
    seen.add(key);
  }
  if (existing.length > 0) {
    aspects[aspectName] = existing;
  }
}

function parseLegacySpecificsText(text = '') {
  const parsed = parseJsonObject(text);
  if (parsed) {
    const out = {};
    for (const [name, value] of Object.entries(parsed)) {
      const normalizedName = normalizeCSpecificAspectName(name) || normalizeText(name);
      mergeAspect(out, normalizedName, value);
    }
    return out;
  }
  const out = {};
  for (const rawLine of normalizeText(text).split('\n')) {
    const line = normalizeText(rawLine);
    if (!line || !line.includes(':')) continue;
    const index = line.indexOf(':');
    const rawName = normalizeText(line.slice(0, index));
    const name = normalizeCSpecificAspectName(rawName) || rawName;
    const value = normalizeText(line.slice(index + 1));
    if (!name || !value) continue;
    mergeAspect(out, name, value);
  }
  return out;
}

function parseImageUrlsFromListing(fields = {}) {
  const imageFieldCandidates = ['Image', 'Image URLs', 'Image URL', 'ImageUrls', 'imageUrls', 'Picture URLs'];
  for (const fieldName of imageFieldCandidates) {
    const rawValue = getFieldValueByName(fields, fieldName);
    const parsed = toStringList(rawValue);
    if (parsed.length > 0) return parsed;
  }

  const rawItem = parseJsonObject(fields['Raw eBay Item JSON']);
  const rawDeep = parseJsonObject(fields['Raw eBay Offer JSON']);
  const candidates = [
    rawItem?.rawDeepListing?.pictureUrls,
    rawItem?.pictureUrls,
    rawItem?.product?.imageUrls,
    rawDeep?.product?.imageUrls
  ];
  for (const candidate of candidates) {
    const urls = toStringList(candidate);
    if (urls.length > 0) return urls;
  }
  return [];
}

const C_SPECIFIC_SKIP_FIELDS = new Set([
  'c: partshunter203 ebay motors conditions & options',
  'c: partshunter203 ebay motors condition and options',
  'c: partshunter203 ebay motors e commerce description',
  'c: partshunter203 ebay motors store category'
]);

function normalizeCSpecificAspectName(fieldName = '') {
  const text = normalizeText(fieldName);
  if (!text) return '';
  return normalizeText(text.replace(/^c:\s*/i, ''));
}

function shouldSkipCSpecificField(fieldName = '') {
  const normalized = normalizeFieldKey(fieldName);
  if (!normalized) return true;
  if (!normalized.startsWith('c:')) return true;
  return C_SPECIFIC_SKIP_FIELDS.has(normalized);
}

function buildAspectsFromListing(fields = {}) {
  const aspects = {};
  // Priority source: legacy C-specifics bundle from Phase 4 enrichment.
  const legacySpecifics = parseLegacySpecificsText(fields['Item Specifics - All C: values relevant to item']);
  for (const [name, value] of Object.entries(legacySpecifics)) {
    mergeAspect(aspects, name, value);
  }

  const itemSpecificsObject = parseJsonObject(fields['Item Specifics']);
  if (itemSpecificsObject) {
    for (const [name, value] of Object.entries(itemSpecificsObject)) {
      mergeAspect(aspects, name, value);
    }
  }

  // Auto-include enriched Item Specifics columns from Airtable (`C:*`) into eBay aspects.
  for (const [fieldName, rawValue] of Object.entries(fields || {})) {
    if (shouldSkipCSpecificField(fieldName)) continue;
    const aspectName = normalizeCSpecificAspectName(fieldName);
    if (!aspectName) continue;
    mergeAspect(aspects, aspectName, rawValue);
  }

  const mappings = [
    ['Brand', ['Brand']],
    ['Manufacturer Part Number', ['Manufacturer Part Number', 'c: partshunter203 ebay MOTORS manufacturer part number']],
    ['Interchange Part Number', ['Interchange Part Number', 'IPN (Interchange Part Number)', 'c: partshunter203 ebay MOTORS interchange part number']],
    ['Part Number', ['Part Number', 'c: partshunter203 ebay MOTORS part number']],
    ['Warranty', ['Warranty']],
    ['Type', ['Type']],
    ['Placement on Vehicle', ['Placement on Vehicle']],
    ['Material', ['Material']],
    ['VIN #', ['VIN #', 'VIN Number']]
  ];

  for (const [aspectName, candidates] of mappings) {
    const value = firstNonEmptyField(fields, candidates);
    if (value) mergeAspect(aspects, aspectName, value);
  }

  return aspects;
}

function buildPackageWeightAndSize(fields = {}) {
  const length = parseNumberValue(firstNonEmptyField(fields, ['Package Length']));
  const width = parseNumberValue(firstNonEmptyField(fields, ['Package Width']));
  const height = parseNumberValue(firstNonEmptyField(fields, ['Package Height']));
  const dimensionUnit = normalizeDimensionUnit(
    firstNonEmptyField(fields, ['Package Dimension Unit', 'Dimensions Unit', 'Dimension Unit'])
  );
  const weightValue = parseNumberValue(firstNonEmptyField(fields, ['Package Weight']));
  const weightUnit = normalizeWeightUnit(firstNonEmptyField(fields, ['Package Weight Unit']));

  const output = {};
  if (Number.isFinite(length) && Number.isFinite(width) && Number.isFinite(height)) {
    output.dimensions = {
      length,
      width,
      height,
      unit: dimensionUnit
    };
  }
  if (Number.isFinite(weightValue)) {
    output.weight = {
      value: weightValue,
      unit: weightUnit
    };
  }
  return Object.keys(output).length > 0 ? output : null;
}

function formatEbayError(error) {
  const status = Number(error?.response?.status || 0);
  const data = error?.response?.data;
  const details = Array.isArray(data?.errors)
    ? data.errors
        .map(entry => normalizeText(entry?.message || entry?.longMessage || entry?.errorId || ''))
        .filter(Boolean)
    : [];
  const summary =
    details.join(' | ') ||
    normalizeText(data?.error_description || data?.message || data?.error || error?.message || String(error));
  return status > 0 ? `HTTP ${status}: ${summary}` : summary;
}

const EBAY_INVENTORY_SCOPE_CANDIDATES = [
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.inventory'
];
const EBAY_TRADING_COMPATIBILITY_LEVEL = '1271';
const EBAY_TRADING_DEFAULT_SITE_ID = '0';
const EBAY_TRADING_MOTORS_SITE_ID = '100';
const USER_ACCESS_TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function escapeXml(value = '') {
  const text = String(value || '');
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildTradingItemSpecificsXml(aspects = {}) {
  if (!aspects || typeof aspects !== 'object') return '';
  let body = '';
  for (const [name, rawValues] of Object.entries(aspects)) {
    const aspectName = normalizeText(name);
    if (!aspectName) continue;
    const values = Array.isArray(rawValues)
      ? rawValues.map(value => normalizeText(value)).filter(Boolean)
      : [normalizeText(rawValues)].filter(Boolean);
    if (values.length === 0) continue;
    body += '<NameValueList>';
    body += `<Name>${escapeXml(aspectName)}</Name>`;
    for (const value of values) {
      body += `<Value>${escapeXml(value)}</Value>`;
    }
    body += '</NameValueList>';
  }
  return body ? `<ItemSpecifics>${body}</ItemSpecifics>` : '';
}

function buildTradingPictureDetailsXml(imageUrls = []) {
  const urls = (Array.isArray(imageUrls) ? imageUrls : [])
    .map(value => normalizeText(value))
    .filter(Boolean)
    .slice(0, 24);
  if (urls.length === 0) return '';
  let body = '<PictureDetails>';
  for (const url of urls) {
    body += `<PictureURL>${escapeXml(url)}</PictureURL>`;
  }
  body += '</PictureDetails>';
  return body;
}

function extractXmlTagValue(xml = '', tagName = '') {
  const source = String(xml || '');
  const tag = normalizeText(tagName);
  if (!source || !tag) return '';
  const match = source.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return normalizeText(match?.[1] || '');
}

function extractXmlErrorMessages(xml = '') {
  const source = String(xml || '');
  if (!source) return [];
  const out = [];
  const blocks = source.match(/<Errors(?:\s[^>]*)?>[\s\S]*?<\/Errors>/gi) || [];
  for (const block of blocks) {
    const code = extractXmlTagValue(block, 'ErrorCode');
    const longMessage = extractXmlTagValue(block, 'LongMessage');
    const shortMessage = extractXmlTagValue(block, 'ShortMessage');
    const detail = longMessage || shortMessage;
    if (code && detail) out.push(`${code}: ${detail}`);
    else if (detail) out.push(detail);
    else if (code) out.push(code);
  }
  return out;
}

function hasInvalidIafTokenError(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  return list.some(message => normalizeText(message).includes('21916984'));
}

function hasCategoryInvalidError(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  return list.some(message => normalizeText(message).includes('107:'));
}

function hasConditionNotApplicableError(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  return list.some(message => normalizeText(message).includes('21917121'));
}

function buildTradingSiteFallbackOrder(initialSiteId = '') {
  const normalized = normalizeText(initialSiteId);
  const ordered = [];
  const pushUnique = (siteId) => {
    const value = normalizeText(siteId);
    if (!value || ordered.includes(value)) return;
    ordered.push(value);
  };

  if (normalized === EBAY_TRADING_DEFAULT_SITE_ID) {
    pushUnique(EBAY_TRADING_DEFAULT_SITE_ID);
    pushUnique(EBAY_TRADING_MOTORS_SITE_ID);
    return ordered;
  }
  if (normalized === EBAY_TRADING_MOTORS_SITE_ID) {
    pushUnique(EBAY_TRADING_MOTORS_SITE_ID);
    pushUnique(EBAY_TRADING_DEFAULT_SITE_ID);
    return ordered;
  }

  pushUnique(normalized);
  pushUnique(EBAY_TRADING_DEFAULT_SITE_ID);
  pushUnique(EBAY_TRADING_MOTORS_SITE_ID);
  return ordered;
}

class Phase5EbayPublishService {
  constructor(config = {}) {
    this.publishApiUrl = normalizeText(config.publishApiUrl || process.env.EBAY_PUBLISH_API_URL || '');
    this.publishApiKey = normalizeText(config.publishApiKey || process.env.EBAY_PUBLISH_API_KEY || '');
    this.ebayEnvironment =
      normalizeText(config.ebayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox').toLowerCase() === 'production'
        ? 'production'
        : 'sandbox';
    this.ebayClientId = normalizeText(config.ebayClientId || process.env.EBAY_CLIENT_ID || '');
    this.ebayDevId = normalizeText(config.ebayDevId || process.env.EBAY_DEV_ID || '');
    this.ebayClientSecret = normalizeText(config.ebayClientSecret || process.env.EBAY_CLIENT_SECRET || '');
    this.ebayRuName = normalizeText(config.ebayRuName || process.env.EBAY_RUNAME || '');
    this.ebayUserAccessToken = normalizeOAuthToken(config.ebayUserAccessToken || process.env.EBAY_USER_ACCESS_TOKEN || '');
    this.ebayRefreshToken = normalizeOAuthToken(config.ebayRefreshToken || process.env.EBAY_REFRESH_TOKEN || '');
    this.ebayRefreshScope = normalizeText(config.ebayRefreshScope || process.env.EBAY_REFRESH_SCOPE || '');
    this.ebayUserAccessTokenIssuedAt = normalizeText(
      config.ebayUserAccessTokenIssuedAt || process.env.EBAY_USER_ACCESS_TOKEN_ISSUED_AT || ''
    );
    this.allowProductionPublish = parseBoolean(
      typeof config.allowProductionPublish !== 'undefined'
        ? config.allowProductionPublish
        : process.env.PHASE5_ALLOW_PRODUCTION_PUBLISH,
      true
    );
    this.timeoutMs = Math.max(5000, Number(config.timeoutMs || process.env.EBAY_PUBLISH_TIMEOUT_MS || 30000) || 30000);
    this.maxAttempts = Math.max(1, Number(config.maxAttempts || process.env.EBAY_PUBLISH_MAX_ATTEMPTS || 2) || 2);
    this.baseDelayMs = Math.max(200, Number(config.baseDelayMs || 500) || 500);

    this.client = axios.create({
      timeout: this.timeoutMs
    });
  }

  getIdentityTokenUrl() {
    return this.ebayEnvironment === 'production'
      ? 'https://api.ebay.com/identity/v1/oauth2/token'
      : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';
  }

  getSellApiBase() {
    return this.ebayEnvironment === 'production'
      ? 'https://api.ebay.com'
      : 'https://api.sandbox.ebay.com';
  }

  getTradingApiUrl() {
    return this.ebayEnvironment === 'production'
      ? 'https://api.ebay.com/ws/api.dll'
      : 'https://api.sandbox.ebay.com/ws/api.dll';
  }

  getItemId(listingFields = {}, schema = {}) {
    const itemIdField = normalizeText(schema.itemIdField || '');
    return firstNonEmptyField(listingFields, [itemIdField, 'eBay Item ID', 'Ebay Item ID', 'Item ID', 'ItemID']);
  }

  getSku(listingFields = {}, schema = {}) {
    const skuField = normalizeText(schema.skuField || '');
    return firstNonEmptyField(listingFields, [skuField, 'SKU', 'Sku', 'sku']);
  }

  buildInventoryPayload(record = {}, schema = {}) {
    const listingFields = record?.fields || {};
    const sku = this.getSku(listingFields, schema);
    if (!sku) {
      throw new Error('Missing SKU. Phase 5 direct eBay publish requires SKU.');
    }

    const title = normalizeText(getFieldValueByName(listingFields, LISTING_PUBLISH_TITLE_FIELD));
    const description = normalizeText(getFieldValueByName(listingFields, LISTING_PUBLISH_DESCRIPTION_FIELD));
    const condition = deriveInventoryConditionEnum(listingFields);
    const conditionDescription = firstNonEmptyField(listingFields, ['Condition Description', 'conditionDescription']);
    const quantity = parseIntegerValue(firstNonEmptyField(listingFields, ['Quantity', 'AvailableQuantity']), 0);
    const locale = firstNonEmptyField(listingFields, ['Locale', 'locale']) || 'en_US';
    const aspects = buildAspectsFromListing(listingFields);
    const packageWeightAndSize = buildPackageWeightAndSize(listingFields);
    const imageUrls = parseImageUrlsFromListing(listingFields);

    const payload = {
      locale
    };
    if (condition) {
      payload.condition = condition;
    }
    if (conditionDescription) {
      payload.conditionDescription = conditionDescription;
    }
    if (Number.isFinite(quantity)) {
      payload.availability = {
        shipToLocationAvailability: {
          quantity
        }
      };
    }
    if (packageWeightAndSize) {
      payload.packageWeightAndSize = packageWeightAndSize;
    }

    const product = {};
    if (title) product.title = title;
    if (description) product.description = description;
    if (Object.keys(aspects).length > 0) product.aspects = aspects;
    if (imageUrls.length > 0) product.imageUrls = imageUrls;
    if (Object.keys(product).length > 0) {
      payload.product = product;
    }

    return {
      sku,
      itemId: this.getItemId(listingFields, schema),
      payload
    };
  }

  resolveTradingSiteId(record = {}) {
    const listingFields = record?.fields || {};
    const explicit = firstNonEmptyField(listingFields, ['Site ID', 'SiteID', 'eBay Site ID']);
    if (explicit && /^\d+$/.test(explicit)) {
      return explicit;
    }
    const siteText = normalizeText(firstNonEmptyField(listingFields, ['Site', 'Marketplace Site'])).toLowerCase();
    if (siteText === 'ebaymotors' || siteText === 'ebay motors') {
      return EBAY_TRADING_MOTORS_SITE_ID;
    }
    return EBAY_TRADING_DEFAULT_SITE_ID;
  }

  buildReviseFixedPriceItemXml(prepared = {}) {
    const itemId = normalizeText(prepared?.itemId);
    const sku = normalizeText(prepared?.sku);
    const title = normalizeText(prepared?.payload?.product?.title);
    const description = normalizeText(prepared?.payload?.product?.description);
    const itemSpecificsXml = buildTradingItemSpecificsXml(prepared?.payload?.product?.aspects || {});
    const pictureDetailsXml = buildTradingPictureDetailsXml(prepared?.payload?.product?.imageUrls || []);
    if (!itemId) {
      throw new Error('Missing Item ID. Trading API revise requires Item ID for existing listing update.');
    }
    if (!title && !description && !itemSpecificsXml && !pictureDetailsXml) {
      throw new Error(
        `Missing publish content for SKU '${sku || 'unknown'}'. Populate title, description, item specifics, and/or images before publish.`
      );
    }

    const itemLines = [`<ItemID>${escapeXml(itemId)}</ItemID>`];
    if (title) itemLines.push(`<Title>${escapeXml(title.slice(0, 80))}</Title>`);
    if (description) itemLines.push(`<Description>${escapeXml(description)}</Description>`);
    if (itemSpecificsXml) itemLines.push(itemSpecificsXml);
    if (pictureDetailsXml) itemLines.push(pictureDetailsXml);

    return (
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
      `<ErrorLanguage>en_US</ErrorLanguage>` +
      `<WarningLevel>High</WarningLevel>` +
      `<Item>${itemLines.join('')}</Item>` +
      `</ReviseFixedPriceItemRequest>`
    );
  }

  buildReviseItemXml(prepared = {}) {
    const itemId = normalizeText(prepared?.itemId);
    const sku = normalizeText(prepared?.sku);
    const title = normalizeText(prepared?.payload?.product?.title);
    const description = normalizeText(prepared?.payload?.product?.description);
    const itemSpecificsXml = buildTradingItemSpecificsXml(prepared?.payload?.product?.aspects || {});
    const pictureDetailsXml = buildTradingPictureDetailsXml(prepared?.payload?.product?.imageUrls || []);
    if (!itemId) {
      throw new Error('Missing Item ID. Trading API revise requires Item ID for existing listing update.');
    }
    if (!title && !description && !itemSpecificsXml && !pictureDetailsXml) {
      throw new Error(
        `Missing publish content for SKU '${sku || 'unknown'}'. Populate title, description, item specifics, and/or images before publish.`
      );
    }

    const itemLines = [`<ItemID>${escapeXml(itemId)}</ItemID>`];
    if (title) itemLines.push(`<Title>${escapeXml(title.slice(0, 80))}</Title>`);
    if (description) itemLines.push(`<Description>${escapeXml(description)}</Description>`);
    if (itemSpecificsXml) itemLines.push(itemSpecificsXml);
    if (pictureDetailsXml) itemLines.push(pictureDetailsXml);

    return (
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
      `<ErrorLanguage>en_US</ErrorLanguage>` +
      `<WarningLevel>High</WarningLevel>` +
      `<Item>${itemLines.join('')}</Item>` +
      `</ReviseItemRequest>`
    );
  }

  async requestUserAccessTokenFromRefreshToken() {
    if (!this.ebayClientId) throw new Error('Missing eBay App ID / Client ID for refresh_token flow.');
    if (!this.ebayClientSecret) throw new Error('Missing eBay Cert ID / Client Secret for refresh_token flow.');
    if (!this.ebayRefreshToken) throw new Error('Missing eBay Refresh Token.');

    const tokenUrl = this.getIdentityTokenUrl();
    const basic = Buffer.from(`${this.ebayClientId}:${this.ebayClientSecret}`).toString('base64');
    const body = new URLSearchParams();
    body.append('grant_type', 'refresh_token');
    body.append('refresh_token', this.ebayRefreshToken);
    if (this.ebayRefreshScope) {
      body.append('scope', this.ebayRefreshScope);
    }

    const response = await this.client.post(tokenUrl, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`
      }
    });
    const accessToken = normalizeOAuthToken(response?.data?.access_token);
    const tokenType = normalizeText(response?.data?.token_type);
    const expiresIn = Number(response?.data?.expires_in || 0) || 0;
    if (!accessToken) {
      throw new Error('eBay credential test failed: refresh_token response did not include access token.');
    }
    this.ebayUserAccessToken = accessToken;
    this.ebayUserAccessTokenIssuedAt = new Date().toISOString();
    return {
      accessToken,
      tokenType,
      expiresIn,
      issuedAt: this.ebayUserAccessTokenIssuedAt
    };
  }

  async ensureUserAccessToken() {
    const issuedAtMs = parseEpochMs(this.ebayUserAccessTokenIssuedAt);
    const tokenAgeMs = issuedAtMs > 0 ? Math.max(0, Date.now() - issuedAtMs) : Number.MAX_SAFE_INTEGER;
    const tokenIsFresh = Boolean(this.ebayUserAccessToken) && issuedAtMs > 0 && tokenAgeMs < USER_ACCESS_TOKEN_MAX_AGE_MS;

    if (this.ebayUserAccessToken) {
      return {
        accessToken: this.ebayUserAccessToken,
        refreshed: false,
        issuedAt: this.ebayUserAccessTokenIssuedAt,
        expiresIn: 0,
        tokenType: 'Bearer',
        tokenFresh: tokenIsFresh
      };
    }

    if (this.ebayRefreshToken && this.ebayClientId && this.ebayClientSecret) {
      const refreshed = await this.requestUserAccessTokenFromRefreshToken();
      return {
        accessToken: refreshed.accessToken,
        refreshed: true,
        issuedAt: refreshed.issuedAt,
        expiresIn: refreshed.expiresIn,
        tokenType: refreshed.tokenType || 'Bearer'
      };
    }

    return {
      accessToken: this.ebayUserAccessToken,
      refreshed: false,
      issuedAt: this.ebayUserAccessTokenIssuedAt,
      expiresIn: 0,
      tokenType: 'Bearer'
    };
  }

  async testCredentials() {
    if (this.ebayUserAccessToken || this.ebayRefreshToken) {
      const resolved = await this.ensureUserAccessToken();
      if (!resolved.accessToken) {
        throw new Error(
          'eBay credential test failed: missing user access token. Provide user token directly or add refresh token + client credentials.'
        );
      }
      const base = this.getSellApiBase();
      let response;
      let finalToken = resolved.accessToken;
      let refreshedInRetry = false;
      try {
        response = await this.client.get(`${base}/sell/inventory/v1/inventory_item`, {
          params: { limit: 1 },
          headers: {
            Authorization: `Bearer ${finalToken}`,
            Accept: 'application/json'
          }
        });
      } catch (error) {
        const status = Number(error?.response?.status || 0);
        if (status !== 401 || !this.ebayRefreshToken || !this.ebayClientId || !this.ebayClientSecret) {
          throw error;
        }
        const refreshed = await this.requestUserAccessTokenFromRefreshToken();
        finalToken = refreshed.accessToken;
        refreshedInRetry = true;
        response = await this.client.get(`${base}/sell/inventory/v1/inventory_item`, {
          params: { limit: 1 },
          headers: {
            Authorization: `Bearer ${finalToken}`,
            Accept: 'application/json'
          }
        });
      }
      const status = Number(response?.status || 0);
      if (status < 200 || status >= 300) {
        throw new Error(`eBay credential test failed with status ${status || 'n/a'}.`);
      }
      return {
        success: true,
        environment: this.ebayEnvironment,
        authMode: 'user_access_token',
        refreshed: resolved.refreshed === true || refreshedInRetry,
        issuedAt: this.ebayUserAccessTokenIssuedAt || resolved.issuedAt || '',
        expiresIn: Number(resolved.expiresIn || 0) || 0,
        userAccessToken: finalToken,
        inventoryEndpoint: `${base}/sell/inventory/v1/inventory_item`
      };
    }

    if (!this.ebayClientId) throw new Error('Missing eBay App ID / Client ID.');
    if (!this.ebayDevId) throw new Error('Missing eBay Dev ID.');
    if (!this.ebayClientSecret) throw new Error('Missing eBay Cert ID / Client Secret.');
    if (!this.ebayRuName) throw new Error('Missing eBay RuName.');

    const tokenUrl = this.getIdentityTokenUrl();
    const basic = Buffer.from(`${this.ebayClientId}:${this.ebayClientSecret}`).toString('base64');

    let lastScopeError = null;
    let acceptedScope = '';
    let response = null;

    for (const scope of EBAY_INVENTORY_SCOPE_CANDIDATES) {
      const body = new URLSearchParams();
      body.append('grant_type', 'client_credentials');
      body.append('scope', scope);
      try {
        response = await this.client.post(tokenUrl, body.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basic}`
          }
        });
        acceptedScope = scope;
        break;
      } catch (error) {
        const status = Number(error?.response?.status || 0);
        const code = normalizeText(error?.response?.data?.error).toLowerCase();
        if (status === 400 && code === 'invalid_scope') {
          lastScopeError = error;
          continue;
        }
        throw error;
      }
    }

    if (!response) {
      if (lastScopeError) {
        throw new Error(
          'eBay credential test failed: invalid_scope with client_credentials. For Inventory API, use a user access token.'
        );
      }
      throw new Error('eBay credential test failed: token response not received.');
    }

    const status = Number(response?.status || 0);
    if (status < 200 || status >= 300) {
      throw new Error(`eBay credential test failed with status ${status || 'n/a'}.`);
    }

    const tokenType = normalizeText(response?.data?.token_type);
    const expiresIn = Number(response?.data?.expires_in || 0) || 0;
    const accessToken = normalizeText(response?.data?.access_token);
    if (!accessToken) {
      throw new Error('eBay credential test failed: access token not returned.');
    }

    return {
      success: true,
      environment: this.ebayEnvironment,
      authMode: 'client_credentials',
      tokenUrl,
      scope: acceptedScope,
      tokenType,
      expiresIn
    };
  }

  async publishRecord(record = {}, schema = {}, options = {}) {
    const dryRun = options?.dryRun === true;
    const prepared = this.buildInventoryPayload(record, schema);
    const siteId = this.resolveTradingSiteId(record);
    const tradingEndpoint = this.getTradingApiUrl();
    const tradingXml = this.buildReviseFixedPriceItemXml(prepared);
    const reviseItemXml = this.buildReviseItemXml(prepared);

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        operation: 'revise_fixed_price_item',
        itemId: prepared.itemId || '',
        sku: prepared.sku,
        response: {
          simulated: true,
          endpoint: tradingEndpoint,
          siteId,
          callName: 'ReviseFixedPriceItem',
          payloadXml: tradingXml
        }
      };
    }

    const resolved = await this.ensureUserAccessToken();
    if (!resolved.accessToken) {
      throw new Error('Missing eBay user access token for direct trading publish.');
    }

    const endpoint = tradingEndpoint;
    let finalToken = resolved.accessToken;
    let finalSiteId = normalizeText(siteId) || EBAY_TRADING_DEFAULT_SITE_ID;
    const canRefresh = this.ebayRefreshToken && this.ebayClientId && this.ebayClientSecret;
    const postTradingRevise = async (accessToken, requestSiteId, callName, requestXml) =>
      retryWithBackoff(
        async () =>
          this.client.post(endpoint, requestXml, {
            responseType: 'text',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'text/xml',
              Accept: 'text/xml',
              'X-EBAY-API-COMPATIBILITY-LEVEL': EBAY_TRADING_COMPATIBILITY_LEVEL,
              'X-EBAY-API-CALL-NAME': callName,
              'X-EBAY-API-SITEID': requestSiteId,
              'X-EBAY-API-IAF-TOKEN': accessToken
            }
          }),
        {
          maxAttempts: this.maxAttempts,
          baseDelayMs: this.baseDelayMs
        }
      );

    let response;
    try {
      response = await postTradingRevise(finalToken, finalSiteId, 'ReviseFixedPriceItem', tradingXml);
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      if (status === 401 && canRefresh) {
        const refreshed = await this.requestUserAccessTokenFromRefreshToken();
        finalToken = refreshed.accessToken;
        response = await postTradingRevise(finalToken, finalSiteId, 'ReviseFixedPriceItem', tradingXml);
      } else {
        throw new Error(`eBay trading revise failed for SKU '${prepared.sku}': ${formatEbayError(error)}`);
      }
    }

    const status = Number(response?.status || 0);
    if (status < 200 || status >= 300) {
      throw new Error(`eBay trading revise failed for SKU '${prepared.sku}' with status ${status || 'n/a'}.`);
    }

    const responseXml = String(response?.data || '');
    const ack = extractXmlTagValue(responseXml, 'Ack');
    const xmlMessages = extractXmlErrorMessages(responseXml);
    let isSuccessAck = ['Success', 'Warning'].includes(ack);
    if (!isSuccessAck && hasInvalidIafTokenError(xmlMessages) && canRefresh) {
      const refreshed = await this.requestUserAccessTokenFromRefreshToken();
      finalToken = refreshed.accessToken;
      response = await postTradingRevise(finalToken, finalSiteId, 'ReviseFixedPriceItem', tradingXml);
      const retriedXml = String(response?.data || '');
      const retriedAck = extractXmlTagValue(retriedXml, 'Ack');
      const retriedMessages = extractXmlErrorMessages(retriedXml);
      if (!['Success', 'Warning'].includes(retriedAck)) {
        const detail = retriedMessages.join(' | ') || `Ack=${retriedAck || 'Unknown'}`;
        throw new Error(`eBay trading revise failed for SKU '${prepared.sku}': ${detail}`);
      }
      return {
        success: true,
        dryRun: false,
        operation: 'revise_fixed_price_item',
        itemId: prepared.itemId || '',
        sku: prepared.sku,
        response: {
          ack: retriedAck,
          messages: retriedMessages,
          raw: retriedXml
        }
      };
    }
    if (!isSuccessAck && (hasCategoryInvalidError(xmlMessages) || hasConditionNotApplicableError(xmlMessages))) {
      const fallbackAttempts = [];
      const attemptedKeys = new Set();
      const appendAttempt = (callName, requestSiteId, xml, tag) => {
        const normalizedSiteId = normalizeText(requestSiteId);
        if (!callName || !normalizedSiteId || !xml) return;
        const key = `${callName}:${normalizedSiteId}`;
        if (attemptedKeys.has(key)) return;
        attemptedKeys.add(key);
        fallbackAttempts.push({ callName, siteId: normalizedSiteId, xml, tag });
      };

      const siteFallbackOrder = buildTradingSiteFallbackOrder(finalSiteId);
      for (const requestSiteId of siteFallbackOrder) {
        const isPrimary = requestSiteId === finalSiteId;
        appendAttempt(
          'ReviseItem',
          requestSiteId,
          reviseItemXml,
          isPrimary
            ? `fallback=call_switch,siteid=${requestSiteId}`
            : `fallback=site_switch,from=${finalSiteId},to=${requestSiteId},call=ReviseItem`
        );
        appendAttempt(
          'ReviseFixedPriceItem',
          requestSiteId,
          tradingXml,
          isPrimary
            ? `fallback=retry_same_call,siteid=${requestSiteId}`
            : `fallback=site_switch,from=${finalSiteId},to=${requestSiteId},call=ReviseFixedPriceItem`
        );
      }

      let lastDetail = xmlMessages.join(' | ') || `Ack=${ack || 'Unknown'}`;
      for (const attempt of fallbackAttempts) {
        try {
          let retryResponse = await postTradingRevise(finalToken, attempt.siteId, attempt.callName, attempt.xml);
          let retryXml = String(retryResponse?.data || '');
          let retryAck = extractXmlTagValue(retryXml, 'Ack');
          let retryMessages = extractXmlErrorMessages(retryXml);

          if (!['Success', 'Warning'].includes(retryAck) && hasInvalidIafTokenError(retryMessages) && canRefresh) {
            const refreshed = await this.requestUserAccessTokenFromRefreshToken();
            finalToken = refreshed.accessToken;
            retryResponse = await postTradingRevise(finalToken, attempt.siteId, attempt.callName, attempt.xml);
            retryXml = String(retryResponse?.data || '');
            retryAck = extractXmlTagValue(retryXml, 'Ack');
            retryMessages = extractXmlErrorMessages(retryXml);
          }

          if (!['Success', 'Warning'].includes(retryAck)) {
            lastDetail = retryMessages.join(' | ') || `Ack=${retryAck || 'Unknown'}`;
            continue;
          }
          return {
            success: true,
            dryRun: false,
            operation: 'revise_fixed_price_item',
            itemId: prepared.itemId || '',
            sku: prepared.sku,
            response: {
              ack: retryAck,
              messages: [
                ...retryMessages,
                attempt.tag
              ],
              raw: retryXml
            }
          };
        } catch (attemptError) {
          const status = Number(attemptError?.response?.status || 0);
          if (status === 401 && canRefresh) {
            try {
              const refreshed = await this.requestUserAccessTokenFromRefreshToken();
              finalToken = refreshed.accessToken;
              const retryResponse = await postTradingRevise(finalToken, attempt.siteId, attempt.callName, attempt.xml);
              const retryXml = String(retryResponse?.data || '');
              const retryAck = extractXmlTagValue(retryXml, 'Ack');
              const retryMessages = extractXmlErrorMessages(retryXml);
              if (['Success', 'Warning'].includes(retryAck)) {
                return {
                  success: true,
                  dryRun: false,
                  operation: 'revise_fixed_price_item',
                  itemId: prepared.itemId || '',
                  sku: prepared.sku,
                  response: {
                    ack: retryAck,
                    messages: [
                      ...retryMessages,
                      `${attempt.tag},token_refresh_retry=1`
                    ],
                    raw: retryXml
                  }
                };
              }
              lastDetail = retryMessages.join(' | ') || `Ack=${retryAck || 'Unknown'}`;
              continue;
            } catch (refreshAttemptError) {
              lastDetail = formatEbayError(refreshAttemptError) || formatEbayError(attemptError) || lastDetail;
              continue;
            }
          }
          lastDetail = formatEbayError(attemptError) || lastDetail;
        }
      }
      throw new Error(`eBay trading revise failed for SKU '${prepared.sku}': ${lastDetail}`);
    }
    if (!isSuccessAck) {
      const detail = xmlMessages.join(' | ') || `Ack=${ack || 'Unknown'}`;
      throw new Error(`eBay trading revise failed for SKU '${prepared.sku}': ${detail}`);
    }

    return {
      success: true,
      dryRun: false,
      operation: 'revise_fixed_price_item',
      itemId: prepared.itemId || '',
      sku: prepared.sku,
      response: {
        ack,
        messages: xmlMessages,
        raw: responseXml
      }
    };
  }
}

module.exports = {
  Phase5EbayPublishService
};
