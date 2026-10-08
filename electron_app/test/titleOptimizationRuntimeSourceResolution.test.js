const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RuntimeConfigurationError,
  normalizeListingEvidence,
  resolveSourcePriority,
  normalizeAndResolveListing
} = require('../src/services/titleOptimizationRuntimeSourceResolutionService');

function mapping(logicalKey, sourceFieldName, extras = {}) {
  return {
    id: `source-${logicalKey}`,
    logicalKey,
    displayName: logicalKey,
    sourceFieldName,
    enabled: true,
    deletedAt: null,
    sortOrder: 1,
    ...extras
  };
}

test('mirror category normalization does not invent an exterior mirror identity', () => {
  for (const [category, expected] of [['Interior:Rear View Mirrors', 'Rear View Mirrors'],
    ['Mirrors', 'Mirrors'], ['Exterior:Side View Mirrors', 'Side View Mirrors']]) {
    const normalized = normalizeListingEvidence({ runtimeSnapshot: snapshot(),
      listingRecord: listing({ 'Category Name': category }) });
    assert.equal(normalized.derived.cleanedCategoryPart.value, expected);
  }
});

test('structured part Type participates in configured source priority ahead of broad category', () => {
  const result = normalizeAndResolveListing({ runtimeSnapshot: snapshot(), listingRecord: listing({
    'Category Name': 'Mirrors',
    'Item Specifics - All C: values relevant to item': JSON.stringify({ Type: 'Interior Rear View Mirror' })
  }) });
  assert.equal(result.resolved.fields.part.resolvedValue, 'Interior Rear View Mirror');
  assert.equal(result.resolved.fields.part.resolvedSource, 'itemSpecifics');
});

test('source derivation does not turn negative equipment or part-name wording into positive facts', () => {
  const result = normalizeAndResolveListing({ runtimeSnapshot: snapshot(), listingRecord: listing({
    'Item Title': '2012 Example Interior Rear View Mirror 00155',
    'Current eBay Fields': JSON.stringify({ donorNotes: 'NON-ILLUMINATED' }),
    'Item Specifics - All C: values relevant to item': JSON.stringify({ Features: 'Does not apply' })
  }) });
  assert.equal(result.normalized.derived.keyFitmentDetailFromNotes.value, null);
  assert.equal(result.resolved.fields.keyFitmentDetail.resolvedValue, null);
  const mirror = normalizeListingEvidence({ runtimeSnapshot: snapshot(), listingRecord: listing({
    'Item Title': '2012 Example Rear View Mirror 00155', 'Current eBay Fields': '{}' }) });
  assert.equal(mirror.derived.placementFromNotes.value, null);
});

test('advertised application model is not replaced by a different donor model', () => {
  const result = normalizeAndResolveListing({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({ 'Item Title': 'Starter Motor Fits 09-15 PILOT 00123', 'Current eBay Fields': JSON.stringify({ donorModel: 'TL', donorYear: '2011' }) }),
    masterRecord: { fields: { 'Part Fitment': 'PILOT 09-15 Starter Motor' } }
  });
  assert.equal(result.resolved.fields.model.resolvedValue, 'PILOT');
  assert.equal(result.resolved.fields.model.conflict, false);
  assert.equal(result.normalized.derived.yearFromDonor.role, 'donor');
});

test('full authoritative make is preserved and shorter corroborating source does not conflict', () => {
  const runtimeSnapshot = snapshot();
  runtimeSnapshot.sections.terminologyRules = { available: true, items: [{ sourceTerm: 'Example Motors', replacementTerm: 'Example', action: 'replace', condition: 'always', appliesTo: 'all' }] };
  const result = normalizeAndResolveListing({ runtimeSnapshot,
    listingRecord: listing({ 'C:Brand': 'Example', 'Item Specifics - All C: values relevant to item': JSON.stringify({ Brand: 'Example Motors' }) }) });
  assert.equal(result.resolved.fields.brandMake.resolvedValue, 'Example Motors');
  assert.equal(result.resolved.fields.brandMake.conflict, false);
});

