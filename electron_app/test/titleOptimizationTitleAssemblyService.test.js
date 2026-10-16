const test = require('node:test');
const assert = require('node:assert/strict');
const { assembleTitleFromConfiguredSegments } = require('../src/services/titleOptimizationTitleAssemblyService');

test('configured assembly binds the authoritative resolved make exactly and keeps the model separate', () => {
  const result = assembleTitleFromConfiguredSegments({
    generatedTitle: '2010 Chevrolet Malibu Starter Motor 12345',
    titleSegments: [
      { key: 'yearOrRange', value: '2010' },
      { key: 'make', value: 'Chevrolet' },
      { key: 'model', value: 'Malibu' },
      { key: 'part', value: 'Starter Motor' },
      { key: 'sku', value: '12345' }
    ]
  }, {
    listingContext: { ipnPrefix: '136' },
    titleStructure: { selected: { id: 'general', segments: [
      { key: 'yearOrRange', kind: 'field' }, { key: 'make', kind: 'field' },
      { key: 'model', kind: 'field' }, { key: 'part', kind: 'field' }, { key: 'sku', kind: 'field' }
    ] } }
  }, {
    resolved: { fields: {
      sku: { resolvedValue: '12345' },
      brandMake: { resolvedValue: 'CHEVROLET TRUCK' }
    } }
  });

  assert.equal(result.titleStructureAssembly.status, 'assembled');
  assert.equal(result.generatedTitle, '2010 CHEVROLET TRUCK Malibu Starter Motor 12345');
  assert.equal(result.titleSegments.find(segment => segment.key === 'make').value, 'CHEVROLET TRUCK');
  assert.equal(result.titleSegments.find(segment => segment.key === 'model').value, 'Malibu');
});

test('an exact configured terminology replacement is allowed for the authoritative Make', () => {
  const result = assembleTitleFromConfiguredSegments({
    generatedTitle: '2010 Chevrolet Truck Malibu Starter 12345',
    titleSegments: [
      { key: 'yearOrRange', value: '2010' },
      { key: 'make', value: 'Chevrolet Truck' },
      { key: 'model', value: 'Malibu' },
      { key: 'part', value: 'Starter' },
      { key: 'sku', value: '12345' }
    ]
  }, {
    listingContext: { ipnPrefix: '136' },
    terminologyRules: [{ sourceTerm: 'Chevrolet Truck', action: 'replace', replacementTerm: 'Chevrolet' }],
    titleStructure: { selected: { id: 'general', segments: [
      { key: 'yearOrRange', kind: 'field' }, { key: 'make', kind: 'field' },
      { key: 'model', kind: 'field' }, { key: 'part', kind: 'field' }, { key: 'sku', kind: 'field' }
    ] } }
  }, {
    resolved: { fields: { sku: { resolvedValue: '12345' }, brandMake: { resolvedValue: 'CHEVROLET TRUCK' } } }
  });

  assert.equal(result.generatedTitle, '2010 Chevrolet Malibu Starter 12345');
  assert.equal(result.titleSegments.find(segment => segment.key === 'make').value, 'Chevrolet');
});

test('an unavailable optional descriptor can be omitted while the configured title is assembled', () => {
  const result = assembleTitleFromConfiguredSegments({
    generatedTitle: '2015 Toyota Camry Engine 2.5L 1234567',
    titleSegments: [
      { key: 'year', value: '2015' }, { key: 'make', value: 'Toyota' },
      { key: 'model', value: 'Camry' }, { key: 'engineLiteral', value: 'Engine' },
      { key: 'engineSize', value: '2.5L' }
    ]
  }, {
    listingContext: { ipnPrefix: '300' },
    titleStructure: { selected: { id: 'engines', segments: [
      { key: 'year', kind: 'field' }, { key: 'make', kind: 'field' },
      { key: 'model', kind: 'field' }, { key: 'engineLiteral', kind: 'literal', label: 'Engine' },
      { key: 'engineSize', kind: 'field' }, { key: 'approvedDescriptor', kind: 'field', optional: true },
      { key: 'sku', kind: 'field' }
    ] } }
  }, { resolved: { fields: { sku: { resolvedValue: '1234567' }, brandMake: { resolvedValue: 'Toyota' } } } });

  assert.equal(result.titleStructureAssembly.status, 'assembled');
  assert.equal(result.generatedTitle, '2015 Toyota Camry Engine 2.5L 1234567');
  assert.equal(result.titleSegments.some(segment => segment.key === 'approvedDescriptor'), true);
  assert.equal(result.titleSegments.find(segment => segment.key === 'approvedDescriptor').value, '');
});

test('a missing non-optional title segment remains a structure error', () => {
  const result = assembleTitleFromConfiguredSegments({
    generatedTitle: '2015 Toyota Engine 2.5L 1234567',
    titleSegments: [
      { key: 'year', value: '2015' }, { key: 'make', value: 'Toyota' },
      { key: 'engineLiteral', value: 'Engine' }, { key: 'engineSize', value: '2.5L' }
    ]
  }, {
    listingContext: { ipnPrefix: '300' },
    titleStructure: { selected: { id: 'engines', segments: [
      { key: 'year', kind: 'field' }, { key: 'make', kind: 'field' },
      { key: 'model', kind: 'field' }, { key: 'engineLiteral', kind: 'literal', label: 'Engine' },
      { key: 'engineSize', kind: 'field' }, { key: 'sku', kind: 'field' }
    ] } }
  }, { resolved: { fields: { sku: { resolvedValue: '1234567' }, brandMake: { resolvedValue: 'Toyota' } } } });

  assert.equal(result.titleStructureAssembly.status, 'invalid');
  assert.ok(result.titleStructureAssembly.errors.some(error => error.includes('configured segment model')));
});
