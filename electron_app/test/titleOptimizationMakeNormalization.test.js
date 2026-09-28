const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVehicleMake } = require('../src/services/titleOptimizationMakeNormalizationService');

test('make formatting preserves every source word independently of IPN', () => {
  assert.equal(normalizeVehicleMake(' CHEVROLET  TRUCK '), 'Chevrolet Truck');
  assert.equal(normalizeVehicleMake('Unknown Truck'), 'Unknown Truck');
});

test('make formatting does not apply terminology replacements and preserves acronyms', () => {
  const rules = [{ sourceTerm: 'Example Motors', replacementTerm: 'Example', action: 'replace', condition: 'always', appliesTo: 'all' }];
  assert.equal(normalizeVehicleMake('EXAMPLE MOTORS', rules), 'Example Motors');
  assert.equal(normalizeVehicleMake('Other Motors', rules), 'Other Motors');
  assert.equal(normalizeVehicleMake('Example Motors', [{ ...rules[0], enabled: false }]), 'Example Motors');
  assert.equal(normalizeVehicleMake('BMW GMC'), 'BMW GMC');
});