test('Front placement complements Driver Left side rather than conflicting with it', () => {
  const result = normalizeAndResolveListing({ runtimeSnapshot: snapshot(),
    listingRecord: listing({ 'Item Title': 'Driver Left Lower Control Arm Front Fits 13-15 CIVIC 1583061', 'Conditions & Options': '',
      'Item Specifics - All C: values relevant to item': JSON.stringify({ 'Placement on Vehicle': 'Front' }) }),
    masterRecord: { fields: { 'Part Fitment': '2013-2015 Honda Civic front lower control arm driver side' } } });
  assert.equal(result.resolved.fields.side.resolvedValue, 'Driver Left LH');
  assert.equal(result.resolved.fields.side.conflict, false);
  assert.equal(result.resolved.fields.placement.resolvedValue, 'Front');
});

function snapshot(overrides = {}) {
  const mappings = [
    mapping('existingTitle', 'Item Title'),
    mapping('legacyTitle', 'Title', { isCustom: true }),
    mapping('manualOverrideStatus', 'Title Override Status'),
    mapping('manualOverrideTitle', 'Manual Override Title', { isCustom: true }),
    mapping('sku', 'SKU'),
    mapping('ipnPrefix', 'IPN'),
    mapping('brandMake', 'C:Brand'),
    mapping('categoryPart', 'Category Name'),
    mapping('itemSpecifics', 'Item Specifics - All C: values relevant to item'),
    mapping('conditionsOptions', 'Conditions & Options'),
    mapping('manufacturerPartNumber', 'C:Manufacturer Part Number'),
    mapping('rawSourceTitle', 'Hollander Title'),
    mapping('currentEbayFields', 'Current eBay Fields'),
    mapping('structuredYear', 'Structured Year', { isCustom: true }),
    mapping('customTrim', 'Trim Level', { isCustom: true })
  ];

  const rows = [
    { key: 'manualOverride', priority: 1 },
    { key: 'lockedFixedIpn', priority: 2 },
    { key: 'itemSpecifics', priority: 3 },
    { key: 'categoryConditions', priority: 4 },
    { key: 'manufacturerPartNumber', priority: 5 },
    { key: 'brandMake', priority: 6 },
    { key: 'otherStructuredFields', priority: 7 },
    { key: 'currentEbay', priority: 8 },
    { key: 'rawHollander', priority: 9 }
  ];

  return {
    mode: 'authoritative',
    runtimeReady: true,
    blockingSections: [],
    sections: {
      sourceFields: { available: true, items: mappings },
      sourcePriority: { available: true, items: rows }
    },
    ...overrides
  };
}

function listing(fields = {}) {
  return {
    id: 'recListing',
    fields: {
      'Item Title': 'Old eBay Title',
      Title: 'Raw Hollander Toyota Mirror 1554743',
      'Title Override Status': '',
      'Manual Override Title': '',
      SKU: '00155',
      IPN: '0641-00641L',
      'C:Brand': 'Toyota',
      'Category Name': 'Door Mirror',
      'Conditions & Options': 'Driver side mirror',
      'C:Manufacturer Part Number': 'MPN-9',
      'Hollander Title': 'Toyota Mirror Hollander',
      'Structured Year': '2012',
      'Trim Level': 'LX',
      'Item Specifics - All C: values relevant to item': JSON.stringify({
        'C:Brand': 'Honda',
        'C:Part': 'Side View Mirror',
        'C:MPN': 'MPN-9'
      }),
      'Current eBay Fields': JSON.stringify({ Subtitle: 'Current listing note' }),
      ...fields
    }
  };
}

