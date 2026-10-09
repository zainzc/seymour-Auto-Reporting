const { DEFAULT_SOURCE_PRIORITY } = require('./titleOptimizationSourcePriorityService');

const SOURCE_FIELD_SECTION = 'sourceFields';
const SOURCE_PRIORITY_SECTION = 'sourcePriority';
const TITLE_OVERRIDE_STATUSES = Object.freeze({
  automatic: 'Automatic',
  'manually approved': 'Manually Approved',
  'manually overridden': 'Manually Overridden'
});

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
  part: ['C:Part', 'Part', 'Part Type', 'C:Type', 'Type', 'Category', 'Category Name'],
  manufacturerPartNumber: ['C:MPN', 'MPN', 'Manufacturer Part Number', 'C:Manufacturer Part Number'],
  side: ['Side', 'Placement on Vehicle', 'C:Side'],
  year: ['Year', 'C:Year', 'Year Range'],
  model: ['Model', 'C:Model'],
  color: ['Color', 'C:Color', 'Paint Color'],
  componentType: ['Component Type', 'C:Component Type'],
  placement: ['Placement', 'Position', 'C:Placement', 'C:Position'],
  keyFitmentDetail: ['Key Fitment Detail', 'Feature', 'Features', 'C:Features'],
  engineDisplacement: ['Engine Size', 'C:Engine Size', 'Engine Displacement', 'C:Engine Displacement', 'C:Engine (liters)'],
  engineCode: ['Engine Code', 'C:Engine Code'],
  transmissionCode: ['Transmission Code', 'C:Transmission Code'],
  drivetrain: ['Drivetrain', 'Drive Type', 'C:Drivetrain', 'C:Drive Type'],
  transmissionSpeedType: ['Transmission Speeds', 'Speed / Type', 'C:Transmission Speeds', 'C:Speed / Type'],
  vinIdentifier: ['VIN Identifier', 'VIN', 'C:VIN Identifier', 'C:VIN'],
  illumination: ['Illumination', 'C:Illumination'],
  paintCode: ['Paint Code', 'C:Paint Code'],
  trim: ['Trim', 'Trim Level', 'C:Trim', 'C:Trim Level'],
  lightingTechnology: ['Lighting Technology', 'C:Lighting Technology', 'Bulb Type', 'C:Bulb Type']
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

