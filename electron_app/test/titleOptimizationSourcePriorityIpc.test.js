const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Source Priority IPC exposes only secure load and save operations', async () => {
  const { registerTitleOptimizationSourcePriorityIpc } = require('../src/main/titleOptimizationSourcePriorityIpc');
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const repository = {
    load: async () => ({ order: ['manualOverride'] }),
    save: async (order) => ({ order }),
  };

  registerTitleOptimizationSourcePriorityIpc(ipcMain, repository);

  assert.deepEqual([...handlers.keys()], [
    'title-optimization-source-priority:load',
    'title-optimization-source-priority:save'
  ]);
  assert.deepEqual(await handlers.get('title-optimization-source-priority:load')(), {
    success: true,
    data: { order: ['manualOverride'] }
  });
  assert.deepEqual(await handlers.get('title-optimization-source-priority:save')(null, ['manualOverride']), {
    success: true,
    data: { order: ['manualOverride'] }
  });
});

test('Source Priority IPC serializes validation failures without throwing across the boundary', async () => {
  const { registerTitleOptimizationSourcePriorityIpc } = require('../src/main/titleOptimizationSourcePriorityIpc');
  const handlers = new Map();
  const error = Object.assign(new Error('Invalid order.'), {
    code: 'VALIDATION_ERROR',
    details: [{ code: 'DUPLICATE_KEY' }]
  });
  registerTitleOptimizationSourcePriorityIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    load: async () => { throw error; },
    save: async () => { throw error; }
  });

  assert.deepEqual(await handlers.get('title-optimization-source-priority:save')(null, []), {
    success: false,
    error: { code: 'VALIDATION_ERROR', message: 'Invalid order.', details: [{ code: 'DUPLICATE_KEY' }] }
  });
});

test('preload bridge exposes Source Priority load and save without storage or credentials', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload/preload.js'), 'utf8');

  assert.match(preload, /titleOptimizationSourcePriorityAPI/);
  assert.match(preload, /title-optimization-source-priority:load/);
  assert.match(preload, /title-optimization-source-priority:save/);
  assert.doesNotMatch(preload, /titleOptimizationSourcePriorityAPI[\s\S]{0,300}(configStore|airtableToken|credentials)/);
});
