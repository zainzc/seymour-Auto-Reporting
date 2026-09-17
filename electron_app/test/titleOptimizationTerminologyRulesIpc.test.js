const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerTitleOptimizationTerminologyRulesIpc } = require('../src/main/titleOptimizationTerminologyRulesIpc');

test('IPC exposes only the four safe terminology operations and serializes validation errors', async () => {
  const handlers = new Map();
  const repository = {
    load: async () => ({ rules: [] }),
    saveRule: async input => ({ id: 'custom-1', ...input }),
    setEnabled: async (id, enabled) => ({ id, enabled }),
    softDelete: async () => { const error = new Error('Seeded rule'); error.code = 'PROTECTED_RULE'; throw error; }
  };
  registerTitleOptimizationTerminologyRulesIpc({ handle: (name, handler) => handlers.set(name, handler) }, repository);
  assert.deepEqual([...handlers.keys()], [
    'title-optimization-terminology-rules:load',
    'title-optimization-terminology-rules:save',
    'title-optimization-terminology-rules:toggle',
    'title-optimization-terminology-rules:delete'
  ]);
  assert.deepEqual(await handlers.get('title-optimization-terminology-rules:load')(), { success: true, data: { rules: [] } });
  assert.deepEqual(await handlers.get('title-optimization-terminology-rules:toggle')(null, 'rule-1', false), { success: true, data: { id: 'rule-1', enabled: false } });
  assert.deepEqual(await handlers.get('title-optimization-terminology-rules:delete')(null, 'rule-1'), {
    success: false, error: { code: 'PROTECTED_RULE', message: 'Seeded rule', details: null }
  });
});

test('preload exposes a narrow terminology bridge without secrets or direct storage access', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload/preload.js'), 'utf8');
  const bridge = preload.match(/contextBridge\.exposeInMainWorld\('titleOptimizationTerminologyRulesAPI',[\s\S]*?\n\}\);/)?.[0] || '';
  assert.match(bridge, /load:.*title-optimization-terminology-rules:load/);
  assert.match(bridge, /save:.*title-optimization-terminology-rules:save/);
  assert.match(bridge, /setEnabled:.*title-optimization-terminology-rules:toggle/);
  assert.match(bridge, /softDelete:.*title-optimization-terminology-rules:delete/);
  assert.doesNotMatch(bridge, /configStore|airtableToken|credentials/);
});
