const test = require('node:test');
const assert = require('node:assert/strict');
const { createTitleOptimizationOverviewService } = require('../src/services/titleOptimizationOverviewService');

const names = ['Source Fields','Source Priority','Terminology Rules','Synonyms','Prefix Rules','Restricted Terms','Category Rules','Title Structure','Flag Reasons','System Rules'];
const at = index => `2026-09-${String(index).padStart(2, '0')}T12:00:00.000Z`;
const enabled = (id, extra = {}) => ({ id, enabled: true, origin: 'client-v5', updatedAt: at(1), ...extra });

function healthyLoaders(overrides = {}) {
  const mappings = Array.from({ length: 10 }, (_, index) => enabled(`mapping-${index + 1}`, { displayName: `Logical ${index + 1}`, sourceFieldName: `Field ${index + 1}`, status: 'Mapped', sortOrder: index + 1 }));
  const rows = Array.from({ length: 9 }, (_, index) => ({ key: `source-${index + 1}`, priority: index + 1, label: `Source ${index + 1}` }));
  const rules = prefix => Array.from({ length: 7 }, (_, index) => enabled(`${prefix}-${index + 1}`, {
    sourceTerm: `Source ${index + 1}`, replacementTerm: `Replacement ${index + 1}`, condition: 'always',
    primaryTerm: `Primary ${index + 1}`, synonyms: [`Synonym ${index + 1}`], prefix: String(200 + index), approvedPartTerms: [`Part ${index + 1}`]
  }));
  return {
    'Source Fields': async () => ({ mappings, quarantined: [], updatedAt: at(1) }),
    'Source Priority': async () => ({ rows, issues: [], updatedAt: at(2) }),
    'Terminology Rules': async () => ({ rules: rules('term'), issues: [], updatedAt: at(3) }),
    'Synonyms': async () => ({ enabled: true, rules: rules('syn'), issues: [], updatedAt: at(4) }),
    'Prefix Rules': async () => ({ rules: rules('prefix'), issues: [], updatedAt: at(5) }),
    'Restricted Terms': async () => ({ rules: [enabled('restricted', { term: 'Long Block', locked: true })], issues: [], updatedAt: at(6) }),
    'Category Rules': async () => ({ rules: [enabled('category', { categoryName: 'Engines' })], issues: [], updatedAt: at(7) }),
    'Title Structure': async () => ({ structures: [enabled('general', { structureName: 'General' }), enabled('engine', { structureName: 'Engines' }), enabled('trans', { structureName: 'Transmissions' }), enabled('extra', { structureName: 'Extra' })], issues: [], updatedAt: at(8) }),
    'Flag Reasons': async () => ({ reasons: [enabled('required', { reason: 'Missing year', required: true }), enabled('custom', { reason: 'Review', required: false, origin: 'custom' })], issues: [], updatedAt: at(9) }),
    'System Rules': async () => ([
      { id: 'SR-01', title: 'Never Guess or Invent', behavior: 'Never invent unsupported information.', source: 'client-v5', version: 'v5', locked: true, order: 1 },
      { id: 'SR-02', title: 'Manual Override Protection', behavior: 'Protect manual overrides.', source: 'client-v5', version: 'v5', locked: true, order: 2 },
      { id: 'SR-03', title: 'Preserve Critical Fitment', behavior: 'Preserve fitment.', source: 'client-v5', version: 'v5', locked: true, order: 3 },
      { id: 'SR-05', title: 'SKU Exactly Once at End', behavior: 'SKU exactly once at end.', source: 'client-v5', version: 'v5', locked: true, order: 5 },
      { id: 'SR-07', title: '80 Character Maximum', behavior: 'Maximum title length: 80 characters.', source: 'client-v5', version: 'v5', locked: true, order: 7 },
      { id: 'SR-14', title: 'No-Degrade / Idempotency', behavior: 'Do not degrade.', source: 'client-v5', version: 'v5', locked: true, order: 14 },
      { id: 'SR-15', title: 'Final Validation', behavior: 'Validate final titles.', source: 'client-v5', version: 'v5', locked: true, order: 15 }
    ]),
    ...overrides
  };
}