test('normalizes configured listing evidence with partFitment as title authority', () => {
  const normalized = normalizeListingEvidence({
    runtimeSnapshot: snapshot(),
    listingRecord: listing(),
    masterRecord: { fields: { 'Part Fitment': 'Fits 2011 Toyota Camry front only' } }
  });

  assert.equal(normalized.runtimeReady, true);
  assert.equal(normalized.fields.existingTitle.value, 'Old eBay Title');
  assert.equal(normalized.fields.legacyTitle.value, 'Raw Hollander Toyota Mirror 1554743');
  assert.equal(normalized.fields.sku.value, '00155');
  assert.equal(normalized.fields.ipn.value, '0641-00641L');
  assert.equal(normalized.fields.ipnPrefix.value, '0641');
  assert.equal(normalized.fields.brandMake.value, 'Toyota');
  assert.equal(normalized.fields.categoryPart.value, 'Door Mirror');
  assert.equal(normalized.fields.manufacturerPartNumber.value, 'MPN-9');
  assert.equal(normalized.fields.customTrim.value, 'LX');
  assert.deepEqual(normalized.structured.itemSpecifics.value, {
    'C:Brand': 'Honda',
    'C:Part': 'Side View Mirror',
    'C:MPN': 'MPN-9'
  });
  assert.equal(normalized.titleAuthority.partFitment.value, 'Fits 2011 Toyota Camry front only');
  assert.equal(normalized.titleAuthority.partFitment.titleAuthority, true);
});

test('derives title-safe vehicle and part details from mapped listing evidence', () => {
  const result = normalizeAndResolveListing({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Item Title': 'Seat Belt Front Bucket Seat Sedan Passenger Fits 11-16 ELANTRA 1588313',
      Title: 'Seat Belt Front Bucket Seat Sedan Passenger Fits 11-16 ELANTRA 1588313',
      SKU: '1588313',
      IPN: '210-52921',
      'Structured Year': '',
      'C:Brand': 'HYUNDAI',
      'Category Name': 'eBay Motors:Parts & Accessories:Car & Truck Parts & Accessories:Interior Parts & Accessories:Interior Safety:Seat Belts & Parts',
      'Conditions & Options': '',
      'C:Manufacturer Part Number': '888203X500RY',
      'Item Specifics - All C: values relevant to item': JSON.stringify({
        Brand: 'HYUNDAI',
        'C:Features': '2-Point Harness',
        'C:Type': 'Seat Belt',
        'C:Number in Pack': '1',
        'C:Color': 'Beige'
      }),
      'Current eBay Fields': JSON.stringify({
        donorModel: 'ELANTRA',
        donorYear: '2011',
        donorNotes: 'PASS RETRACTOR YDA - BEIGE'
      })
    }),
    masterRecord: {
      fields: {
        'Part Fitment': 'Fits 2011-2015 Hyundai Elantra Seat Belt Front Bucket Seat Sedan Passenger Retractor; 2016 Hyundai Elantra Seat Belt Front Bucket Seat Sedan Passenger Retractor'
      }
    }
  });

  assert.equal(result.resolved.fields.yearRange, undefined);
  assert.equal(result.resolved.fields.model.resolvedValue, 'ELANTRA');
  assert.equal(result.resolved.fields.side.resolvedValue, 'Passenger Right RH');
  assert.equal(result.resolved.fields.componentType.resolvedValue, 'Retractor');
  assert.equal(result.resolved.fields.color.resolvedValue, 'Beige');
  assert.equal(result.resolved.fields.sku.resolvedValue, '1588313');
  assert.equal(result.resolved.missing.includes('model'), false);
  assert.equal(result.normalized.titleAuthority.partFitment.value.includes('2011-2015 Hyundai Elantra'), true);
});

