function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeLinkKey(value) {
  return normalizeText(value).toUpperCase();
}

function getLinkKeyVariants(value) {
  const key = String(value || '');
  return key ? [key] : [];
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.replace(/,/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDateMs(value) {
  const text = normalizeText(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function selectBetterCandidate(existing, incoming) {
  if (!existing) return incoming;

  const existingQohPositive = (existing.quantityAvailable || 0) > 0;
  const incomingQohPositive = (incoming.quantityAvailable || 0) > 0;

  if (existingQohPositive !== incomingQohPositive) {
    return incomingQohPositive ? incoming : existing;
  }

  const existingDate = existing.lastModifiedMs;
  const incomingDate = incoming.lastModifiedMs;
  if (Number.isFinite(existingDate) && Number.isFinite(incomingDate) && existingDate !== incomingDate) {
    return incomingDate > existingDate ? incoming : existing;
  }

  return existing;
}

function findHeaderIndex(headers, aliases) {
  const normalizedHeaders = headers.map(header => normalizeText(header).toLowerCase());
  for (const alias of aliases) {
    const idx = normalizedHeaders.indexOf(String(alias).trim().toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

function buildPowerlinkMapping(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Powerlink source sheet is empty.');
  }

  const headers = values[0] || [];
  const rnumberIdx = findHeaderIndex(headers, ['RNumber', 'R Number', 'InventoryID']);
  const ipnIdx = findHeaderIndex(headers, ['InventoryNumber', 'IPN']);
  const qohIdx = findHeaderIndex(headers, ['QuantityAvailable', 'Quantity (QOH)', 'QOH']);
  const lastModifiedIdx = findHeaderIndex(headers, ['LastDateModified', 'DateLastModified']);

  if (rnumberIdx < 0 || ipnIdx < 0) {
    throw new Error('Powerlink sheet is missing required columns: RNumber and InventoryNumber.');
  }

  const map = new Map();
  const duplicates = [];

  for (let rowIdx = 1; rowIdx < values.length; rowIdx += 1) {
    const row = values[rowIdx] || [];
    const rnumber = String(row[rnumberIdx] || '');
    const ipn = normalizeText(row[ipnIdx]);
    if (!rnumber || !ipn) {
      continue;
    }

    const incoming = {
      rnumber,
      ipn,
      quantityAvailable: qohIdx >= 0 ? toNumber(row[qohIdx]) || 0 : 0,
      lastModifiedMs: lastModifiedIdx >= 0 ? toDateMs(row[lastModifiedIdx]) : null
    };

    const key = rnumber;
    const existing = map.get(key);
    if (existing) {
      const selected = selectBetterCandidate(existing, incoming);
      map.set(key, selected);
      if (selected !== existing) {
        duplicates.push(`Duplicate RNumber '${rnumber}': selected row ${rowIdx + 1} over earlier row.`);
      }
      continue;
    }

    map.set(key, incoming);
  }

  const rnumToIpn = new Map();
  for (const [key, candidate] of map.entries()) {
    for (const variant of getLinkKeyVariants(key)) {
      if (!rnumToIpn.has(variant)) {
        rnumToIpn.set(variant, candidate.ipn);
      }
    }
  }

  return {
    rnumToIpn,
    rowsScanned: Math.max(0, values.length - 1),
    mappedCount: map.size,
    duplicateWarnings: duplicates
  };
}

module.exports = {
  buildPowerlinkMapping,
  normalizeLinkKey,
  getLinkKeyVariants
};
