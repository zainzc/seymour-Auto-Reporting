const AirtableService = require('./airtableService');
const AirtableSchemaService = require('./airtableSchemaService');
const Phase4AiEvaluatorService = require('./phase4AiEvaluatorService');
const { asIdentitySet, isPublishedIdentity } = require('./phase5IdentityService');
const { isManualOverrideForField: isManualOverrideFromGovernance } = require('./phase5GovernanceService');

const DEFAULT_LISTINGS_TABLE = 'eBay Listings (API)';
const DEFAULT_MASTER_TABLE = 'Master Parts Table';
const LISTING_IPN_FIELD = 'IPN (Interchange Part Number)';
const LISTING_LEGACY_TITLE_FIELD = 'Title';
const LISTING_OUTPUT_TITLE_FIELD = 'Item Title';
const LISTING_OUTPUT_DESCRIPTION_FIELD = 'Item Description';
const LISTING_SHORT_DESCRIPTION_FIELD = 'Short Description';
const LISTING_SOURCE_DESCRIPTION_FIELD = 'Description';
const LISTING_TITLE_REVIEW_STATUS_FIELD = 'Title Review Status';
const LISTING_TITLE_REVIEW_REASON_FIELD = 'Title Review Reason';
const LISTING_TITLE_REVIEW_NOTES_FIELD = 'Title Review Notes';
const LISTING_CONDITIONS_FIELD = 'Conditions & Options';
const LISTING_CONDITIONS_FALLBACK_FIELD = 'Conditions & Options';
const LISTING_C_SPECIFICS_FIELD = 'Item Specifics - All C: values relevant to item';
const MASTER_IPN_FIELD = 'IPN';
const MASTER_FITMENT_FIELD = 'Part Fitment';

const LISTING_ITEM_SPECIFIC_FIELDS = [
  'Brand',
  'Manufacturer',
  'Model Number'
];

const LISTING_CATEGORY_FIELDS = ['Category'];
const LISTING_SKU_FIELDS = ['SKU', 'Custom Label', 'CustomLabel'];

const NOISY_ITEM_SPECIFIC_KEYS = new Set([
  'country/region of manufacture',
  'manufacturer warranty',
  'labels & certification',
  'package weight unit',
  'universal fitment',
  'vintage part',
  'performance part'
]);

const NOISY_ITEM_SPECIFIC_VALUES = new Set([
  'does not apply',
  'n/a',
  'na',
  'none',
  'unknown',
  'not specified'
]);

const TITLE_REVIEW_STATUS_COMPLETED = 'Completed';
const TITLE_REVIEW_STATUS_NEEDS_REVIEW = 'Needs Review';
const TITLE_REVIEW_STATUS_AIRBAG_LOCKED = 'Airbag - Locked';
const TITLE_REVIEW_STATUS_MANUAL_OVERRIDE = 'Skipped - Manual Override';

