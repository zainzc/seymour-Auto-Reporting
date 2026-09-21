const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/services/titleOptimizationFlagReasonsService');
const NOW = '2026-09-21T12:00:00.000Z';
const NAMES = ['Missing verified year','Make cannot be verified','Model cannot be normalized safely','Multiple year ranges require review','Part identity uncertain','Required engine fitment missing','Transmission code cannot be verified','Conflicting source data','Cannot preserve essential fitment within 80 characters','Proposed title would degrade existing title'];

test('first run seeds exactly the ten required client-v5 reasons in authoritative order', () => {
  const config = service.seedFlagReasonsConfiguration({ now: NOW, actor: 'Gary' });
  assert.deepEqual(config.reasons.map(x => x.reason), NAMES);
  assert.deepEqual(config.reasons.map(x => x.seedOrder), [1,2,3,4,5,6,7,8,9,10]);
  assert.ok(config.reasons.every(x => x.origin === 'client-v5' && x.required && x.enabled && x.createdBy === 'Gary'));
});

test('duplicate normalized reasons quarantine every conflicting record and preserve unrelated valid entries', () => {
  const config = service.seedFlagReasonsConfiguration({ now: NOW, actor: 'Gary' });
  const duplicate = { ...config.reasons[1], id: 'custom-duplicate', origin: 'custom', seedOrder: null, required: false, reason: ' missing   verified YEAR ' };
  const hydrated = service.hydrateFlagReasonsConfiguration({ ...config, reasons: [config.reasons[0], duplicate, config.reasons[2]] });
  assert.deepEqual(hydrated.reasons.map(x => x.id), [config.reasons[2].id]);
  assert.equal(hydrated.quarantined.length, 2);
  assert.match(hydrated.issues[0].message, /missing verified year.*client-v5-01.*custom-duplicate/i);
});

test('future read excludes invalid disabled and deleted reasons without injecting missing seeds', () => {
  const config = service.seedFlagReasonsConfiguration({ now: NOW, actor: 'Gary' });
  const custom = { ...config.reasons[0], id: 'custom-a', origin: 'custom', seedOrder: null, required: false, reason: 'Additional review', enabled: true };
  const result = service.enabledFlagReasons(service.hydrateFlagReasonsConfiguration({ ...config, reasons: [config.reasons[2], { ...config.reasons[0], enabled: false }, custom] }));
  assert.deepEqual(result.map(x => x.reason), ['Model cannot be normalized safely', 'Additional review']);
});
