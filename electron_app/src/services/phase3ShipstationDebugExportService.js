const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { buildSkuToDims, normalizeSku } = require('./phase3PlanningService');

function normalizeText(value) {
  return String(value || '').trim();
}

function isPositiveNumber(value) {
  return Number.isFinite(value) && value > 0;
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

function normalizeWeightUnit(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function convertWeightToLbs(value, unit) {
  const parsed = parseNumber(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  const normalizedUnit = normalizeWeightUnit(unit);
  if (!normalizedUnit || normalizedUnit === 'oz' || normalizedUnit === 'ounce' || normalizedUnit === 'ounces') {
    return parsed / 16;
  }
  if (normalizedUnit === 'lb' || normalizedUnit === 'lbs' || normalizedUnit === 'pound' || normalizedUnit === 'pounds') {
    return parsed;
  }
  if (normalizedUnit === 'g' || normalizedUnit === 'gram' || normalizedUnit === 'grams') {
    return parsed / 453.59237;
  }
  if (normalizedUnit === 'kg' || normalizedUnit === 'kilogram' || normalizedUnit === 'kilograms') {
    return parsed * 2.2046226218;
  }

  return parsed / 16;
}

function extractCompleteShipmentMeasurements(shipment) {
  const weightValue = parseNumber(shipment?.weight?.value);
  const weightUnit =
    shipment?.weight?.units ||
    shipment?.weight?.unit ||
    shipment?.weightUnit ||
    shipment?.weightUnits ||
    '';
  const weightLbs = convertWeightToLbs(weightValue, weightUnit);
  const lengthIn = parseNumber(shipment?.dimensions?.length);
  const widthIn = parseNumber(shipment?.dimensions?.width);
  const heightIn = parseNumber(shipment?.dimensions?.height);
  const createDateMs = parseCreateDateMs(shipment?.createDate);

  const hasCompleteDims =
    isPositiveNumber(weightLbs) &&
    isPositiveNumber(lengthIn) &&
    isPositiveNumber(widthIn) &&
    isPositiveNumber(heightIn);

  if (!hasCompleteDims) return null;

  return {
    weightLbs: roundToTwo(weightLbs),
    weightSourceValue: weightValue,
    weightSourceUnit: normalizeWeightUnit(weightUnit),
    lengthIn,
    widthIn,
    heightIn,
    createDate: shipment?.createDate || null,
    createDateMs,
    shipmentId: shipment?.shipmentId || shipment?.shipmentNumber || null
  };
}

function isExcludedIpn(ipn) {
  const normalized = String(ipn || '').trim().toUpperCase();
  return normalized.startsWith('900') || normalized.startsWith('950') || normalized.startsWith('999');
}

function resolveMappedIpn(sku = '', rnumToIpn = new Map(), directSkuToIpn = new Map()) {
  const directIpn = normalizeText(directSkuToIpn.get(sku));
  if (directIpn) {
    return { mappedIpn: directIpn, mappingMethod: 'Master RNumber' };
  }
  const powerlinkIpn = normalizeText(rnumToIpn.get(sku));
  if (powerlinkIpn) {
    return { mappedIpn: powerlinkIpn, mappingMethod: 'Powerlink RNumber' };
  }
  return { mappedIpn: '', mappingMethod: '' };
}

function buildRawShipmentItemRows(shipments = [], rnumToIpn = new Map(), directSkuToIpn = new Map()) {
  const rows = [];
  const uniqueSkus = new Set();
  let itemsWithCompleteDims = 0;
  let mappedRows = 0;

  for (const shipment of shipments || []) {
    const complete = extractCompleteShipmentMeasurements(shipment);
    const shipmentItems = Array.isArray(shipment?.shipmentItems) && shipment.shipmentItems.length > 0
      ? shipment.shipmentItems
      : [null];

    for (const item of shipmentItems) {
      const sku = normalizeSku(item?.sku);
      if (sku) uniqueSkus.add(sku);

      const mapping = sku ? resolveMappedIpn(sku, rnumToIpn, directSkuToIpn) : {};
      const mappedIpn = normalizeText(mapping.mappedIpn);
      const row = {
        ShipmentID: shipment?.shipmentId || shipment?.shipmentNumber || '',
        ShipmentNumber: shipment?.shipmentNumber || '',
        OrderNumber: shipment?.orderNumber || shipment?.orderKey || '',
        CreateDate: shipment?.createDate || '',
        CarrierCode: shipment?.carrierCode || '',
        ServiceCode: shipment?.serviceCode || '',
        TrackingNumber: shipment?.trackingNumber || '',
        SKU: sku || '',
        Quantity: item?.quantity || item?.lineItemQuantity || item?.qty || '',
        LengthIn: complete?.lengthIn || '',
        WidthIn: complete?.widthIn || '',
        HeightIn: complete?.heightIn || '',
        WeightLbs: complete?.weightLbs || '',
        WeightSourceValue: complete?.weightSourceValue || '',
        WeightSourceUnit: complete?.weightSourceUnit || '',
        HasCompleteDims: complete ? 'Yes' : 'No',
        MappedIPN: mappedIpn,
        MappingMethod: mappedIpn ? normalizeText(mapping.mappingMethod) : '',
        MappingStatus: mappedIpn
          ? isExcludedIpn(mappedIpn)
            ? 'Excluded IPN'
            : 'Mapped'
          : 'Unmapped'
      };

      if (complete) itemsWithCompleteDims += 1;
      if (mappedIpn) mappedRows += 1;
      rows.push(row);
    }
  }

  return {
    rows,
    totalItems: rows.length,
    uniqueSkus: uniqueSkus.size,
    itemsWithCompleteDims,
    mappedRows
  };
}

function buildSkuSummaryRows(shipments = [], rnumToIpn = new Map(), directSkuToIpn = new Map()) {
  const { skuToDims } = buildSkuToDims(shipments);
  const rows = [];
  let mappedCount = 0;
  let masterRNumberMappedCount = 0;
  let powerlinkMappedCount = 0;
  let unmappedCount = 0;
  let excludedCount = 0;

  for (const [sku, dims] of skuToDims.entries()) {
    const mapping = resolveMappedIpn(sku, rnumToIpn, directSkuToIpn);
    const mappedIpn = normalizeText(mapping.mappedIpn);
    let mappingStatus = 'Unmapped';
    if (mappedIpn) {
      if (isExcludedIpn(mappedIpn)) {
        mappingStatus = 'Excluded IPN';
        excludedCount += 1;
      } else {
        mappingStatus = 'Mapped';
        mappedCount += 1;
        if (mapping.mappingMethod === 'Master RNumber') masterRNumberMappedCount += 1;
        if (mapping.mappingMethod === 'Powerlink RNumber') powerlinkMappedCount += 1;
      }
    } else {
      unmappedCount += 1;
    }

    rows.push({
      SKU: sku,
      MappedIPN: mappedIpn,
      MappingMethod: mappedIpn ? normalizeText(mapping.mappingMethod) : '',
      MappingStatus: mappingStatus,
      ShipmentID: dims?.shipmentId || '',
      CreateDate: dims?.createDate || '',
      LengthIn: dims?.lengthIn || '',
      WidthIn: dims?.widthIn || '',
      HeightIn: dims?.heightIn || '',
      WeightLbs: dims?.weightLbs || ''
    });
  }

  return {
    rows,
    uniqueSkuCount: rows.length,
    mappedCount,
    masterRNumberMappedCount,
    powerlinkMappedCount,
    unmappedCount,
    excludedCount
  };
}

function applyWorksheetStyling(worksheet, freezeHeader = true) {
  if (!worksheet || !worksheet.columns) return;

  worksheet.columns.forEach(column => {
    column.width = Math.max(12, Math.min(30, (column.header ? String(column.header).length : 12) + 4));
  });

  if (freezeHeader) {
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  worksheet.getRow(1).font = { bold: true };
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: worksheet.columnCount }
  };
}

async function exportShipstationDebugWorkbook({
  shipments = [],
  rnumToIpn = new Map(),
  directSkuToIpn = new Map(),
  outputPath
} = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Phase 3 ShipStation Debug Export';
  workbook.created = new Date();
  workbook.views = [{ activeTab: 0 }];

  const safeOutputPath =
    String(outputPath || '').trim() ||
    path.resolve(__dirname, '..', '..', 'dev-output', 'phase3-shipstation-debug.xlsx');
  fs.mkdirSync(path.dirname(safeOutputPath), { recursive: true });

  const rawData = buildRawShipmentItemRows(shipments, rnumToIpn, directSkuToIpn);
  const skuSummary = buildSkuSummaryRows(shipments, rnumToIpn, directSkuToIpn);

  const rawSheet = workbook.addWorksheet('Raw Shipment Items');
  rawSheet.columns = [
    { header: 'ShipmentID', key: 'ShipmentID', width: 18 },
    { header: 'ShipmentNumber', key: 'ShipmentNumber', width: 16 },
    { header: 'OrderNumber', key: 'OrderNumber', width: 16 },
    { header: 'CreateDate', key: 'CreateDate', width: 24 },
    { header: 'CarrierCode', key: 'CarrierCode', width: 14 },
    { header: 'ServiceCode', key: 'ServiceCode', width: 14 },
    { header: 'TrackingNumber', key: 'TrackingNumber', width: 18 },
    { header: 'SKU', key: 'SKU', width: 18 },
    { header: 'Quantity', key: 'Quantity', width: 10 },
    { header: 'LengthIn', key: 'LengthIn', width: 10 },
    { header: 'WidthIn', key: 'WidthIn', width: 10 },
    { header: 'HeightIn', key: 'HeightIn', width: 10 },
    { header: 'WeightLbs', key: 'WeightLbs', width: 10 },
    { header: 'WeightSourceValue', key: 'WeightSourceValue', width: 16 },
    { header: 'WeightSourceUnit', key: 'WeightSourceUnit', width: 14 },
    { header: 'HasCompleteDims', key: 'HasCompleteDims', width: 14 },
    { header: 'MappedIPN', key: 'MappedIPN', width: 18 },
    { header: 'MappingMethod', key: 'MappingMethod', width: 18 },
    { header: 'MappingStatus', key: 'MappingStatus', width: 14 }
  ];
  rawSheet.addRows(rawData.rows);
  applyWorksheetStyling(rawSheet);

  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Metric', key: 'metric', width: 34 },
    { header: 'Value', key: 'value', width: 36 }
  ];
  summarySheet.addRows([
    { metric: 'Shipments fetched', value: shipments.length },
    { metric: 'Raw shipment item rows', value: rawData.totalItems },
    { metric: 'Unique SKUs observed', value: rawData.uniqueSkus },
    { metric: 'Raw rows with complete dims', value: rawData.itemsWithCompleteDims },
    { metric: 'Raw rows with mapped IPN', value: rawData.mappedRows },
    { metric: 'Unique SKU summary rows', value: skuSummary.uniqueSkuCount },
    { metric: 'Unique SKU summary mapped', value: skuSummary.mappedCount },
    { metric: 'Unique SKU summary mapped by Master RNumber', value: skuSummary.masterRNumberMappedCount },
    { metric: 'Unique SKU summary mapped by Powerlink RNumber', value: skuSummary.powerlinkMappedCount },
    { metric: 'Unique SKU summary unmapped', value: skuSummary.unmappedCount },
    { metric: 'Unique SKU summary excluded', value: skuSummary.excludedCount },
    { metric: 'Output file', value: safeOutputPath }
  ]);
  applyWorksheetStyling(summarySheet);

  const skuSheet = workbook.addWorksheet('SKU Summary');
  skuSheet.columns = [
    { header: 'SKU', key: 'SKU', width: 18 },
    { header: 'MappedIPN', key: 'MappedIPN', width: 18 },
    { header: 'MappingMethod', key: 'MappingMethod', width: 18 },
    { header: 'MappingStatus', key: 'MappingStatus', width: 14 },
    { header: 'ShipmentID', key: 'ShipmentID', width: 18 },
    { header: 'CreateDate', key: 'CreateDate', width: 24 },
    { header: 'LengthIn', key: 'LengthIn', width: 10 },
    { header: 'WidthIn', key: 'WidthIn', width: 10 },
    { header: 'HeightIn', key: 'HeightIn', width: 10 },
    { header: 'WeightLbs', key: 'WeightLbs', width: 10 }
  ];
  skuSheet.addRows(skuSummary.rows);
  applyWorksheetStyling(skuSheet);

  workbook.views = [{ activeTab: 0 }];

  await workbook.xlsx.writeFile(safeOutputPath);

  return {
    filePath: safeOutputPath,
    rawRows: rawData.totalItems,
    uniqueSkus: rawData.uniqueSkus,
    mappedRows: rawData.mappedRows,
    skuSummaryRows: skuSummary.uniqueSkuCount
  };
}

module.exports = {
  exportShipstationDebugWorkbook
};
