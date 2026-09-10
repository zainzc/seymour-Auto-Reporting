const test = require('node:test');
const assert = require('node:assert/strict');

const REPOSITORY_PATH = '../src/services/titleOptimizationSourcePriorityRepository';
const DEFAULT_ORDER = [
  'manualOverride', 'lockedFixedIpn', 'itemSpecifics', 'categoryConditions',
  'manufacturerPartNumber', 'brandMake', 'otherStructuredFields', 'currentEbay', 'rawHollander'
];

function harness(options = {}) {
  let stored = options.stored;
  let writes = 0;
  const repository = require(REPOSITORY_PATH).createTitleOptimizationSourcePriorityRepository({
    getStored: () => {
      if (options.readError) throw options.readError;
      return structuredClone(stored);
    },
    setStored: (value) => {
      if (options.writeError) throw options.writeError;
      stored = structuredClone(value);
      writes += 1;
    },
    getActor: async () => options.actor || 'user@example.com',
    now: () => options.now || '2026-09-10T10:00:00.000Z'
  });
  return { repository, stored: () => stored, writes: () => writes };
}

test('true first run seeds and persists the exact v5 default hierarchy', async () => {
  const h = harness();
  const result = await h.repository.load();

  assert.deepEqual(result.order, DEFAULT_ORDER);
  assert.equal(result.rows.length, 9);
  assert.equal(result.rows[0].status, 'Locked');
  assert.equal(result.requiresCorrection, false);
  assert.equal(h.writes(), 1);
  assert.deepEqual(h.stored().order, DEFAULT_ORDER);
});

test('reload restores an existing valid order without reseeding or writing', async () => {
  const order = ['manualOverride', 'itemSpecifics', 'lockedFixedIpn', ...DEFAULT_ORDER.slice(3)];
  const saved = { version: 1, policy: 'titleOptimizationSourcePriority', order, updatedAt: 'old', updatedBy: 'old-user' };
  const h = harness({ stored: saved });

  const result = await h.repository.load();

  assert.deepEqual(result.order, order);
  assert.equal(result.updatedBy, 'old-user');
  assert.equal(h.writes(), 0);
});

test('malformed persistence is safely displayed with issues and never silently rewritten', async () => {
  const saved = { version: 1, policy: 'titleOptimizationSourcePriority', order: ['manualOverride', 'itemSpecifics', 'itemSpecifics', 'unknown'] };
  const h = harness({ stored: saved });

  const result = await h.repository.load();

  assert.equal(result.requiresCorrection, true);
  assert.equal(result.issues.length > 0, true);
  assert.equal(result.rows.some((row) => row.status === 'Needs correction'), true);
  assert.deepEqual(h.stored(), saved);
  assert.equal(h.writes(), 0);
});

test('persisted null is malformed configuration rather than a first-run seed', async () => {
  const h = harness({ stored: null });

  const result = await h.repository.load();

  assert.equal(result.requiresCorrection, true);
  assert.equal(result.issues.length > 0, true);
  assert.equal(h.stored(), null);
  assert.equal(h.writes(), 0);
});

test('valid save is idempotent, last-write-wins, and stamps audit metadata', async () => {
  const h = harness();
  await h.repository.load();
  const order = ['manualOverride', 'itemSpecifics', 'lockedFixedIpn', ...DEFAULT_ORDER.slice(3)];

  const once = await h.repository.save(order);
  const twice = await h.repository.save(order);

  assert.deepEqual(twice.order, order);
  assert.equal(twice.updatedAt, '2026-09-10T10:00:00.000Z');
  assert.equal(twice.updatedBy, 'user@example.com');
  assert.equal(h.writes(), 3);
  assert.deepEqual(once.order, twice.order);
});

test('invalid save and failed persistence preserve the previous configuration', async () => {
  const saved = { version: 1, policy: 'titleOptimizationSourcePriority', order: DEFAULT_ORDER, updatedAt: 'old', updatedBy: 'old-user' };
  const invalidHarness = harness({ stored: saved });
  await assert.rejects(invalidHarness.repository.save([...DEFAULT_ORDER.slice(0, 8), 'itemSpecifics']), (error) => error.code === 'VALIDATION_ERROR');
  assert.deepEqual(invalidHarness.stored(), saved);
  assert.equal(invalidHarness.writes(), 0);

  const failedHarness = harness({ stored: saved, writeError: new Error('Disk unavailable') });
  await assert.rejects(failedHarness.repository.save(DEFAULT_ORDER), (error) => error.code === 'PERSISTENCE_ERROR');
  assert.deepEqual(failedHarness.stored(), saved);
});

test('read failures surface clearly and future runtime API returns only valid ordered keys', async () => {
  const failed = harness({ readError: new Error('Store unavailable') });
  await assert.rejects(failed.repository.load(), (error) => error.code === 'CONFIG_READ_FAILED');

  const h = harness({ stored: { version: 1, policy: 'titleOptimizationSourcePriority', order: DEFAULT_ORDER } });
  assert.deepEqual(await h.repository.getTitleOptimizationSourcePriority(), DEFAULT_ORDER);
});