test('derives donor values from mapped HTML description source', () => {
  const sourceFields = {
    available: true,
    items: snapshot().sections.sourceFields.items.map(item =>
      item.logicalKey === 'currentEbayFields'
        ? { ...item, sourceFieldName: 'Description' }
        : item
    )
  };
  const htmlDescription = `
    <!-- PLModel: 535045435452412020 --><!-- PLYear: 32303039 --><!-- PLStockNumber: 323630383731 -->
    <div class="des_section"><div class="d_left">Model :</div><div class="d_right">SPECTRA  </div></div>
    <div class="des_section"><div class="d_left">Year :</div><div class="d_right">2009</div></div>
    <div class="des_section"><div class="d_left">Stock Number :</div><div class="d_right">260871</div></div>
    <div class="des_section"><div class="d_left">Notes :</div><div class="d_right">FRNT </div></div>
  `;

  const result = normalizeAndResolveListing({
    runtimeSnapshot: {
      ...snapshot(),
      sections: { ...snapshot().sections, sourceFields }
    },
    listingRecord: listing({
      'Item Title': 'Driver Left Power Window Motor Front Sedan Fits 04-09 SPECTRA 1586203',
      SKU: '1586203',
      IPN: '617-58916L',
      'Structured Year': '',
      'Conditions & Options': '',
      Description: htmlDescription,
      'Current eBay Fields': undefined
    })
  });

  assert.equal(result.resolved.fields.yearRange, undefined);
  assert.equal(result.resolved.fields.year.resolvedValue, '2009');
  assert.equal(result.resolved.fields.model.resolvedValue, 'SPECTRA');
  assert.equal(result.resolved.fields.side.resolvedValue, 'Driver Left LH');
});

test('retains a donor note from legacy Description when current eBay fields are unmapped', () => {
  const runtimeSnapshot = snapshot();
  runtimeSnapshot.sections.sourceFields.items = runtimeSnapshot.sections.sourceFields.items.filter(item =>
    item.logicalKey !== 'currentEbayFields');
  const result = normalizeAndResolveListing({ runtimeSnapshot,
    listingRecord: listing({ Description: '<div class="d_left">Notes :</div><div class="d_right">TRUNK LATCH ACTUATOR</div>' }) });
  assert.equal(result.normalized.titleAuthority.legacyDonorNote.value, 'TRUNK LATCH ACTUATOR');
});

test('keeps two-digit partFitment ranges as raw AI evidence without resolving yearRange', () => {
  const result = normalizeAndResolveListing({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Item Title': 'Driver Left Power Window Motor Front Sedan SPECTRA 1586203',
      SKU: '1586203',
      IPN: '617-58916L',
      'Structured Year': '',
      'Conditions & Options': '',
      'Current eBay Fields': JSON.stringify({ donorModel: 'SPECTRA', donorYear: '2009', donorNotes: 'FRNT' })
    }),
    masterRecord: {
      fields: {
        'Part Fitment': 'SPECTRA 04 Front; 2.0L (4 cylinder), L.; SPECTRA 05-09 Front; Sdn, L.; SPECTRA 05-09 Rear; SW, L.'
      }
    }
  });

  assert.equal(result.resolved.fields.yearRange, undefined);
  assert.equal(result.normalized.titleAuthority.partFitment.value, 'SPECTRA 04 Front; 2.0L (4 cylinder), L.; SPECTRA 05-09 Front; Sdn, L.; SPECTRA 05-09 Rear; SW, L.');
  assert.equal(result.normalized.titleAuthority.partFitment.titleAuthority, true);
});

test('keeps full-year partFitment ranges as raw AI evidence and treats equivalent side labels as non-conflicting', () => {
  const result = normalizeAndResolveListing({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Item Title': '2009 Kia Spectra Driver Left Power Window Motor 824502F000 1586203',
      SKU: '1586203',
      IPN: '617-58916L',
      'Structured Year': '',
      'C:Brand': 'KIA',
      'Category Name': 'Window Motors & Regulators',
      'Conditions & Options': '',
      'Item Specifics - All C: values relevant to item': JSON.stringify({
        'Placement on Vehicle': 'Driver/Left',
        'C:Manufacturer Part Number': '824502F000'
      }),
      'Current eBay Fields': JSON.stringify({ donorModel: 'SPECTRA', donorYear: '2009', donorNotes: 'FRNT' })
    }),
    masterRecord: {
      fields: {
        'Part Fitment': 'Fits 2004 Kia Spectra Window Motor Front Left; 2005-2009 Kia Spectra Window Motor Front Left'
      }
    }
  });

  assert.equal(result.resolved.fields.yearRange, undefined);
  assert.equal(result.normalized.titleAuthority.partFitment.value.includes('2005-2009 Kia Spectra'), true);
  assert.equal(result.resolved.fields.side.resolvedValue, 'Driver/Left');
  assert.equal(result.resolved.fields.side.conflict, false);
});

