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
    .replace(/\s+/g, '_');
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
    return value.map(item => normalizeText(item)).filter(Boolean);
  }
  if (value && typeof value === 'object') {
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
  const out = {};
  for (const rawLine of normalizeText(text).split('\n')) {
    const line = normalizeText(rawLine);
    if (!line || !line.includes(':')) continue;
    const index = line.indexOf(':');
    const name = normalizeText(line.slice(0, index));
    const value = normalizeText(line.slice(index + 1));
    if (!name || !value) continue;
    mergeAspect(out, name, value);
  }
  return out;
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
  const itemSpecificsObject = parseJsonObject(fields['Item Specifics']);
  if (itemSpecificsObject) {
    for (const [name, value] of Object.entries(itemSpecificsObject)) {
      mergeAspect(aspects, name, value);
    }
  }

  const legacySpecifics = parseLegacySpecificsText(fields['Item Specifics - All C: values relevant to item']);
  for (const [name, value] of Object.entries(legacySpecifics)) {
    mergeAspect(aspects, name, value);
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
const USER_ACCESS_TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

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
      false
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

    const title = firstNonEmptyField(listingFields, [
      schema.titleField,
      'Title',
      'Product Title(New)',
      'Product Title',
      'AI Optimized Title'
    ]);
    const description = firstNonEmptyField(listingFields, [
      schema.descriptionField,
      'Item Description',
      'Description',
      'c: partshunter203 ebay MOTORS e commerce description',
      'Full listing description HTML'
    ]);
    const condition = normalizeCondition(firstNonEmptyField(listingFields, ['Condition']));
    const conditionDescription = firstNonEmptyField(listingFields, ['Condition Description', 'conditionDescription']);
    const quantity = parseIntegerValue(firstNonEmptyField(listingFields, ['Quantity', 'AvailableQuantity']), 0);
    const locale = firstNonEmptyField(listingFields, ['Locale', 'locale']) || 'en_US';
    const aspects = buildAspectsFromListing(listingFields);
    const packageWeightAndSize = buildPackageWeightAndSize(listingFields);
    const imageUrls = toStringList(firstNonEmptyField(listingFields, ['Image URLs', 'Image URL', 'ImageUrls', 'imageUrls']));

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

    if (tokenIsFresh) {
      return {
        accessToken: this.ebayUserAccessToken,
        refreshed: false,
        issuedAt: this.ebayUserAccessTokenIssuedAt,
        expiresIn: 0,
        tokenType: 'Bearer'
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

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        operation: 'upsert_inventory_item',
        itemId: prepared.itemId || '',
        sku: prepared.sku,
        response: {
          simulated: true,
          endpoint: `${this.getSellApiBase()}/sell/inventory/v1/inventory_item/${encodeURIComponent(prepared.sku)}`,
          payload: prepared.payload
        }
      };
    }

    if (this.ebayEnvironment === 'production' && !this.allowProductionPublish) {
      throw new Error(
        'Direct Phase 5 production publish is disabled. Set phase5AllowProductionPublish=true (or PHASE5_ALLOW_PRODUCTION_PUBLISH=true) to enable.'
      );
    }

    const resolved = await this.ensureUserAccessToken();
    if (!resolved.accessToken) {
      throw new Error('Missing eBay user access token for direct inventory publish.');
    }

    const endpoint = `${this.getSellApiBase()}/sell/inventory/v1/inventory_item/${encodeURIComponent(prepared.sku)}`;
    let response;
    let finalToken = resolved.accessToken;

    try {
      response = await retryWithBackoff(
        async () =>
          this.client.put(endpoint, prepared.payload, {
            headers: {
              Authorization: `Bearer ${finalToken}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'Content-Language': 'en-US'
            }
          }),
        {
          maxAttempts: this.maxAttempts,
          baseDelayMs: this.baseDelayMs
        }
      );
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      const canRefresh = this.ebayRefreshToken && this.ebayClientId && this.ebayClientSecret;
      if (status === 401 && canRefresh) {
        const refreshed = await this.requestUserAccessTokenFromRefreshToken();
        finalToken = refreshed.accessToken;
        response = await retryWithBackoff(
          async () =>
            this.client.put(endpoint, prepared.payload, {
              headers: {
                Authorization: `Bearer ${finalToken}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'Content-Language': 'en-US'
              }
            }),
          {
            maxAttempts: this.maxAttempts,
            baseDelayMs: this.baseDelayMs
          }
        );
      } else {
        throw new Error(`eBay inventory update failed for SKU '${prepared.sku}': ${formatEbayError(error)}`);
      }
    }

    const status = Number(response?.status || 0);
    if (status < 200 || status >= 300) {
      throw new Error(`eBay inventory update failed for SKU '${prepared.sku}' with status ${status || 'n/a'}.`);
    }

    return {
      success: true,
      dryRun: false,
      operation: 'upsert_inventory_item',
      itemId: prepared.itemId || '',
      sku: prepared.sku,
      response: response?.data || {}
    };
  }
}

module.exports = {
  Phase5EbayPublishService
};
