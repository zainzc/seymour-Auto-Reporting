const AirtableService = require('./airtableService');
const AirtableSchemaService = require('./airtableSchemaService');
const Phase4AiEvaluatorService = require('./phase4AiEvaluatorService');

const DEFAULT_LISTINGS_TABLE = 'eBay Listings (API) (Mock)';
const DEFAULT_MASTER_TABLE = 'Master Parts Table';
const LISTING_IPN_FIELD = 'c: partshunter203 ebay MOTORS interchange part number';
const LISTING_TITLE_FIELD = 'Product Title';
const LISTING_NEW_TITLE_FIELD = 'Product Title(New)';
const LISTING_DESCRIPTION_OUTPUT_FIELD = 'c: partshunter203 ebay MOTORS e commerce description';
const LISTING_SHORT_DESCRIPTION_FIELD = 'Short Description';
const LISTING_CONDITIONS_FIELD = 'c: partshunter203 ebay MOTORS conditions & options';
const LISTING_CONDITIONS_FALLBACK_FIELD = 'Listing Conditions and Options';
const MASTER_IPN_FIELD = 'IPN';
const MASTER_FITMENT_FIELD = 'Part Fitment';

const LISTING_ITEM_SPECIFIC_FIELDS = [
  'Brand',
  'Manufacturer',
  'Model Number',
  'c: partshunter203 ebay MOTORS manufacturer part number',
  'c: partshunter203 ebay MOTORS mpn',
  'c: partshunter203 ebay MOTORS o e/ o e m part number',
  'c: partshunter203 ebay MOTORS o e part number',
  'c: partshunter203 ebay MOTORS other part number',
  'c: partshunter203 ebay MOTORS part number',
  'c: partshunter203 ebay MOTORS placement on vehicle',
  'c: partshunter203 ebay MOTORS placement',
  'c: partshunter203 ebay MOTORS lighting technology',
  'c: partshunter203 ebay MOTORS housing color',
  'c: partshunter203 ebay MOTORS lens color',
  'c: partshunter203 ebay MOTORS light color',
  'c: partshunter203 ebay MOTORS material',
  'c: partshunter203 ebay MOTORS color',
  'c: partshunter203 ebay MOTORS features',
  'c: partshunter203 ebay MOTORS connector type',
  'c: partshunter203 ebay MOTORS connector quantity',
  'c: partshunter203 ebay MOTORS terminal type',
  'c: partshunter203 ebay MOTORS terminal quantity',
  'c: partshunter203 ebay MOTORS number of pieces',
  'c: partshunter203 ebay MOTORS number of bulbs',
  'c: partshunter203 ebay MOTORS number of holes',
  'c: partshunter203 ebay MOTORS number of teeth',
  'c: partshunter203 ebay MOTORS voltage',
  'c: partshunter203 ebay MOTORS wattage',
  'c: partshunter203 ebay MOTORS amperage',
  'c: partshunter203 ebay MOTORS power rating',
  'c: partshunter203 ebay MOTORS engine size',
  'c: partshunter203 ebay MOTORS number of cylinders',
  'c: partshunter203 ebay MOTORS transmission type',
  'c: partshunter203 ebay MOTORS transmission speeds',
  'c: partshunter203 ebay MOTORS drive type',
  'c: partshunter203 ebay MOTORS fuel type',
  'c: partshunter203 ebay MOTORS make',
  'c: partshunter203 ebay MOTORS model',
  'c: partshunter203 ebay MOTORS year',
  'c: partshunter203 ebay MOTORS mileage',
  'c: partshunter203 ebay MOTORS stock #'
];

const LISTING_CATEGORY_FIELDS = [
  'Category',
  'c: partshunter203 ebay MOTORS Store Category',
  'c: partshunter203 ebay MOTORS Store Category 2',
  'c: partshunter203 ebay MOTORS Import Category'
];

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

