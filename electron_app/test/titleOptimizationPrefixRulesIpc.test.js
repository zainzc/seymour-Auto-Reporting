const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTitleOptimizationPrefixRulesIpc } = require('../src/main/titleOptimizationPrefixRulesIpc');

test('Prefix Rules IPC exposes only load, save, toggle, and soft-delete with serialized errors', async () => {
  const handlers = new Map();
  const repository = {
    load: async () => ({ rules: [], issues: [] }),
    saveRule: async input => input,
    setRuleEnabled: async (id, enabled) => ({ id, enabled }),
    softDelete: async () => { const error = Error('Protected'); error.code = 'PROTECTED_RULE'; throw error; }
  };
  registerTitleOptimizationPrefixRulesIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, repository);
  assert.deepEqual([...handlers.keys()], [
    'title-optimization-prefix-rules:load', 'title-optimization-prefix-rules:save',
    'title-optimization-prefix-rules:toggle', 'title-optimization-prefix-rules:delete'
  ]);
  assert.deepEqual((await handlers.get('title-optimization-prefix-rules:load')()).data, { rules: [], issues: [] });
  assert.equal((await handlers.get('title-optimization-prefix-rules:delete')(null, 'id')).error.code, 'PROTECTED_RULE');
});
