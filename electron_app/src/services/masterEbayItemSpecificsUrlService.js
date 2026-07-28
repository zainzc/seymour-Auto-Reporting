const AirtableService = require('./airtableService');
const AirtableSchemaService = require('./airtableSchemaService');

const DEFAULT_MASTER_TABLE = 'Master Parts Table';
const DEFAULT_CATEGORY_TABLE = 'Category Definitions';
const DEFAULT_TARGET_FIELD = 'eBay Item Specifics';
const DEFAULT_SAMPLE_LIMIT = 25;

function normalizeText(value) {
  return String(value || '').trim();
}

function safeGetInventoryConfig(key = '') {
  try {
    const { getInventoryConfig } = require('../config/configStore');
    return getInventoryConfig(key);
  } catch (_) {
    return null;
  }
}

function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return defaultValue;
}

function appendSample(list, value, limit = DEFAULT_SAMPLE_LIMIT) {
  if (!Array.isArray(list) || !value || list.length >= limit) return;
  list.push(value);
}

function emitProgress(progressCallback, payload = {}) {
  if (typeof progressCallback === 'function') {
    progressCallback(payload);
  }
}

function extractIpnPrefix(ipn) {
  const text = normalizeText(ipn).toUpperCase();
  if (!text) return null;
  const match = text.match(/^(\d{3})/);
  return match && match[1] ? match[1] : null;
}

function parseMasterPrefix(value) {
  const parsed = parseInt(normalizeText(value), 10);
  if (!Number.isFinite(parsed)) return '';
  return String(parsed).padStart(3, '0');
}