function titleCaseWords(value = '') {
  return normalizeText(value).toLowerCase().replace(/\b[a-z]/g, char => char.toUpperCase());
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

function decodeHtmlEntities(value = '') {
  return normalizeText(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtmlToText(value = '') {
  return decodeHtmlEntities(
    normalizeText(value)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:div|p|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function decodeHexCommentValue(value = '') {
  const hex = normalizeText(value).replace(/\s+/g, '');
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return '';
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    const code = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isFinite(code) && code > 0) out += String.fromCharCode(code);
  }
  return normalizeText(out);
}

function readHtmlCommentValue(html = '', name = '') {
  const escaped = normalizeText(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return '';
  const match = String(html || '').match(new RegExp(`<!--\\s*${escaped}\\s*:\\s*([\\s\\S]*?)\\s*-->`, 'i'));
  return normalizeText(match?.[1]);
}

function readDescriptionLabel(html = '', label = '') {
  const escaped = normalizeText(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return '';
  const raw = String(html || '');
  const divPattern = new RegExp(
    `<div[^>]*>\\s*${escaped}\\s*:\\s*<\\/div>\\s*<div[^>]*>([\\s\\S]*?)<\\/div>`,
    'i'
  );
  const divMatch = raw.match(divPattern);
  if (divMatch) return stripHtmlToText(divMatch[1]);

  const text = stripHtmlToText(raw);
  const labels = 'Model|Year|Mileage|Stock Number|Notes';
  const labelMatch = text.match(new RegExp(`${escaped}\\s*:\\s*([\\s\\S]*?)(?=\\s*(?:${labels})\\s*:|\\s*This Part Will Fit|$)`, 'i'));
  return normalizeText(labelMatch?.[1]);
}

function normalizeCurrentEbayFields(value = {}) {
  const structured = normalizeObjectValues(value);
  if (structured) return structured;
  const html = typeof value === 'string' ? value : '';
  if (!normalizeText(html)) return {};

  const out = {};
  const model = readDescriptionLabel(html, 'Model') || decodeHexCommentValue(readHtmlCommentValue(html, 'PLModel'));
  const year = readDescriptionLabel(html, 'Year') || decodeHexCommentValue(readHtmlCommentValue(html, 'PLYear'));
  const notes = readDescriptionLabel(html, 'Notes');
  const stockNumber =
    readDescriptionLabel(html, 'Stock Number') ||
    decodeHexCommentValue(readHtmlCommentValue(html, 'PLStockNumber'));

  if (model) out.donorModel = model;
  if (year) out.donorYear = year;
  if (notes) out.donorNotes = notes;
  if (stockNumber) out.donorStockNumber = stockNumber;
  return out;
}

function expandTwoDigitYear(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return '';
  return String(number <= 30 ? 2000 + number : 1900 + number);
}

function canonicalTitleOverrideStatus(value) {
  return TITLE_OVERRIDE_STATUSES[normalizeText(value).toLocaleLowerCase('en-US')] || '';
}

function deriveYearEvidenceFromTitle(value = '') {
  const text = normalizeText(value);
  const match = text.match(/\b(?:fits?\s+)?(\d{2}|\d{4})\s*-\s*(\d{2}|\d{4})\b/i);
  if (match) {
    const startYear = match[1].length === 2 ? expandTwoDigitYear(match[1]) : match[1];
    let endYear = match[2].length === 2 ? expandTwoDigitYear(match[2]) : match[2];
    if (match[1].length === 4 && match[2].length === 2) {
      endYear = `${match[1].slice(0, 2)}${match[2]}`;
    }
    const start = Number.parseInt(startYear, 10);
    const end = Number.parseInt(endYear, 10);
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end) {
      return `${startYear}-${endYear}`;
    }
  }
  return text.match(/\b(?:19\d{2}|20\d{2})\b/)?.[0] || '';
}

function parseFitmentApplications(value = '') {
  const text = normalizeText(value);
  if (!text) return [];
  const out = [];
  const withMakePattern = /\b(?:Fits\s+)?(\d{4})(?:\s*-\s*(\d{4}))?\s+([A-Z][A-Za-z]+)\s+([A-Z][A-Za-z0-9-]+)\b/g;
  let withMake;
  while ((withMake = withMakePattern.exec(text)) !== null) {
    out.push({
      startYear: withMake[1],
      endYear: withMake[2] || withMake[1],
      make: titleCaseWords(withMake[3]),
      model: normalizeText(withMake[4]).toUpperCase()
    });
  }

  const yearFirstPattern = /\b(?:Fits\s+)?(\d{4})(?:\s*-\s*(\d{4}))?\s+([A-Z][A-Za-z0-9-]+)\s+([A-Z][A-Za-z0-9-]+)\b/g;
  let yearFirst;
  while ((yearFirst = yearFirstPattern.exec(text)) !== null) {
    const first = normalizeText(yearFirst[3]);
    const second = normalizeText(yearFirst[4]);
    if (!first || !second) continue;
    out.push({
      startYear: yearFirst[1],
      endYear: yearFirst[2] || yearFirst[1],
      make: titleCaseWords(first),
      model: second.toUpperCase()
    });
  }

  const compactPattern = /\b([A-Z][A-Z0-9-]{2,})\s+(\d{2,4})(?:\s*-\s*(\d{2,4}))?\b/gi;
  let compact;
  while ((compact = compactPattern.exec(text)) !== null) {
    const startYear = compact[2].length === 2 ? expandTwoDigitYear(compact[2]) : normalizeText(compact[2]);
    const endYear = compact[3]
      ? compact[3].length === 2 ? expandTwoDigitYear(compact[3]) : normalizeText(compact[3])
      : startYear;
    out.push({
      startYear,
      endYear,
      make: '',
      model: normalizeText(compact[1]).toUpperCase()
    });
  }
  return out;
}

function deriveMakeFromFitment(value = '', model = '', year = '') {
  const normalizedModel = normalizeText(model).toUpperCase();
  const targetYear = Number.parseInt(normalizeText(year), 10);
  const applications = parseFitmentApplications(value).filter(item => item.make);
  const matching = applications.find(item => {
    if (normalizedModel && item.model !== normalizedModel) return false;
    const start = Number.parseInt(item.startYear, 10);
    const end = Number.parseInt(item.endYear, 10);
    if (Number.isFinite(targetYear) && Number.isFinite(start) && Number.isFinite(end)) {
      return targetYear >= start && targetYear <= end;
    }
    return true;
  });
  return matching?.make || '';
}

function deriveModelFromTitle(value = '') {
  const text = normalizeText(value);
  const fitMatch = text.match(/\bFits\s+\d{2}\s*-\s*\d{2}\s+([A-Z][A-Z0-9-]{2,})\b/i);
  if (fitMatch) return normalizeText(fitMatch[1]).toUpperCase();
  return '';
}

function modelEvidenceCandidates({ itemSpecifics = {}, existingTitle = '', partFitment = '', donorModel = '' } = {}) {
  const values = [];
  const itemSpecificModel = itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES.model);
  if (itemSpecificModel) values.push({ value: itemSpecificModel, source: 'itemSpecifics' });
  if (donorModel && !deriveModelFromTitle(existingTitle)) values.push({ value: donorModel, source: 'currentEbay' });
  const titleModels = normalizeText(existingTitle).match(/\b(OUTBACK|LEGACY|OUTBAKLEG)\b/gi) || [];
  for (const value of titleModels) values.push({ value: value.toUpperCase(), source: 'currentEbay' });
  for (const application of parseFitmentApplications(partFitment)) {
    if (application.model) values.push({ value: application.model, source: 'partFitment' });
  }
  return values;
}

function modelAmbiguity(candidates = []) {
  const unique = [];
  for (const candidate of candidates) {
    const value = normalizeText(candidate.value).toUpperCase();
    if (!value || unique.some(item => normalizeCompare(item.value) === normalizeCompare(value))) continue;
    unique.push({ value, sources: [candidate.source] });
  }
  for (const candidate of candidates) {
    const entry = unique.find(item => normalizeCompare(item.value) === normalizeCompare(candidate.value));
    if (entry && !entry.sources.includes(candidate.source)) entry.sources.push(candidate.source);
  }
  const listingIdentityValues = unique.filter(item =>
    item.sources.some(source => source === 'itemSpecifics' || source === 'currentEbay')
  );
  return { ambiguous: listingIdentityValues.length > 1, candidates: unique };
}

function modelAmbiguityResolvedByCandidate(sourceResolution = {}, candidateTitle = '') {
  const ambiguity = sourceResolution?.resolved?.modelAmbiguity;
  if (!ambiguity?.ambiguous) return true;
  const title = normalizeCompare(candidateTitle);
  const corroborated = (ambiguity.candidates || [])
    .filter(candidate => (candidate.sources || []).some(source => source === 'currentEbay' || source === 'partFitment'))
    .map(candidate => normalizeText(candidate.value))
    .filter(Boolean);
  const unique = [...new Set(corroborated.map(value => normalizeCompare(value)))];
  return unique.length >= 2 && unique.every(value => title.includes(value));
}

function analyzeSideText(value = '', { contentRole = 'listing-specific' } = {}) {
  const text = normalizeText(value).toUpperCase();
  const hasPassengerRight = /\b(PASS|PASSENGERS?|RIGHT|RH)\b/.test(text);
  const hasDriverLeft = /\b(DRIVERS?|LEFT|LH)\b/.test(text);
  if (hasPassengerRight && hasDriverLeft) {
    return {
      value: '',
      contentRole: /\bLEFT\s+IS\b|\bRIGHT\s+IS\b|\bDRIVER'?S?\s+SIDE\b.*\bPASSENGER'?S?\s+SIDE\b/.test(text)
        ? 'boilerplate'
        : contentRole
    };
  }
  if (hasPassengerRight) return { value: 'Passenger Right RH', contentRole };
  if (hasDriverLeft) return { value: 'Driver Left LH', contentRole };
  return { value: '', contentRole };
}

function deriveSideFromText(value = '', options = {}) {
  return analyzeSideText(value, options).value;
}

const { normalizeVehicleMake, corroboratesAuthoritativeMake } = require('./titleOptimizationMakeNormalizationService');

function canonicalResolvedValue(field = '', value = '', terminologyRules = []) {
  const text = normalizeText(value);
  if (field === 'brandMake') return normalizeCompare(normalizeVehicleMake(text, terminologyRules));
  if (field !== 'side') return normalizeCompare(text);
  const upper = text.toUpperCase().replace(/[\/_-]+/g, ' ');
  if (/\b(DRIVERS?|LEFT|LH)\b/.test(upper)) return 'driver-left-lh';
  if (/\b(PASS|PASSENGERS?|RIGHT|RH)\b/.test(upper)) return 'passenger-right-rh';
  return normalizeCompare(text);
}

function derivePlacementFromText(value = '') {
  const text = normalizeText(value).toUpperCase().replace(/\bREAR[ -]+VIEW[ -]+MIRRORS?\b/g, '');
  if (/\b(FRNT|FRONT|FRT)\b/.test(text)) return 'Front';
  if (/\b(REAR|RR)\b/.test(text)) return 'Rear';
  return '';
}

function deriveKeyFitmentDetailFromText(value = '') {
  const text = normalizeText(value).toUpperCase();
  // Leave negative/conditional equipment wording in raw evidence for AI interpretation.
  if (/\b(?:NO|NON|NOT|WITHOUT|EXCEPT)\b|W\s*\/\s*O\b/.test(text)) return '';
  const details = [];
  if (/\b(PWR|POWER)\b/.test(text)) details.push('Power');
  if (/\bILLUM|ILLUMINATED|ILLUMINATION\b/.test(text)) details.push('With Illumination');
  return details.join(', ');
}

function cleanCategoryPartName(value = '') {
  const raw = normalizeText(value);
  if (!raw) return '';
  const last = raw.split(':').map(item => normalizeText(item)).filter(Boolean).pop() || raw;
  const normalized = normalizeCompare(last);
  if (normalized.includes('seat belts')) return 'Seat Belt';
  if (normalized.includes('interior safety')) return 'Seat Belt';
  // A broad mirror category does not establish interior/exterior part identity.
  return last.replace(/\s*&\s*Parts\b/i, '').trim();
}

function deriveComponentTypeFromText(value = '') {
  const text = normalizeText(value);
  if (/\bretractor\b/i.test(text)) return 'Retractor';
  if (/\bbuckle\b/i.test(text)) return 'Buckle';
  if (/\breceiver\b/i.test(text)) return 'Receiver';
  return '';
}

function deriveColorFromText(value = '') {
  const text = normalizeText(value);
  const match = text.match(/(?:^|[-\s])\b(BEIGE|BLACK|GRAY|GREY|TAN|BROWN|BLUE|RED|GREEN|WHITE|IVORY|SILVER)\b(?:$|[-\s])/i);
  if (!match) return '';
  const color = match[1].toLowerCase() === 'grey' ? 'gray' : match[1];
  return titleCaseWords(color);
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

function derivedEvidence(value, source, sourceFieldName, rawValue = value, extra = {}) {
  return evidence(value, source, {
    sourceFieldName,
    sourceFieldId: null,
    id: null
  }, rawValue, {
    derived: true,
    ...extra
  });
}

function setMappedField(out, mapping, rawValue) {
  const key = mapping.logicalKey;
  const source = SEMANTIC_SOURCE[key] || (mapping.isCustom ? 'otherStructuredFields' : 'otherStructuredFields');
  const structured = key === 'itemSpecifics'
    ? normalizeObjectValues(rawValue)
    : key === 'currentEbayFields'
      ? normalizeCurrentEbayFields(rawValue)
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
    runtimeMode: 'authoritative',
    runtimeReady: true,
    recordId: listingRecord?.id || null,
    fields: {},
    structured: {},
    manualOverride: {
      status: evidence('', 'manualOverride'),
      title: evidence('', 'manualOverride'),
      canonicalStatus: '',
      active: false
    },
    descriptionOnly: {},
    titleAuthority: {},
    derived: {},
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
  out.manualOverride.canonicalStatus = canonicalTitleOverrideStatus(out.manualOverride.status.value);
  out.manualOverride.active = out.manualOverride.canonicalStatus === 'Manually Approved' ||
    out.manualOverride.canonicalStatus === 'Manually Overridden';

  const partFitment = normalizeText(masterFields['Part Fitment'] || masterFields.partFitment);
  out.titleAuthority.partFitment = evidence(partFitment, 'partFitment', null, partFitment, {
    titleAuthority: true
  });

  const existingTitle = normalizeText(out.fields.existingTitle?.value);
  const legacyTitle = normalizeText(out.fields.legacyTitle?.value || out.fields.rawSourceTitle?.value);
  const currentEbayFields = out.structured.currentEbayFields?.value || {};
  const itemSpecifics = out.structured.itemSpecifics?.value || {};
  const legacyDonorNote = readDescriptionLabel(String(fields.Description || ''), 'Notes');
  out.titleAuthority.legacyDonorNote = derivedEvidence(legacyDonorNote, 'rawHollander', 'Description',
    legacyDonorNote, { logicalKey: 'donorNotes', titleEvidence: true });
  const donorNotes = normalizeText(
    currentEbayFields.donorNotes ||
    currentEbayFields.Notes ||
    currentEbayFields.notes ||
    currentEbayFields['Donor Notes'] ||
    legacyDonorNote
  );
  const donorModel = normalizeText(
    currentEbayFields.donorModel ||
    currentEbayFields.Model ||
    currentEbayFields.model ||
    currentEbayFields['Donor Model']
  );
  const titleSide = analyzeSideText(existingTitle);
  const noteSide = analyzeSideText(donorNotes);
  const fitmentSide = analyzeSideText(partFitment);
  const donorYear = normalizeText(
    currentEbayFields.donorYear ||
    currentEbayFields.Year ||
    currentEbayFields.year ||
    currentEbayFields['Donor Year']
  );

  out.titleAuthority.titleYearFallback = derivedEvidence(
    partFitment ? '' : deriveYearEvidenceFromTitle(existingTitle || legacyTitle),
    'currentEbay',
    'Item Title',
    existingTitle || legacyTitle,
    { logicalKey: 'yearRange', fallbackOnly: true, useOnlyWhenPartFitmentUnavailable: true }
  );

  out.derived.makeFromFitment = derivedEvidence(
    deriveMakeFromFitment(partFitment, deriveModelFromTitle(existingTitle || legacyTitle) || donorModel, ''),
    'partFitment',
    'Part Fitment',
    partFitment,
    { logicalKey: 'brandMake' }
  );
  out.derived.modelFromCurrentTitle = derivedEvidence(
    deriveModelFromTitle(existingTitle || legacyTitle),
    'currentEbay',
    'Item Title',
    existingTitle || legacyTitle,
    { logicalKey: 'model' }
  );
  out.derived.modelFromDonor = derivedEvidence(donorModel, 'currentEbay', 'Current eBay Fields', currentEbayFields, {
    logicalKey: 'model'
  });
  out.derived.modelAmbiguity = modelAmbiguity(modelEvidenceCandidates({
    itemSpecifics,
    existingTitle,
    partFitment,
    donorModel
  }));
  out.derived.yearFromDonor = derivedEvidence(donorYear, 'currentEbay', 'Current eBay Fields', currentEbayFields, {
    logicalKey: 'year', contextOnly: true, role: 'donor'
  });
  out.derived.sideFromTitle = derivedEvidence(titleSide.value, 'currentEbay', 'Item Title', existingTitle, {
    logicalKey: 'side', contentRole: titleSide.contentRole
  });
  out.derived.sideFromNotes = derivedEvidence(noteSide.value, 'currentEbay', 'Current eBay Fields', donorNotes, {
    logicalKey: 'side', contentRole: noteSide.contentRole
  });
  out.derived.sideFromFitment = derivedEvidence(fitmentSide.value, 'partFitment', 'Part Fitment', partFitment, {
    logicalKey: 'side', contentRole: fitmentSide.contentRole, titleEvidence: true
  });
  out.derived.componentTypeFromNotes = derivedEvidence(
    deriveComponentTypeFromText(donorNotes || existingTitle),
    'currentEbay',
    donorNotes ? 'Current eBay Fields' : 'Item Title',
    donorNotes || existingTitle,
    { logicalKey: 'componentType' }
  );
  out.derived.colorFromNotes = derivedEvidence(deriveColorFromText(donorNotes), 'currentEbay', 'Current eBay Fields', donorNotes, {
    logicalKey: 'color'
  });
  out.derived.colorFromItemSpecifics = derivedEvidence(
    itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES.color),
    'itemSpecifics',
    'Item Specifics - All C: values relevant to item',
    itemSpecifics,
    { logicalKey: 'color' }
  );
  out.derived.placementFromNotes = derivedEvidence(
    derivePlacementFromText(donorNotes || existingTitle),
    'currentEbay',
    donorNotes ? 'Current eBay Fields' : 'Item Title',
    donorNotes || existingTitle,
    { logicalKey: 'placement' }
  );
  out.derived.keyFitmentDetailFromNotes = derivedEvidence(
    deriveKeyFitmentDetailFromText(donorNotes),
    'currentEbay',
    'Current eBay Fields',
    donorNotes,
    { logicalKey: 'keyFitmentDetail' }
  );
  out.derived.cleanedCategoryPart = derivedEvidence(
    cleanCategoryPartName(out.fields.categoryPart?.value || out.fields.conditionsOptions?.value),
    'categoryConditions',
    out.fields.categoryPart?.sourceFieldName || out.fields.conditionsOptions?.sourceFieldName || null,
    out.fields.categoryPart?.rawValue || out.fields.conditionsOptions?.rawValue || '',
    { logicalKey: 'part' }
  );

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
    if (!['title', 'sku'].includes(field) && /^(?:does not apply|not applicable|n\/a|unknown|unspecified)$/i.test(text)) return;
    if (field === 'side' && !/\b(?:drivers?|passengers?|pass|left|right|lh|rh|center|centre)\b/i.test(text)) return;
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
    add(out, 'partFitment', normalized.derived.makeFromFitment?.value, normalized.derived.makeFromFitment);
  } else if (field === 'part') {
    add(out, 'itemSpecifics', itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES.part), normalized.structured.itemSpecifics);
    add(
      out,
      'categoryConditions',
      normalized.derived.cleanedCategoryPart?.value || normalized.fields.categoryPart?.value || normalized.fields.conditionsOptions?.value,
      normalized.derived.cleanedCategoryPart?.value
        ? normalized.derived.cleanedCategoryPart
        : normalized.fields.categoryPart || normalized.fields.conditionsOptions
    );
    add(out, 'rawHollander', normalized.fields.rawSourceTitle?.value || normalized.fields.legacyTitle?.value, normalized.fields.rawSourceTitle || normalized.fields.legacyTitle);
  } else if (field === 'manufacturerPartNumber') {
    add(out, 'itemSpecifics', itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES.manufacturerPartNumber), normalized.structured.itemSpecifics);
    add(out, 'manufacturerPartNumber', normalized.fields.manufacturerPartNumber?.value, normalized.fields.manufacturerPartNumber);
  } else if (field === 'side') {
    add(out, 'itemSpecifics', itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES.side), normalized.structured.itemSpecifics);
    add(out, 'categoryConditions', normalized.fields.conditionsOptions?.value, normalized.fields.conditionsOptions);
    add(out, 'currentEbay', normalized.derived.sideFromNotes?.value, normalized.derived.sideFromNotes);
    add(out, 'currentEbay', normalized.derived.sideFromTitle?.value, normalized.derived.sideFromTitle);
    add(out, 'partFitment', normalized.derived.sideFromFitment?.value, normalized.derived.sideFromFitment);
  } else if (field === 'year') {
    add(out, 'itemSpecifics', itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES.year), normalized.structured.itemSpecifics);
    add(out, 'otherStructuredFields', normalized.fields.year?.value || normalized.fields.structuredYear?.value, normalized.fields.year || normalized.fields.structuredYear);
    add(out, 'currentEbay', normalized.derived.yearFromDonor?.value, normalized.derived.yearFromDonor);
  } else if (field === 'model') {
    add(out, 'itemSpecifics', itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES.model), normalized.structured.itemSpecifics);
    if (!normalized.derived.modelFromCurrentTitle?.value) add(out, 'currentEbay', normalized.derived.modelFromDonor?.value, normalized.derived.modelFromDonor);
    add(out, 'currentEbay', normalized.derived.modelFromCurrentTitle?.value, normalized.derived.modelFromCurrentTitle);
  } else if (field === 'componentType') {
    add(out, 'itemSpecifics', itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES.componentType), normalized.structured.itemSpecifics);
    add(out, 'currentEbay', normalized.derived.componentTypeFromNotes?.value, normalized.derived.componentTypeFromNotes);
  } else if (field === 'color') {
    add(out, 'itemSpecifics', itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES.color), normalized.structured.itemSpecifics);
    add(out, 'currentEbay', normalized.derived.colorFromNotes?.value, normalized.derived.colorFromNotes);
  } else if (field === 'placement') {
    add(out, 'itemSpecifics', itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES.placement), normalized.structured.itemSpecifics);
    add(out, 'itemSpecifics', derivePlacementFromText(itemSpecificValue(itemSpecifics, ['Placement on Vehicle', 'Side', 'C:Side'])), normalized.structured.itemSpecifics);
    add(out, 'currentEbay', normalized.derived.placementFromNotes?.value, normalized.derived.placementFromNotes);
  } else if (field === 'keyFitmentDetail') {
    add(out, 'itemSpecifics', itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES.keyFitmentDetail), normalized.structured.itemSpecifics);
    add(out, 'currentEbay', normalized.derived.keyFitmentDetailFromNotes?.value, normalized.derived.keyFitmentDetailFromNotes);
  } else if (ITEM_SPECIFIC_ALIASES[field]) {
    add(out, 'itemSpecifics', itemSpecificValue(itemSpecifics, ITEM_SPECIFIC_ALIASES[field]), normalized.structured.itemSpecifics);
  } else if (field === 'sku') {
    add(out, 'otherStructuredFields', normalized.fields.sku?.value, normalized.fields.sku);
  } else if (normalized.fields[field]) {
    const item = normalized.fields[field];
    add(out, item.source || 'otherStructuredFields', item.value, item);
  }

  return out.sort((a, b) => a.priority - b.priority || a.source.localeCompare(b.source) || a.value.localeCompare(b.value));
}

