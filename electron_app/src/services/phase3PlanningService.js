const EXCLUDED_PREFIXES = ['900', '950', '999'];

function isPositiveNumber(value) {
  return Number.isFinite(value) && value > 0;
}

function normalizeSku(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeIpn(value) {
  return String(value || '').trim();
}

function isExcludedIpn(ipn) {
  const normalized = normalizeIpn(ipn).toUpperCase();
  return EXCLUDED_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCreateDateMs(value) {
  const dateMs = Date.parse(String(value || '').trim());
  return Number.isFinite(dateMs) ? dateMs : null;
}

function roundToTwo(value) {
  return Math.round(value * 100) / 100;
}

function formatTextNumber(value, decimals = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return '';
  if (decimals <= 0) {
    return String(Math.round(parsed));
  }
  return parsed.toFixed(decimals);
}

function extractCompleteShipmentMeasurements(shipment) {
  const weightOz = parseNumber(shipment?.weight?.value);
  const lengthIn = parseNumber(shipment?.dimensions?.length);
  const widthIn = parseNumber(shipment?.dimensions?.width);
  const heightIn = parseNumber(shipment?.dimensions?.height);
  const createDateMs = parseCreateDateMs(shipment?.createDate);

  const hasCompleteDims =
    isPositiveNumber(weightOz) &&
    isPositiveNumber(lengthIn) &&
    isPositiveNumber(widthIn) &&
    isPositiveNumber(heightIn);

  if (!hasCompleteDims) return null;

  return {
    weightOz,
    lengthIn,
    widthIn,
    heightIn,
    createDate: shipment?.createDate || null,
    createDateMs,
    shipmentId: shipment?.shipmentId || shipment?.shipmentNumber || null
  };
}

function shouldReplaceMeasurement(existing, incoming) {
  if (!existing) return true;
  const existingMs = existing.createDateMs;
  const incomingMs = incoming.createDateMs;
  if (Number.isFinite(incomingMs) && Number.isFinite(existingMs)) {
    return incomingMs > existingMs;
  }
  if (Number.isFinite(incomingMs) && !Number.isFinite(existingMs)) {
    return true;
  }
  return false;
}

function buildSkuToDims(shipments) {
  const skuObserved = new Set();
  const skuToDims = new Map();

  for (const shipment of shipments || []) {
    const complete = extractCompleteShipmentMeasurements(shipment);
    const items = Array.isArray(shipment?.shipmentItems) ? shipment.shipmentItems : [];
    for (const item of items) {
      const sku = normalizeSku(item?.sku);
      if (!sku) continue;
      skuObserved.add(sku);

      if (!complete) continue;
      const existing = skuToDims.get(sku);
      if (shouldReplaceMeasurement(existing, complete)) {
        skuToDims.set(sku, complete);
      }
    }
  }

  return {
    skuToDims,
    skusExtracted: skuObserved.size,
    skusWithCompleteDims: skuToDims.size
  };
}

function buildIpnToDims(skuToDims, rnumToIpn, summary, handlers = {}) {
  const ipnToDims = new Map();

  for (const [sku, dims] of skuToDims.entries()) {
    const ipn = normalizeIpn(rnumToIpn.get(sku));
    if (!ipn) {
      summary.skusUnmappedInPowerlink += 1;
      if (typeof handlers.onUnmappedSku === 'function') {
        handlers.onUnmappedSku(sku);
      }
      continue;
    }

    summary.skusMappedToIpn += 1;
    if (isExcludedIpn(ipn)) {
      summary.ipnsSkippedExcludedPrefix += 1;
      if (typeof handlers.onExcludedIpn === 'function') {
        handlers.onExcludedIpn(ipn, sku);
      }
      continue;
    }

    const existing = ipnToDims.get(ipn);
    if (shouldReplaceMeasurement(existing, dims)) {
      ipnToDims.set(ipn, dims);
    }
  }

  return ipnToDims;
}

function isBlankFieldValue(value) {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && !value.trim()) ||
    (Array.isArray(value) && value.length === 0)
  );
}

function normalizeFieldKey(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveExistingFieldName(existingFields, exactCandidates = [], containsAllKeywords = [], fallback = '') {
  const fieldNames = Object.keys(existingFields || {});
  const normalizedToOriginal = new Map(fieldNames.map(name => [normalizeFieldKey(name), name]));

  for (const candidate of exactCandidates) {
    const match = normalizedToOriginal.get(normalizeFieldKey(candidate));
    if (match) return match;
  }

  for (const fieldName of fieldNames) {
    const normalized = normalizeFieldKey(fieldName);
    if (containsAllKeywords.every(keyword => normalized.includes(normalizeFieldKey(keyword)))) {
      return fieldName;
    }
  }

  return fallback;
}

function buildShipstationFieldsForBlankTargets(existingFields, dims) {
  const lengthText = formatTextNumber(dims.lengthIn, 0);
  const widthText = formatTextNumber(dims.widthIn, 0);
  const heightText = formatTextNumber(dims.heightIn, 0);
  const weightLbs = roundToTwo(dims.weightOz / 16);
  const weightText = formatTextNumber(weightLbs, 2);

  const lengthFieldName = resolveExistingFieldName(
    existingFields,
    ['Package Length (ShipStation)', 'Package Length (Shipstation)'],
    ['package', 'length', 'shipstation'],
    'Package Length (ShipStation)'
  );
  const widthFieldName = resolveExistingFieldName(
    existingFields,
    ['Package Width (ShipStation)', 'Package Width (Shipstation)'],
    ['package', 'width', 'shipstation'],
    'Package Width (ShipStation)'
  );
  const heightFieldName = resolveExistingFieldName(
    existingFields,
    ['Package Height (ShipStation)', 'Package Height (Shipstation)'],
    ['package', 'height', 'shipstation'],
    'Package Height (ShipStation)'
  );
  const weightFieldName = resolveExistingFieldName(
    existingFields,
    [
      'Package Weight (ShipStation)',
      'Package Weight (Shipstation)',
      'Package Weight (ShipStation) converted to lbs',
      'Package Weight (Shipstation) converted to lbs'
    ],
    ['package', 'weight', 'shipstation'],
    'Package Weight (ShipStation)'
  );

  const targets = [
    { fieldName: lengthFieldName, value: lengthText, mode: 'blank_only' },
    { fieldName: widthFieldName, value: widthText, mode: 'blank_only' },
    { fieldName: heightFieldName, value: heightText, mode: 'blank_only' },
    { fieldName: weightFieldName, value: weightText, numericValue: weightLbs, mode: 'sync_weight_lbs' }
  ];

  const fields = {};
  for (const target of targets) {
    const fieldName = String(target?.fieldName || '').trim();
    const value = target?.value;
    if (!fieldName || !value) continue;

    const current = existingFields ? existingFields[fieldName] : undefined;
    if (target.mode === 'blank_only') {
      if (isBlankFieldValue(current)) {
        fields[fieldName] = value;
      }
      continue;
    }

    if (target.mode === 'sync_weight_lbs') {
      const currentNumber = parseNumber(current);
      const isAccurate = Number.isFinite(currentNumber) && Math.abs(currentNumber - target.numericValue) < 0.01;
      if (!isAccurate) {
        fields[fieldName] = value;
      }
    }
  }

  return fields;
}

module.exports = {
  buildSkuToDims,
  buildIpnToDims,
  buildShipstationFieldsForBlankTargets,
  isExcludedIpn,
  normalizeSku
};