function buildItemSpecifics(fields = {}) {
  const out = {};
  for (const name of LISTING_ITEM_SPECIFIC_FIELDS) {
    const value = normalizeText(fields[name]);
    if (!value) continue;
    out[name] = value;
  }
  return out;
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
  const openaiBaseUrl = normalizeText(options.openaiBaseUrl || process.env.OPENAI_BASE_URL || '');
  const promptCacheEnabled =
    normalizeText(options.phase74PromptCacheEnabled ?? process.env.PHASE74_PROMPT_CACHE_ENABLED ?? 'true').toLowerCase() !==
    'false';
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
    promptCacheKey
  });

  const summary = {
    listingsTable,
    masterTable,
    testIpnsCount: testIpnSet.size,
    maxListings,
    listingsScanned: 0,
    listingsEligible: 0,
    masterMatched: 0,
    masterMissing: 0,
    listingFieldsCreated: 0,
    titleGenerated: 0,
    descriptionGenerated: 0,
    shortDescriptionWritten: 0,
    skippedManualOverride: 0,
    skippedNoChange: 0,
    aiFailures: 0,
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
    LISTING_NEW_TITLE_FIELD,
    LISTING_DESCRIPTION_OUTPUT_FIELD
  ]);
  summary.listingFieldsCreated = (ensureResult?.createdFields || []).length;

  const hasShortDescriptionField = ensureResult.existingFields.has(LISTING_SHORT_DESCRIPTION_FIELD);

  const selectFields = [
    LISTING_IPN_FIELD,
    LISTING_TITLE_FIELD,
    LISTING_NEW_TITLE_FIELD,
    LISTING_DESCRIPTION_OUTPUT_FIELD,
    LISTING_CONDITIONS_FIELD,
    LISTING_CONDITIONS_FALLBACK_FIELD,
    'Condition',
    'Condition Note',
    ...LISTING_CATEGORY_FIELDS,
    ...LISTING_ITEM_SPECIFIC_FIELDS
  ];
  if (hasShortDescriptionField) {
    selectFields.push(LISTING_SHORT_DESCRIPTION_FIELD);
  }

  emitProgress(progressCallback, {
    stage: 'phase74_load_listings',
    percent: 15,
    counts: summary,
    message: `Loading listings from '${listingsTable}'...`
  });

  const listingRows = await fetchAllRecordsWithFallback(airtableService, listingsTable, Array.from(new Set(selectFields)));
  summary.listingsScanned = listingRows.length;

  const neededIpns = [];
  for (const row of listingRows) {
    const ipn = normalizeIpn(row?.fields?.[LISTING_IPN_FIELD]);
    if (!ipn) continue;
    if (testIpnSet.size > 0 && !testIpnSet.has(ipn)) continue;
    neededIpns.push(ipn);
  }

  const uniqueIpns = Array.from(new Set(neededIpns));
  const masterRows =
    uniqueIpns.length > 0
      ? await fetchMasterRowsByIpnSet(airtableService, masterTable, uniqueIpns, [MASTER_IPN_FIELD, MASTER_FITMENT_FIELD])
      : [];
  const masterByIpn = new Map();
  for (const row of masterRows) {
    const ipn = normalizeIpn(row?.fields?.[MASTER_IPN_FIELD]);
    if (!ipn || masterByIpn.has(ipn)) continue;
    masterByIpn.set(ipn, row);
  }

  const updates = [];
  const sampleSeen = new Set();

  let processedEligible = 0;
  let lastProgressAt = Date.now();

  for (let i = 0; i < listingRows.length; i += 1) {
    const row = listingRows[i];
    const fields = row?.fields || {};
    const ipn = normalizeIpn(fields[LISTING_IPN_FIELD]);
    if (!ipn) continue;
    if (testIpnSet.size > 0 && !testIpnSet.has(ipn)) continue;

    summary.listingsEligible += 1;
    processedEligible += 1;
    if (maxListings > 0 && processedEligible > maxListings) break;

    const master = masterByIpn.get(ipn);
    if (!master) {
      summary.masterMissing += 1;
      continue;
    }
    summary.masterMatched += 1;

    const conditionsAndOptions =
      normalizeText(fields[LISTING_CONDITIONS_FIELD]) || normalizeText(fields[LISTING_CONDITIONS_FALLBACK_FIELD]);
    const categoryContext = buildCategoryContext(fields);
    const itemSpecifics = buildItemSpecifics(fields);

    emitProgress(progressCallback, {
      stage: 'phase74_generate',
      percent: Math.min(88, 20 + Math.floor(((i + 1) / Math.max(1, listingRows.length)) * 68)),
      counts: summary,
      message: `Generating title/description for listing ${i + 1}/${listingRows.length} (IPN '${ipn}')...`
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
        currentTitle: normalizeText(fields[LISTING_TITLE_FIELD])
      });
    } catch (error) {
      summary.aiFailures += 1;
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`ipn='${ipn}' AI failed: ${error.message}`);
      }
      continue;
    }

    const nextTitle = normalizeText(generated?.generatedTitle);
    const nextDescription = normalizeText(generated?.generatedDescription);
    const nextShortDescription = normalizeText(generated?.shortDescription);

    if (!nextTitle && !nextDescription) {
      summary.aiFailures += 1;
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`ipn='${ipn}' AI returned empty title and description.`);
      }
      continue;
    }

    const existingTitleNew = normalizeText(fields[LISTING_NEW_TITLE_FIELD]);
    const existingDescriptionOut = normalizeText(fields[LISTING_DESCRIPTION_OUTPUT_FIELD]);
    const existingShort = hasShortDescriptionField ? normalizeText(fields[LISTING_SHORT_DESCRIPTION_FIELD]) : '';

    const writeFields = {};

    if (nextTitle && nextTitle !== existingTitleNew) {
      writeFields[LISTING_NEW_TITLE_FIELD] = nextTitle;
      summary.titleGenerated += 1;
    }

    if (nextDescription && nextDescription !== existingDescriptionOut) {
      writeFields[LISTING_DESCRIPTION_OUTPUT_FIELD] = nextDescription;
      summary.descriptionGenerated += 1;
    }

    if (hasShortDescriptionField && nextShortDescription && nextShortDescription !== existingShort) {
      writeFields[LISTING_SHORT_DESCRIPTION_FIELD] = nextShortDescription;
      summary.shortDescriptionWritten += 1;
    }

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
        `ipn='${ipn}' title='${compactText(nextTitle, 90)}' desc='${compactText(nextDescription, 120)}'`
      );
    }

    const now = Date.now();
    if (i === 0 || i + 1 === listingRows.length || now - lastProgressAt >= 10000) {
      lastProgressAt = now;
      emitProgress(progressCallback, {
        stage: 'phase74_generate',
        percent: Math.min(92, 20 + Math.floor(((i + 1) / Math.max(1, listingRows.length)) * 72)),
        counts: summary,
        message:
          `Phase 7.4 progress ${i + 1}/${listingRows.length}: eligible=${summary.listingsEligible}, ` +
          `matched=${summary.masterMatched}, titles=${summary.titleGenerated}, descriptions=${summary.descriptionGenerated}, pendingWrites=${updates.length}`
      });
    }
  }

  emitProgress(progressCallback, {
    stage: 'phase74_write',
    percent: 94,
    counts: summary,
    message: `Writing ${updates.length} listing updates to Airtable...`
  });

  for (const batch of chunkArray(updates, 10)) {
    try {
      await airtableService.request('PATCH', `/${encodeURIComponent(listingsTable)}`, {
        data: {
          records: batch,
          typecast: true
        }
      });
    } catch (error) {
      summary.writeFailures += batch.length;
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`write batch failed: ${error.message}`);
      }
    }
  }

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: summary,
    message: `Phase 7.4 completed. Titles=${summary.titleGenerated}, Descriptions=${summary.descriptionGenerated}, WritesFailed=${summary.writeFailures}.`
  });

  return summary;
}

module.exports = {
  runPhase74TitleDescription
};
