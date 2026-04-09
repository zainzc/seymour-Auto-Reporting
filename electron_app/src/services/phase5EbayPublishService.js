const axios = require('axios');
const { retryWithBackoff } = require('../utils/retry');

function normalizeText(value) {
  return String(value || '').trim();
}

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

  async testCredentials() {
    if (!this.ebayClientId) throw new Error('Missing eBay App ID / Client ID.');
    if (!this.ebayDevId) throw new Error('Missing eBay Dev ID.');
    if (!this.ebayClientSecret) throw new Error('Missing eBay Cert ID / Client Secret.');
    if (!this.ebayRuName) throw new Error('Missing eBay RuName.');

    const tokenUrl = this.getIdentityTokenUrl();
    const body = new URLSearchParams();
    body.append('grant_type', 'client_credentials');
    body.append('scope', 'https://api.ebay.com/oauth/api_scope');

    const basic = Buffer.from(`${this.ebayClientId}:${this.ebayClientSecret}`).toString('base64');
    const response = await this.client.post(tokenUrl, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`
      }
    });

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
      tokenUrl,
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