test('treats plural and possessive structured side labels as equivalent to directional title evidence', () => {
  for (const [structuredSide, titleSide] of [
    ['Drivers Door', 'Driver Left LH'],
    ["Driver's Door", 'Left LH'],
    ['Passengers Door', 'Passenger Right RH'],
    ["Passenger's Door", 'Right RH']
  ]) {
    const result = normalizeAndResolveListing({
      runtimeSnapshot: snapshot(),
      listingRecord: listing({
        'Item Title': `2011 Hyundai Elantra ${titleSide} Master Window Switch 1588346`,
        SKU: '1588346',
        IPN: '641-50922L',
        'Conditions & Options': '',
        'Item Specifics - All C: values relevant to item': JSON.stringify({
          Side: structuredSide,
          'C:Brand': 'Hyundai'
        })
      })
    });

    assert.equal(result.resolved.fields.side.resolvedValue, structuredSide);
    assert.equal(result.resolved.fields.side.conflict, false, `${structuredSide} should agree with ${titleSide}`);
    assert.deepEqual(result.resolved.fields.side.conflicts, []);
  }
});

test('uses an existing-title year range as fallback evidence only when Part Fitment is unavailable', () => {
  const withoutFitment = normalizeAndResolveListing({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Item Title': 'Engine 2.4L VIN 1 6th Digit Coupe Federal Emissions Fits 13-15 ACCORD 1585847',
      SKU: '1585847',
      IPN: '300-80094A',
      'Structured Year': '2013'
    }),
    masterRecord: { fields: { 'Part Fitment': '' } }
  });

  assert.equal(withoutFitment.normalized.titleAuthority.titleYearFallback.value, '2013-2015');
  assert.equal(withoutFitment.normalized.titleAuthority.titleYearFallback.source, 'currentEbay');

  const withFitment = normalizeAndResolveListing({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Item Title': 'Engine 2.4L VIN 1 6th Digit Coupe Federal Emissions Fits 13-15 ACCORD 1585847',
      SKU: '1585847',
      IPN: '300-80094A',
      'Structured Year': '2013'
    }),
    masterRecord: { fields: { 'Part Fitment': 'Fits 2014-2016 Honda Accord Engine' } }
  });

  assert.equal(withFitment.normalized.titleAuthority.titleYearFallback.value, null);

  const singleYearWithoutFitment = normalizeAndResolveListing({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Item Title': '2013 Honda Accord Coupe Engine 2.4L 1585847',
      SKU: '1585847',
      IPN: '300-80094A',
      'Structured Year': ''
    }),
    masterRecord: { fields: { 'Part Fitment': '' } }
  });

  assert.equal(singleYearWithoutFitment.normalized.titleAuthority.titleYearFallback.value, '2013');
});

test('retains full source title for AI without generating a hardcoded protection list', () => {
  const result = normalizeAndResolveListing({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Item Title': 'Engine 2.4L VIN 1 6th Digit Coupe Federal Emissions Fits 13-15 ACCORD 1585847',
      SKU: '1585847',
      IPN: '300-80094A'
    })
  });

  assert.equal(result.normalized.titleAuthority.importantExistingTitleDetails, undefined);
  assert.match(result.normalized.fields.existingTitle.value, /Coupe Federal Emissions/);
});