test('Overview composes actual previews in owner order with approved deterministic limits', async () => {
  const result = await createTitleOptimizationOverviewService(healthyLoaders()).load();
  assert.equal(result.status, 'Healthy');
  assert.equal(result.configuredTabs, 10);
  assert.equal(result.totalTabs, 10);
  assert.equal(result.configurationVersion, 'v5');
  assert.equal(result.lastUpdated, at(9));
  assert.deepEqual(result.previews.sourceFields.rows.map(row => row.displayName), Array.from({ length: 8 }, (_, index) => `Logical ${index + 1}`));
  assert.deepEqual(result.previews.sourcePriority.rows.map(row => row.priority), [1,2,3,4,5,6,7,8,9]);
  assert.equal(result.previews.terminologyRules.rows.length, 5);
  assert.equal(result.previews.synonyms.rows.length, 5);
  assert.equal(result.previews.prefixRules.rows.length, 5);
  assert.deepEqual(result.summaries.titleStructure.names, ['General', 'Engines', 'Transmissions']);
});

test('Overview derives five summary values and active items without counting System Rules', async () => {
  const result = await createTitleOptimizationOverviewService(healthyLoaders()).load();
  assert.deepEqual(result.globalProtections, { maximumTitleLength: 80, synonymEnrichment: true, manualOverrideProtection: true, skuRequirement: 'SKU exactly once at end' });
  assert.equal(result.activeConfigurationItems, 10 + 9 + 7 + 7 + 7 + 1 + 1 + 4 + 2);
  assert.equal(result.systemRuleCount, 7);
});

test('disabled Synonym enrichment contributes zero active rules while retaining preview data', async () => {
  const result = await createTitleOptimizationOverviewService(healthyLoaders({
    'Synonyms': async () => ({ enabled: false, rules: [enabled('syn-1', { primaryTerm: 'Headlight', synonyms: ['Headlamp'] })], issues: [], updatedAt: at(4) })
  })).load();
  assert.equal(result.globalProtections.synonymEnrichment, false);
  assert.equal(result.previews.synonyms.rows.length, 1);
  assert.equal(result.sections.find(section => section.name === 'Synonyms').activeCount, 0);
});

test('Flag Reasons summary counts only enabled custom reasons', async () => {
  const result = await createTitleOptimizationOverviewService(healthyLoaders({
    'Flag Reasons': async () => ({ reasons: [
      enabled('required', { reason: 'Required', required: true }),
      enabled('custom-on', { reason: 'Enabled custom', required: false, origin: 'custom' }),
      enabled('custom-off', { reason: 'Disabled custom', required: false, origin: 'custom', enabled: false })
    ], issues: [], updatedAt: at(9) })
  })).load();
  assert.equal(result.summaries.flagReasons.customActiveCount, 1);
});

test('warnings preserve service grouping, order, IDs, and details', async () => {
  const warningA = { id: 'A-1', message: 'First warning', details: { ids: ['x', 'y'] } };
  const warningB = { id: 'A-2', message: 'Second warning', details: ['z'] };
  const result = await createTitleOptimizationOverviewService(healthyLoaders({
    'Category Rules': async () => ({ rules: [], issues: [warningA, warningB], updatedAt: 'not-a-date' })
  })).load();
  assert.equal(result.status, 'Needs Attention');
  assert.equal(result.warningCount, 2);
  assert.deepEqual(result.warningGroups, [{ section: 'Category Rules', items: [warningA, warningB] }]);
  assert.equal(result.lastUpdated, at(9));
});

test('an unavailable editable service makes health and active total unavailable without fake warnings', async () => {
  const result = await createTitleOptimizationOverviewService(healthyLoaders({ 'Category Rules': async () => { throw Error('storage unavailable'); } })).load();
  assert.equal(result.status, 'Unavailable');
  assert.equal(result.configuredTabs, 9);
  assert.equal(result.activeConfigurationItems, null);
  assert.equal(result.warningCount, 0);
  assert.equal(result.summaries.categoryRules.available, false);
  assert.match(result.sections.find(section => section.name === 'Category Rules').error, /storage unavailable/);
});

test('System Rules unavailability removes canonical metadata but editable active total remains real', async () => {
  const result = await createTitleOptimizationOverviewService(healthyLoaders({ 'System Rules': async () => { throw Error('canonical rules unavailable'); } })).load();
  assert.equal(result.status, 'Unavailable');
  assert.equal(result.configurationVersion, null);
  assert.equal(typeof result.activeConfigurationItems, 'number');
  assert.deepEqual(result.safetyHighlights, []);
});

test('loaded empty services return honest empty previews and no fallback timestamp', async () => {
  const empty = Object.fromEntries(names.map(name => [name, async () => name === 'System Rules' ? [] : ({ issues: [], updatedAt: null })]));
  const result = await createTitleOptimizationOverviewService(empty).load();
  assert.equal(result.status, 'Healthy');
  assert.equal(result.lastUpdated, null);
  assert.equal(result.activeConfigurationItems, 0);
  assert.deepEqual(result.previews.sourceFields.rows, []);
  assert.equal(result.configurationVersion, null);
});
