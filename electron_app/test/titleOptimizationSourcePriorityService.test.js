const test = require('node:test');
const assert = require('node:assert/strict');

const SERVICE_PATH = '../src/services/titleOptimizationSourcePriorityService';

const expectedOrder = [
  'manualOverride',
  'lockedFixedIpn',
  'itemSpecifics',
  'categoryConditions',
  'manufacturerPartNumber',
  'brandMake',
  'otherStructuredFields',
  'currentEbay',
  'rawHollander'
];

test('defines the exact v5 hierarchy and stable display metadata', () => {
  const { DEFAULT_SOURCE_PRIORITY, SOURCE_PRIORITY_METADATA } = require(SERVICE_PATH);

  assert.deepEqual(DEFAULT_SOURCE_PRIORITY, expectedOrder);
  assert.equal(Object.keys(SOURCE_PRIORITY_METADATA).length, 9);
  assert.equal(SOURCE_PRIORITY_METADATA.manualOverride.locked, true);
  assert.equal(SOURCE_PRIORITY_METADATA.rawHollander.label, 'Raw Hollander / Source Title');
});

test('validates exactly nine known unique keys with Manual Override first', () => {
  const { validateSourcePriority } = require(SERVICE_PATH);

  assert.deepEqual(validateSourcePriority(expectedOrder), []);
  assert.match(validateSourcePriority([...expectedOrder.slice(0, 8), 'itemSpecifics'])[0].message, /duplicate/i);
  assert.match(validateSourcePriority([...expectedOrder.slice(0, 8), 'unknown'])[0].message, /unknown/i);
  assert.match(validateSourcePriority([...expectedOrder.slice(1), 'manualOverride'])[0].message, /priority 1/i);
});

test('moves only priorities 2 through 9 and keeps sequential display order', () => {
  const { moveSource } = require(SERVICE_PATH);

  assert.deepEqual(moveSource(expectedOrder, 'manualOverride', 'down'), expectedOrder);
  assert.deepEqual(moveSource(expectedOrder, 'lockedFixedIpn', 'up'), expectedOrder);
  assert.deepEqual(moveSource(expectedOrder, 'itemSpecifics', 'up').slice(0, 4), [
    'manualOverride', 'itemSpecifics', 'lockedFixedIpn', 'categoryConditions'
  ]);
  assert.deepEqual(moveSource(expectedOrder, 'rawHollander', 'down'), expectedOrder);
});

test('hydrates malformed persistence for safe display without hiding valid ordering issues', () => {
  const { hydrateSourcePriority } = require(SERVICE_PATH);
  const raw = {
    version: 1,
    policy: 'titleOptimizationSourcePriority',
    order: ['itemSpecifics', 'manualOverride', 'itemSpecifics', 'unknown', 'rawHollander'],
    updatedAt: '2026-09-10T00:00:00.000Z',
    updatedBy: 'user@example.com'
  };

  const result = hydrateSourcePriority(raw);

  assert.equal(result.requiresCorrection, true);
  assert.deepEqual(result.order.slice(0, 4), ['manualOverride', 'itemSpecifics', 'rawHollander', 'lockedFixedIpn']);
  assert.equal(result.order.length, 9);
  assert.equal(new Set(result.order).size, 9);
  assert.equal(result.issues.some((issue) => issue.code === 'MANUAL_OVERRIDE_POSITION'), true);
  assert.equal(result.issues.some((issue) => issue.code === 'DUPLICATE_KEY'), true);
  assert.equal(result.issues.some((issue) => issue.code === 'UNKNOWN_KEY'), true);
  assert.equal(result.issues.some((issue) => issue.code === 'MISSING_KEY'), true);
  assert.deepEqual(result.persistedOrder, raw.order);
});
