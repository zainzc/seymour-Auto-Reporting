const { DEFAULT_SOURCE_PRIORITY } = require('./titleOptimizationSourcePriorityService');

const SOURCE_FIELD_SECTION = 'sourceFields';
const SOURCE_PRIORITY_SECTION = 'sourcePriority';

const SEMANTIC_SOURCE = Object.freeze({
  existingTitle: 'currentEbay',
  legacyTitle: 'rawHollander',
  rawSourceTitle: 'rawHollander',
  manualOverrideStatus: 'manualOverride',
  manualOverrideTitle: 'manualOverride',
  fixedIpnValues: 'lockedFixedIpn',
  sku: 'otherStructuredFields',
  ipn: 'otherStructuredFields',
  ipnPrefix: 'otherStructuredFields',
  year: 'otherStructuredFields',
  structuredYear: 'otherStructuredFields',
  brandMake: 'brandMake',
  manufacturerPartNumber: 'manufacturerPartNumber',
  itemSpecifics: 'itemSpecifics',
  conditionsOptions: 'categoryConditions',
  categoryPart: 'categoryConditions',
  currentEbayFields: 'currentEbay'
});

const ITEM_SPECIFIC_ALIASES = Object.freeze({
  brandMake: ['C:Brand', 'Brand', 'Make', 'C:Make'],
  part: ['C:Part', 'Part', 'Part Type', 'Category', 'Category Name'],
  manufacturerPartNumber: ['C:MPN', 'MPN', 'Manufacturer Part Number', 'C:Manufacturer Part Number'],
  side: ['Side', 'Placement on Vehicle', 'C:Side'],
  year: ['Year', 'C:Year', 'Year Range']
});

class RuntimeConfigurationError extends Error {
  constructor(section, message, details = {}) {
    super(message);
    this.name = 'RuntimeConfigurationError';
    this.section = section;
    this.details = details;
  }
}

function normalizeText(value) {
  if (Array.isArray(value)) return normalizeText(value[0]);
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/\s+/g, ' ');
}

function normalizeCompare(value) {
  return normalizeText(value).toLocaleLowerCase('en-US');
}

function rawRecordFields(record = {}) {
  return record?.fields && typeof record.fields === 'object' ? record.fields : record || {};
}

function readField(fields = {}, mapping = {}) {
  const name = normalizeText(mapping.sourceFieldName);
  if (!name) return undefined;
  if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name];
  const target = normalizeCompare(name);
  const key = Object.keys(fields).find(candidate => normalizeCompare(candidate) === target);
  return key ? fields[key] : undefined;
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function normalizeObjectValues(value) {
  const parsed = parseObject(value);
  if (!parsed) return null;
  const out = {};
  for (const [key, raw] of Object.entries(parsed)) {
    const name = normalizeText(key);
    if (!name) continue;
    if (Array.isArray(raw)) {
      const values = raw.map(item => normalizeText(item)).filter(Boolean);
      if (values.length) out[name] = values.join(', ');
      continue;
    }
    const text = normalizeText(raw);
    if (text) out[name] = text;
  }
  return Object.keys(out).length ? out : null;
}

function deriveIpnPrefix(value) {
  const text = normalizeText(value).toUpperCase();
  if (!text) return '';
  const beforeSeparator = text.match(/^([A-Z0-9]+)(?=[\s-])/);
  if (beforeSeparator) return beforeSeparator[1];
  const numericPrefix = text.match(/^(\d{3,})/);
  return numericPrefix ? numericPrefix[1] : '';
}

function sectionFromSnapshot(snapshot = {}, section) {
  return snapshot?.sections?.[section] || null;
}

function assertRuntimeReadyFor(snapshot = {}, section) {
  const blocking = Array.isArray(snapshot.blockingSections) ? snapshot.blockingSections : [];
  if (snapshot.runtimeReady === false && (blocking.length === 0 || blocking.includes(section))) {
    throw new RuntimeConfigurationError(section, `${labelForSection(section)} configuration is not runtime-ready.`, {
      blockingSections: blocking
    });
  }
}

