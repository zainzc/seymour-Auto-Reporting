const test = require('node:test');
const assert = require('node:assert/strict');
const { createTitleOptimizationFlagReasonsRepository } = require('../src/services/titleOptimizationFlagReasonsRepository');
const NOW = '2026-09-21T12:00:00.000Z';
const harness = stored => { let value = stored; let id = 0; const repository = createTitleOptimizationFlagReasonsRepository({ getStored: () => value, setStored: next => { value = structuredClone(next); }, getActor: async () => 'Gary', now: () => NOW, createId: () => `custom-${++id}` }); return { repository, get value() { return value; } }; };

test('absent storage seeds once while existing malformed storage is preserved', async () => {
  const fresh = harness(undefined); assert.equal((await fresh.repository.load()).reasons.length, 10);
  const malformed = harness({ bad: true }); const loaded = await malformed.repository.load(); assert.equal(loaded.reasons.length, 0); assert.deepEqual(malformed.value, { bad: true });
});

test('seeded reason allows note edits but blocks text changes toggles and deletion', async () => {
  const h = harness(undefined); const seeded = (await h.repository.load()).reasons[0];
  const edited = await h.repository.saveReason({ id: seeded.id, reason: seeded.reason, note: 'Updated note', enabled: true }); assert.equal(edited.note, 'Updated note');
  await assert.rejects(h.repository.saveReason({ id: seeded.id, reason: 'Changed', note: null, enabled: true }), /cannot be changed/i);
  await assert.rejects(h.repository.setReasonEnabled(seeded.id, false), /required/i);
  await assert.rejects(h.repository.softDelete(seeded.id), /cannot be deleted/i);
});

test('custom reasons support audited CRUD and release normalized text after soft delete', async () => {
  const h = harness(undefined); await h.repository.load();
  const added = await h.repository.saveReason({ reason: 'Manual inspection', note: null, enabled: true }); assert.equal(added.createdBy, 'Gary');
  await h.repository.setReasonEnabled(added.id, false); await h.repository.softDelete(added.id);
  const reused = await h.repository.saveReason({ reason: ' manual   inspection ', note: null, enabled: true }); assert.equal(reused.id, 'custom-2');
});