function resolveField(field, candidates = [], terminologyRules = []) {
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
  const winnerKey = canonicalResolvedValue(field, winner.value, terminologyRules);
  const conflicts = [];
  const seen = new Set([winnerKey]);
  for (const item of present.slice(1)) {
    const key = canonicalResolvedValue(field, item.value, terminologyRules);
    if (field === 'brandMake' && corroboratesAuthoritativeMake(winner.value, item.value)) continue;
    if (!key || key === winnerKey || seen.has(key)) continue;
    seen.add(key);
    conflicts.push(item);
  }
  return {
    field,
    candidates: present,
    resolvedValue: field === 'brandMake' ? normalizeVehicleMake(winner.value, terminologyRules) : winner.value,
    resolvedSource: winner.source,
    conflict: conflicts.length > 0,
    conflicts,
    missing: false
  };
}

function resolveSourcePriority({ runtimeSnapshot, normalizedListing, fields = [] } = {}) {
  const priorities = activePriorityRows(runtimeSnapshot);
  const requested = Array.isArray(fields) && fields.length
    ? [...new Set(fields.filter(field => field !== 'yearRange'))]
    : [
      'title', 'brandMake', 'model', 'part', 'manufacturerPartNumber', 'side', 'year', 'sku',
      'componentType', 'color', 'placement', 'keyFitmentDetail', 'engineDisplacement',
      'engineCode', 'transmissionCode', 'drivetrain', 'transmissionSpeedType',
      'vinIdentifier', 'illumination', 'paintCode', 'trim', 'lightingTechnology'
    ];
  const resolvedFields = {};
  for (const field of requested) {
    resolvedFields[field] = resolveField(field, candidatesForField(field, normalizedListing, priorities), runtimeSnapshot?.sections?.terminologyRules?.items || []);
  }
  return {
    contractVersion: 1,
    runtimeMode: 'authoritative',
    priorityOrder: priorities.map(row => row.key),
    fields: resolvedFields,
    conflicts: Object.values(resolvedFields).filter(item => item.conflict),
    missing: Object.values(resolvedFields).filter(item => item.missing).map(item => item.field)
  };
}

function normalizeAndResolveListing({ runtimeSnapshot, listingRecord, masterRecord = {}, fields = [] } = {}) {
  const normalized = normalizeListingEvidence({ runtimeSnapshot, listingRecord, masterRecord });
  const resolved = resolveSourcePriority({ runtimeSnapshot, normalizedListing: normalized, fields });
  resolved.modelAmbiguity = normalized.derived.modelAmbiguity || { ambiguous: false, candidates: [] };
  return {
    contractVersion: 1,
    mode: 'authoritative',
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
  normalizeAndResolveListing,
  modelAmbiguityResolvedByCandidate
};