function labelForSection(section) {
  if (section === SOURCE_FIELD_SECTION) return 'Source Fields';
  if (section === SOURCE_PRIORITY_SECTION) return 'Source Priority';
  return section;
}

function activeSourceMappings(runtimeSnapshot = {}) {
  assertRuntimeReadyFor(runtimeSnapshot, SOURCE_FIELD_SECTION);
  const section = sectionFromSnapshot(runtimeSnapshot, SOURCE_FIELD_SECTION);
  if (!section || section.available === false) {
    throw new RuntimeConfigurationError(SOURCE_FIELD_SECTION, 'Source Fields configuration is unavailable.');
  }
  const items = Array.isArray(section.items) ? section.items : [];
  const mappings = [];
  for (const item of items) {
    if (!item || item.enabled === false || item.deletedAt) continue;
    const logicalKey = normalizeText(item.logicalKey);
    if (!logicalKey || !normalizeText(item.id)) {
      throw new RuntimeConfigurationError(SOURCE_FIELD_SECTION, 'Source Fields configuration is malformed.', { mapping: item });
    }
    if (item.required && !normalizeText(item.sourceFieldName) && !normalizeText(item.sourceFieldId)) {
      throw new RuntimeConfigurationError(
        SOURCE_FIELD_SECTION,
        `Required Source Field mapping '${logicalKey}' is not mapped.`,
        { logicalKey }
      );
    }
    mappings.push(item);
  }
  return mappings;
}

function activePriorityRows(runtimeSnapshot = {}) {
  assertRuntimeReadyFor(runtimeSnapshot, SOURCE_PRIORITY_SECTION);
  const section = sectionFromSnapshot(runtimeSnapshot, SOURCE_PRIORITY_SECTION);
  if (!section || section.available === false) {
    throw new RuntimeConfigurationError(SOURCE_PRIORITY_SECTION, 'Source Priority configuration is unavailable.');
  }
  const rows = (Array.isArray(section.items) ? section.items : [])
    .filter(row => row && row.enabled !== false && !row.deletedAt)
    .map(row => ({ key: normalizeText(row.key), priority: Number(row.priority) || 0 }));

  const keys = rows.map(row => row.key);
  const expected = new Set(DEFAULT_SOURCE_PRIORITY);
  const seen = new Set();
  const malformed =
    rows.length !== DEFAULT_SOURCE_PRIORITY.length ||
    rows.some(row => !expected.has(row.key) || seen.has(row.key) || (seen.add(row.key) && false)) ||
    keys[0] !== 'manualOverride' ||
    DEFAULT_SOURCE_PRIORITY.some(key => !seen.has(key));

  if (malformed) {
    throw new RuntimeConfigurationError(SOURCE_PRIORITY_SECTION, 'Source Priority configuration is malformed.', { keys });
  }
  return rows.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
}

function evidence(value, source, mapping = null, rawValue = value, extra = {}) {
  const normalized = typeof value === 'object' && value !== null ? value : normalizeText(value);
  const missing = typeof normalized === 'object' ? Object.keys(normalized).length === 0 : !normalized;
  return {
    value: missing ? null : normalized,
    rawValue,
    source,
    sourceFieldName: mapping?.sourceFieldName || null,
    sourceFieldId: mapping?.sourceFieldId || null,
    mappingId: mapping?.id || null,
    missing,
    ...extra
  };
}

function setMappedField(out, mapping, rawValue) {
  const key = mapping.logicalKey;
  const source = SEMANTIC_SOURCE[key] || (mapping.isCustom ? 'otherStructuredFields' : 'otherStructuredFields');
  const structured = key === 'itemSpecifics' || key === 'currentEbayFields'
    ? normalizeObjectValues(rawValue)
    : null;
  const value = structured || rawValue;
  const target = structured ? out.structured : out.fields;
  target[key] = evidence(value, source, mapping, rawValue, {
    logicalKey: key,
    displayName: mapping.displayName || key,
    structured: Boolean(structured)
  });
}

