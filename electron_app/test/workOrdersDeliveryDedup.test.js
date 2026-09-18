const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadDeliverySync(tasks) {
  const originalLoad = Module._load;
  let nextId = 100;
  const created = [];

  class FakeClickUpService {
    async getList() { return { fields: [] }; }
    async getListCustomFields() { return { fields: [] }; }
    async fetchTasksByStatuses() { return tasks.map(entry => ({ ...entry })); }
    async getTask(id) { return tasks.find(task => task.id === id); }
    async updateTask(id, patch) {
      Object.assign(tasks.find(task => task.id === id), patch);
    }
    async updateTaskStatus(id, status) {
      tasks.find(task => task.id === id).status = { status };
    }
    async request(method, path, options) {
      assert.equal(method, 'POST');
      assert.match(path, /\/task$/);
      const task = { id: String(nextId++), ...options.data, custom_fields: [] };
      tasks.push(task);
      created.push(task);
      return task;
    }
  }

  try {
    Module._load = function (request, parent, isMain) {
      if (request === '../config/configStore') {
        return { getReportingConfig: () => null, saveReportingConfig: () => {} };
      }
      if (request === './clickupService' && parent?.filename?.endsWith('workOrdersGoogleSheetsSync.js')) {
        return FakeClickUpService;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    const servicePath = require.resolve('../src/services/workOrdersGoogleSheetsSync');
    delete require.cache[servicePath];
    return { sync: require(servicePath).syncRowsToDeliveryAutomation, created };
  } finally {
    Module._load = originalLoad;
  }
}

function row(lineItemId, description = 'Front Door Switch') {
  return {
    'Record Type': 'WORK ORDER',
    Status: 'OPEN',
    'Line Item Status': 'OPEN',
    'Line Item ID': lineItemId,
    'W/O or Quote Number': '414023',
    'Detail (IPN)': '641-00641L',
    'Line Item Description': description,
    'Billing Customer Name': 'Linders Inc.',
    'Shipping Customer Name': 'Linders Inc.',
    'Shipping Customer Address': '211 Granite St., Worcester, MA, 01607',
    'Shipping City': 'Worcester',
    'Shipping State': 'MA',
    'Ship Via': 'RCD',
    'Delivery Date': '2026-09-18 14:36:24.000'
  };
}

function task(id, key) {
  return {
    id,
    name: 'Linders Inc.',
    description: `Record Key: Line Item-${key}\nBilling Name: Linders Inc.\nShipping Name: Linders Inc.\nShipping Address: 211 Granite St., Worcester, MA, 01607\nShipping City: Worcester\nShipping State: MA\nShip Via: RCD`,
    status: { status: 'Friday' },
    custom_fields: []
  };
}

test('does not rewrite a different line item as a duplicate when shipping details match', async () => {
  const tasks = [task('a', '448286'), task('b', '448999')];
  const { sync, created } = loadDeliverySync(tasks);
  await sync({ clickupToken: 'test', mainClickupListId: 'main', deliveryClickupListId: 'delivery', latestRows: [row('448286')] });
  assert.equal(created.length, 0);
  assert.match(tasks[0].description, /Record Key: Line Item-448286/);
  assert.match(tasks[1].description, /Record Key: Line Item-448999/);
});

test('does not adopt a differently keyed task when a new line item shares its address', async () => {
  const tasks = [task('a', '448999')];
  const { sync, created } = loadDeliverySync(tasks);
  await sync({ clickupToken: 'test', mainClickupListId: 'main', deliveryClickupListId: 'delivery', latestRows: [row('448286')] });
  assert.equal(created.length, 1);
  assert.match(tasks[0].description, /Record Key: Line Item-448999/);
  assert.match(created[0].description, /Record Key: Line Item-448286/);
});

test('reports an existing duplicate record key without selecting or deleting either task', async () => {
  const tasks = [task('a', '448286'), task('b', '448286')];
  const originalDescriptions = tasks.map(entry => entry.description);
  const { sync, created } = loadDeliverySync(tasks);
  const result = await sync({
    clickupToken: 'test',
    mainClickupListId: 'main',
    deliveryClickupListId: 'delivery',
    latestRows: [row('448286')]
  });
  assert.equal(created.length, 0);
  assert.deepEqual(tasks.map(entry => entry.description), originalDescriptions);
  assert.ok(result.errors.some(message => /duplicate.*Line Item-448286/i.test(message)));
});

test('overlapping delivery syncs create only one task for a record key', async () => {
  const tasks = [];
  const { sync, created } = loadDeliverySync(tasks);
  const args = {
    clickupToken: 'test',
    mainClickupListId: 'main',
    deliveryClickupListId: 'delivery',
    latestRows: [row('448286')]
  };
  await Promise.all([sync(args), sync(args)]);
  assert.equal(created.length, 1);
});

test('separate line items at one delivery address retain their own record keys', async () => {
  const tasks = [];
  const { sync, created } = loadDeliverySync(tasks);
  const args = {
    clickupToken: 'test',
    mainClickupListId: 'main',
    deliveryClickupListId: 'delivery',
    latestRows: [row('448286'), row('448999', 'Seat Belt, Front')]
  };
  await sync(args);
  await sync(args);
  assert.equal(created.length, 2);
  assert.match(tasks[0].description, /Record Key: Line Item-448286/);
  assert.match(tasks[1].description, /Record Key: Line Item-448999/);
});
