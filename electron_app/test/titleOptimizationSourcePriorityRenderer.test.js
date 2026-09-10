const test = require('node:test');
const assert = require('node:assert/strict');

const MODULE_PATH = '../src/renderer/pages/title-optimization/source-priority.js';
const DEFAULT_ORDER = [
  'manualOverride', 'lockedFixedIpn', 'itemSpecifics', 'categoryConditions',
  'manufacturerPartNumber', 'brandMake', 'otherStructuredFields', 'currentEbay', 'rawHollander'
];

function rows(order = DEFAULT_ORDER) {
  return order.map((key, index) => ({
    key,
    priority: index + 1,
    label: key,
    description: `${key} purpose`,
    locked: key === 'manualOverride',
    status: key === 'manualOverride' ? 'Locked' : 'Reorderable'
  }));
}

function payload(overrides = {}) {
  return {
    version: 1,
    policy: 'titleOptimizationSourcePriority',
    order: [...DEFAULT_ORDER],
    rows: rows(),
    updatedAt: '2026-09-10T10:00:00.000Z',
    updatedBy: 'user@example.com',
    issues: [],
    requiresCorrection: false,
    ...overrides
  };
}

test('loads Source Priority without becoming dirty', async () => {
  const { createSourcePriorityController } = require(MODULE_PATH);
  const controller = createSourcePriorityController({ api: { load: async () => ({ success: true, data: payload() }) } });

  await controller.load();

  assert.deepEqual(controller.state.order, DEFAULT_ORDER);
  assert.equal(controller.state.rows[0].priority, 1);
  assert.equal(controller.state.dirty, false);
});

test('Move Up and Move Down reorder priorities 2 through 9 and update numbering', () => {
  const { createSourcePriorityController } = require(MODULE_PATH);
  const controller = createSourcePriorityController({ api: {} });
  controller.replaceData(payload());

  assert.equal(controller.move('manualOverride', 'down'), false);
  assert.equal(controller.move('lockedFixedIpn', 'up'), false);
  assert.equal(controller.move('itemSpecifics', 'up'), true);
  assert.deepEqual(controller.state.order.slice(0, 3), ['manualOverride', 'itemSpecifics', 'lockedFixedIpn']);
  assert.equal(controller.state.rows.find((row) => row.key === 'itemSpecifics').priority, 2);
  assert.equal(controller.state.dirty, true);
});

test('drag drop reorders movable sources but never moves Manual Override', () => {
  const { createSourcePriorityController } = require(MODULE_PATH);
  const controller = createSourcePriorityController({ api: {} });
  controller.replaceData(payload());

  assert.equal(controller.drop('manualOverride', 'itemSpecifics'), false);
  assert.equal(controller.drop('rawHollander', 'itemSpecifics'), true);
  assert.deepEqual(controller.state.order.slice(0, 4), ['manualOverride', 'lockedFixedIpn', 'rawHollander', 'itemSpecifics']);
  assert.equal(controller.drop('brandMake', 'manualOverride'), true);
  assert.equal(controller.state.order[0], 'manualOverride');
  assert.equal(controller.state.order[1], 'brandMake');
});

test('Reset to Default requires confirmation and remains local until Save', async () => {
  const { createSourcePriorityController } = require(MODULE_PATH);
  let confirmations = 0;
  let saves = 0;
  const controller = createSourcePriorityController({
    api: { save: async (order) => { saves += 1; return { success: true, data: payload({ order, rows: rows(order) }) }; } },
    confirmReset: async () => { confirmations += 1; return confirmations > 1; }
  });
  const changed = ['manualOverride', 'itemSpecifics', 'lockedFixedIpn', ...DEFAULT_ORDER.slice(3)];
  controller.replaceData(payload({ order: changed, rows: rows(changed) }));

  assert.equal(await controller.reset(), false);
  assert.deepEqual(controller.state.order, changed);
  assert.equal(await controller.reset(), true);
  assert.deepEqual(controller.state.order, DEFAULT_ORDER);
  assert.equal(controller.state.dirty, true);
  assert.equal(saves, 0);
  await controller.save();
  assert.equal(saves, 1);
  assert.equal(controller.state.dirty, false);
});

test('save failure preserves local order, dirty state, and validation details', async () => {
  const { createSourcePriorityController } = require(MODULE_PATH);
  const controller = createSourcePriorityController({ api: {
    save: async () => ({ success: false, error: { message: 'Invalid order.', details: [{ code: 'DUPLICATE_KEY', message: 'Duplicate source.' }] } })
  } });
  controller.replaceData(payload());
  controller.move('itemSpecifics', 'up');
  const localOrder = [...controller.state.order];

  await assert.rejects(controller.save(), /Invalid order/);

  assert.deepEqual(controller.state.order, localOrder);
  assert.equal(controller.state.dirty, true);
  assert.equal(controller.state.issues[0].code, 'DUPLICATE_KEY');
});

test('malformed loaded configuration surfaces correction state without marking local repair saved', async () => {
  const { createSourcePriorityController } = require(MODULE_PATH);
  const malformed = payload({
    requiresCorrection: true,
    issues: [{ code: 'MISSING_KEY', key: 'rawHollander', message: 'Missing source.' }],
    rows: rows().map((row) => row.key === 'rawHollander' ? { ...row, status: 'Needs correction' } : row)
  });
  const controller = createSourcePriorityController({ api: { load: async () => ({ success: true, data: malformed }) } });

  await controller.load();

  assert.equal(controller.state.requiresCorrection, true);
  assert.equal(controller.state.dirty, false);
  assert.equal(controller.state.rows.at(-1).status, 'Needs correction');
});

test('confirmed reset marks a malformed default-looking configuration dirty so it can be repaired', async () => {
  const { createSourcePriorityController } = require(MODULE_PATH);
  const controller = createSourcePriorityController({ confirmReset: async () => true, api: {} });
  controller.replaceData(payload({
    requiresCorrection: true,
    issues: [{ code: 'DUPLICATE_KEY', message: 'Duplicate source.' }]
  }));

  assert.equal(await controller.reset(), true);
  assert.deepEqual(controller.state.order, DEFAULT_ORDER);
  assert.equal(controller.state.requiresCorrection, false);
  assert.equal(controller.state.issues.length, 0);
  assert.equal(controller.state.dirty, true);
});

test('unsaved navigation confirmation authorizes one unload only', async () => {
  const { createSourcePriorityController } = require(MODULE_PATH);
  let confirmations = 0;
  const controller = createSourcePriorityController({ api: {}, confirmDiscard: async () => { confirmations += 1; return true; } });
  controller.replaceData(payload());
  controller.move('itemSpecifics', 'up');

  assert.equal(await controller.canNavigateAway(), true);
  assert.equal(confirmations, 1);
  assert.equal(controller.shouldBlockUnload(), false);
  assert.equal(controller.shouldBlockUnload(), true);
});