function normalizeListingEvidence({ runtimeSnapshot, listingRecord, masterRecord = {} } = {}) {
  const mappings = activeSourceMappings(runtimeSnapshot);
  const fields = rawRecordFields(listingRecord);
  const masterFields = rawRecordFields(masterRecord);
  const out = {
    contractVersion: 1,
    runtimeMode: 'shadow-only',
    runtimeReady: true,
    recordId: listingRecord?.id || null,
    fields: {},
    structured: {},
    manualOverride: {
      status: evidence('', 'manualOverride'),
      title: evidence('', 'manualOverride'),
      active: false
    },
    descriptionOnly: {},
    titleAuthority: {},
    missing: [],
    unresolved: [],
    allEvidence: []
  };

  for (const mapping of mappings) {
    const rawValue = readField(fields, mapping);
    setMappedField(out, mapping, rawValue);
  }

  const ipnEvidence = out.fields.ipnPrefix || out.fields.ipn;
  const ipn = normalizeText(ipnEvidence?.value);
  if (ipn) {
    out.fields.ipn = evidence(ipn, 'otherStructuredFields', ipnEvidence, ipnEvidence.rawValue, { logicalKey: 'ipn' });
    out.fields.ipnPrefix = evidence(deriveIpnPrefix(ipn), 'otherStructuredFields', ipnEvidence, ipnEvidence.rawValue, { logicalKey: 'ipnPrefix' });
  }

  out.manualOverride.status = out.fields.manualOverrideStatus || evidence('', 'manualOverride');
  out.manualOverride.title = out.fields.manualOverrideTitle || evidence('', 'manualOverride');
  out.manualOverride.active = /manual|override|approved/i.test(normalizeText(out.manualOverride.status.value));

  const partFitment = normalizeText(masterFields['Part Fitment'] || masterFields.partFitment);
  out.descriptionOnly.partFitment = evidence(partFitment, 'descriptionOnly', null, partFitment, {
    titleAuthority: false
  });

  for (const [key, item] of Object.entries(out.fields)) {
    if (item?.missing) out.missing.push(key);
    out.allEvidence.push({ field: key, ...item });
  }
  for (const [key, item] of Object.entries(out.structured)) {
    if (item?.missing) out.missing.push(key);
    out.allEvidence.push({ field: key, ...item });
  }
  return out;
}

function itemSpecificValue(itemSpecifics = {}, aliases = []) {
  for (const alias of aliases) {
    const target = normalizeCompare(alias);
    const match = Object.entries(itemSpecifics || {}).find(([key]) => normalizeCompare(key) === target);
    const value = normalizeText(match?.[1]);
    if (value) return value;
  }
  return '';
}

function candidate(field, source, value, priority, evidenceValue) {
  return {
    field,
    source,
    value: normalizeText(value),
    priority,
    evidence: evidenceValue || null
  };
}