function normalizeText(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    return normalizeText(value[0]);
  }
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeIpn(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
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
  return decodeHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:div|p|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function decodeHexCommentValue(value = '') {
  const text = normalizeText(value).replace(/\s+/g, '');
  if (!text || text.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(text)) return '';
  try {
    return Buffer.from(text, 'hex').toString('utf8').trim();
  } catch (_) {
    return '';
  }
}

function readHtmlCommentValue(html = '', key = '') {
  const escaped = normalizeText(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return '';
  const match = normalizeText(html).match(new RegExp(`<!--\\s*${escaped}\\s*:\\s*([\\s\\S]*?)\\s*-->`, 'i'));
  return normalizeText(match?.[1]);
}

function readLabeledTextBlock(text = '', label = '') {
  const escaped = normalizeText(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return '';
  const labels = 'Model|Year|Mileage|Stock Number|Notes';
  const match = normalizeText(text).match(new RegExp(`${escaped}\\s*:\\s*([\\s\\S]*?)(?=\\s*(?:${labels})\\s*:|\\s*This Part Will Fit|$)`, 'i'));
  return normalizeText(match?.[1]).replace(/\s+/g, ' ').trim();
}

function extractDonorVehicleEvidence(descriptionHtml = '') {
  const html = normalizeText(descriptionHtml);
  if (!html) return {};

  const text = stripHtmlToText(html);
  const donor = {};

  const modelFromHtml = readLabeledTextBlock(text, 'Model');
  const yearFromHtml = readLabeledTextBlock(text, 'Year');
  const notesFromHtml = readLabeledTextBlock(text, 'Notes');
  const stockFromHtml = readLabeledTextBlock(text, 'Stock Number');

  if (modelFromHtml) donor.model = modelFromHtml;
  if (yearFromHtml) donor.year = yearFromHtml;
  if (notesFromHtml) donor.notes = notesFromHtml;
  if (stockFromHtml) donor.stockNumber = stockFromHtml;

  const plModel = decodeHexCommentValue(readHtmlCommentValue(html, 'PLModel'));
  const plYear = decodeHexCommentValue(readHtmlCommentValue(html, 'PLYear'));
  if (!donor.model && plModel) donor.model = plModel;
  if (!donor.year && plYear) donor.year = plYear;

  return donor;
}

function getFieldValueByName(fields = {}, name = '') {
  if (!fields || typeof fields !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name];
  const target = normalizeKey(name);
  if (!target) return '';
  const key = Object.keys(fields).find(item => normalizeKey(item) === target);
  if (!key) return '';
  return fields[key];
}

function parseJsonObject(value) {
  if (!value && value !== 0) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  const text = normalizeText(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {
    return null;
  }
  return null;
}

function parseListingCSpecifics(fields = {}) {
  const parsed = parseJsonObject(getFieldValueByName(fields, LISTING_C_SPECIFICS_FIELD));
  const out = {};
  if (!parsed) return out;
  for (const [name, rawValue] of Object.entries(parsed)) {
    const key = normalizeText(name);
    if (!key) continue;
    if (Array.isArray(rawValue)) {
      const values = rawValue.map(item => normalizeText(item)).filter(Boolean);
      if (values.length > 0) out[key] = values.join(', ');
      continue;
    }
    const value = normalizeText(rawValue);
    if (value) out[key] = value;
  }
  return out;
}

function resolveListingConditionsAndOptions(fields = {}, cSpecifics = {}) {
  const direct =
    normalizeText(fields[LISTING_CONDITIONS_FIELD]) || normalizeText(fields[LISTING_CONDITIONS_FALLBACK_FIELD]);
  if (direct) return direct;
  const entries = Object.entries(cSpecifics || {});
  const match = entries.find(([name]) => {
    const key = normalizeKey(name);
    return key.includes('conditions') && key.includes('option');
  });
  return normalizeText(match?.[1]);
}

function parseIpnList(value) {
  if (Array.isArray(value)) {
    return value.map(item => normalizeIpn(item)).filter(Boolean);
  }
  const text = String(value || '');
  if (!text.trim()) return [];
  return text
    .split(/[\n,\t;|]+/)
    .map(item => normalizeIpn(item))
    .filter(Boolean);
}

function emitProgress(progressCallback, payload = {}) {
  if (typeof progressCallback === 'function') {
    progressCallback(payload);
  }
}

function chunkArray(values = [], size = 10) {
  const out = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

function escapeAirtableFormulaValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildIpnFilterFormula(ipns = []) {
  const clauses = ipns.map(ipn => `{${MASTER_IPN_FIELD}}="${escapeAirtableFormulaValue(ipn)}"`);
  if (clauses.length === 0) return '';
  if (clauses.length === 1) return clauses[0];
  return `OR(${clauses.join(',')})`;
}

async function fetchAllRecordsWithFallback(service, tableNameOrId, selectFields = []) {
  try {
    return await service.fetchAllRecords(tableNameOrId, selectFields);
  } catch (error) {
    if (error?.response?.status !== 422) throw error;
    return service.fetchAllRecords(tableNameOrId, []);
  }
}

async function fetchMasterRowsByIpnSet(service, tableName, ipns = [], selectFields = []) {
  const rows = [];
  for (const batch of chunkArray(ipns, 25)) {
    const formula = buildIpnFilterFormula(batch);
    if (!formula) continue;
    let offset = null;
    do {
      const params = { filterByFormula: formula };
      if (offset) params.offset = offset;
      if (Array.isArray(selectFields) && selectFields.length > 0) {
        params.fields = selectFields;
      }
      const data = await service.request('GET', `/${encodeURIComponent(tableName)}`, { params });
      rows.push(...(Array.isArray(data?.records) ? data.records : []));
      offset = data?.offset || null;
    } while (offset);
  }
  return rows;
}

function buildItemSpecifics(fields = {}, cSpecifics = {}) {
  const out = {};
  for (const name of LISTING_ITEM_SPECIFIC_FIELDS) {
    const value = normalizeText(fields[name]);
    if (!shouldSendItemSpecificToAi(name, value)) continue;
    out[name] = value;
  }
  for (const [name, value] of Object.entries(cSpecifics || {})) {
    if (!shouldSendItemSpecificToAi(name, value)) continue;
    out[normalizeText(name)] = normalizeText(value);
  }
  return out;
}

function shouldSendItemSpecificToAi(name = '', value = '') {
  const normalizedName = normalizeKey(name).replace(/^c:/, '');
  const normalizedValue = normalizeText(value);
  if (!normalizedName || !normalizedValue) return false;
  if (NOISY_ITEM_SPECIFIC_KEYS.has(normalizedName)) return false;
  if (NOISY_ITEM_SPECIFIC_VALUES.has(normalizedValue.toLowerCase())) return false;
  if (normalizedName === 'country/region of manufacture' && normalizedValue.toLowerCase() === 'oem') return false;
  return true;
}

function buildCategoryContext(fields = {}) {
  const out = {};
  for (const name of LISTING_CATEGORY_FIELDS) {
    const value = normalizeText(fields[name]);
    if (!value) continue;
    out[name] = value;
  }
  return out;
}

function compactText(value, maxLength = 220) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = normalizeText(value).toLowerCase();
  if (!text) return defaultValue;
  if (['true', '1', 'yes', 'y', 'on', 'locked'].includes(text)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(text)) return false;
  return defaultValue;
}

function normalizeTitleForKey(value) {
  return normalizeText(value).replace(/\s+/g, ' ').toLowerCase();
}

function collapseConsecutiveDuplicateWords(value) {
  let text = normalizeText(value).replace(/\s+/g, ' ').trim();
  let previous = '';
  while (text && text !== previous) {
    previous = text;
    text = text.replace(/\b([A-Za-z0-9]+)(\s+\1\b)+/gi, '$1').replace(/\s+/g, ' ').trim();
  }
  return text;
}

function extractTrailingSku(value) {
  const text = normalizeText(value);
  const afterOem = text.match(/\bOEM\s+([A-Z0-9][A-Z0-9.-]{3,})$/i);
  if (afterOem) return afterOem[1];
  const beforeOem = text.match(/\s+([0-9]{5,})\s+OEM$/i);
  if (beforeOem) return beforeOem[1];
  return '';
}

function ensureSingleOemAtEnd(value) {
  const source = collapseConsecutiveDuplicateWords(value);
  const sku = extractTrailingSku(source);
  let title = source.replace(/\bOEM\b/gi, '').replace(/\s+/g, ' ').trim();
  if (sku) {
    title = title
      .replace(new RegExp(`\\s+${sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (!title) return '';
  title = title.replace(/[,\-:/|]+$/, '').trim();
  return collapseConsecutiveDuplicateWords(`${title} OEM${sku ? ` ${sku}` : ''}`);
}

function trimAtWordBoundary(value, maxLength) {
  const text = normalizeText(value).replace(/\s+/g, ' ').trim();
  if (!text || text.length <= maxLength) return text;
  const candidate = text.slice(0, Math.max(0, maxLength)).replace(/[,\-:/| ]+$/, '').trim();
  const lastSpace = candidate.lastIndexOf(' ');
  if (lastSpace > 0) {
    return candidate.slice(0, lastSpace).replace(/[,\-:/| ]+$/, '').trim();
  }
  return candidate;
}

function extractProtectedSourceTitlePhrases(values = []) {
  const phrases = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = normalizeText(value);
    if (!text) continue;
    const matches = text.match(/\bID\s+[A-Z0-9][A-Z0-9.-]{2,}\b/gi) || [];
    for (const match of matches) {
      const phrase = normalizeText(match).replace(/\s+/g, ' ');
      const key = phrase.toLowerCase();
      if (!phrase || seen.has(key)) continue;
      seen.add(key);
      phrases.push(phrase);
    }
  }
  return phrases;
}

function preserveProtectedSourceTitlePhrases(candidate, sourceTitles = [], skuValue = '', max = 80) {
  let title = ensureSingleOemAtEnd(candidate);
  if (!title) return '';
  const phrases = extractProtectedSourceTitlePhrases(sourceTitles);
  if (phrases.length === 0) return title;

  const normalizedTitle = () => normalizeTitleForKey(title);
  for (const phrase of phrases) {
    if (normalizedTitle().includes(phrase.toLowerCase())) continue;
    const sku = extractTrailingSku(title) || normalizeText(skuValue);
    const escapedSku = sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const suffixPattern = new RegExp(`\\s+OEM${sku ? `\\s+${escapedSku}` : ''}$`, 'i');
    let core = title.replace(suffixPattern, '').trim();
    core = core.replace(/\bID$/i, '').replace(/[,\-:/| ]+$/, '').trim();
    const next = ensureSingleOemAtEnd(`${core} ${phrase} OEM${sku ? ` ${sku}` : ''}`);
    if (next && next.length <= max) {
      title = next;
      continue;
    }

    const safeSource = sourceTitles
      .map(sourceTitle => ensureSingleOemAtEnd(sourceTitle))
      .find(sourceTitle => {
        if (!sourceTitle || sourceTitle.length > max) return false;
        if (!normalizeTitleForKey(sourceTitle).includes(phrase.toLowerCase())) return false;
        if (sku && !new RegExp(`\\b${escapedSku}$`, 'i').test(sourceTitle)) return false;
        return true;
      });
    if (safeSource) title = safeSource;
  }
  return title;
}

function enforceTitleLength(value, min = 65, max = 80) {
  let title = ensureSingleOemAtEnd(value);
  if (!title) return '';
  if (title.length > max) {
    const sku = extractTrailingSku(title);
    const suffix = ` OEM${sku ? ` ${sku}` : ''}`;
    const keep = Math.max(1, max - suffix.length);
    const core = title
      .replace(new RegExp(`\\s+OEM${sku ? `\\s+${sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` : ''}$`, 'i'), '')
      .trim();
    const trimmedCore = trimAtWordBoundary(core, keep);
    title = `${trimmedCore}${suffix}`;
  }
  return collapseConsecutiveDuplicateWords(title);
}

function replaceOemQualifier(value, qualifier = 'OEM') {
  const title = ensureSingleOemAtEnd(value);
  if (!title) return '';
  const sku = extractTrailingSku(title);
  const suffixPattern = new RegExp(`\\s+OEM${sku ? `\\s+${sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` : ''}$`, 'i');
  const core = title.replace(suffixPattern, '').trim();
  return collapseConsecutiveDuplicateWords(`${core} ${qualifier}${sku ? ` ${sku}` : ''}`);
}

function ensureTitleHasSku(value, skuValue = '') {
  const sku = normalizeText(skuValue);
  const title = ensureSingleOemAtEnd(value);
  if (!title || !sku) return title;
  const escapedSku = sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\b${escapedSku}$`, 'i').test(title)) return title;
  return ensureSingleOemAtEnd(`${title} ${sku}`);
}

function makeTitleUnique(candidate, usedTitleKeys = new Set(), min = 65, max = 80) {
  const base = enforceTitleLength(candidate, min, max);
  if (!base) return '';
  const baseKey = normalizeTitleForKey(base);
  if (!baseKey || !usedTitleKeys.has(baseKey)) return base;

  const qualifiers = ['Used OEM', 'Genuine OEM', 'Original OEM', 'Factory OEM'];
  for (const qualifier of qualifiers) {
    const variant = enforceTitleLength(replaceOemQualifier(base, qualifier), min, max);
    const key = normalizeTitleForKey(variant);
    if (variant && key && !usedTitleKeys.has(key)) return variant;
  }
  return base;
}

function titleContainsAirbag(value) {
  return /\bair\s*bag\b|\bairbag\b/i.test(normalizeText(value));
}

function normalizeTitleReviewStatus(value, fallback = TITLE_REVIEW_STATUS_COMPLETED) {
  const key = normalizeText(value).toLowerCase();
  if (!key) return fallback;
  if (key === 'completed' || key === 'complete' || key === 'ok') return TITLE_REVIEW_STATUS_COMPLETED;
  if (key === 'needs review' || key === 'need review' || key === 'manual review') return TITLE_REVIEW_STATUS_NEEDS_REVIEW;
  if (key === 'airbag - locked' || key === 'airbag locked' || key === 'airbag') return TITLE_REVIEW_STATUS_AIRBAG_LOCKED;
  if (key === 'skipped - manual override' || key === 'manual override' || key === 'skipped manual override') {
    return TITLE_REVIEW_STATUS_MANUAL_OVERRIDE;
  }
  return fallback;
}

function inferTitleReviewStatus(generated = {}) {
  const explicit = normalizeTitleReviewStatus(generated.titleReviewStatus, '');
  if (explicit) return explicit;
  const text = [
    generated.reasoningSummary,
    generated.titleReviewReason,
    generated.titleReviewNotes
  ]
    .map(item => normalizeText(item).toLowerCase())
    .filter(Boolean)
    .join(' ');
  if (/\bair\s*bag\b|\bairbag\b/.test(text)) return TITLE_REVIEW_STATUS_AIRBAG_LOCKED;
  if (/\b(flag|manual review|uncertain|missing|unknown|multi-year|multiple year|unmapped|cannot determine|not certain)\b/.test(text)) {
    return TITLE_REVIEW_STATUS_NEEDS_REVIEW;
  }
  return TITLE_REVIEW_STATUS_COMPLETED;
}

function addFieldIfChanged(writeFields = {}, existingFields = {}, fieldName = '', nextValue = '') {
  const value = normalizeText(nextValue);
  if (!fieldName || !value) return false;
  if (normalizeText(existingFields[fieldName]) === value) return false;
  writeFields[fieldName] = value;
  return true;
}

function isManualOverrideForField(listingFields = {}, fieldName = '') {
  return isManualOverrideFromGovernance(listingFields, fieldName);
}

async function ensureFields(schemaService, listingsTable, requiredFieldNames = []) {
  const tableNameNorm = normalizeText(listingsTable).toLowerCase();
  const tables = await schemaService.listTables();
  const table = (tables || []).find(item => normalizeText(item?.name).toLowerCase() === tableNameNorm);
  if (!table?.id) {
    throw new Error(`Listings table '${listingsTable}' not found in Airtable schema.`);
  }

  const existing = new Set((table.fields || []).map(field => normalizeText(field?.name)).filter(Boolean));
  const created = [];

  for (const fieldName of requiredFieldNames) {
    const normalized = normalizeText(fieldName);
    if (!normalized || existing.has(normalized)) continue;
    await schemaService.createField(table.id, {
      name: normalized,
      type: 'singleLineText'
    });
    existing.add(normalized);
    created.push(normalized);
  }

  return {
    table,
    existingFields: existing,
    createdFields: created
  };
}

async function runPhase74TitleDescription(options = {}, progressCallback = () => {}) {
  const airtableToken = normalizeText(options.airtableToken || process.env.AIRTABLE_TOKEN || '');
  const airtableBaseId = normalizeText(options.airtableBaseId || process.env.AIRTABLE_BASE_ID || '');
  const listingsTable = normalizeText(options.phase74ListingsTable || process.env.PHASE74_LISTINGS_TABLE || DEFAULT_LISTINGS_TABLE);
  const masterTable = normalizeText(options.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || DEFAULT_MASTER_TABLE);
  const openaiApiKey = normalizeText(options.openaiApiKey || process.env.OPENAI_API_KEY || '');
  const openaiModel = normalizeText(options.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini');
  const phase74TitleRulesPrompt = normalizeText(
    options.phase74TitleRulesPrompt || process.env.PHASE74_TITLE_RULES_PROMPT || ''
  );
  const openaiBaseUrl = normalizeText(options.openaiBaseUrl || process.env.OPENAI_BASE_URL || '');
  const promptCacheEnabled =
    normalizeText(options.phase74PromptCacheEnabled ?? process.env.PHASE74_PROMPT_CACHE_ENABLED ?? 'true').toLowerCase() !==
    'false';
  const logAiPayload = parseBoolean(options.phase74LogAiPayload ?? process.env.PHASE74_LOG_AI_PAYLOAD ?? 'false', false);
  const promptCacheKey = normalizeText(
    options.phase74PromptCacheKey ||
      process.env.PHASE74_PROMPT_CACHE_KEY ||
      process.env.OPENAI_PROMPT_CACHE_KEY ||
      'phase74_title_description_v1'
  );
  const testIpnList = parseIpnList(options.phase74TestIpns || process.env.PHASE74_TEST_IPNS || '');
  const testIpnSet = new Set(testIpnList);
  const maxListings = Math.max(0, Number(options.phase74MaxListings || process.env.PHASE74_MAX_LISTINGS || 0) || 0);
  const sampleLimit = Math.max(5, Number(options.sampleLimit || process.env.PHASE74_SAMPLE_LIMIT || 20) || 20);

  if (!airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (!airtableBaseId) throw new Error('Missing AIRTABLE_BASE_ID.');
  if (!openaiApiKey) throw new Error('Missing OpenAI API key for Phase 7.4.');

  const airtableService = new AirtableService({
    token: airtableToken,
    baseId: airtableBaseId,
    masterTable
  });
  const schemaService = new AirtableSchemaService({
    token: airtableToken,
    baseId: airtableBaseId
  });
  const aiService = new Phase4AiEvaluatorService({
    apiKey: openaiApiKey,
    model: openaiModel,
    baseUrl: openaiBaseUrl || undefined,
    timeoutMs: Number(options.aiTimeoutMs || process.env.PHASE74_AI_TIMEOUT_MS || 30000) || 30000,
    maxAttempts: Number(options.aiMaxAttempts || process.env.PHASE74_AI_MAX_ATTEMPTS || 3) || 3,
    baseDelayMs: 600,
    promptCacheEnabled,
    promptCacheKey,
    logPhase74AiPayload: logAiPayload
  });

  const summary = {
    listingsTable,
    masterTable,
    testIpnsCount: testIpnSet.size,
    maxListings,
    listingsScanned: 0,
    listingsEligible: 0,
    skippedAlreadyPublished: 0,
    masterMatched: 0,
    masterMissing: 0,
    listingFieldsCreated: 0,
    titleGenerated: 0,
    descriptionGenerated: 0,
    shortDescriptionWritten: 0,
    skippedAlreadyEnriched: 0,
    skippedManualOverride: 0,
    skippedNoChange: 0,
    aiFailures: 0,
    titleReviewCompleted: 0,
    titleReviewNeedsReview: 0,
    titleReviewAirbagLocked: 0,
    titleReviewManualOverride: 0,
    titleReviewWritten: 0,
    writesAttempted: 0,
    writesSucceeded: 0,
    writeFailures: 0,
    samples: [],
    errors: []
  };

  emitProgress(progressCallback, {
    stage: 'phase74_prepare',
    percent: 5,
    counts: summary,
    message: `Preparing Phase 7.4 for listings table '${listingsTable}'...`
  });

  const ensureResult = await ensureFields(schemaService, listingsTable, [
    LISTING_OUTPUT_TITLE_FIELD,
    LISTING_OUTPUT_DESCRIPTION_FIELD,
    LISTING_TITLE_REVIEW_STATUS_FIELD,
    LISTING_TITLE_REVIEW_REASON_FIELD,
    LISTING_TITLE_REVIEW_NOTES_FIELD
  ]);
  summary.listingFieldsCreated = (ensureResult?.createdFields || []).length;

  const hasShortDescriptionField = ensureResult.existingFields.has(LISTING_SHORT_DESCRIPTION_FIELD);

  const selectFields = [
    LISTING_IPN_FIELD,
    LISTING_LEGACY_TITLE_FIELD,
    LISTING_OUTPUT_TITLE_FIELD,
    LISTING_OUTPUT_DESCRIPTION_FIELD,
    LISTING_TITLE_REVIEW_STATUS_FIELD,
    LISTING_TITLE_REVIEW_REASON_FIELD,
    LISTING_TITLE_REVIEW_NOTES_FIELD,
    `${LISTING_OUTPUT_TITLE_FIELD} Manual Override`,
    `${LISTING_OUTPUT_TITLE_FIELD} Override`,
    `${LISTING_OUTPUT_TITLE_FIELD} Locked`,
    `${LISTING_OUTPUT_TITLE_FIELD} Manual`,
    `${LISTING_OUTPUT_DESCRIPTION_FIELD} Manual Override`,
    `${LISTING_OUTPUT_DESCRIPTION_FIELD} Override`,
    `${LISTING_OUTPUT_DESCRIPTION_FIELD} Locked`,
    `${LISTING_OUTPUT_DESCRIPTION_FIELD} Manual`,
    'Manual Override',
    'Manual Edit',
    'Manual Edited',
    LISTING_CONDITIONS_FIELD,
    LISTING_CONDITIONS_FALLBACK_FIELD,
    LISTING_C_SPECIFICS_FIELD,
    LISTING_SOURCE_DESCRIPTION_FIELD,
    'Condition',
    'Condition Note',
    ...LISTING_CATEGORY_FIELDS,
    ...LISTING_ITEM_SPECIFIC_FIELDS,
    ...LISTING_SKU_FIELDS
  ];
  if (hasShortDescriptionField) {
    selectFields.push(LISTING_SHORT_DESCRIPTION_FIELD);
    selectFields.push(`${LISTING_SHORT_DESCRIPTION_FIELD} Manual Override`);
    selectFields.push(`${LISTING_SHORT_DESCRIPTION_FIELD} Override`);
    selectFields.push(`${LISTING_SHORT_DESCRIPTION_FIELD} Locked`);
    selectFields.push(`${LISTING_SHORT_DESCRIPTION_FIELD} Manual`);
  }

  if (phase74TitleRulesPrompt) {
    emitProgress(progressCallback, {
      stage: 'phase74_prepare',
      percent: 8,
      counts: summary,
      message: `Using custom Phase 7.4 title prompt from UI (chars=${phase74TitleRulesPrompt.length}).`
    });
  }

  if (logAiPayload) {
    emitProgress(progressCallback, {
      stage: 'phase74_prepare',
      percent: 9,
      counts: summary,
      message: 'Phase 7.4 AI payload debug logging is enabled. Full request bodies will print as [Phase7.4 AI Payload] in the app logs.'
    });
  }

  emitProgress(progressCallback, {
    stage: 'phase74_load_listings',
    percent: 15,
    counts: summary,
    message: `Loading listings from '${listingsTable}'...`
  });

  const listingRows = await fetchAllRecordsWithFallback(airtableService, listingsTable, Array.from(new Set(selectFields)));
  summary.listingsScanned = listingRows.length;
  const publishedIdentitySet = asIdentitySet(options.phase5PublishedIdentities || []);
  const titleMinLength = 65;
  const titleMaxLength = 80;
  const usedTitleKeys = new Set();
  const usedTitles = [];

  for (const row of listingRows) {
    const fields = row?.fields || {};
    const existingOutputTitle = normalizeText(fields[LISTING_OUTPUT_TITLE_FIELD]);
    if (existingOutputTitle) {
      const key = normalizeTitleForKey(existingOutputTitle);
      if (key) usedTitleKeys.add(key);
      usedTitles.push(existingOutputTitle);
      continue;
    }
    const existingLegacyTitle = normalizeText(fields[LISTING_LEGACY_TITLE_FIELD]);
    if (existingLegacyTitle) {
      const key = normalizeTitleForKey(existingLegacyTitle);
      if (key) usedTitleKeys.add(key);
      usedTitles.push(existingLegacyTitle);
    }
  }

  const rowsForGeneration = [];
  for (const row of listingRows) {
    const fields = row?.fields || {};
    const ipn = normalizeIpn(fields[LISTING_IPN_FIELD]);
    if (!ipn) continue;
    if (testIpnSet.size > 0 && !testIpnSet.has(ipn)) continue;
    if (isPublishedIdentity(fields, publishedIdentitySet)) {
      summary.skippedAlreadyPublished += 1;
      continue;
    }

    const existingTitle = normalizeText(fields[LISTING_OUTPUT_TITLE_FIELD]);
    const existingDescription = normalizeText(fields[LISTING_OUTPUT_DESCRIPTION_FIELD]);
    const existingReviewStatus = normalizeText(fields[LISTING_TITLE_REVIEW_STATUS_FIELD]);
    if (existingTitle && existingDescription && existingReviewStatus) {
      summary.skippedAlreadyEnriched += 1;
      continue;
    }

    rowsForGeneration.push(row);
  }
  summary.listingsEligible = rowsForGeneration.length;

  const neededIpns = [];
  for (const row of rowsForGeneration) {
    const ipn = normalizeIpn(row?.fields?.[LISTING_IPN_FIELD]);
    if (!ipn) continue;
    neededIpns.push(ipn);
  }

  const uniqueIpns = Array.from(new Set(neededIpns));
  const preloadedMasterTable = normalizeKey(options.phaseSharedMasterTable || options.preloadedMasterTable || '');
  const preloadedMasterByIpn =
    options.phaseSharedMasterByIpn instanceof Map
      ? options.phaseSharedMasterByIpn
      : options.preloadedMasterByIpn instanceof Map
        ? options.preloadedMasterByIpn
        : null;
  const preloadedMasterRows = Array.isArray(options.phaseSharedMasterRows)
    ? options.phaseSharedMasterRows
    : Array.isArray(options.preloadedMasterRows)
      ? options.preloadedMasterRows
      : null;
  const canUsePreloadedMaster =
    (!preloadedMasterTable || preloadedMasterTable === normalizeKey(masterTable)) &&
    (preloadedMasterByIpn instanceof Map || Array.isArray(preloadedMasterRows));

  const masterByIpn = new Map();
  if (canUsePreloadedMaster && preloadedMasterByIpn instanceof Map) {
    for (const ipn of uniqueIpns) {
      const row = preloadedMasterByIpn.get(ipn);
      if (row && !masterByIpn.has(ipn)) masterByIpn.set(ipn, row);
    }
    emitProgress(progressCallback, {
      stage: 'phase74_prepare',
      percent: 19,
      counts: summary,
      message: `Using shared Master Parts context cache for needed IPNs: requested=${uniqueIpns.length}, matched=${masterByIpn.size}`
    });
  } else if (canUsePreloadedMaster && Array.isArray(preloadedMasterRows)) {
    for (const row of preloadedMasterRows) {
      const ipn = normalizeIpn(row?.fields?.[MASTER_IPN_FIELD]);
      if (!ipn || masterByIpn.has(ipn)) continue;
      masterByIpn.set(ipn, row);
    }
    emitProgress(progressCallback, {
      stage: 'phase74_prepare',
      percent: 19,
      counts: summary,
      message: `Using shared Master Parts rows cache: rows=${preloadedMasterRows.length}, uniqueIpns=${masterByIpn.size}`
    });
  } else {
    const masterRows =
      uniqueIpns.length > 0
        ? await fetchMasterRowsByIpnSet(airtableService, masterTable, uniqueIpns, [MASTER_IPN_FIELD, MASTER_FITMENT_FIELD])
        : [];
    for (const row of masterRows) {
      const ipn = normalizeIpn(row?.fields?.[MASTER_IPN_FIELD]);
      if (!ipn || masterByIpn.has(ipn)) continue;
      masterByIpn.set(ipn, row);
    }
  }

  const updates = [];
  const sampleSeen = new Set();

  let processedEligible = 0;
  let lastProgressAt = Date.now();

  for (let i = 0; i < rowsForGeneration.length; i += 1) {
    const row = rowsForGeneration[i];
    const fields = row?.fields || {};
    const ipn = normalizeIpn(fields[LISTING_IPN_FIELD]);
    processedEligible += 1;
    if (maxListings > 0 && processedEligible > maxListings) break;

    const master = masterByIpn.get(ipn);
    if (!master) {
      summary.masterMissing += 1;
      continue;
    }
    summary.masterMatched += 1;

    const cSpecifics = parseListingCSpecifics(fields);
    const conditionsAndOptions = resolveListingConditionsAndOptions(fields, cSpecifics);
    const categoryContext = buildCategoryContext(fields);
    const itemSpecifics = buildItemSpecifics(fields, cSpecifics);
    const currentLegacyTitle = normalizeText(getFieldValueByName(fields, LISTING_LEGACY_TITLE_FIELD));
    const currentOutputTitle = normalizeText(getFieldValueByName(fields, LISTING_OUTPUT_TITLE_FIELD));
    const donorVehicle = extractDonorVehicleEvidence(getFieldValueByName(fields, LISTING_SOURCE_DESCRIPTION_FIELD));
    const customLabelSku =
      normalizeText(getFieldValueByName(fields, 'SKU')) ||
      normalizeText(getFieldValueByName(fields, 'Custom Label')) ||
      normalizeText(getFieldValueByName(fields, 'CustomLabel'));
    const titleManualOverride = isManualOverrideForField(fields, LISTING_OUTPUT_TITLE_FIELD);
    const descriptionManualOverride = isManualOverrideForField(fields, LISTING_OUTPUT_DESCRIPTION_FIELD);
    const shortDescriptionManualOverride =
      hasShortDescriptionField && isManualOverrideForField(fields, LISTING_SHORT_DESCRIPTION_FIELD);

    if (titleContainsAirbag(currentOutputTitle || currentLegacyTitle)) {
      const writeFields = {};
      addFieldIfChanged(writeFields, fields, LISTING_TITLE_REVIEW_STATUS_FIELD, TITLE_REVIEW_STATUS_AIRBAG_LOCKED);
      addFieldIfChanged(writeFields, fields, LISTING_TITLE_REVIEW_REASON_FIELD, 'airbag_guard');
      addFieldIfChanged(
        writeFields,
        fields,
        LISTING_TITLE_REVIEW_NOTES_FIELD,
        'Airbag title detected. Client rule says title automation must not alter airbag listings.'
      );
      if (Object.keys(writeFields).length > 0) {
        updates.push({ id: row.id, fields: writeFields });
        summary.titleReviewWritten += 1;
      }
      summary.titleReviewAirbagLocked += 1;
      continue;
    }

    emitProgress(progressCallback, {
      stage: 'phase74_generate',
      percent: Math.min(88, 20 + Math.floor(((i + 1) / Math.max(1, rowsForGeneration.length)) * 68)),
      counts: summary,
      message: `Generating title/description for listing ${i + 1}/${rowsForGeneration.length} (IPN '${ipn}')...`
    });

    let generated;
    try {
      generated = await aiService.generateTitleAndDescription({
        ipn,
        categoryContext,
        conditionsAndOptions,
        condition: normalizeText(fields.Condition),
        conditionNote: normalizeText(fields['Condition Note']),
        itemSpecifics,
        partFitment: normalizeText(master?.fields?.[MASTER_FITMENT_FIELD]),
        currentLegacyTitle,
        currentTitle: currentOutputTitle || currentLegacyTitle,
        donorVehicle,
        customLabelSku,
        phase74TitleRulesPrompt
      });
    } catch (error) {
      summary.aiFailures += 1;
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`ipn='${ipn}' AI failed: ${error.message}`);
        emitProgress(progressCallback, {
          stage: 'phase74_ai_error',
          percent: Math.min(92, 20 + Math.floor(((i + 1) / Math.max(1, rowsForGeneration.length)) * 72)),
          counts: summary,
          message: `AI failed for IPN '${ipn}': ${compactText(error.message, 220)}`
        });
      }
      continue;
    }

    const aiTitle = preserveProtectedSourceTitlePhrases(
      ensureTitleHasSku(generated?.generatedTitle, customLabelSku),
      [currentOutputTitle, currentLegacyTitle],
      customLabelSku,
      titleMaxLength
    );
    const nextTitle = makeTitleUnique(aiTitle, usedTitleKeys, titleMinLength, titleMaxLength);
    const nextDescription = normalizeText(generated?.generatedDescription);
    const nextShortDescription = normalizeText(generated?.shortDescription);
    let nextReviewStatus = inferTitleReviewStatus(generated);
    let nextReviewReason = normalizeText(generated?.titleReviewReason);
    let nextReviewNotes =
      normalizeText(generated?.titleReviewNotes) || normalizeText(generated?.reasoningSummary);

    if (!nextTitle || !nextDescription) {
      const writeFields = {};
      addFieldIfChanged(writeFields, fields, LISTING_TITLE_REVIEW_STATUS_FIELD, TITLE_REVIEW_STATUS_NEEDS_REVIEW);
      addFieldIfChanged(writeFields, fields, LISTING_TITLE_REVIEW_REASON_FIELD, 'ai_blank_output');
      addFieldIfChanged(
        writeFields,
        fields,
        LISTING_TITLE_REVIEW_NOTES_FIELD,
        `AI returned blank title or description. ${compactText(generated?.reasoningSummary, 180)}`
      );
      if (Object.keys(writeFields).length > 0) {
        updates.push({ id: row.id, fields: writeFields });
        summary.titleReviewWritten += 1;
        summary.titleReviewNeedsReview += 1;
      }
      summary.aiFailures += 1;
      if (summary.errors.length < sampleLimit) {
        const blankMessage =
          `ipn='${ipn}' AI returned blank title/description. keys=${Array.isArray(generated?.parsedKeys) ? generated.parsedKeys.join(',') : 'none'} ` +
            `recognized=${Array.isArray(generated?.recognizedKeys) ? generated.recognizedKeys.join(',') : 'none'} ` +
            `reasoning='${compactText(generated?.reasoningSummary, 120)}' raw='${compactText(generated?.rawContent, 320)}'`;
        summary.errors.push(blankMessage);
        emitProgress(progressCallback, {
          stage: 'phase74_ai_blank',
          percent: Math.min(92, 20 + Math.floor(((i + 1) / Math.max(1, rowsForGeneration.length)) * 72)),
          counts: summary,
          message: blankMessage
        });
      }
      console.warn(
        `[Phase7.4] AI blank output for ipn='${ipn}' ` +
          `title='${compactText(nextTitle, 80)}' desc='${compactText(nextDescription, 80)}' ` +
          `keys=${Array.isArray(generated?.parsedKeys) ? generated.parsedKeys.join(',') : 'none'} ` +
          `recognized=${Array.isArray(generated?.recognizedKeys) ? generated.recognizedKeys.join(',') : 'none'} ` +
          `raw='${compactText(generated?.rawContent, 320)}'`
      );
      continue;
    }

    const existingTitleNew = normalizeText(fields[LISTING_OUTPUT_TITLE_FIELD]);
    const existingDescriptionOut = normalizeText(fields[LISTING_OUTPUT_DESCRIPTION_FIELD]);
    const existingShort = hasShortDescriptionField ? normalizeText(fields[LISTING_SHORT_DESCRIPTION_FIELD]) : '';

    const writeFields = {};

    if (titleManualOverride) {
      nextReviewStatus = TITLE_REVIEW_STATUS_MANUAL_OVERRIDE;
      nextReviewReason = nextReviewReason || 'manual_override';
      nextReviewNotes = nextReviewNotes || 'Item Title is marked as manually overridden, so Phase 7.4 did not replace it.';
    } else if (nextReviewStatus === TITLE_REVIEW_STATUS_COMPLETED) {
      nextReviewReason = nextReviewReason || 'completed';
      nextReviewNotes = nextReviewNotes || 'Title generated from confirmed listing data.';
    } else if (nextReviewStatus === TITLE_REVIEW_STATUS_NEEDS_REVIEW) {
      nextReviewReason = nextReviewReason || 'manual_review_required';
      nextReviewNotes = nextReviewNotes || 'Title rules flagged this row for manual review.';
    }

    if (!titleManualOverride && nextTitle && nextTitle !== existingTitleNew) {
      writeFields[LISTING_OUTPUT_TITLE_FIELD] = nextTitle;
      summary.titleGenerated += 1;
      const titleKey = normalizeTitleForKey(nextTitle);
      if (titleKey) usedTitleKeys.add(titleKey);
      usedTitles.push(nextTitle);
    } else if (titleManualOverride) {
      summary.skippedManualOverride += 1;
    }

    if (!descriptionManualOverride && nextDescription && nextDescription !== existingDescriptionOut) {
      writeFields[LISTING_OUTPUT_DESCRIPTION_FIELD] = nextDescription;
      summary.descriptionGenerated += 1;
    } else if (descriptionManualOverride) {
      summary.skippedManualOverride += 1;
    }

    if (!shortDescriptionManualOverride && hasShortDescriptionField && nextShortDescription && nextShortDescription !== existingShort) {
      writeFields[LISTING_SHORT_DESCRIPTION_FIELD] = nextShortDescription;
      summary.shortDescriptionWritten += 1;
    } else if (shortDescriptionManualOverride) {
      summary.skippedManualOverride += 1;
    }

    if (addFieldIfChanged(writeFields, fields, LISTING_TITLE_REVIEW_STATUS_FIELD, nextReviewStatus)) {
      summary.titleReviewWritten += 1;
    }
    addFieldIfChanged(writeFields, fields, LISTING_TITLE_REVIEW_REASON_FIELD, nextReviewReason);
    addFieldIfChanged(writeFields, fields, LISTING_TITLE_REVIEW_NOTES_FIELD, nextReviewNotes);

    if (nextReviewStatus === TITLE_REVIEW_STATUS_COMPLETED) summary.titleReviewCompleted += 1;
    if (nextReviewStatus === TITLE_REVIEW_STATUS_NEEDS_REVIEW) summary.titleReviewNeedsReview += 1;
    if (nextReviewStatus === TITLE_REVIEW_STATUS_AIRBAG_LOCKED) summary.titleReviewAirbagLocked += 1;
    if (nextReviewStatus === TITLE_REVIEW_STATUS_MANUAL_OVERRIDE) summary.titleReviewManualOverride += 1;

    if (Object.keys(writeFields).length === 0) {
      summary.skippedNoChange += 1;
      continue;
    }

    updates.push({
      id: row.id,
      fields: writeFields
    });

    if (!sampleSeen.has(ipn) && summary.samples.length < sampleLimit) {
      sampleSeen.add(ipn);
      summary.samples.push(
        `ipn='${ipn}' title='${compactText(nextTitle, 90)}' review='${nextReviewStatus}' desc='${compactText(nextDescription, 120)}'`
      );
    }

    const now = Date.now();
    if (i === 0 || i + 1 === rowsForGeneration.length || now - lastProgressAt >= 10000) {
      lastProgressAt = now;
      emitProgress(progressCallback, {
        stage: 'phase74_generate',
        percent: Math.min(92, 20 + Math.floor(((i + 1) / Math.max(1, rowsForGeneration.length)) * 72)),
        counts: summary,
        message:
          `Phase 7.4 progress ${i + 1}/${rowsForGeneration.length}: eligible=${summary.listingsEligible}, ` +
          `matched=${summary.masterMatched}, titles=${summary.titleGenerated}, descriptions=${summary.descriptionGenerated}, ` +
          `alreadyEnrichedSkipped=${summary.skippedAlreadyEnriched}, manualSkipped=${summary.skippedManualOverride}, ` +
          `publishedSkipped=${summary.skippedAlreadyPublished}, pendingWrites=${updates.length}`
      });
    }
  }

  emitProgress(progressCallback, {
    stage: 'phase74_write',
    percent: 94,
    counts: summary,
    message: `Writing ${updates.length} listing updates to Airtable...`
  });

  const writeBatches = chunkArray(updates, 10);
  summary.writesAttempted = updates.length;
  let writeBatchIndex = 0;
  for (const batch of writeBatches) {
    writeBatchIndex += 1;
    try {
      await airtableService.request('PATCH', `/${encodeURIComponent(listingsTable)}`, {
        data: {
          records: batch,
          typecast: true
        }
      });
      summary.writesSucceeded += batch.length;
    } catch (error) {
      summary.writeFailures += batch.length;
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`write batch failed: ${error.message}`);
      }
    }
    emitProgress(progressCallback, {
      stage: 'phase74_write',
      percent: Math.min(99, 94 + Math.floor((writeBatchIndex / Math.max(1, writeBatches.length)) * 5)),
      counts: summary,
      message:
        `Writing listing updates to Airtable: batch ${writeBatchIndex}/${Math.max(1, writeBatches.length)} ` +
        `(attempted=${summary.writesAttempted}, written=${summary.writesSucceeded}, failed=${summary.writeFailures})`
    });
  }

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: summary,
    message:
      `Phase 7.4 completed. Titles=${summary.titleGenerated}, Descriptions=${summary.descriptionGenerated}, ` +
      `AlreadyEnrichedSkipped=${summary.skippedAlreadyEnriched}, ManualSkipped=${summary.skippedManualOverride}, ` +
      `ReviewWritten=${summary.titleReviewWritten}, ReviewNeeds=${summary.titleReviewNeedsReview}, ` +
      `PublishedSkipped=${summary.skippedAlreadyPublished}, ` +
      `AIFailures=${summary.aiFailures}, SkippedNoChange=${summary.skippedNoChange}, ` +
      `WritesAttempted=${summary.writesAttempted}, WritesSucceeded=${summary.writesSucceeded}, WritesFailed=${summary.writeFailures}.`
  });

  return summary;
}

module.exports = {
  runPhase74TitleDescription
};

