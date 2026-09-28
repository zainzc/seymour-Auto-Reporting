const test = require('node:test');
const assert = require('node:assert/strict');

const { createPhase74Runner } = require('../src/renderer/pages/title-optimization/overview');

function api(overrides = {}) {
  const calls = [];
  return {
    calls,
    getConfig: async () => ({ listingsTableName: 'eBay Listings (API)', testIpns: '300-80094A', maxListings: 5 }),
    run: async options => {
      calls.push(options);
      return { success: true, summary: { listingsScanned: 1, titleGenerated: 1, descriptionGenerated: 1, writeFailures: 0 } };
    },
    onProgress: callback => { callback(null, { stage: 'phase74_generate', percent: 50, message: 'Generating...' }); },
    ...overrides
  };
}

test('Overview Phase 7.4 runner loads saved settings and forwards the write-run options', async () => {
  const service = api();
  const states = [];
  const runner = createPhase74Runner({ api: service, onChange: state => states.push({ ...state }) });

  await runner.load();
  assert.equal(runner.state.listingsTableName, 'eBay Listings (API)');
  assert.equal(runner.state.testIpns, '300-80094A');
  assert.equal(runner.state.maxListings, 5);
  assert.equal(runner.state.progress, 50);

  const result = await runner.run();
  assert.equal(result.success, true);
  assert.deepEqual(service.calls, [{
    phase74ListingsTable: 'eBay Listings (API)',
    phase74TestIpns: '300-80094A',
    phase74MaxListings: 5
  }]);
  assert.equal(runner.state.status, 'completed');
  assert.equal(runner.state.summary.titleGenerated, 1);
  assert.equal(states.some(state => state.running), true);
});

test('Overview Phase 7.4 runner confirms unrestricted writes and blocks invalid or duplicate runs', async () => {
  let confirmations = 0;
  let release;
  const service = api({
    getConfig: async () => ({ listingsTableName: 'eBay Listings (API)', testIpns: '', maxListings: 0 }),
    run: options => new Promise(resolve => { service.calls.push(options); release = () => resolve({ success: true, summary: {} }); })
  });
  const runner = createPhase74Runner({
    api: service,
    confirmFullRun: () => { confirmations += 1; return true; }
  });
  await runner.load();

  const pending = runner.run();
  assert.equal(confirmations, 1);
  assert.equal(runner.state.running, true);
  assert.equal(await runner.run(), null);
  release();
  await pending;

  runner.update({ listingsTableName: '', maxListings: -1 });
  await assert.rejects(() => runner.run(), /Listings Table Name is required/);
  assert.equal(service.calls.length, 1);
});
