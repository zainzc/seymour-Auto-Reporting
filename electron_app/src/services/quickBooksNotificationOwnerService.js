const AirtableService = require('./airtableService');

const STAGING_BASE_ID = 'appBCWdJiujeXGtsy';
const RUNTIME_CONFIG_TABLE = 'Automation Runtime Configuration';
const OWNER_NAME_KEY = 'quickBooks.notification.ownerName';
const OWNER_CLICKUP_ID_KEY = 'quickBooks.notification.ownerClickUpId';
const DEFAULT_ENVIRONMENT = 'SANDBOX';

function normalizeText(value = '') {
  if (Array.isArray(value)) {
    return value.map(item => normalizeText(item)).filter(Boolean).join(', ');
  }
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.name) return normalizeText(value.name);
    if (value.text) return normalizeText(value.text);
    return '';
  }
  return String(value).trim();
}

function normalizeEnvironment(value = '') {
  return normalizeText(value || DEFAULT_ENVIRONMENT).toUpperCase();
}

function buildRuntimeConfigFormula(configKey, environment) {
  return AirtableService.buildAndFormula([
    AirtableService.buildEqualsFormula('Config Key', configKey),
    AirtableService.buildEqualsFormula('Environment', normalizeEnvironment(environment))
  ]);
}

function getField(record = {}, fieldName = '') {
  return record?.fields?.[fieldName];
}

function normalizeOwnerRecord(record = null, configKey = '') {
  return {
    recordId: normalizeText(record?.id),
    configKey,
    environment: normalizeEnvironment(getField(record, 'Environment')),
    value: normalizeText(getField(record, 'Value'))
  };
}

async function findRuntimeConfigRecord(service, configKey, environment) {
  const records = await service.fetchRecordsByFormula(
    RUNTIME_CONFIG_TABLE,
    buildRuntimeConfigFormula(configKey, environment),
    ['Config Key', 'Environment', 'Value'],
    2
  );

  if (records.length > 1) {
    throw new Error(`Duplicate Runtime Configuration records found for ${configKey} in ${normalizeEnvironment(environment)}.`);
  }

  return records[0] || null;
}

async function resolveOwnerRecords(service, environment) {
  const [nameRecord, clickUpIdRecord] = await Promise.all([
    findRuntimeConfigRecord(service, OWNER_NAME_KEY, environment),
    findRuntimeConfigRecord(service, OWNER_CLICKUP_ID_KEY, environment)
  ]);

  return { nameRecord, clickUpIdRecord };
}

async function getQuickBooksNotificationOwner(options = {}) {
  const serviceFromOptions = options.airtableService;
  const token = normalizeText(options.airtableToken || process.env.QUICKBOOKS_AIRTABLE_TOKEN || process.env.AIRTABLE_TOKEN);
  const stagingBaseId = normalizeText(options.stagingBaseId || process.env.QUICKBOOKS_STAGING_BASE_ID || STAGING_BASE_ID);
  const environment = normalizeEnvironment(options.environment || process.env.QUICKBOOKS_ENVIRONMENT || DEFAULT_ENVIRONMENT);

  if (!token && !serviceFromOptions) {
    throw new Error('Airtable token is required to load notification owner configuration.');
  }

  const service = serviceFromOptions || new AirtableService({ token, baseId: stagingBaseId });
  const { nameRecord, clickUpIdRecord } = await resolveOwnerRecords(service, environment);
  const ownerName = normalizeText(getField(nameRecord, 'Value'));
  const ownerClickUpId = normalizeText(getField(clickUpIdRecord, 'Value'));

  return {
    environment,
    ownerName,
    ownerClickUpId,
    configured: Boolean(ownerName && ownerClickUpId),
    missingKeys: [
      !nameRecord ? OWNER_NAME_KEY : '',
      !clickUpIdRecord ? OWNER_CLICKUP_ID_KEY : ''
    ].filter(Boolean),
    records: {
      ownerName: normalizeOwnerRecord(nameRecord, OWNER_NAME_KEY),
      ownerClickUpId: normalizeOwnerRecord(clickUpIdRecord, OWNER_CLICKUP_ID_KEY)
    }
  };
}

async function updateQuickBooksNotificationOwner(options = {}) {
  const serviceFromOptions = options.airtableService;
  const token = normalizeText(options.airtableToken || process.env.QUICKBOOKS_AIRTABLE_TOKEN || process.env.AIRTABLE_TOKEN);
  const stagingBaseId = normalizeText(options.stagingBaseId || process.env.QUICKBOOKS_STAGING_BASE_ID || STAGING_BASE_ID);
  const environment = normalizeEnvironment(options.environment || process.env.QUICKBOOKS_ENVIRONMENT || DEFAULT_ENVIRONMENT);
  const ownerName = normalizeText(options.ownerName);
  const ownerClickUpId = normalizeText(options.ownerClickUpId);

  if (!ownerName || !ownerClickUpId) {
    throw new Error('Owner Name and ClickUp User ID are required.');
  }
  if (!token && !serviceFromOptions) {
    throw new Error('Airtable token is required to save notification owner configuration.');
  }

  const service = serviceFromOptions || new AirtableService({ token, baseId: stagingBaseId });
  const { nameRecord, clickUpIdRecord } = await resolveOwnerRecords(service, environment);
  if (!nameRecord || !clickUpIdRecord) {
    throw new Error('Notification owner configuration is incomplete.');
  }

  await service.updateRecords(
    RUNTIME_CONFIG_TABLE,
    [
      { id: nameRecord.id, fields: { Value: ownerName } },
      { id: clickUpIdRecord.id, fields: { Value: ownerClickUpId } }
    ],
    { typecast: false }
  );

  return getQuickBooksNotificationOwner({
    airtableService: service,
    environment
  });
}

module.exports = {
  DEFAULT_ENVIRONMENT,
  OWNER_CLICKUP_ID_KEY,
  OWNER_NAME_KEY,
  RUNTIME_CONFIG_TABLE,
  getQuickBooksNotificationOwner,
  updateQuickBooksNotificationOwner
};
