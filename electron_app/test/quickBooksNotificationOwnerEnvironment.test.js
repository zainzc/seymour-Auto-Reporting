const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_ENVIRONMENT,
  getQuickBooksNotificationOwner,
  updateQuickBooksNotificationOwner
} = require('../src/services/quickBooksNotificationOwnerService');

test('notification owner defaults Airtable reads to Production', async () => {
  const formulas = [];
  const airtableService = {
    async fetchRecordsByFormula(_table, formula) {
      formulas.push(formula);
      return [];
    }
  };

  const owner = await getQuickBooksNotificationOwner({ airtableService, environment: 'SANDBOX' });

  assert.equal(DEFAULT_ENVIRONMENT, 'PRODUCTION');
  assert.equal(owner.environment, 'PRODUCTION');
  assert.equal(formulas.length, 2);
  assert.equal(formulas.every(formula => formula.includes('PRODUCTION')), true);
});

test('owner save updates only the two matching Production configuration Values', async () => {
  const updates = [];
  const airtableService = {
    async fetchRecordsByFormula(_table, formula) {
      if (!formula.includes('PRODUCTION')) throw new Error('Unexpected non-Production lookup');
      if (formula.includes('ownerName')) return [{ id: 'rec-owner-name', fields: { Environment: 'PRODUCTION', Value: 'Old Owner' } }];
      if (formula.includes('ownerClickUpId')) return [{ id: 'rec-owner-id', fields: { Environment: 'PRODUCTION', Value: '111' } }];
      return [];
    },
    async updateRecords(table, records, options) {
      updates.push({ table, records, options });
    }
  };

  await updateQuickBooksNotificationOwner({
    airtableService,
    environment: 'SANDBOX',
    ownerName: 'Lisa Yarosh, Gary',
    ownerClickUpId: '222, 333'
  });

  assert.deepEqual(updates, [{
    table: 'Automation Runtime Configuration',
    records: [
      { id: 'rec-owner-name', fields: { Value: 'Lisa Yarosh, Gary' } },
      { id: 'rec-owner-id', fields: { Value: '222, 333' } }
    ],
    options: { typecast: false }
  }]);
});

test('QuickBooks backend and owner UI have no Sandbox fallback', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/milestone11/index.html'), 'utf8');
  const resolver = main.slice(main.indexOf('function resolveQuickBooksEnvironment'), main.indexOf('function resolveQuickBooksAirtableToken'));
  const ownerResolver = html.slice(html.indexOf('function getQuickBooksOwnerEnvironment'), html.indexOf('async function loadQuickBooksNotificationOwner'));

  assert.match(resolver, /'PRODUCTION'/);
  assert.doesNotMatch(resolver, /SANDBOX/);
  assert.match(ownerResolver, /'PRODUCTION'/);
  assert.doesNotMatch(ownerResolver, /SANDBOX/);
});
