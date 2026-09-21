const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTitleOptimizationFlagReasonsIpc } = require('../src/main/titleOptimizationFlagReasonsIpc');

test('Flag Reasons IPC exposes only load save toggle and delete operations', async () => {
  const handlers = new Map();
  const calls = [];
  const repository = {
    load: async () => ({ reasons: [] }),
    saveReason: async input => { calls.push(['save', input]); return input; },
    setReasonEnabled: async (id, enabled) => { calls.push(['toggle', id, enabled]); return { id, enabled }; },
    softDelete: async id => { calls.push(['delete', id]); return { id }; }
  };
  registerTitleOptimizationFlagReasonsIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, repository);
  assert.deepEqual([...handlers.keys()].sort(), [
    'title-optimization-flag-reasons:delete',
    'title-optimization-flag-reasons:load',
    'title-optimization-flag-reasons:save',
    'title-optimization-flag-reasons:toggle'
  ]);
  assert.equal((await handlers.get('title-optimization-flag-reasons:load')({})).success, true);
  await handlers.get('title-optimization-flag-reasons:save')({}, { reason: 'Review' });
  await handlers.get('title-optimization-flag-reasons:toggle')({}, 'id', false);
  await handlers.get('title-optimization-flag-reasons:delete')({}, 'id');
  assert.deepEqual(calls, [['save', { reason: 'Review' }], ['toggle', 'id', false], ['delete', 'id']]);
});

test('Flag Reasons IPC serializes repository errors', async () => {
  const handlers = new Map();
  registerTitleOptimizationFlagReasonsIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    load: async () => { const error = new Error('bad config'); error.code = 'CONFIG_INVALID'; throw error; }
  });
  assert.deepEqual(await handlers.get('title-optimization-flag-reasons:load')({}), {
    success: false,
    error: { code: 'CONFIG_INVALID', message: 'bad config', details: null }
  });
});
