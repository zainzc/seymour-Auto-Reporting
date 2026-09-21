const test = require('node:test');
const assert = require('node:assert/strict');
const { createTitleOptimizationOverviewService } = require('../src/services/titleOptimizationOverviewService');

const names = ['Source Fields','Source Priority','Terminology Rules','Synonyms','Prefix Rules','Restricted Terms','Category Rules','Title Structure','Flag Reasons','System Rules'];
const healthyLoaders = Object.fromEntries(names.map(name => [name, async () => ({ rules:[{ id:name, enabled:true, origin:'client-v5' }], issues:[] })]));

test('Overview derives healthy counts from all ten owning services', async () => {
  const result = await createTitleOptimizationOverviewService(healthyLoaders).load();
  assert.equal(result.status, 'Healthy');
  assert.equal(result.configuredTabs, 10);
  assert.equal(result.totalTabs, 10);
  assert.equal(result.warningCount, 0);
  assert.deepEqual(result.sections.map(section => section.name), names);
  assert.equal(result.sections[0].activeCount, 1);
});

test('Overview passes through owner warnings and reports unavailable services', async () => {
  const warned = { ...healthyLoaders, 'Flag Reasons': async () => ({ reasons:[], issues:[{ message:'Duplicate reason IDs: a, b' }] }) };
  const attention = await createTitleOptimizationOverviewService(warned).load();
  assert.equal(attention.status, 'Needs Attention');
  assert.match(attention.warnings[0].message, /Duplicate reason/);
  const failed = { ...warned, 'Category Rules': async () => { throw Error('storage unavailable'); } };
  const unavailable = await createTitleOptimizationOverviewService(failed).load();
  assert.equal(unavailable.status, 'Unavailable');
  assert.equal(unavailable.configuredTabs, 9);
  assert.match(unavailable.sections.find(x => x.name==='Category Rules').error, /storage unavailable/);
});
