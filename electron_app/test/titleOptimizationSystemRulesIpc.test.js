const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTitleOptimizationSystemRulesIpc } = require('../src/main/titleOptimizationSystemRulesIpc');

test('System Rules IPC exposes read-only retrieval only', async () => {
  const handlers = new Map();
  registerTitleOptimizationSystemRulesIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, () => [{ id:'SR-01' }]);
  assert.deepEqual([...handlers.keys()], ['title-optimization-system-rules:load']);
  assert.deepEqual(await handlers.get('title-optimization-system-rules:load')({}), { success:true, data:[{ id:'SR-01' }] });
});
