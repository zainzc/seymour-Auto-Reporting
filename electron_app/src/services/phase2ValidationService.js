const EXPECTED_PHASE1_HEADERS = [
  'RNumber',
  'InventoryNumber',
  'ModelYear',
  'ModelName',
  'CategoryCode',
  'StockTicketNumber',
  'PartType',
  'LocationCode',
  'PrimaryARADamageCode',
  'SecondaryARADamageCode',
  'ConditionsAndOptions',
  'PartNotes',
  'IsAlternate',
  'PartRating',
  'InventoriedDate',
  'DateAcquired',
  'ConditionCode',
  'QuantityAvailable',
  'QuantityQuoted',
  'QuantityOnHold',
  'Inventorier',
  'Dismantler',
  'Mileage',
  'RetailPrice',
  'WholesalePrice',
  'CostPrice',
  'ValuePrice',
  'EbayPrice',
  'EcomPrice',
  'DamageReported',
  'UnitsOfDamage',
  'DateBPGGraded',
  'EComDescription',
  'PrivacyIndicator',
  'BlockOnlineSale',
  'ReferenceNumber'
];

const LEGACY_PHASE1_HEADERS = [
  'RNumber',
  'InventoryNumber',
  'ModelYear',
  'ModelName',
  'CategoryCode',
  'StockTicketNumber',
  'PartType',
  'LocationCode',
  'PrimaryARADamageCode',
  'SecondaryARADamageCode',
  'ConditionsAndOptions',
  'PartNotes',
  'IsAlternate',
  'PartRating',
  'InventoriedDate',
  'DateAcquired',
  'ConditionCode',
  'QuantityAvailable',
  'QuantityQuoted',
  'QuantityOnHold',
  'InventorierID',
  'DismantlerID',
  'Mileage',
  'RetailPrice',
  'WholesalePrice',
  'CostPrice',
  'ValuePrice',
  'EbayPrice',
  'EcomPrice',
  'DamageReported',
  'UnitsOfDamage',
  'DateBPGGraded',
  'EComDescription',
  'PrivacyIndicator',
  'BlockOnlineSale',
  'ReferenceNumber'
];

const EXPECTED_PHASE1_HEADERS_WITH_INTERCHANGE = [
  ...EXPECTED_PHASE1_HEADERS,
  'InterChangeNumber'
];

const LEGACY_PHASE1_HEADERS_WITH_INTERCHANGE = [
  ...LEGACY_PHASE1_HEADERS,
  'InterChangeNumber'
];

const EXPECTED_PHASE1_HEADERS_WITH_INTERCHANGE_BEFORE_REFERENCE = [
  ...EXPECTED_PHASE1_HEADERS.slice(0, -1),
  'InterChangeNumber',
  'ReferenceNumber'
];

const LEGACY_PHASE1_HEADERS_WITH_INTERCHANGE_BEFORE_REFERENCE = [
  ...LEGACY_PHASE1_HEADERS.slice(0, -1),
  'InterChangeNumber',
  'ReferenceNumber'
];

const OPTIONAL_PHASE1_HEADERS = new Set([
  'Last Modified Date/Time',
  'LastDateModified'
]);

function normalizeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function parseNumeric(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;

  const normalized = text.replace(/,/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchesVariant(cleaned, variant) {
  if (cleaned.length !== variant.length) return false;
  for (let i = 0; i < variant.length; i += 1) {
    if (cleaned[i] !== variant[i]) {
      return false;
    }
  }
  return true;
}

function findHeaderVariant(headers) {
  const variants = [
    EXPECTED_PHASE1_HEADERS,
    LEGACY_PHASE1_HEADERS,
    EXPECTED_PHASE1_HEADERS_WITH_INTERCHANGE,
    LEGACY_PHASE1_HEADERS_WITH_INTERCHANGE,
    EXPECTED_PHASE1_HEADERS_WITH_INTERCHANGE_BEFORE_REFERENCE,
    LEGACY_PHASE1_HEADERS_WITH_INTERCHANGE_BEFORE_REFERENCE
  ];
  const cleaned = headers.map(h => String(h || '').trim());

  for (const variant of variants) {
    if (matchesVariant(cleaned, variant)) {
      return cleaned;
    }

    if (
      cleaned.length === variant.length + 1 &&
      cleaned[0] === variant[0] &&
      OPTIONAL_PHASE1_HEADERS.has(cleaned[1])
    ) {
      const withoutOptional = [cleaned[0], ...cleaned.slice(2)];
      if (matchesVariant(withoutOptional, variant)) {
        return cleaned;
      }
    }
  }

  return null;
}

function validateHeaders(headers) {
  if (!Array.isArray(headers)) {
    throw new Error('Invalid header row: header row is missing.');
  }

  const variant = findHeaderVariant(headers);
  if (!variant) {
    const cleaned = headers.map(h => String(h || '').trim());
    throw new Error(
      `Header mismatch for Phase 1 dataset. Received columns: ${cleaned.join(', ')}`
    );
  }

  return variant;
}

function buildRowObject(headers, rowValues) {
  const row = {};
  headers.forEach((header, index) => {
    row[header] = rowValues[index] !== undefined ? rowValues[index] : '';
  });
  return row;
}

function getIpnPrefix(ipn) {
  const firstToken = String(ipn).split('-')[0].trim();
  const parsed = parseInt(firstToken, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRow(row, rowNumber) {
  const ipn = normalizeString(row.InventoryNumber);
  if (!ipn) {
    return {
      rowNumber,
      skipReason: 'missing_ipn'
    };
  }

  const upperIpn = ipn.toUpperCase();
  if (upperIpn.startsWith('900') || upperIpn.startsWith('950') || upperIpn.startsWith('999')) {
    return {
      rowNumber,
      skipReason: 'excluded_prefix'
    };
  }

  const ipnPrefix = getIpnPrefix(ipn);

  return {
    rowNumber,
    skipReason: null,
    rNumber: normalizeString(row.RNumber),
    ipn,
    ipnUpper: upperIpn,
    ipnPrefix,
    qoh: parseNumeric(row.QuantityAvailable) || 0,
    categoryCode: normalizeString(row.CategoryCode),
    conditionsAndOptions: normalizeString(row.ConditionsAndOptions),
    conditionsAndOptionsLower: normalizeLower(row.ConditionsAndOptions),
    partType: normalizeString(row.PartType),
    modelYear: normalizeString(row.ModelYear),
    modelName: normalizeString(row.ModelName),
    locationCode: normalizeString(row.LocationCode),
    stockTicketNumber: normalizeString(row.StockTicketNumber),
    interchangeNumber: normalizeString(row.InterChangeNumber),
    referenceNumber: normalizeString(row.ReferenceNumber),
    sourceRow: row
  };
}

module.exports = {
  EXPECTED_PHASE1_HEADERS,
  LEGACY_PHASE1_HEADERS,
  validateHeaders,
  buildRowObject,
  normalizeRow,
  normalizeString
};
