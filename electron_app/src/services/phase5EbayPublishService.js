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

const EBAY_INVENTORY_SCOPE_CANDIDATES = [
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.inventory'
];
const USER_ACCESS_TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

class Phase5EbayPublishService {
  constructor(config = {}) {
    this.publishApiUrl = normalizeText(config.publishApiUrl || process.env.EBAY_PUBLISH_API_URL || '');
    this.publishApiKey = normalizeText(config.publishApiKey || process.env.EBAY_PUBLISH_API_KEY || '');
    this.ebayEnvironment = normalizeText(config.ebayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox').toLowerCase() === 'production'
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
    this.timeoutMs = Math.max(5000, Number(config.timeoutMs || process.env.EBAY_PUBLISH_TIMEOUT_MS || 30000) || 30000);
    this.maxAttempts = Math.max(1, Number(config.maxAttempts || process.env.EBAY_PUBLISH_MAX_ATTEMPTS || 2) || 2);
    this.baseDelayMs = Math.max(200, Number(config.baseDelayMs || 500) || 500);

    this.client = axios.create({
      timeout: this.timeoutMs
    });
  }

  getItemId(listingFields = {}, schema = {}) {
    const itemIdField = normalizeText(schema.itemIdField || '');
    return itemIdField ? normalizeText(listingFields[itemIdField]) : '';
  }

  detectOperation(listingFields = {}, schema = {}) {
    const itemId = this.getItemId(listingFields, schema);
    return {
      operation: 'revise',
      itemId
    };
  }

  buildPublishPayload(record = {}, schema = {}) {
    const listingFields = record?.fields || {};
    const op = this.detectOperation(listingFields, schema);
    return {
      operation: op.operation,
      itemId: op.itemId,
      airtableRecordId: normalizeText(record?.id),
      tableName: normalizeText(schema.tableName),
      listing: listingFields,
      publishContext: {
        environment: this.ebayEnvironment,
        clientId: this.ebayClientId,
        devId: this.ebayDevId,
        clientSecret: this.ebayClientSecret,
        ruName: this.ebayRuName
      }
    };
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
    const tokenIsFresh =
      Boolean(this.ebayUserAccessToken) &&
      issuedAtMs > 0 &&
      tokenAgeMs < USER_ACCESS_TOKEN_MAX_AGE_MS;

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
    const payload = this.buildPublishPayload(record, schema);
    if (!payload.itemId) {
      throw new Error('Missing ItemID for revise-only publish.');
    }
    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        operation: payload.operation,
        itemId: payload.itemId || '',
        response: { simulated: true }
      };
    }

    if (!this.publishApiUrl) {
      throw new Error('Missing eBay publish API URL (EBAY_PUBLISH_API_URL).');
    }

    const headers = {
      'Content-Type': 'application/json'
    };
    if (this.publishApiKey) {
      headers.Authorization = `Bearer ${this.publishApiKey}`;
    }

    const response = await retryWithBackoff(
      async () =>
        this.client.post(this.publishApiUrl, payload, {
          headers
        }),
      {
        maxAttempts: this.maxAttempts,
        baseDelayMs: this.baseDelayMs
      }
    );

    const status = Number(response?.status || 0);
    if (status < 200 || status >= 300) {
      throw new Error(`eBay publish API returned status ${status || 'n/a'}.`);
    }

    return {
      success: true,
      dryRun: false,
      operation: payload.operation,
      itemId:
        normalizeText(response?.data?.itemId) ||
        payload.itemId ||
        '',
      response: response?.data || {}
    };
  }
}

module.exports = {
  Phase5EbayPublishService
};
