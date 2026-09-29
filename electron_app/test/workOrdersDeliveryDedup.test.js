const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadDeliverySync(tasks, fields = []) {
  const originalLoad = Module._load;
  let nextId = 100;
  const created = [];
  const fieldWrites = [];

  class FakeClickUpService {
    async getList() { return { fields }; }
    async getListCustomFields() { return { fields }; }
    async fetchTasksByStatuses() { return tasks.map(entry => ({ ...entry })); }
    async getTask(id) { return tasks.find(task => task.id === id); }
    async updateTask(id, patch) {
      Object.assign(tasks.find(task => task.id === id), patch);
    }
    async updateTaskStatus(id, status) {
      tasks.find(task => task.id === id).status = { status };
    }
    async request(method, path, options) {
      if (/\/field\//.test(path)) {
        fieldWrites.push({ method, path, data: options?.data });
        return {};
      }
      assert.equal(method, 'POST');
      assert.match(path, /\/task$/);
      const task = { id: String(nextId++), ...options.data, custom_fields: (options.data.custom_fields || []).map(field => ({ ...fields.find(item => item.id === field.id), ...field })) };
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
    return { sync: require(servicePath).syncRowsToDeliveryAutomation, created, fieldWrites };
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

test('existing delivery tasks in any manual status are preserved and not recreated', async () => {
  for (const status of ['Gjon', 'Steve', 'Truck 3', 'Sean', 'Future Driver']) {
    const existing = task(`task-${status}`, '448286');
    existing.status = { status };
    const tasks = [existing];
    const { sync, created } = loadDeliverySync(tasks);

    const result = await sync({
      clickupToken: 'test',
      mainClickupListId: 'main',
      deliveryClickupListId: 'delivery',
      latestRows: [row('448286')]
    });

    assert.equal(created.length, 0, status);
    assert.equal(tasks.length, 1, status);
    assert.equal(tasks[0].status.status, status, status);
    assert.equal(result.created, 0, status);
  }
});

test('existing blank or weekday delivery statuses still follow the calculated weekday', async () => {
  for (const status of ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']) {
    const existing = task(`task-${status || 'blank'}`, '448286');
    existing.status = { status };
    const tasks = [existing];
    const { sync, created } = loadDeliverySync(tasks);

    await sync({
      clickupToken: 'test',
      mainClickupListId: 'main',
      deliveryClickupListId: 'delivery',
      latestRows: [row('448286')]
    });

    assert.equal(created.length, 0, status || 'blank');
    assert.equal(tasks[0].status.status, 'Friday', status || 'blank');
  }
});

function shipViaDropdown() {
  return { id: 'ship-field', name: 'Ship Via', type: 'drop_down', type_config: {
    options: ['CDC', 'RCD', 'DELIVER', 'PICKUP', 'PRP'].map((name, orderindex) => ({ name, id: `option-${name}`, orderindex }))
  } };
}

test('delivery creation uses dropdown option IDs with whitespace and case normalized', async () => {
  for (const label of ['CDC', 'RCD', 'DELIVER']) {
    const { sync, created } = loadDeliverySync([], [shipViaDropdown()]);
    await sync({ clickupToken: 'test', mainClickupListId: 'main', deliveryClickupListId: 'delivery',
      latestRows: [{ ...row(label), 'Ship Via': ` ${label.toLowerCase()} ` }] });
    assert.equal(created.length, 1);
    assert.equal(created[0].custom_fields.find(field => field.id === 'ship-field').value, `option-${label}`);
  }
});

test('existing delivery task updates dropdown by option ID', async () => {
  const existing = task('existing', '448286');
  existing.custom_fields = [{ ...shipViaDropdown(), value: 'option-CDC' }];
  const { sync, fieldWrites } = loadDeliverySync([existing], [shipViaDropdown()]);
  await sync({ clickupToken: 'test', mainClickupListId: 'main', deliveryClickupListId: 'delivery', latestRows: [row('448286')] });
  assert.ok(fieldWrites.some(write => write.path.endsWith('/field/ship-field') && write.data?.value === 'option-RCD'));
});

test('unmatched delivery Ship Via is reported without using PRP or writing text to dropdown', async () => {
  const { sync, created, fieldWrites } = loadDeliverySync([], [shipViaDropdown()]);
  const result = await sync({ clickupToken: 'test', mainClickupListId: 'main', deliveryClickupListId: 'delivery',
    latestRows: [{ ...row('448286'), 'Ship Via': 'HUB' }] });
  assert.ok(result.errors.some(message => /dropdown option missing.*HUB/.test(message)));
  assert.equal(created[0].custom_fields.some(field => field.id === 'ship-field'), false);
  assert.equal(fieldWrites.some(write => write.path.endsWith('/field/ship-field')), false);
});

test('delivery text Ship Via remains compatible during dropdown migration', async () => {
  const { sync, created } = loadDeliverySync([], [{ id: 'ship-field', name: 'Ship Via', type: 'short_text' }]);
  await sync({ clickupToken: 'test', mainClickupListId: 'main', deliveryClickupListId: 'delivery', latestRows: [row('448286')] });
  assert.equal(created[0].custom_fields.find(field => field.id === 'ship-field').value, 'RCD');
});
