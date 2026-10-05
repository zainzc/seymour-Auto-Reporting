const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resyncProductionEbayCredentialsFromAirtable
} = require('../src/services/ebayCredentialResyncService');

function createAirtableServiceFactory(record) {
  return function AirtableServiceFake(config) {
    this.config = config;
    this.fetchRecordsByFormula = async () => {
      return record ? [{ fields: record }] : [];
    };
  };
}

test('unchanged Airtable refresh token does not save credentials', async () => {
  const saves = [];
  const result = await resyncProductionEbayCredentialsFromAirtable({
    airtableToken: 'pat-token',
    currentConfig: {
      phase5EbayCredentialSets: {
        production: {
          phase5EbayUserAccessToken: 'access-a',
          phase5EbayRefreshToken: 'refresh-a'
        }
      }
    },
    AirtableServiceClass: createAirtableServiceFactory({
      'Refresh Token': 'refresh-a'
    }),
    saveConfig: config => saves.push(config)
  });

  assert.equal(result.success, true);
  assert.equal(result.updated, false);
  assert.equal(result.message, 'Credentials are already up to date.');
  assert.equal(saves.length, 0);
});

test('missing Airtable refresh token preserves saved credentials and names missing field', async () => {
  const saves = [];
  const result = await resyncProductionEbayCredentialsFromAirtable({
    airtableToken: 'pat-token',
    currentConfig: {
      phase5EbayCredentialSets: {
        production: {
          phase5EbayUserAccessToken: 'access-a',
          phase5EbayRefreshToken: 'refresh-a'
        }
      }
    },
    AirtableServiceClass: createAirtableServiceFactory({}),
    saveConfig: config => saves.push(config)
  });

  assert.equal(result.success, false);
  assert.match(result.message, /Refresh Token is missing/);
  assert.equal(saves.length, 0);
});

test('changed Airtable refresh token updates only production refresh token credential', async () => {
  let savedConfig = null;
  const result = await resyncProductionEbayCredentialsFromAirtable({
    airtableToken: 'pat-token',
    currentConfig: {
      phase5EbayEnvironment: 'sandbox',
      phase5ListingsTable: 'eBay Listings (API)',
      phase5EbayCredentialSets: {
        sandbox: {
          phase5EbayUserAccessToken: 'sandbox-access',
          phase5EbayRefreshToken: 'sandbox-refresh'
        },
        production: {
          phase5EbayClientId: 'client',
          phase5EbayUserAccessToken: 'access-a',
          phase5EbayRefreshToken: 'refresh-a'
        }
      }
    },
    AirtableServiceClass: createAirtableServiceFactory({
      'Refresh Token': 'refresh-b'
    }),
    saveConfig: config => {
      savedConfig = config;
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.updated, true);
  assert.equal(result.message, 'eBay credentials updated successfully.');
  assert.equal(result.credentials.phase5EbayRefreshToken, 'refresh-b');
  assert.equal(savedConfig.phase5EbayEnvironment, 'sandbox');
  assert.equal(savedConfig.phase5ListingsTable, 'eBay Listings (API)');
  assert.equal(savedConfig.phase5EbayCredentialSets.sandbox.phase5EbayUserAccessToken, 'sandbox-access');
  assert.equal(savedConfig.phase5EbayCredentialSets.production.phase5EbayClientId, 'client');
  assert.equal(savedConfig.phase5EbayCredentialSets.production.phase5EbayUserAccessToken, 'access-a');
  assert.equal(savedConfig.phase5EbayCredentialSets.production.phase5EbayRefreshToken, 'refresh-b');
});

test('Airtable fetch requests only the refresh token field', async () => {
  let requestedFields = null;
  function AirtableServiceFake() {
    this.fetchRecordsByFormula = async (_tableId, _formula, fields) => {
      requestedFields = fields;
      return [{ fields: { 'Refresh Token': 'refresh-b' } }];
    };
  }

  await resyncProductionEbayCredentialsFromAirtable({
    airtableToken: 'pat-token',
    currentConfig: {
      phase5EbayCredentialSets: {
        production: {
          phase5EbayRefreshToken: 'refresh-a'
        }
      }
    },
    AirtableServiceClass: AirtableServiceFake,
    saveConfig: () => {}
  });

  assert.deepEqual(requestedFields, ['Refresh Token']);
});
