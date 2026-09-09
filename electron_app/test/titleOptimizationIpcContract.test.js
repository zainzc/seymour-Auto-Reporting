const test = require('node:test');
const assert = require('node:assert/strict');

test('IPC registration exposes only safe Source Fields operations and serializes errors', async () => {
  const { registerTitleOptimizationSourceFieldsIpc } = require('../src/main/titleOptimizationSourceFieldsIpc');
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const repository = {
    load: async () => ({ mappings: [{ logicalKey: 'sku' }], fields: [], table: { name: 'eBay Listings (API)' } }),
    refreshFields: async () => {
      const error = new Error('Airtable rate limit reached.');
      error.code = 'SCHEMA_REFRESH_FAILED';
      error.current = { mappings: [{ logicalKey: 'sku' }], fields: [] };
      throw error;
    },
    save: async (mappings) => ({ mappings }),
    softDelete: async (id) => ({ deletedId: id })
  };

  registerTitleOptimizationSourceFieldsIpc(ipcMain, repository);
  assert.deepEqual([...handlers.keys()], [
    'title-optimization-source-fields:load',
    'title-optimization-source-fields:refresh',
    'title-optimization-source-fields:save',
    'title-optimization-source-fields:delete'
  ]);

  const loaded = await handlers.get('title-optimization-source-fields:load')();
  assert.equal(loaded.success, true);
  assert.equal(loaded.data.table.name, 'eBay Listings (API)');

  const failed = await handlers.get('title-optimization-source-fields:refresh')();
  assert.deepEqual(failed, {
    success: false,
    error: { code: 'SCHEMA_REFRESH_FAILED', message: 'Airtable rate limit reached.', details: null },
    current: { mappings: [{ logicalKey: 'sku' }], fields: [] }
  });

  const saved = await handlers.get('title-optimization-source-fields:save')(null, [{ logicalKey: 'sku' }]);
  assert.deepEqual(saved, { success: true, data: { mappings: [{ logicalKey: 'sku' }] } });
  const deleted = await handlers.get('title-optimization-source-fields:delete')(null, 'custom-1');
  assert.deepEqual(deleted, { success: true, data: { deletedId: 'custom-1' } });
});
