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

function buildShipstationFieldsForBlankTargets(existingFields, dims) {
  const lengthText = formatTextNumber(dims.lengthIn, 0);
  const widthText = formatTextNumber(dims.widthIn, 0);
  const heightText = formatTextNumber(dims.heightIn, 0);
  const weightText = formatTextNumber(roundToTwo(dims.weightOz / 16), 2);

  const targets = [
    ['Length (ShipStation)', lengthText],
    ['Width (ShipStation)', widthText],
    ['Height (ShipStation)', heightText],
    ['Weight (ShipStation)', weightText]
  ];

  const fields = {};
  for (const [fieldName, value] of targets) {
    if (!value) continue;
    const current = existingFields ? existingFields[fieldName] : undefined;
    const isBlank =
      current === null ||
      current === undefined ||
      (typeof current === 'string' && !current.trim()) ||
      (Array.isArray(current) && current.length === 0);
    if (isBlank) {
      fields[fieldName] = value;
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