test('resolves client-required fitment details from structured Item Specifics', () => {
  const result = normalizeAndResolveListing({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Item Specifics - All C: values relevant to item': JSON.stringify({
        'C:Engine Size': '2.4L',
        'C:Engine Code': 'K24W1',
        'C:Transmission Code': 'CVT2',
        'C:Drivetrain': 'FWD',
        'C:Transmission Speeds': '6-Speed',
        'C:VIN Identifier': 'VIN 1',
        'C:Illumination': 'Illuminated',
        'C:Paint Code': 'NH731P',
        'C:Trim': 'EX-L',
        'C:Lighting Technology': 'LED'
      })
    }),
    fields: [
      'engineDisplacement', 'engineCode', 'transmissionCode', 'drivetrain',
      'transmissionSpeedType', 'vinIdentifier', 'illumination', 'paintCode',
      'trim', 'lightingTechnology'
    ]
  });

  assert.equal(result.resolved.fields.engineDisplacement.resolvedValue, '2.4L');
  assert.equal(result.resolved.fields.engineCode.resolvedValue, 'K24W1');
  assert.equal(result.resolved.fields.transmissionCode.resolvedValue, 'CVT2');
  assert.equal(result.resolved.fields.drivetrain.resolvedValue, 'FWD');
  assert.equal(result.resolved.fields.transmissionSpeedType.resolvedValue, '6-Speed');
  assert.equal(result.resolved.fields.vinIdentifier.resolvedValue, 'VIN 1');
  assert.equal(result.resolved.fields.illumination.resolvedValue, 'Illuminated');
  assert.equal(result.resolved.fields.paintCode.resolvedValue, 'NH731P');
  assert.equal(result.resolved.fields.trim.resolvedValue, 'EX-L');
  assert.equal(result.resolved.fields.lightingTechnology.resolvedValue, 'LED');
});

test('retains arbitrary title details for AI assessment', () => {
  const result = normalizeAndResolveListing({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Item Title': '2018 Honda Accord EX-L LED Illuminated Black NH731P Engine Module 1585847'
    })
  });

  assert.equal(result.normalized.titleAuthority.importantExistingTitleDetails, undefined);
  assert.match(result.normalized.fields.existingTitle.value, /EX-L LED Illuminated Black NH731P/);
});

test('does not automatically protect generic Assembly from the existing title', () => {
  const result = normalizeAndResolveListing({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Item Title': '2010-2012 Subaru Outback Column Switch Assembly Station Wgn LEGACY 1459826',
      SKU: '1459826',
      IPN: '629-50937A'
    })
  });

  assert.equal(result.normalized.titleAuthority.importantExistingTitleDetails, undefined);
  assert.match(result.normalized.fields.existingTitle.value, /Assembly/);
});

test('uses fitment and category cleanup for missing make and cleaner part names', () => {
  const result = normalizeAndResolveListing({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Item Title': 'Seat Belt Front Bucket Seat Sedan Passenger 1588313',
      SKU: '1588313',
      IPN: '210-52921',
      'C:Brand': '',
      'Structured Year': '',
      'Category Name': 'eBay Motors:Parts & Accessories:Car & Truck Parts & Accessories:Interior Parts & Accessories:Interior Safety:Seat Belts & Parts',
      'Conditions & Options': '',
      'Item Specifics - All C: values relevant to item': JSON.stringify({
        'C:Color': 'Beige'
      }),
      'Current eBay Fields': JSON.stringify({ donorModel: 'ELANTRA', donorYear: '2011', donorNotes: 'PASS RETRACTOR YDA - BEIGE' })
    }),
    masterRecord: {
      fields: {
        'Part Fitment': 'Fits 2011-2015 Hyundai Elantra Seat Belt Front Bucket Seat Sedan Passenger Retractor; 2016 Hyundai Elantra Seat Belt Front Bucket Seat Sedan Passenger Retractor'
      }
    }
  });

  assert.equal(result.resolved.fields.brandMake.resolvedValue, 'Hyundai');
  assert.equal(result.resolved.fields.brandMake.resolvedSource, 'partFitment');
  assert.equal(result.resolved.fields.part.resolvedValue, 'Seat Belt');
});

test('does not treat other compatible Part Fitment models as listing-model ambiguity', () => {
  const result = normalizeAndResolveListing({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Item Title': '2012 Chevrolet Cruze Throttle Body 1.8L 1584723',
      SKU: '1584723',
      IPN: '337-02220',
      'C:Brand': 'CHEVROLET',
      'Current eBay Fields': JSON.stringify({ donorModel: 'CRUZE', donorYear: '2012' })
    }),
    masterRecord: {
      fields: {
        'Part Fitment': 'Fits 2009-2011 Chevrolet Aveo; 2011-2016 Chevrolet Cruze; 2012-2018 Chevrolet Sonic; 2013-2014 Chevrolet Trax'
      }
    }
  });

  assert.equal(result.resolved.fields.model.resolvedValue, 'CRUZE');
  assert.equal(result.resolved.modelAmbiguity.ambiguous, false);
});

