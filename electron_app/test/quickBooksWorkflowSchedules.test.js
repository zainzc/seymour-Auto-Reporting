const test = require('node:test');
const assert = require('node:assert/strict');

const scheduler = require('../src/services/quickBooksAutomationSchedulerService');

test('normalizes independent Main, Retry 1, and Retry 2 schedules', () => {
  const settings = scheduler.normalizeWorkflowSettings({
    workflows: {
      main: { enabled: true, runTime: '01:15' },
      retry1: { enabled: true, runTime: '06:30' },
      retry2: { enabled: false, runTime: '10:45' }
    }
  });

  assert.deepEqual(Object.fromEntries(Object.entries(settings.workflows).map(([key, value]) => [key, {
    enabled: value.enabled,
    runTime: value.runTime,
    timezone: value.timezone
  }])), {
    main: { enabled: true, runTime: '01:15', timezone: 'America/New_York' },
    retry1: { enabled: true, runTime: '06:30', timezone: 'America/New_York' },
    retry2: { enabled: false, runTime: '10:45', timezone: 'America/New_York' }
  });
});

test('migrates the existing single Main schedule without enabling retry workflows', () => {
  const settings = scheduler.normalizeWorkflowSettings({ enabled: true, runTime: '02:20' });

  assert.equal(settings.workflows.main.enabled, true);
  assert.equal(settings.workflows.main.runTime, '02:20');
  assert.equal(settings.workflows.retry1.enabled, false);
  assert.equal(settings.workflows.retry2.enabled, false);
});

test('routes each workflow to its approved webhook URL', () => {
  assert.deepEqual(scheduler.WORKFLOW_DEFINITIONS, {
    main: {
      label: 'Main Run',
      webhookUrl: 'https://seymourauto.app.n8n.cloud/webhook/qb-01-main-controll'
    },
    retry1: {
      label: 'Retry 1',
      webhookUrl: 'https://seymourauto.app.n8n.cloud/webhook/qb-10-retry1-controll'
    },
    retry2: {
      label: 'Retry 2',
      webhookUrl: 'https://seymourauto.app.n8n.cloud/webhook/qb-10-retry2-controll'
    }
  });
});

test('rejects an unknown workflow instead of calling the Main webhook', () => {
  assert.throws(() => scheduler.getWorkflowDefinition('retry3'), /Unknown QuickBooks workflow/);
});

test('Retry 1 and Retry 2 manual runs call only their own webhook', async () => {
  const axios = require('axios');
  const configPath = require.resolve('../src/config/configStore');
  const originalConfigModule = require.cache[configPath];
  const originalGet = axios.get;
  const values = new Map();
  const calledUrls = [];
  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
      getInventoryConfig: key => values.get(key),
      saveInventoryConfig: (key, value) => values.set(key, value)
    }
  };
  axios.get = async url => {
    calledUrls.push(url);
    return { status: 200, data: { success: true } };
  };

  try {
    await scheduler.triggerWebhook('retry1', 'manual');
    await scheduler.triggerWebhook('retry2', 'manual');
    assert.deepEqual(calledUrls, [
      'https://seymourauto.app.n8n.cloud/webhook/qb-10-retry1-controll',
      'https://seymourauto.app.n8n.cloud/webhook/qb-10-retry2-controll'
    ]);
  } finally {
    axios.get = originalGet;
    if (originalConfigModule) require.cache[configPath] = originalConfigModule;
    else delete require.cache[configPath];
  }
});
