const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTitleOptimizationSynonymsIpc } = require('../src/main/titleOptimizationSynonymsIpc');

test('IPC exposes only five synonym operations with serializable results', async () => {
  const handlers = new Map();
  const repository = {
    load: async () => ({ enabled: true, rules: [], policies: {}, issues: [], updatedAt: null }),
    saveRule: async input => input,
    setRuleEnabled: async (id, enabled) => ({ id, enabled }),
    setMasterEnabled: async enabled => ({ enabled, updatedAt: 'now' }),
    softDelete: async () => { const error = Error('Protected'); error.code = 'PROTECTED_RULE'; throw error; }
  };
  registerTitleOptimizationSynonymsIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, repository);
  assert.deepEqual([...handlers.keys()], [
    'title-optimization-synonyms:load', 'title-optimization-synonyms:save',
    'title-optimization-synonyms:toggle-rule', 'title-optimization-synonyms:toggle-master',
    'title-optimization-synonyms:delete'
  ]);
  assert.equal((await handlers.get('title-optimization-synonyms:load')()).data.enabled, true);
  assert.deepEqual(await handlers.get('title-optimization-synonyms:toggle-master')(null, false), { success: true, data: { enabled: false, updatedAt: 'now' } });
  assert.equal((await handlers.get('title-optimization-synonyms:delete')(null, 'id')).error.code, 'PROTECTED_RULE');
});