test('derives common placement and feature abbreviations from donor notes', () => {
  const result = normalizeAndResolveListing({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Item Title': 'Power Window Motor SPECTRA 1586203',
      SKU: '1586203',
      IPN: '617-58916L',
      'Structured Year': '',
      'Conditions & Options': '',
      'Current eBay Fields': JSON.stringify({ donorModel: 'SPECTRA', donorYear: '2009', donorNotes: 'FRNT PWR' })
    })
  });

  assert.equal(result.resolved.fields.placement.resolvedValue, 'Front');
  assert.equal(result.resolved.fields.keyFitmentDetail.resolvedValue, 'Power');
});

test('normalization marks optional blanks missing and ignores disabled or deleted mappings', () => {
  const base = snapshot();
  const sourceFields = {
    available: true,
    items: [
      mapping('sku', 'SKU'),
      mapping('brandMake', 'C:Brand', { enabled: false }),
      mapping('categoryPart', 'Category Name', { deletedAt: '2026-01-01T00:00:00.000Z' }),
      mapping('customPaintCode', 'Paint Code', { isCustom: true })
    ]
  };

  const normalized = normalizeListingEvidence({
    runtimeSnapshot: {
      ...base,
      sections: { ...base.sections, sourceFields }
    },
    listingRecord: listing({ SKU: '', 'Paint Code': '' })
  });

  assert.equal(normalized.fields.sku.missing, true);
  assert.equal(normalized.fields.brandMake, undefined);
  assert.equal(normalized.fields.categoryPart, undefined);
  assert.equal(normalized.fields.customPaintCode.missing, true);
});

test('normalization fails fast for unavailable, blocking, malformed, or required missing Source Fields', () => {
  assert.throws(
    () => normalizeListingEvidence({ runtimeSnapshot: snapshot({ runtimeReady: false, blockingSections: ['sourceFields'] }), listingRecord: listing() }),
    (error) => error instanceof RuntimeConfigurationError && error.section === 'sourceFields'
  );

  assert.throws(
    () => normalizeListingEvidence({
      runtimeSnapshot: {
        ...snapshot(),
        sections: { ...snapshot().sections, sourceFields: { available: false, items: [] } }
      },
      listingRecord: listing()
    }),
    /Source Fields configuration is unavailable/
  );

  assert.throws(
    () => normalizeListingEvidence({
      runtimeSnapshot: {
        ...snapshot(),
        sections: { ...snapshot().sections, sourceFields: { available: true, items: [{ id: 'broken' }] } }
      },
      listingRecord: listing()
    }),
    /Source Fields configuration is malformed/
  );

  assert.throws(
    () => normalizeListingEvidence({
      runtimeSnapshot: {
        ...snapshot(),
        sections: { ...snapshot().sections, sourceFields: { available: true, items: [mapping('sku', '', { required: true })] } }
      },
      listingRecord: listing()
    }),
    /Required Source Field mapping 'sku' is not mapped/
  );
});

test('priority resolution falls through blanks, selects highest authority, and preserves lower evidence', () => {
  const normalized = normalizeListingEvidence({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Manual Override Title': '',
      'C:Brand': 'Toyota',
      'Item Specifics - All C: values relevant to item': JSON.stringify({ 'C:Brand': 'Honda' }),
      'Hollander Title': 'Toyota Mirror'
    })
  });

  const resolved = resolveSourcePriority({
    runtimeSnapshot: snapshot(),
    normalizedListing: normalized,
    fields: ['brandMake']
  });

  assert.equal(resolved.fields.brandMake.resolvedValue, 'Honda');
  assert.equal(resolved.fields.brandMake.resolvedSource, 'itemSpecifics');
  assert.equal(resolved.fields.brandMake.conflict, true);
  assert.deepEqual(resolved.fields.brandMake.conflicts.map(item => item.value), ['Toyota']);
  assert.deepEqual(resolved.fields.brandMake.candidates.map(item => item.source), ['itemSpecifics', 'brandMake']);
});

