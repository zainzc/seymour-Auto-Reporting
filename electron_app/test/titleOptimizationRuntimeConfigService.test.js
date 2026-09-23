const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SECTION_ORDER,
  EDITABLE_SECTION_ORDER,
  createTitleOptimizationRuntimeConfigService
} = require('../src/services/titleOptimizationRuntimeConfigService');

const at = index => `2026-09-${String(index).padStart(2, '0')}T12:00:00.000Z`;
const enabled = (id, extra = {}) => ({ id, enabled: true, origin: 'client-v5', updatedAt: at(1), ...extra });

function healthyLoaders(overrides = {}) {
  return {
    sourceFields: async () => ({
      mappings: [
        enabled('source-existingTitle', { logicalKey: 'existingTitle', sortOrder: 1 }),
        enabled('source-sku', { logicalKey: 'sku', sortOrder: 3 }),
        enabled('source-ipnPrefix', { logicalKey: 'ipnPrefix', sortOrder: 4 })
      ],
      issues: [],
      updatedAt: at(1)
    }),
    sourcePriority: async () => ({
      order: ['manualOverride', 'itemSpecifics', 'categoryConditions'],
      rows: [
        { key: 'manualOverride', priority: 1 },
        { key: 'itemSpecifics', priority: 2 },
        { key: 'categoryConditions', priority: 3 }
      ],
      issues: [],
      updatedAt: at(2)
    }),
    terminologyRules: async () => ({
      rules: [
        enabled('term-1', { sourceTerm: 'Headlamp', replacementTerm: 'Headlight', priority: 20 }),
        enabled('term-2', { sourceTerm: 'Tail Lamp', replacementTerm: 'Tail Light', priority: 10 }),
        enabled('term-off', { sourceTerm: 'Off', replacementTerm: 'Nope', enabled: false })
      ],
      issues: [],
      updatedAt: at(3)
    }),
    synonyms: async () => ({
      enabled: true,
      rules: [
        enabled('syn-2', { primaryTerm: 'Tail Light', synonyms: ['Tail Lamp'], priority: 20 }),
        enabled('syn-1', { primaryTerm: 'Headlight', synonyms: ['Headlamp'], priority: 10 })
      ],
      policies: { cvAxleFrontHalfShaft: { note: 'CV Axle may only be used for a confirmed FRONT half-shaft.' } },
      issues: [],
      updatedAt: at(4)
    }),
    prefixRules: async () => ({
      rules: [
        enabled('prefix-257', { prefix: '257', approvedPartTerms: ['Speedometer'], priority: 20 }),
        enabled('prefix-234', { prefix: '234', approvedPartTerms: ['Gas Pedal'], priority: 10 })
      ],
      issues: [],
      updatedAt: at(5)
    }),
    restrictedTerms: async () => ({
      rules: [
        enabled('client-v5-long-block', { term: 'Long Block', ruleType: 'never-introduce', locked: true }),
        enabled('client-v5-short-block', { term: 'Short Block', ruleType: 'never-introduce', locked: true }),
        enabled('client-v5-ecm', { term: 'ECM', ruleType: 'must-preserve' })
      ],
      warnings: [{ id: 'client-v5-long-block', message: 'Locked term restored in memory.' }],
      updatedAt: at(6)
    }),
    categoryRules: async () => ({
      rules: [
        enabled('cat-engines', { categoryName: 'Engines', seedOrder: 1 }),
        enabled('cat-custom', { categoryName: 'Alternator', origin: 'custom' })
      ],
      issues: [],
      updatedAt: at(7)
    }),
    titleStructures: async () => ({
      structures: [
        enabled('structure-general', { structureName: 'General', seedOrder: 1 }),
        enabled('structure-engine', { structureName: 'Engines', seedOrder: 2 })
      ],
      issues: [],
      updatedAt: at(8)
    }),
    flagReasons: async () => ({
      reasons: [
        enabled('flag-1', { reason: 'Missing verified year', required: true, seedOrder: 1 }),
        enabled('flag-custom', { reason: 'Custom review reason', required: false, origin: 'custom' })
      ],
      issues: [],
      updatedAt: at(9)
    }),
    systemRules: async () => ([
      { id: 'SR-01', title: 'Never Guess or Invent', order: 1, version: 'v5', source: 'client-v5', locked: true },
      { id: 'SR-07', title: '80 Character Maximum', order: 7, version: 'v5', source: 'client-v5', locked: true }
    ]),
    ...overrides
  };
}