function normalizeCategoryToken(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[\/,_]/g, ' ')
    .replace(/[()\[\]{}.:;+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function addCategoryTokens(tokens, value) {
  if (!(tokens instanceof Set)) return;
  const raw = normalizeText(value);
  if (!raw) return;
  const add = text => {
    const token = normalizeCategoryToken(text);
    if (token) tokens.add(token);
  };
  add(raw);
  raw
    .split(/[|,;/]+/)
    .map(item => normalizeText(item))
    .filter(Boolean)
    .forEach(add);
}

function extractEbayCategoryLeaf(value) {
  const raw = normalizeText(value);
  if (!raw) return '';
  const parts = raw
    .split('Â»')
    .map(item => normalizeText(item))
    .filter(Boolean);
  if (parts.length > 0) return parts[parts.length - 1];
  return raw;
}

function readLinkedRecordIds(fields = {}, candidates = []) {
  for (const name of candidates) {
    const key = normalizeText(name);
    if (!key) continue;
    const raw = fields?.[key];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    return raw
      .map(item => {
        if (!item) return '';
        if (typeof item === 'string') return normalizeText(item);
        if (typeof item === 'object') return normalizeText(item.id || item.recordId || '');
        return '';
      })
      .filter(Boolean);
  }
  return [];
}

function buildCategoryDefinitionLookup(categoryRecords = []) {
  const byId = new Map();
  for (const record of categoryRecords) {
    const id = normalizeText(record?.id);
    if (!id) continue;
    const fields = record?.fields || {};
    const prefix = parseMasterPrefix(fields['IPN Prefix']);
    const tokens = new Set();
    addCategoryTokens(tokens, fields['Category Identifier / Conditions & Options']);
    addCategoryTokens(tokens, fields['Category Identifier']);
    addCategoryTokens(tokens, fields['Conditions & Options']);
    if (tokens.size === 0) {
      const ebayCategoryLeaf = extractEbayCategoryLeaf(
        fields['eBay Category Name'] || fields['eBay Category'] || fields['eBay Category Path']
      );
      addCategoryTokens(tokens, ebayCategoryLeaf);
    }
    byId.set(id, {
      prefix,
      tokens
    });
  }
  return byId;
}

function resolveIdentifierTokensForRecord(
  fields = {},
  categoryLookup = new Map(),
  prefix = '',
  categoryLinkFieldName = ''
) {
  const resolved = new Set();
  const linkFieldCandidates = [
    'Category Definitions Link',
    'Category Definitions',
    'Categories'
  ];
  const dynamicLinkField = normalizeText(categoryLinkFieldName);
  if (dynamicLinkField) {
    linkFieldCandidates.unshift(dynamicLinkField);
  }
  const linkedIds = readLinkedRecordIds(fields, linkFieldCandidates);
  for (const recordId of linkedIds) {
    const entry = categoryLookup.get(recordId);
    if (!entry) continue;
    if (entry.prefix && prefix && entry.prefix !== prefix) continue;
    for (const token of entry.tokens || []) {
      if (token) resolved.add(token);
    }
  }
  addCategoryTokens(resolved, fields['Category Identifier / Conditions & Options']);
  addCategoryTokens(resolved, fields['Category Identifier']);
  addCategoryTokens(resolved, fields['Conditions & Options']);
  return resolved;
}

function getRouteCategoryKey(tableName) {
  const match = normalizeText(tableName).match(/^\d{3}\s*-\s*(.+)$/);
  return normalizeCategoryToken(match ? match[1] : '');
}

function findRouteByIdentifierTokens(routes = [], categoryIdentifierTokens = new Set()) {
  const candidates = Array.isArray(routes) ? routes : [];
  const tokens = categoryIdentifierTokens instanceof Set
    ? [...categoryIdentifierTokens].filter(token => token && token.length >= 2)
    : [];
  if (candidates.length === 0 || tokens.length === 0) {
    return {
      status: 'missing',
      matches: []
    };
  }

  const exactMatches = candidates.filter(route =>
    tokens.includes(normalizeText(route?.categoryKey))
  );
  if (exactMatches.length === 1) {
    return {
      status: 'ok',
      matches: exactMatches,
      route: exactMatches[0],
      matchType: 'exact'
    };
  }
  if (exactMatches.length > 1) {
    return {
      status: 'ambiguous',
      matches: exactMatches
    };
  }

  const containedMatches = candidates.filter(route => {
    const routeKey = normalizeText(route?.categoryKey);
    if (!routeKey) return false;
    return tokens.some(token => routeKey.includes(token) || token.includes(routeKey));
  });
  if (containedMatches.length === 1) {
    return {
      status: 'ok',
      matches: containedMatches,
      route: containedMatches[0],
      matchType: 'contains'
    };
  }
  if (containedMatches.length > 1) {
    return {
      status: 'ambiguous',
      matches: containedMatches
    };
  }

  return {
    status: 'missing',
    matches: []
  };
}

function matchesPrefixTableName(prefix = '', tableName = '') {
  const normalizedPrefix = normalizeText(prefix);
  const normalizedTableName = normalizeText(tableName);
  if (!normalizedPrefix || !normalizedTableName) return false;
  const expression = new RegExp(`^${normalizedPrefix}(?:\\s*-|\\s|$)`, 'i');
  return expression.test(normalizedTableName);
}

function choosePreferredView(table = {}) {
  const views = Array.isArray(table?.views) ? table.views : [];
  if (views.length === 0) return null;
  const gridView = views.find(view => normalizeText(view?.name).toLowerCase() === 'grid view');
  return gridView || views[0] || null;
}

function buildSchemaIndex(schemaTables = []) {
  const tables = Array.isArray(schemaTables) ? schemaTables : [];
  const tablesByPrefix = new Map();

  for (const table of tables) {
    const tableId = normalizeText(table?.id);
    const tableName = normalizeText(table?.name);
    const prefix = extractIpnPrefix(tableName);
    if (!tableId || !tableName || !prefix) continue;
    if (!matchesPrefixTableName(prefix, tableName)) continue;

    const view = choosePreferredView(table);
    const entry = {
      tableId,
      tableName,
      prefix,
      categoryKey: getRouteCategoryKey(tableName),
      viewId: normalizeText(view?.id),
      viewName: normalizeText(view?.name)
    };
    if (!tablesByPrefix.has(prefix)) {
      tablesByPrefix.set(prefix, []);
    }
    tablesByPrefix.get(prefix).push(entry);
  }

  return {
    tables,
    tablesByPrefix
  };
}

function buildItemSpecificTableUrl(prefix, schema) {
  const normalizedPrefix = normalizeText(prefix);
  const tablesByPrefix = schema?.tablesByPrefix instanceof Map
    ? schema.tablesByPrefix
    : buildSchemaIndex(Array.isArray(schema?.tables) ? schema.tables : []).tablesByPrefix;
  const itemSpecificsBaseId = normalizeText(schema?.itemSpecificsBaseId);
  if (!normalizedPrefix || !itemSpecificsBaseId) return null;

  const matches = Array.isArray(tablesByPrefix.get(normalizedPrefix))
    ? tablesByPrefix.get(normalizedPrefix)
    : [];
  if (matches.length !== 1) return null;

  const table = matches[0];
  return buildItemSpecificTableUrlForTable(table, schema);
}

function buildItemSpecificTableUrlForTable(table = {}, schema = {}) {
  const itemSpecificsBaseId = normalizeText(schema?.itemSpecificsBaseId);
  if (!itemSpecificsBaseId) return null;
  if (!table?.tableId || !table?.viewId) return null;
  return {
    url: `https://airtable.com/${itemSpecificsBaseId}/${table.tableId}/${table.viewId}?blocks=hide`,
    tableId: table.tableId,
    tableName: table.tableName,
    viewId: table.viewId,
    viewName: table.viewName || ''
  };
}

function resolveItemSpecificTableMatch(prefix, schema, options = {}) {
  const normalizedPrefix = normalizeText(prefix);
  const tablesByPrefix = schema?.tablesByPrefix instanceof Map
    ? schema.tablesByPrefix
    : buildSchemaIndex(Array.isArray(schema?.tables) ? schema.tables : []).tablesByPrefix;
  const matches = Array.isArray(tablesByPrefix.get(normalizedPrefix))
    ? tablesByPrefix.get(normalizedPrefix)
    : [];
  if (matches.length === 0) {
    return {
      status: 'missing',
      prefix: normalizedPrefix,
      matches: []
    };
  }
  if (matches.length > 1) {
    const identifierMatch = findRouteByIdentifierTokens(matches, options.categoryIdentifierTokens);
    if (identifierMatch.status === 'ok' && identifierMatch.route) {
      const detail = buildItemSpecificTableUrlForTable(identifierMatch.route, schema);
      if (!detail) {
        return {
          status: 'missing_view',
          prefix: normalizedPrefix,
          matches: identifierMatch.matches
        };
      }
      return {
        status: 'ok',
        prefix: normalizedPrefix,
        matches: identifierMatch.matches,
        detail,
        matchType: identifierMatch.matchType
      };
    }
    return {
      status: 'ambiguous',
      prefix: normalizedPrefix,
      matches: identifierMatch.matches && identifierMatch.matches.length > 0
        ? identifierMatch.matches
        : matches
    };
  }
  const detail = buildItemSpecificTableUrl(normalizedPrefix, schema);
  if (!detail) {
    return {
      status: 'missing_view',
      prefix: normalizedPrefix,
      matches
    };
  }
  return {
    status: 'ok',
    prefix: normalizedPrefix,
    matches,
    detail
  };
}

async function fetchItemSpecificsBaseSchema(config = {}) {
  const schemaTables = Array.isArray(config.schemaTables) ? config.schemaTables : null;
  const itemSpecificsBaseId = normalizeText(config.itemSpecificsBaseId);
  if (!itemSpecificsBaseId) {
    throw new Error('ITEM_SPECIFICS_BASE_ID / AIRTABLE_ITEM_SPECIFICS_BASE_ID is required.');
  }
  if (schemaTables) {
    const indexed = buildSchemaIndex(schemaTables);
    return {
      itemSpecificsBaseId,
      tables: indexed.tables,
      tablesByPrefix: indexed.tablesByPrefix,
      metadataCalls: 0
    };
  }

  const schemaService = config.schemaService instanceof AirtableSchemaService
    ? config.schemaService
    : new AirtableSchemaService({
        token: normalizeText(config.airtableToken),
        baseId: itemSpecificsBaseId
      });
  const tables = await schemaService.listTables();
  const indexed = buildSchemaIndex(tables);
  return {
    itemSpecificsBaseId,
    tables: indexed.tables,
    tablesByPrefix: indexed.tablesByPrefix,
    metadataCalls: 1
  };
}

function buildServiceConfig(options = {}) {
  const stored = safeGetInventoryConfig('phase2Config') || {};
  const merged = {
    ...stored,
    ...options
  };

  return {
    airtableToken: normalizeText(merged.airtableToken || process.env.AIRTABLE_TOKEN),
    masterBaseId: normalizeText(merged.airtableBaseId || process.env.AIRTABLE_BASE_ID),
    masterTable: normalizeText(
      merged.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || DEFAULT_MASTER_TABLE
    ),
    categoryTable: normalizeText(
      merged.airtableCategoryTable || process.env.AIRTABLE_CATEGORY_TABLE || DEFAULT_CATEGORY_TABLE
    ),
    categoryLinkFieldName: normalizeText(
      merged.airtableCategoryLinkFieldName ||
        merged.categoryLinkFieldName ||
        process.env.AIRTABLE_CATEGORY_LINK_FIELD_NAME
    ),
    itemSpecificsBaseId: normalizeText(
      merged.itemSpecificsBaseId ||
        process.env.AIRTABLE_ITEM_SPECIFICS_BASE_ID ||
        process.env.ITEM_SPECIFICS_BASE_ID
    ),
    targetFieldName: normalizeText(
      merged.ebayItemSpecificsFieldName ||
        process.env.EBAY_ITEM_SPECIFICS_FIELD_NAME ||
        DEFAULT_TARGET_FIELD
    ),
    sampleLimit: Number(merged.sampleLimit || merged.phase4SampleLimit || DEFAULT_SAMPLE_LIMIT) || DEFAULT_SAMPLE_LIMIT,
    dryRun: parseBoolean(merged.dryRun, false),
    masterRows: Array.isArray(merged.masterRows) ? merged.masterRows : null,
    schemaTables: Array.isArray(merged.schemaTables) ? merged.schemaTables : null
  };
}

function buildSummary(config = {}) {
  return {
    dryRun: Boolean(config.dryRun),
    masterTable: normalizeText(config.masterTable || DEFAULT_MASTER_TABLE),
    itemSpecificsBaseId: normalizeText(config.itemSpecificsBaseId),
    targetFieldName: normalizeText(config.targetFieldName || DEFAULT_TARGET_FIELD),
    metadataCalls: 0,
    schemaTablesLoaded: 0,
    schemaPrefixesLoaded: 0,
    recordsScanned: 0,
    recordsProcessed: 0,
    recordsPlanned: 0,
    recordsUpdated: 0,
    skippedAlreadyPopulated: 0,
    skippedMissingIpn: 0,
    skippedMissingPrefix: 0,
    skippedNoMatchingTable: 0,
    skippedAmbiguousTable: 0,
    skippedMissingView: 0,
    missingPrefixes: [],
    ambiguousPrefixes: [],
    logSamples: [],
    errors: [],
    sampleLimit: Number(config.sampleLimit || DEFAULT_SAMPLE_LIMIT) || DEFAULT_SAMPLE_LIMIT
  };
}

function buildBlankBackfillFormula(targetFieldName = DEFAULT_TARGET_FIELD) {
  const ipnField = '{IPN}';
  const targetField = `{${normalizeText(targetFieldName) || DEFAULT_TARGET_FIELD}}`;
  return `AND(LEN(TRIM(${ipnField}&""))>0,LEN(TRIM(${targetField}&""))=0)`;
}

function buildMasterBackfillSelectFields(
  targetFieldName = DEFAULT_TARGET_FIELD,
  availableFieldNames = null,
  categoryLinkFieldName = ''
) {
  const candidates = [
    'IPN',
    targetFieldName,
    'Category Identifier / Conditions & Options',
    'Category Identifier',
    'Conditions & Options',
    'Category Definitions Link',
    'Category Definitions',
    'Categories'
  ];
  const dynamicLinkField = normalizeText(categoryLinkFieldName);
  if (dynamicLinkField) {
    candidates.unshift(dynamicLinkField);
  }
  const available = availableFieldNames instanceof Set ? availableFieldNames : null;
  return candidates
    .map(fieldName => normalizeText(fieldName))
    .filter(Boolean)
    .filter((fieldName, index, list) => list.indexOf(fieldName) === index)
    .filter(fieldName => !available || available.has(fieldName));
}

function pushUnique(list, value, limit = DEFAULT_SAMPLE_LIMIT) {
  if (!Array.isArray(list)) return;
  if (list.includes(value)) return;
  if (list.length >= limit) return;
  list.push(value);
}

function logSample(summary, message) {
  appendSample(summary.logSamples, message, summary.sampleLimit);
}

function populateEbayItemSpecificsUrlForRecord(masterRecord, context = {}) {
  const summary = context.summary;
  const targetFieldName = normalizeText(context.targetFieldName || DEFAULT_TARGET_FIELD);
  const fields = masterRecord?.fields || {};
  const recordId = normalizeText(masterRecord?.id);
  const ipn = normalizeText(fields.IPN).toUpperCase();
  const existingValue = normalizeText(fields[targetFieldName]);

  summary.recordsProcessed += 1;
  if (!ipn) {
    summary.skippedMissingIpn += 1;
    logSample(summary, `[skip][missing_ipn] record='${recordId || 'unknown'}'`);
    return null;
  }
  if (existingValue) {
    summary.skippedAlreadyPopulated += 1;
    logSample(
      summary,
      `[skip][already_populated] ipn='${ipn}' record='${recordId || 'unknown'}' field='${targetFieldName}'`
    );
    return null;
  }

  const prefix = extractIpnPrefix(ipn);
  if (!prefix) {
    summary.skippedMissingPrefix += 1;
    logSample(summary, `[skip][missing_prefix] ipn='${ipn}' record='${recordId || 'unknown'}'`);
    return null;
  }

  const categoryIdentifierTokens = resolveIdentifierTokensForRecord(
    fields,
    context.categoryDefinitionLookup,
    prefix,
    context.categoryLinkFieldName
  );
  const match = resolveItemSpecificTableMatch(prefix, context.schema, {
    categoryIdentifierTokens
  });
  if (match.status === 'missing') {
    summary.skippedNoMatchingTable += 1;
    pushUnique(summary.missingPrefixes, prefix, summary.sampleLimit);
    logSample(summary, `[skip][no_matching_table] ipn='${ipn}' prefix='${prefix}'`);
    return null;
  }
  if (match.status === 'ambiguous') {
    summary.skippedAmbiguousTable += 1;
    pushUnique(
      summary.ambiguousPrefixes,
      `${prefix}: ${match.matches.map(item => item.tableName).join(' | ')}`,
      summary.sampleLimit
    );
    logSample(
      summary,
      `[skip][ambiguous_tables] ipn='${ipn}' prefix='${prefix}' candidates='${match.matches
        .map(item => item.tableName)
        .join(' | ')}' identifiers='${[...categoryIdentifierTokens].join(' | ')}'`
    );
    return null;
  }
  if (match.status === 'missing_view') {
    summary.skippedMissingView += 1;
    logSample(summary, `[skip][missing_view] ipn='${ipn}' prefix='${prefix}'`);
    return null;
  }

  const { detail } = match;
  summary.recordsPlanned += 1;
  logSample(
    summary,
    `[process] ipn='${ipn}' prefix='${prefix}' table='${detail.tableName}' view='${detail.viewName || detail.viewId}' url='${detail.url}'`
  );
  return {
    id: recordId,
    fields: {
      [targetFieldName]: detail.url
    }
  };
}

async function populateEbayItemSpecificsUrlsForRecords(masterRecords = [], options = {}, progressCallback = () => {}) {
  const config = buildServiceConfig(options);
  const summary = buildSummary(config);

  const masterService = options.masterService instanceof AirtableService
    ? options.masterService
    : new AirtableService({
        token: config.airtableToken,
        baseId: config.masterBaseId,
        masterTable: config.masterTable
      });

  if (!config.airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (!config.masterBaseId) throw new Error('Missing AIRTABLE_BASE_ID.');
  if (!config.itemSpecificsBaseId) {
    throw new Error('Missing ITEM_SPECIFICS_BASE_ID / AIRTABLE_ITEM_SPECIFICS_BASE_ID.');
  }

  const masterFieldNames = await masterService.getMasterFieldNames();
  if (!masterFieldNames.has(config.targetFieldName)) {
    throw new Error(
      `Master Parts field '${config.targetFieldName}' was not found in '${config.masterTable}'.`
    );
  }

  emitProgress(progressCallback, {
    stage: 'master_item_specifics_url_prepare',
    percent: 5,
    counts: summary,
    message: `Loading Item Specifics base schema for '${config.itemSpecificsBaseId}'...`
  });
  const schema = await fetchItemSpecificsBaseSchema({
    airtableToken: config.airtableToken,
    itemSpecificsBaseId: config.itemSpecificsBaseId,
    schemaTables: config.schemaTables
  });
  summary.metadataCalls = Number(schema.metadataCalls || 0);
  summary.schemaTablesLoaded = Array.isArray(schema.tables) ? schema.tables.length : 0;
  summary.schemaPrefixesLoaded = schema.tablesByPrefix instanceof Map ? schema.tablesByPrefix.size : 0;

  const records = Array.isArray(masterRecords) ? masterRecords : [];
  summary.recordsScanned = records.length;
  emitProgress(progressCallback, {
    stage: 'master_item_specifics_url_prepare',
    percent: 10,
    counts: summary,
    message:
      `Item Specifics schema ready: tables=${summary.schemaTablesLoaded}, ` +
      `prefixes=${summary.schemaPrefixesLoaded}, metadataCalls=${summary.metadataCalls}`
  });

  let categoryDefinitionLookup = new Map();
  let categoryLinkFieldName = normalizeText(config.categoryLinkFieldName);
  const hasDuplicatePrefixes = schema.tablesByPrefix instanceof Map &&
    [...schema.tablesByPrefix.values()].some(matches => Array.isArray(matches) && matches.length > 1);
  if (hasDuplicatePrefixes) {
    try {
      categoryLinkFieldName = await masterService.resolveMasterCategoryLinkFieldName(categoryLinkFieldName);
      const categoryRecords = await masterService.fetchAllRecords(config.categoryTable, []);
      categoryDefinitionLookup = buildCategoryDefinitionLookup(categoryRecords);
      logSample(
        summary,
        `[routing] loaded_category_definitions='${categoryRecords.length}' category_link_field='${categoryLinkFieldName || 'not_detected'}' duplicate_prefix_matching='enabled'`
      );
    } catch (error) {
      summary.errors.push(`Category Definitions duplicate-prefix routing unavailable: ${error.message}`);
    }
  }

  const updates = [];
  let lastProgressAt = Date.now();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const update = populateEbayItemSpecificsUrlForRecord(record, {
      schema,
      summary,
      targetFieldName: config.targetFieldName,
      categoryDefinitionLookup,
      categoryLinkFieldName
    });
    if (update) updates.push(update);

    const now = Date.now();
    if (
      index === 0 ||
      index + 1 === records.length ||
      (index + 1) % 500 === 0 ||
      now - lastProgressAt >= 5000
    ) {
      lastProgressAt = now;
      emitProgress(progressCallback, {
        stage: 'master_item_specifics_url_scan',
        percent: 35,
        counts: summary,
        message:
          `Scanning Master Parts ${index + 1}/${records.length}... ` +
          `planned=${summary.recordsPlanned}, existing=${summary.skippedAlreadyPopulated}, ` +
          `missingPrefix=${summary.skippedMissingPrefix}, noMatch=${summary.skippedNoMatchingTable}, ` +
          `ambiguous=${summary.skippedAmbiguousTable}`
      });
    }
  }

  if (config.dryRun || updates.length === 0) {
    summary.recordsUpdated = 0;
    emitProgress(progressCallback, {
      stage: 'master_item_specifics_url_completed',
      percent: 100,
      counts: summary,
      message: config.dryRun
        ? `Master Parts eBay Item Specifics URL dry run completed. Planned=${summary.recordsPlanned}.`
        : 'Master Parts eBay Item Specifics URL run completed. No updates were needed.'
    });
    return summary;
  }

  emitProgress(progressCallback, {
    stage: 'master_item_specifics_url_write',
    percent: 70,
    counts: summary,
    message: `Writing Master Parts eBay Item Specifics URLs... records=${updates.length}`
  });
  const result = await masterService.writeMasterPartsWithFallback(
    'PATCH',
    updates,
    batchState => {
      emitProgress(progressCallback, {
        stage: 'master_item_specifics_url_write',
        percent: 85,
        counts: summary,
        message:
          `Writing Master Parts eBay Item Specifics URLs... batch ${batchState.batchIndex || batchState.index || 0}/` +
          `${batchState.totalBatches || batchState.total || 0}, written=${batchState.writtenRecords || batchState.written || batchState.writtenSoFar || 0}, ` +
          `failed=${batchState.failedRecords || batchState.failed || batchState.errorsSoFar || 0}`
      });
    }
  );
  summary.recordsUpdated = Number(result.count || result.written || 0);
  if (Array.isArray(result.errors)) {
    result.errors.slice(0, 200).forEach(error => summary.errors.push(error));
  }

  emitProgress(progressCallback, {
    stage: 'master_item_specifics_url_completed',
    percent: 100,
    counts: summary,
    message:
      `Master Parts eBay Item Specifics URL population completed. ` +
      `updated=${summary.recordsUpdated}, planned=${summary.recordsPlanned}, ` +
      `existing=${summary.skippedAlreadyPopulated}, missing=${summary.skippedNoMatchingTable}, ambiguous=${summary.skippedAmbiguousTable}`
  });
  return summary;
}

async function fetchMasterBackfillRows(
  masterService,
  tableName,
  targetFieldName,
  progressCallback = () => {},
  options = {}
) {
  const selectFields = options.minimalFields
    ? buildMasterBackfillSelectFields(targetFieldName, new Set(['IPN', targetFieldName]))
    : buildMasterBackfillSelectFields(
        targetFieldName,
        options.availableFieldNames,
        options.categoryLinkFieldName
      );
  const filterByFormula = buildBlankBackfillFormula(targetFieldName);
  const records = [];
  let offset = null;
  let page = 0;
  do {
    const params = {};
    if (offset) params.offset = offset;
    params.fields = selectFields;
    params.filterByFormula = filterByFormula;
    const data = await masterService.request('GET', `/${encodeURIComponent(tableName)}`, { params });
    const batch = Array.isArray(data?.records) ? data.records : [];
    records.push(...batch);
    page += 1;
    emitProgress(progressCallback, {
      stage: 'master_item_specifics_url_backfill_load',
      percent: 20,
      counts: null,
      message: `Loading Master Parts backfill rows... loaded=${records.length} (page ${page})`
    });
    offset = data?.offset || null;
  } while (offset);
  return records;
}

async function backfillEbayItemSpecificsUrls(options = {}, progressCallback = () => {}) {
  const config = buildServiceConfig(options);
  const masterService = new AirtableService({
    token: config.airtableToken,
    baseId: config.masterBaseId,
    masterTable: config.masterTable
  });

  const masterFieldNames = await masterService.getMasterFieldNames();
  if (!masterFieldNames.has(config.targetFieldName)) {
    throw new Error(
      `Master Parts field '${config.targetFieldName}' was not found in '${config.masterTable}'.`
    );
  }

  emitProgress(progressCallback, {
    stage: 'master_item_specifics_url_backfill_prepare',
    percent: 5,
    counts: null,
    message:
      `Preparing Master Parts eBay Item Specifics URL backfill for '${config.masterTable}' ` +
      `using Item Specifics base '${config.itemSpecificsBaseId}'...`
  });
  const rows = Array.isArray(config.masterRows)
    ? config.masterRows
    : await (async () => {
        let categoryLinkFieldName = normalizeText(config.categoryLinkFieldName);
        try {
          categoryLinkFieldName = await masterService.resolveMasterCategoryLinkFieldName(categoryLinkFieldName);
        } catch (_) {
          categoryLinkFieldName = normalizeText(config.categoryLinkFieldName);
        }
        try {
          return await fetchMasterBackfillRows(
            masterService,
            config.masterTable,
            config.targetFieldName,
            progressCallback,
            {
              availableFieldNames: masterFieldNames,
              categoryLinkFieldName
            }
          );
        } catch (error) {
          emitProgress(progressCallback, {
            stage: 'master_item_specifics_url_backfill_load',
            percent: 20,
            counts: null,
            message:
              `Category-aware backfill read failed (${error.message}); retrying with IPN-only fields.`
          });
          return fetchMasterBackfillRows(
            masterService,
            config.masterTable,
            config.targetFieldName,
            progressCallback,
            { minimalFields: true }
          );
        }
      })();

  return populateEbayItemSpecificsUrlsForRecords(rows, {
    ...config,
    masterService
  }, progressCallback);
}

module.exports = {
  backfillEbayItemSpecificsUrls,
  buildItemSpecificTableUrl,
  extractIpnPrefix,
  fetchItemSpecificsBaseSchema,
  populateEbayItemSpecificsUrlForRecord,
  populateEbayItemSpecificsUrlsForRecords
};
