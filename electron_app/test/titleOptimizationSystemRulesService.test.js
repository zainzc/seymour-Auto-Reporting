const test = require('node:test');
const assert = require('node:assert/strict');
const { getTitleOptimizationSystemRules } = require('../src/services/titleOptimizationSystemRulesService');

const TITLES = [
  'Never Guess or Invent', 'Manual Override Protection', 'Preserve Critical Fitment',
  'Manufacturer Part Number Safety', 'SKU Exactly Once at End', 'Prefix 257 #SKU Exception',
  '80 Character Maximum', 'Over-Limit Reduction Order', 'AC Formatting',
  'Make / Model Case Safety', 'Side Only When Verified', 'Junk / Noise Cleanup',
  'Truthful Duplicate Handling', 'No-Degrade / Idempotency', 'Final Validation'
];
const CATEGORIES = ['Safety','Protection','Fitment','Part Numbers','SKU','SKU','Length','Length','Formatting','Formatting','Fitment','Cleanup','Duplicates','Protection','Validation'];

test('canonical System Rules returns the exact locked SR-01 through SR-15 metadata', () => {
  const rules = getTitleOptimizationSystemRules();
  assert.deepEqual(rules.map(rule => rule.id), TITLES.map((_, i) => `SR-${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual(rules.map(rule => rule.title), TITLES);
  assert.deepEqual(rules.map(rule => rule.category), CATEGORIES);
  assert.ok(rules.every(rule => rule.source === 'client-v5' && rule.version === 'v5' && rule.locked === true));
  assert.match(rules[14].behavior, /AI reviews supplied listing evidence/i);
  assert.match(rules[13].behavior, /Proposed title would degrade existing title/);
  assert.match(rules[2].behavior, /Enforced by the runtime validator/i);
  assert.match(rules[14].behavior, /AI Evidence Check/);
  assert.match(rules[14].behavior, /no separate human approval is required/i);
  assert.match(rules[14].behavior, /Code does not independently infer semantic fitment, side, or category/i);
  assert.match(rules[14].behavior, /enforces the 80-character maximum/i);
  assert.match(rules[14].behavior, /title over 80 characters is Needs Review/i);
  assert.notEqual(getTitleOptimizationSystemRules(), rules);
});