test('runtime snapshot aggregates sections in deterministic order with runtime-ready data only', async () => {
  const service = createTitleOptimizationRuntimeConfigService(healthyLoaders(), { now: () => '2026-09-23T00:00:00.000Z' });
  const snapshot = await service.loadSnapshot();

  assert.deepEqual(SECTION_ORDER, [
    'sourceFields', 'sourcePriority', 'terminologyRules', 'synonyms', 'prefixRules',
    'restrictedTerms', 'categoryRules', 'titleStructures', 'flagReasons', 'systemRules'
  ]);
  assert.deepEqual(EDITABLE_SECTION_ORDER, SECTION_ORDER.slice(0, -1));
  assert.equal(snapshot.mode, 'shadow-only');
  assert.equal(snapshot.runtimeReady, true);
  assert.equal(snapshot.metadata.loadedAt, '2026-09-23T00:00:00.000Z');
  assert.equal(snapshot.metadata.configurationVersion, 'v5');
  assert.equal(snapshot.metadata.lastUpdated, at(9));
  assert.deepEqual(snapshot.sections.terminologyRules.items.map(rule => rule.sourceTerm), ['Tail Lamp', 'Headlamp']);
  assert.deepEqual(snapshot.sections.synonyms.items.map(rule => rule.primaryTerm), ['Headlight', 'Tail Light']);
  assert.deepEqual(snapshot.sections.prefixRules.items.map(rule => rule.prefix), ['234', '257']);
  assert.deepEqual(snapshot.sections.systemRules.items.map(rule => rule.id), ['SR-01', 'SR-07']);
});

test('runtime snapshot preserves warnings by section and remains ready for restricted locked-term warnings', async () => {
  const snapshot = await createTitleOptimizationRuntimeConfigService(healthyLoaders()).loadSnapshot();

  assert.equal(snapshot.status, 'ready-with-warnings');
  assert.equal(snapshot.runtimeReady, true);
  assert.deepEqual(snapshot.warnings, [
    { section: 'restrictedTerms', id: 'client-v5-long-block', message: 'Locked term restored in memory.' }
  ]);
  assert.equal(snapshot.sections.restrictedTerms.warningCount, 1);
  assert.equal(snapshot.sections.restrictedTerms.available, true);
});

test('runtime snapshot marks unavailable required sections not ready without fabricating warnings', async () => {
  const snapshot = await createTitleOptimizationRuntimeConfigService(healthyLoaders({
    sourcePriority: async () => { throw Error('priority storage unavailable'); }
  })).loadSnapshot();

  assert.equal(snapshot.status, 'blocked');
  assert.equal(snapshot.runtimeReady, false);
  assert.deepEqual(snapshot.unavailableSections, ['sourcePriority']);
  assert.deepEqual(snapshot.warnings, [
    { section: 'restrictedTerms', id: 'client-v5-long-block', message: 'Locked term restored in memory.' }
  ]);
  assert.match(snapshot.sections.sourcePriority.error, /priority storage unavailable/);
});

test('runtime snapshot continues without optional synonym enrichment when synonym service is unavailable', async () => {
  const snapshot = await createTitleOptimizationRuntimeConfigService(healthyLoaders({
    synonyms: async () => { throw Error('synonym storage unavailable'); }
  })).loadSnapshot();

  assert.equal(snapshot.status, 'ready-with-warnings');
  assert.equal(snapshot.runtimeReady, true);
  assert.deepEqual(snapshot.unavailableSections, ['synonyms']);
  assert.equal(snapshot.sections.synonyms.optional, true);
  assert.equal(snapshot.sections.synonyms.items.length, 0);
});

test('runtime snapshot treats malformed configuration issues as blocking except locked restricted warnings', async () => {
  const snapshot = await createTitleOptimizationRuntimeConfigService(healthyLoaders({
    categoryRules: async () => ({ rules: [], issues: [{ id: 'cat-1', message: 'Duplicate category name.' }], updatedAt: at(7) })
  })).loadSnapshot();

  assert.equal(snapshot.status, 'blocked');
  assert.equal(snapshot.runtimeReady, false);
  assert.deepEqual(snapshot.blockingSections, ['categoryRules']);
  assert.deepEqual(snapshot.warnings, [
    { section: 'restrictedTerms', id: 'client-v5-long-block', message: 'Locked term restored in memory.' },
    { section: 'categoryRules', id: 'cat-1', message: 'Duplicate category name.' }
  ]);
});
