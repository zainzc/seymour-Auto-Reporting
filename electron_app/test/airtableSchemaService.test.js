const test = require('node:test');
const assert = require('node:assert/strict');

test('listTables forwards a one-attempt policy for manual Source Fields refresh', async () => {
  const retryPath = require.resolve('../src/utils/retry');
  const servicePath = require.resolve('../src/services/airtableSchemaService');
  const originalRetry = require.cache[retryPath];
  const originalService = require.cache[servicePath];
  let receivedOptions;

  require.cache[retryPath] = {
    id: retryPath,
    filename: retryPath,
    loaded: true,
    exports: {
      sleep: async () => {},
      retryWithBackoff: async (operation, options) => {
        receivedOptions = options;
        return operation();
      }
    }
  };
  delete require.cache[servicePath];

  try {
    const AirtableSchemaService = require(servicePath);
    const service = new AirtableSchemaService({ token: 'token', baseId: 'base' });
    service.client = { request: async () => ({ data: { tables: [] } }) };
    await service.listTables({ maxAttempts: 1 });
    assert.equal(receivedOptions.maxAttempts, 1);
  } finally {
    if (originalRetry) require.cache[retryPath] = originalRetry;
    else delete require.cache[retryPath];
    if (originalService) require.cache[servicePath] = originalService;
    else delete require.cache[servicePath];
  }
});