function candidatesForField(field, normalized, priorities) {
  const priorityBySource = new Map(priorities.map(row => [row.key, row.priority]));
  const add = (out, source, value, evidenceValue) => {
    const text = normalizeText(value);
    if (!text) return;
    out.push(candidate(field, source, text, priorityBySource.get(source) || Number.MAX_SAFE_INTEGER, evidenceValue));
  };
  const out = [];
  const itemSpecifics = normalized.structured.itemSpecifics?.value || {};

  if (field === 'title') {
    add(out, 'manualOverride', normalized.manualOverride.title.value, normalized.manualOverride.title);
    add(out, 'currentEbay', normalized.fields.existingTitle?.value, normalized.fields.existingTitle);
    add(out, 'rawHollander', normalized.fields.legacyTitle?.value || normalized.fields.rawSourceTitle?.value, normalized.fields.legacyTitle || normalized.fields.rawSourceTitle);
  } else if (field === 'brandMake') {
    add(out, 'itemSpecifics', itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES.brandMake), normalized.structured.itemSpecifics);
    add(out, 'brandMake', normalized.fields.brandMake?.value, normalized.fields.brandMake);
  } else if (field === 'part') {
    add(out, 'itemSpecifics', itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES.part), normalized.structured.itemSpecifics);
    add(out, 'categoryConditions', normalized.fields.categoryPart?.value || normalized.fields.conditionsOptions?.value, normalized.fields.categoryPart || normalized.fields.conditionsOptions);
    add(out, 'rawHollander', normalized.fields.rawSourceTitle?.value || normalized.fields.legacyTitle?.value, normalized.fields.rawSourceTitle || normalized.fields.legacyTitle);
  } else if (field === 'manufacturerPartNumber') {
    add(out, 'itemSpecifics', itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES.manufacturerPartNumber), normalized.structured.itemSpecifics);
    add(out, 'manufacturerPartNumber', normalized.fields.manufacturerPartNumber?.value, normalized.fields.manufacturerPartNumber);
  } else if (field === 'side') {
    add(out, 'itemSpecifics', itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES.side), normalized.structured.itemSpecifics);
    add(out, 'categoryConditions', normalized.fields.conditionsOptions?.value, normalized.fields.conditionsOptions);
  } else if (field === 'year') {
    add(out, 'itemSpecifics', itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES.year), normalized.structured.itemSpecifics);
    add(out, 'otherStructuredFields', normalized.fields.year?.value || normalized.fields.structuredYear?.value, normalized.fields.year || normalized.fields.structuredYear);
  } else if (field === 'sku') {
    add(out, 'otherStructuredFields', normalized.fields.sku?.value, normalized.fields.sku);
  } else if (normalized.fields[field]) {
    const item = normalized.fields[field];
    add(out, item.source || 'otherStructuredFields', item.value, item);
  }

  return out.sort((a, b) => a.priority - b.priority || a.source.localeCompare(b.source) || a.value.localeCompare(b.value));
}

function resolveField(field, candidates = []) {
  const present = candidates.filter(item => normalizeText(item.value));
  if (!present.length) {
    return {
      field,
      candidates: [],
      resolvedValue: null,
      resolvedSource: null,
      conflict: false,
      conflicts: [],
      missing: true
    };
  }
  const winner = present[0];
  const winnerKey = normalizeCompare(winner.value);
  const conflicts = [];
  const seen = new Set([winnerKey]);
  for (const item of present.slice(1)) {
    const key = normalizeCompare(item.value);
    if (!key || key === winnerKey || seen.has(key)) continue;
    seen.add(key);
    conflicts.push(item);
  }
  return {
    field,
    candidates: present,
    resolvedValue: winner.value,
    resolvedSource: winner.source,
    conflict: conflicts.length > 0,
    conflicts,
    missing: false
  };
}

function resolveSourcePriority({ runtimeSnapshot, normalizedListing, fields = [] } = {}) {
  const priorities = activePriorityRows(runtimeSnapshot);
  const requested = Array.isArray(fields) && fields.length
    ? fields
    : ['title', 'brandMake', 'part', 'manufacturerPartNumber', 'side', 'year', 'sku'];
  const resolvedFields = {};
  for (const field of requested) {
    resolvedFields[field] = resolveField(field, candidatesForField(field, normalizedListing, priorities));
  }
  return {
    contractVersion: 1,
    runtimeMode: 'shadow-only',
    priorityOrder: priorities.map(row => row.key),
    fields: resolvedFields,
    conflicts: Object.values(resolvedFields).filter(item => item.conflict),
    missing: Object.values(resolvedFields).filter(item => item.missing).map(item => item.field)
  };
}

function normalizeAndResolveListing({ runtimeSnapshot, listingRecord, masterRecord = {}, fields = [] } = {}) {
  const normalized = normalizeListingEvidence({ runtimeSnapshot, listingRecord, masterRecord });
  const resolved = resolveSourcePriority({ runtimeSnapshot, normalizedListing: normalized, fields });
  return {
    contractVersion: 1,
    mode: 'shadow-only',
    productionIntegration: false,
    normalized,
    resolved
  };
}

module.exports = {
  RuntimeConfigurationError,
  deriveIpnPrefix,
  normalizeListingEvidence,
  resolveSourcePriority,
  normalizeAndResolveListing
};
