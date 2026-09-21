const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTitleOptimizationCategoryRulesIpc } = require('../src/main/titleOptimizationCategoryRulesIpc');

test('Category Rules IPC exposes only load save toggle and delete operations', async () => {
  const handlers = new Map(), calls = [];
  const repository = {
    load: async () => ({ rules: [] }), saveRule: async input => { calls.push(['save', input]); return input; },
    setRuleEnabled: async (id, enabled) => { calls.push(['toggle', id, enabled]); return { id, enabled }; },
    softDelete: async id => { calls.push(['delete', id]); return { id }; }
  };
  registerTitleOptimizationCategoryRulesIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, repository);
  assert.deepEqual([...handlers.keys()].sort(), [
    'title-optimization-category-rules:delete', 'title-optimization-category-rules:load',
    'title-optimization-category-rules:save', 'title-optimization-category-rules:toggle'
  ]);
  assert.equal((await handlers.get('title-optimization-category-rules:load')({})).success, true);
  await handlers.get('title-optimization-category-rules:save')({}, { categoryName: 'Test' });
  await handlers.get('title-optimization-category-rules:toggle')({}, 'id', false);
  await handlers.get('title-optimization-category-rules:delete')({}, 'id');
  assert.deepEqual(calls, [['save', { categoryName: 'Test' }], ['toggle', 'id', false], ['delete', 'id']]);
});

test('Category Rules IPC serializes repository errors without throwing into renderer', async () => {
  const handlers = new Map();
  registerTitleOptimizationCategoryRulesIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    load: async () => { const error = new Error('bad config'); error.code = 'CONFIG_INVALID'; error.details = [{ field: 'rule' }]; throw error; }
  });
  assert.deepEqual(await handlers.get('title-optimization-category-rules:load')({}), { success: false, error: { code: 'CONFIG_INVALID', message: 'bad config', details: [{ field: 'rule' }] } });
});
