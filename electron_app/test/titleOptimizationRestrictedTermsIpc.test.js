const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTitleOptimizationRestrictedTermsIpc } = require('../src/main/titleOptimizationRestrictedTermsIpc');

test('Restricted Terms IPC exposes only the approved repository operations', async () => {
  const handlers = new Map();
  const calls = [];
  const repository = {
    load: async () => ({ rules: [] }),
    saveRule: async input => { calls.push(['save', input]); return input; },
    setRuleEnabled: async (id, enabled) => { calls.push(['toggle', id, enabled]); return { id, enabled }; },
    softDelete: async id => { calls.push(['delete', id]); return { id }; }
  };
  registerTitleOptimizationRestrictedTermsIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, repository);
  assert.deepEqual([...handlers.keys()].sort(), [
    'title-optimization-restricted-terms:delete', 'title-optimization-restricted-terms:load',
    'title-optimization-restricted-terms:save', 'title-optimization-restricted-terms:toggle'
  ]);
  assert.deepEqual(await handlers.get('title-optimization-restricted-terms:save')({}, { term: 'Foo' }), { success: true, data: { term: 'Foo' } });
  assert.deepEqual(await handlers.get('title-optimization-restricted-terms:toggle')({}, 'id', false), { success: true, data: { id: 'id', enabled: false } });
  assert.deepEqual(await handlers.get('title-optimization-restricted-terms:delete')({}, 'id'), { success: true, data: { id: 'id' } });
  assert.deepEqual(calls, [['save', { term: 'Foo' }], ['toggle', 'id', false], ['delete', 'id']]);
});

test('Restricted Terms IPC serializes service errors', async () => {
  const handlers = new Map();
  registerTitleOptimizationRestrictedTermsIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    load: async () => { const error = new Error('bad config'); error.code = 'CONFIG_INVALID'; throw error; }
  });
  assert.deepEqual(await handlers.get('title-optimization-restricted-terms:load')({}), {
    success: false, error: { code: 'CONFIG_INVALID', message: 'bad config', details: null }
  });
});