test('priority resolution treats identical values as non-conflicting and no candidate as unresolved', () => {
  const normalized = normalizeListingEvidence({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'C:Brand': 'Honda',
      'Item Specifics - All C: values relevant to item': JSON.stringify({ 'C:Brand': 'Honda' }),
      'Conditions & Options': '',
      'Hollander Title': ''
    })
  });

  const resolved = resolveSourcePriority({
    runtimeSnapshot: snapshot(),
    normalizedListing: normalized,
    fields: ['brandMake', 'engineCode']
  });

  assert.equal(resolved.fields.brandMake.resolvedValue, 'Honda');
  assert.equal(resolved.fields.brandMake.conflict, false);
  assert.equal(resolved.fields.engineCode.missing, true);
  assert.equal(resolved.fields.engineCode.resolvedValue, null);
});

test('only canonical manual override statuses activate title protection', () => {
  const cases = [
    { status: '', canonicalStatus: '', active: false },
    { status: 'Automatic', canonicalStatus: 'Automatic', active: false },
    { status: 'automatic', canonicalStatus: 'Automatic', active: false },
    { status: 'Manually Approved', canonicalStatus: 'Manually Approved', active: true },
    { status: 'manually overridden', canonicalStatus: 'Manually Overridden', active: true },
    { status: 'Approved by staff', canonicalStatus: '', active: false }
  ];

  for (const item of cases) {
    const normalized = normalizeListingEvidence({
      runtimeSnapshot: snapshot(),
      listingRecord: listing({ 'Title Override Status': item.status })
    });

    assert.equal(normalized.manualOverride.canonicalStatus, item.canonicalStatus, item.status || 'blank');
    assert.equal(normalized.manualOverride.active, item.active, item.status || 'blank');
  }
});

test('manually overridden title evidence takes priority when a manual title is supplied', () => {
  const combined = normalizeAndResolveListing({
    runtimeSnapshot: snapshot(),
    listingRecord: listing({
      'Title Override Status': 'Manually Overridden',
      'Manual Override Title': 'Approved Manual Title'
    }),
    fields: ['title']
  });

  assert.equal(combined.normalized.manualOverride.status.value, 'Manually Overridden');
  assert.equal(combined.normalized.manualOverride.canonicalStatus, 'Manually Overridden');
  assert.equal(combined.normalized.manualOverride.active, true);
  assert.equal(combined.resolved.fields.title.resolvedValue, 'Approved Manual Title');
  assert.equal(combined.resolved.fields.title.resolvedSource, 'manualOverride');
  assert.equal(combined.productionIntegration, false);
});

test('priority resolution fails for unavailable or malformed Source Priority without prompt fallback', () => {
  const normalized = normalizeListingEvidence({ runtimeSnapshot: snapshot(), listingRecord: listing() });

  assert.throws(
    () => resolveSourcePriority({
      runtimeSnapshot: {
        ...snapshot(),
        sections: { ...snapshot().sections, sourcePriority: { available: false, items: [] } }
      },
      normalizedListing: normalized,
      fields: ['brandMake']
    }),
    (error) => error instanceof RuntimeConfigurationError && error.section === 'sourcePriority'
  );

  assert.throws(
    () => resolveSourcePriority({
      runtimeSnapshot: {
        ...snapshot(),
        sections: { ...snapshot().sections, sourcePriority: { available: true, items: [{ key: 'manualOverride', priority: 1 }] } }
      },
      normalizedListing: normalized,
      fields: ['brandMake']
    }),
    /Source Priority configuration is malformed/
  );
});

test('normalization and resolution are deterministic across repeated execution', () => {
  const input = { runtimeSnapshot: snapshot(), listingRecord: listing(), fields: ['title', 'brandMake', 'part', 'sku'] };
  const first = normalizeAndResolveListing(input);
  const second = normalizeAndResolveListing(input);
  assert.deepEqual(second, first);
});
