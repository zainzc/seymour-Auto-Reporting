const AirtableService = require('./airtableService');

const EBAY_TOKENS_BASE_ID = 'appYfME2eQXGcnPRP';
const EBAY_TOKENS_TABLE_ID = 'tblAI42Cr5hQztPVC';
const EBAY_TOKEN_KEY = 'PRODUCTION_DEFAULT';
const TOKEN_FIELDS = ['Refresh Token'];

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeCredentialSet(raw = {}) {
  return {
    ...(raw || {}),
    phase5EbayUserAccessToken: normalizeText(raw.phase5EbayUserAccessToken || ''),
    phase5EbayRefreshToken: normalizeText(raw.phase5EbayRefreshToken || '')
  };
}

async function fetchProductionTokenRecord({ airtableToken, AirtableServiceClass = AirtableService }) {
  const service = new AirtableServiceClass({
    token: airtableToken,
    baseId: EBAY_TOKENS_BASE_ID
  });
  const records = await service.fetchRecordsByFormula(
    EBAY_TOKENS_TABLE_ID,
    `{Token Key}="${EBAY_TOKEN_KEY}"`,
    TOKEN_FIELDS,
    1
  );
  return Array.isArray(records) && records.length > 0 ? records[0] : null;
}

async function resyncProductionEbayCredentialsFromAirtable({
  airtableToken,
  currentConfig = {},
  AirtableServiceClass = AirtableService,
  saveConfig
} = {}) {
  const token = normalizeText(airtableToken || currentConfig.airtableToken || process.env.AIRTABLE_TOKEN || '');
  if (!token) {
    return {
      success: false,
      updated: false,
      message: 'Airtable token is missing. Save the Airtable token before resyncing eBay credentials.'
    };
  }

  const record = await fetchProductionTokenRecord({
    airtableToken: token,
    AirtableServiceClass
  });
  if (!record) {
    return {
      success: false,
      updated: false,
      message: `No Airtable eBay OAuth Tokens record found for Token Key ${EBAY_TOKEN_KEY}.`
    };
  }

  const fields = record.fields || {};
  const refreshToken = normalizeText(fields['Refresh Token']);
  const missing = [];
  if (!refreshToken) missing.push('Refresh Token');
  if (missing.length > 0) {
    return {
      success: false,
      updated: false,
      message: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing in Airtable. Current eBay credentials were not overwritten.`
    };
  }

  const sets =
    currentConfig.phase5EbayCredentialSets && typeof currentConfig.phase5EbayCredentialSets === 'object'
      ? currentConfig.phase5EbayCredentialSets
      : {};
  const production = normalizeCredentialSet(sets.production || {});
  if (production.phase5EbayRefreshToken === refreshToken) {
    return {
      success: true,
      updated: false,
      message: 'Credentials are already up to date.'
    };
  }

  const nextProduction = normalizeCredentialSet({
    ...production,
    phase5EbayRefreshToken: refreshToken
  });
  const nextConfig = {
    ...currentConfig,
    phase5EbayCredentialSets: {
      ...sets,
      production: nextProduction
    }
  };

  if (typeof saveConfig === 'function') {
    await saveConfig(nextConfig);
  }

  return {
    success: true,
    updated: true,
    message: 'eBay credentials updated successfully.',
    credentials: {
      phase5EbayRefreshToken: refreshToken
    }
  };
}

module.exports = {
  EBAY_TOKENS_BASE_ID,
  EBAY_TOKENS_TABLE_ID,
  EBAY_TOKEN_KEY,
  TOKEN_FIELDS,
  resyncProductionEbayCredentialsFromAirtable
};
