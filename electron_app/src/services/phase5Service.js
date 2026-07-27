const AirtableService = require('./airtableService');
const AirtableSchemaService = require('./airtableSchemaService');
const { Phase5ApprovalService, DEFAULT_LISTINGS_TABLE, normalizeText } = require('./phase5ApprovalService');
const { Phase5EbayPublishService } = require('./phase5EbayPublishService');
const { Phase5PublishLogService } = require('./phase5PublishLogService');
const { validateBatchGovernanceSchema } = require('./phase5BatchGovernanceService');
const {
  parseBoolean,
  parseCsvList,
  normalizeComparableValue,
  extractLinkedRecordIds,
  firstNonEmptyField,
  getIpnPrefix,
  buildListingPayloadHash
} = require('./phase5GovernanceService');

function emitProgress(progressCallback, payload = {}) {
  if (typeof progressCallback === 'function') {
    progressCallback(payload);
  }
}

function parseIdentitySet(values = []) {
  return new Set((Array.isArray(values) ? values : []).map(value => normalizeText(value)).filter(Boolean));
}

function normalizePhase5Mode(value) {
  const text = normalizeText(value).toLowerCase();
  if (
    text === 'b' ||
    text === 'option_b' ||
    text === 'option-b' ||
    text === 'scheduled' ||
    text === 'auto' ||
    text === 'auto_push' ||
    text === 'auto-push'
  ) {
    return 'B';
  }
  return 'A';
}

function getModeLabel(mode) {
  return mode === 'B' ? 'Option B (Scheduled Auto-Push)' : 'Option A (Approval Gate)';
}

function normalizeTextOrComparable(value) {
  return normalizeText(normalizeComparableValue(value));
}

function detectLinkedRecordField(fields = [], linkedTableId = '', preferred = []) {
  const targetLinkedTableId = normalizeText(linkedTableId);
  const normalizedPreferred = (Array.isArray(preferred) ? preferred : [])
    .map(name => normalizeText(name).toLowerCase())
    .filter(Boolean);
  const candidates = (Array.isArray(fields) ? fields : []).filter(field => {
    if (normalizeText(field?.type) !== 'multipleRecordLinks') return false;
    const fieldLinkedTableId = normalizeText(field?.options?.linkedTableId);
    return targetLinkedTableId && fieldLinkedTableId === targetLinkedTableId;
  });
  if (candidates.length === 0) return '';

  for (const wanted of normalizedPreferred) {
    const exact = candidates.find(field => normalizeText(field?.name).toLowerCase() === wanted);
    if (exact?.name) return normalizeText(exact.name);
  }

  const first = candidates[0];
  return normalizeText(first?.name || '');
}

function normalizeValueSet(list = []) {
  const set = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const key = normalizeText(item).toLowerCase();
    if (!key) continue;
    set.add(key);
  }
  return set;
}

function parseRecordIdList(value) {
  if (Array.isArray(value)) {
    return value.map(item => normalizeText(item)).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map(item => normalizeText(item))
    .filter(Boolean);
}

function isExceptionResolved(value, resolvedValues = []) {
  const resolved = normalizeValueSet(resolvedValues);
  const text = normalizeTextOrComparable(value).toLowerCase();
  if (!text) return true;
  // Support boolean-style exception flags in listings table.
  if (['false', '0', 'no', 'n', 'none', 'clear', 'cleared'].includes(text)) return true;
  if (['true', '1', 'yes', 'y', 'open', 'pending', 'exception', 'flagged'].includes(text)) return false;
  if (resolved.size === 0) return false;
  return resolved.has(text);
}

function normalizeEbayItemId(value) {
  const text = normalizeText(value)
    .replace(/^[\s'"`]+/, '')
    .replace(/[\s'"`]+$/, '');
  if (/^[\d\s.,'-]+$/.test(text)) {
    return text.replace(/\D+/g, '');
  }
  return text;
}

async function loadQueueRecordsWithProgress(airtableService, tableNameOrId, progressCallback, summaryRef) {
  const records = [];
  let offset = null;
  let page = 0;

  do {
    const params = {};
    if (offset) params.offset = offset;

    const data = await airtableService.request('GET', `/${encodeURIComponent(tableNameOrId)}`, { params });
    const batch = Array.isArray(data?.records) ? data.records : [];
    records.push(...batch);
    offset = data?.offset || null;
    page += 1;

    emitProgress(progressCallback, {
      stage: 'phase5_load_queue',
      percent: Math.min(24, 15 + Math.floor(Math.min(page, 18) / 2)),
      counts: summaryRef || null,
      message: `Phase 5: Loaded ${records.length} queue records (${page} page${page === 1 ? '' : 's'})...`
    });
  } while (offset);

  return records;
}

async function patchListingRecordFields(airtableService, tableId, recordId, fields = {}) {
  const keys = Object.keys(fields || {});
  if (!tableId || !recordId || keys.length === 0) return;
  await airtableService.request('PATCH', `/${encodeURIComponent(tableId)}`, {
    data: {
      records: [{ id: recordId, fields }],
      typecast: true
    }
  });
}

async function cleanupPublishedBatches({
  airtableService,
  listingsTableId,
  batchTableId,
  batchLinkField,
  batchIds = []
}) {
  const uniqueBatchIds = Array.from(
    new Set((Array.isArray(batchIds) ? batchIds : []).map(id => normalizeText(id)).filter(Boolean))
  );
  const result = {
    checked: uniqueBatchIds.length,
    deleted: 0,
    retained: 0,
    errors: []
  };

  if (!airtableService || !listingsTableId || !batchTableId || !batchLinkField || uniqueBatchIds.length === 0) {
    return result;
  }

  const remainingByBatch = new Set();
  const remainingRows = await airtableService.fetchAllRecords(listingsTableId, [batchLinkField]);
  for (const row of remainingRows) {
    const links = extractLinkedRecordIds(row?.fields?.[batchLinkField]);
    for (const batchId of links) {
      if (uniqueBatchIds.includes(batchId)) {
        remainingByBatch.add(batchId);
      }
    }
  }

  for (const batchId of uniqueBatchIds) {
    if (remainingByBatch.has(batchId)) {
      result.retained += 1;
      continue;
    }
    try {
      await airtableService.deleteRecord(batchTableId, batchId);
      result.deleted += 1;
    } catch (error) {
      const detail =
        error?.response?.data?.error?.message ||
        error?.response?.data?.error ||
        error?.message ||
        String(error);
      result.errors.push(`batch_delete_failed batch='${batchId}': ${detail}`);
    }
  }

  return result;
}

async function loadBatchApprovalContext(airtableService, schemaService, schema, options = {}) {
  const enforceBatchApproval = parseBoolean(
    options.phase5EnforceBatchApproval ?? process.env.PHASE5_ENFORCE_BATCH_APPROVAL ?? 'true',
    true
  );
  const batchTableName = normalizeText(options.phase5BatchesTable || schema.batchTableName || 'Listing Batches');
  const batchStatusFieldName = normalizeText(options.phase5BatchStatusFieldName || schema.batchStatusFieldName || 'Batch Status');
  const batchApprovedValue = normalizeText(options.phase5BatchApprovedValue || schema.batchApprovedValue || 'Approved') || 'Approved';
  const configuredBatchLinkField = normalizeText(
    options.phase5BatchLinkFieldName || schema.batchLinkField || schema.groupField || ''
  );

  if (!enforceBatchApproval) {
    return {
      enforceBatchApproval,
      batchLinkField: configuredBatchLinkField,
      approvedBatchIds: new Set(),
      totalBatches: 0,
      approvedBatches: 0,
      batchTableId: '',
      batchTableName,
      batchStatusFieldName,
      batchApprovedValue
    };
  }

  const tables = await schemaService.listTables();
  const batchTable = (tables || []).find(t => normalizeText(t?.name).toLowerCase() === batchTableName.toLowerCase());
  if (!batchTable?.id) {
    throw new Error(`Phase 5 requires batch table '${batchTableName}' but it was not found.`);
  }
  const listingTable = (tables || []).find(t => normalizeText(t?.id) === normalizeText(schema.tableId));
  const detectedBatchLinkField = detectLinkedRecordField(listingTable?.fields || [], batchTable.id, [
    configuredBatchLinkField,
    'Listing Batches',
    'Listing Batch',
    'Batch',
    'Batch Link'
  ]);
  const batchLinkField = detectedBatchLinkField || configuredBatchLinkField;
  if (!batchLinkField) {
    throw new Error('Phase 5 requires a batch link field on listings table (e.g., Listing Batches link).');
  }

  const rows = await airtableService.fetchAllRecords(batchTable.id, [batchStatusFieldName]);
  const approvedBatchIds = new Set();
  for (const row of rows) {
    const value = row?.fields?.[batchStatusFieldName];
    if (normalizeTextOrComparable(value).toLowerCase() === batchApprovedValue.toLowerCase()) {
      approvedBatchIds.add(normalizeText(row?.id));
    }
  }

  return {
    enforceBatchApproval,
    batchTableId: batchTable.id,
    batchLinkField,
    approvedBatchIds,
    totalBatches: rows.length,
    approvedBatches: approvedBatchIds.size,
    batchTableName,
    batchStatusFieldName,
    batchApprovedValue
  };
}

function buildLogRow(record = {}, schema = {}, publishState = {}) {
  const fields = record?.fields || {};
  const ipn = firstNonEmptyField(fields, [schema.ipnField, 'IPN', 'Inventory Number', 'IP']);
  const batchLinks = extractLinkedRecordIds(fields[schema.batchLinkField || '']);
  const batchId = batchLinks[0] || normalizeText(fields[schema.groupField || '']);
  const itemId = normalizeEbayItemId(
    firstNonEmptyField(fields, [schema.itemIdField, 'Item ID', 'ItemID', 'eBay Item ID', 'Ebay Item ID'])
  );
  const categoryId = firstNonEmptyField(fields, [schema.categoryIdField, 'eBay Category ID']);
  const categoryName = firstNonEmptyField(fields, ['Category Name', 'Category']);
  const storeCategory = firstNonEmptyField(fields, ['eBay Store Category', 'Store Category', 'c: partshunter203 ebay MOTORS Store Category']);
  const aiTitle = firstNonEmptyField(fields, [
    schema.titleField,
    'Item Title',
    'AI Optimized Title',
    'Product Title(New)',
    'Product Title'
  ]);
  const quantity = firstNonEmptyField(fields, ['Quantity', 'AvailableQuantity']);
  const price = firstNonEmptyField(fields, ['Price', 'Start Price', 'Current Price']);
  const publishedAtIso = normalizeText(publishState.publishedAt || new Date().toISOString());
  const publishRunId = normalizeText(publishState.publishRunId || '');
  const payloadHash = normalizeText(publishState.payloadHash || '');

  return [
    publishedAtIso,
    batchId,
    ipn,
    getIpnPrefix(fields, [schema.ipnField, 'IPN', 'Inventory Number', 'IP']),
    itemId,
    categoryId,
    categoryName,
    storeCategory,
    aiTitle,
    quantity,
    price,
    normalizeText(record?.id),
    publishRunId,
    payloadHash
  ];
}

function passesRequiredFieldGate(fields = {}, schema = {}, options = {}) {
  const categoryIdField = normalizeText(options.phase5RequiredCategoryIdFieldName || schema.categoryIdField || '');
  const titleField = normalizeText(options.phase5RequiredTitleFieldName || schema.titleField || '');
  const descriptionField = normalizeText(options.phase5RequiredDescriptionFieldName || schema.descriptionField || '');
  const itemSpecificsField = normalizeText(options.phase5RequiredItemSpecificsFieldName || schema.itemSpecificsField || '');
  const requiredItemSpecificNames = parseCsvList(options.phase5RequiredItemSpecificFieldNames || '');
  const blockedField = normalizeText(options.phase5BlockedFieldName || schema.blockedField || '');
  const exceptionField = normalizeText(options.phase5ClickupExceptionFieldName || schema.exceptionField || '');
  const resolvedExceptionValues = parseCsvList(
    options.phase5ClickupResolvedValues || process.env.PHASE5_CLICKUP_RESOLVED_VALUES || 'resolved,done,closed,complete'
  );

  const sku = firstNonEmptyField(fields, ['SKU', 'Sku', 'sku']);
  if (!sku) return { ok: false, reason: 'missing_sku' };
  if (categoryIdField && !normalizeTextOrComparable(fields[categoryIdField])) return { ok: false, reason: 'missing_category_id' };
  if (titleField && !normalizeTextOrComparable(fields[titleField])) return { ok: false, reason: 'missing_title' };
  if (descriptionField && !normalizeTextOrComparable(fields[descriptionField])) return { ok: false, reason: 'missing_description' };
  if (itemSpecificsField && !normalizeTextOrComparable(fields[itemSpecificsField])) return { ok: false, reason: 'missing_item_specifics' };
  for (const field of requiredItemSpecificNames) {
    if (!normalizeTextOrComparable(fields[field])) {
      return { ok: false, reason: `missing_required_item_specific:${field}` };
    }
  }
  if (blockedField && parseBoolean(fields[blockedField], false)) return { ok: false, reason: 'blocked' };
  if (exceptionField && !isExceptionResolved(fields[exceptionField], resolvedExceptionValues)) {
    return { ok: false, reason: 'unresolved_clickup_exception' };
  }
  return { ok: true, reason: '' };
}

function isManualEligibilityAllowed(value) {
  const text = normalizeTextOrComparable(value).toLowerCase();
  if (!text) return false;
  return new Set([
    'eligible',
    'publish eligible',
    'auto push eligible',
    'ready',
    'ready to publish',
    'yes',
    'true',
    '1'
  ]).has(text);
}

async function runPhase5PublishApproved(options = {}, progressCallback = () => {}) {
  const airtableToken = normalizeText(options.airtableToken || process.env.AIRTABLE_TOKEN || '');
  const airtableBaseId = normalizeText(options.airtableBaseId || process.env.AIRTABLE_BASE_ID || '');
  const listingsTableName = normalizeText(
    options.phase5ListingsTable || options.phase4DListingsTable || process.env.PHASE5_LISTINGS_TABLE || DEFAULT_LISTINGS_TABLE
  );
  const dryRun = options?.dryRun === true;
  const phase5Mode = normalizePhase5Mode(options.phase5Mode || process.env.PHASE5_MODE || 'A');
  const enforceListingApproval = parseBoolean(
    options.phase5EnforceListingApproval ?? process.env.PHASE5_ENFORCE_LISTING_APPROVAL ?? 'false',
    false
  );
  const requireApprovalField = phase5Mode === 'A' && enforceListingApproval;
  const requireEligibilityField = phase5Mode === 'B';
  const autoPushEnabled =
    String(options.phase5AutoPushEnabled ?? process.env.PHASE5_AUTOPUSH_ENABLED ?? 'false').trim().toLowerCase() === 'true';

  if (!airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (!airtableBaseId) throw new Error('Missing AIRTABLE_BASE_ID.');
  if (phase5Mode === 'B' && !autoPushEnabled) {
    throw new Error('Phase 5 Option B is disabled. Enable phase5AutoPushEnabled before scheduled auto-push.');
  }

  const summary = {
    dryRun,
    phase5Mode,
    modeLabel: getModeLabel(phase5Mode),
    autoPushEnabled,
    listingApprovalEnforced: enforceListingApproval,
    ebayEnvironment: normalizeText(options.phase5EbayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox')
      .toLowerCase() === 'production' ? 'production' : 'sandbox',
    listingsTable: listingsTableName,
    approvalField: '',
    eligibilityField: '',
    eligibilityValues: [],
    groupField: '',
    groupValue: normalizeText(options.phase5GroupValue || ''),
    approvedFound: 0,
    publishedSuccess: 0,
    publishedFailed: 0,
    removedFromQueue: 0,
    skippedNotApproved: 0,
    skippedAlreadyPublished: 0,
    skippedMissingSku: 0,
    skippedMissingItemId: 0,
    skippedBatchNotApproved: 0,
    skippedBlocked: 0,
    skippedMissingRequired: 0,
    skippedUnresolvedException: 0,
    loggedToSheets: 0,
    loggingPending: 0,
    logRetryOnlyCount: 0,
    batchesCheckedForCleanup: 0,
    batchesDeleted: 0,
    batchesRetainedWithRemainingItems: 0,
    batchTable: '',
    batchStatusField: '',
    batchApprovedValue: '',
    approvedBatchCount: 0,
    totalBatchCount: 0,
    errors: [],
    sampleSkips: [],
    samplePublished: [],
    schemaCsvPath: ''
  };

  emitProgress(progressCallback, {
    stage: 'phase5_load_schema',
    percent: 5,
    counts: summary,
    message: `Phase 5: Resolving schema for '${listingsTableName}'...`
  });

  const airtableService = new AirtableService({ token: airtableToken, baseId: airtableBaseId });
  const schemaService = new AirtableSchemaService({ token: airtableToken, baseId: airtableBaseId });
  const approvalService = new Phase5ApprovalService({
    listingsTableName,
    approvalFieldName: options.phase5ApprovalFieldName,
    groupFieldName: options.phase5GroupFieldName,
    groupValue: options.phase5GroupValue,
    autoPushEligibilityFieldName: options.phase5AutoPushEligibilityFieldName,
    autoPushEligibilityValues: options.phase5AutoPushEligibilityValues,
    schemaCsvPath: options.phase5SchemaCsvPath,
    batchTableName: options.phase5BatchesTable,
    batchStatusFieldName: options.phase5BatchStatusFieldName,
    batchApprovedValue: options.phase5BatchApprovedValue,
    requiredCategoryIdFieldName: options.phase5RequiredCategoryIdFieldName,
    requiredTitleFieldName: options.phase5RequiredTitleFieldName,
    requiredDescriptionFieldName: options.phase5RequiredDescriptionFieldName,
    requiredItemSpecificsFieldName: options.phase5RequiredItemSpecificsFieldName,
    blockedFieldName: options.phase5BlockedFieldName,
    exceptionFieldName: options.phase5ClickupExceptionFieldName,
    publishStatusFieldName: options.phase5PublishStatusFieldName,
    payloadHashFieldName: options.phase5PayloadHashFieldName,
    publishedAtFieldName: options.phase5PublishedAtFieldName,
    publishRunIdFieldName: options.phase5PublishRunIdFieldName
  });
  const publishService = new Phase5EbayPublishService({
    publishApiUrl: options.phase5EbayPublishApiUrl || options.ebayPublishApiUrl || process.env.EBAY_PUBLISH_API_URL,
    publishApiKey: options.phase5EbayPublishApiKey || options.ebayPublishApiKey || process.env.EBAY_PUBLISH_API_KEY,
    ebayEnvironment: options.phase5EbayEnvironment || process.env.EBAY_ENVIRONMENT || 'sandbox',
    ebayClientId: options.phase5EbayClientId || process.env.EBAY_CLIENT_ID || '',
    ebayDevId: options.phase5EbayDevId || process.env.EBAY_DEV_ID || '',
    ebayClientSecret: options.phase5EbayClientSecret || process.env.EBAY_CLIENT_SECRET || '',
    ebayRuName: options.phase5EbayRuName || process.env.EBAY_RUNAME || '',
    ebayUserAccessToken: options.phase5EbayUserAccessToken || process.env.EBAY_USER_ACCESS_TOKEN || '',
    ebayRefreshToken: options.phase5EbayRefreshToken || process.env.EBAY_REFRESH_TOKEN || '',
    ebayRefreshScope: options.phase5EbayRefreshScope || process.env.EBAY_REFRESH_SCOPE || '',
    ebayUserAccessTokenIssuedAt:
      options.phase5EbayUserAccessTokenIssuedAt || process.env.EBAY_USER_ACCESS_TOKEN_ISSUED_AT || '',
    allowProductionPublish:
      typeof options.phase5AllowProductionPublish !== 'undefined'
        ? options.phase5AllowProductionPublish
        : process.env.PHASE5_ALLOW_PRODUCTION_PUBLISH
  });
  const publishLogService = new Phase5PublishLogService({
    enabled: options.phase5SheetsLogEnabled ?? process.env.PHASE5_SHEETS_LOG_ENABLED ?? 'false',
    spreadsheetId: options.phase5SheetsLogSpreadsheetId || process.env.PHASE5_SHEETS_LOG_SPREADSHEET_ID || '',
    tabName: options.phase5SheetsLogTabName || process.env.PHASE5_SHEETS_LOG_TAB || 'Log',
    authContext: options.phase5SheetsLogAuthContext || process.env.PHASE5_SHEETS_LOG_AUTH_CONTEXT || 'inventory'
  });
  if (!dryRun && !publishLogService.isConfigured()) {
    throw new Error(
      'Phase 5 publish log is required. Enable phase5SheetsLogEnabled and set phase5SheetsLogSpreadsheetId before publishing.'
    );
  }

  const schema = await approvalService.resolveTableSchema(schemaService, { requireApprovalField, requireEligibilityField });
  summary.approvalField = schema.approvalField;
  summary.eligibilityField = schema.eligibilityField || '';
  summary.eligibilityValues = Array.isArray(schema.eligibilityValues) ? schema.eligibilityValues : [];
  summary.groupField = schema.groupField;
  summary.schemaCsvPath = schema.schemaCsvPath || '';

  const batchContext = await loadBatchApprovalContext(airtableService, schemaService, schema, options);
  const batchSchemaCheck = await validateBatchGovernanceSchema({
    ...options,
    airtableToken,
    airtableBaseId,
    phase5ListingsTable: listingsTableName
  });
  if (!batchSchemaCheck.ok) {
    throw new Error(batchSchemaCheck.message || 'Batch governance schema validation failed.');
  }
  summary.batchTable = batchContext.batchTableName;
  summary.batchStatusField = batchContext.batchStatusFieldName;
  summary.batchApprovedValue = batchContext.batchApprovedValue;
  summary.approvedBatchCount = batchContext.approvedBatches;
  summary.totalBatchCount = batchContext.totalBatches;

  emitProgress(progressCallback, {
    stage: 'phase5_load_queue',
    percent: 15,
    counts: summary,
    message: `Phase 5: Loading queue records from '${schema.tableName}'...`
  });

  const rows = await loadQueueRecordsWithProgress(airtableService, schema.tableId, progressCallback, summary);
  const linkedTestBatchRecordIds = new Set(
    parseRecordIdList(options.phase5TestBatchRecordIds || options.phase5TestBatchRecordId || options.batchRecordId || '')
  );
  const queueRows =
    linkedTestBatchRecordIds.size === 0
      ? rows
      : rows.filter(row => {
          const fields = row?.fields || {};
          const linkedBatchIds = extractLinkedRecordIds(fields[batchContext.batchLinkField]);
          return linkedBatchIds.some(id => linkedTestBatchRecordIds.has(normalizeText(id)));
        });
  if (linkedTestBatchRecordIds.size > 0) {
    const skipped = Math.max(0, rows.length - queueRows.length);
    if (skipped > 0 && summary.sampleSkips.length < 20) {
      summary.sampleSkips.push(
        `skip=test_batch_filter expected_any_of='${Array.from(linkedTestBatchRecordIds).join(',')}' skipped='${skipped}'`
      );
    }
    emitProgress(progressCallback, {
      stage: 'phase5_load_queue',
      percent: 24,
      counts: summary,
      message: `Phase 5: Applied temporary test batch filter; retained ${queueRows.length}/${rows.length} queue records.`
    });
  }
  const eligible =
    phase5Mode === 'B'
      ? approvalService.filterAutoPushEligibleRecords(queueRows, schema)
      : enforceListingApproval
        ? approvalService.filterApprovedRecords(queueRows, schema)
        : approvalService.filterQueueRecords(queueRows, schema);

  const approvedRecords = eligible.approved || [];
  const governanceEligible = [];
  const pendingLogValue = normalizeText(options.phase5PublishedLogPendingValue || 'Published (Log Pending)') || 'Published (Log Pending)';

  for (const row of approvedRecords) {
    const fields = row?.fields || {};
    const recordId = normalizeText(row?.id);
    const linkedBatchIds = extractLinkedRecordIds(fields[batchContext.batchLinkField]);

    if (
      batchContext.enforceBatchApproval &&
      (linkedBatchIds.length === 0 || !linkedBatchIds.some(id => batchContext.approvedBatchIds.has(id)))
    ) {
      summary.skippedBatchNotApproved += 1;
      if (summary.sampleSkips.length < 20) summary.sampleSkips.push(`skip=batch_not_approved record='${recordId}'`);
      continue;
    }

    if (phase5Mode === 'A' && schema.eligibilityField && !isManualEligibilityAllowed(fields[schema.eligibilityField])) {
      summary.skippedMissingRequired += 1;
      if (summary.sampleSkips.length < 20) {
        summary.sampleSkips.push(
          `skip=not_eligible record='${recordId}' field='${schema.eligibilityField}' value='${normalizeTextOrComparable(
            fields[schema.eligibilityField]
          )}'`
        );
      }
      continue;
    }

    const gate = passesRequiredFieldGate(fields, schema, options);
    if (!gate.ok) {
      if (gate.reason === 'blocked') summary.skippedBlocked += 1;
      else if (gate.reason === 'unresolved_clickup_exception') summary.skippedUnresolvedException += 1;
      else if (gate.reason === 'missing_sku') summary.skippedMissingSku += 1;
      else summary.skippedMissingRequired += 1;
      if (summary.sampleSkips.length < 20) summary.sampleSkips.push(`skip=${gate.reason} record='${recordId}'`);
      continue;
    }

    governanceEligible.push(row);
  }

  summary.approvedFound = governanceEligible.length;
  summary.skippedNotApproved = Number(eligible.skippedNotApproved || 0);
  const originalSampleSkips = Array.isArray(eligible.sampleSkips) ? eligible.sampleSkips.slice(0, 20) : [];
  for (const skip of originalSampleSkips) {
    if (summary.sampleSkips.length >= 20) break;
    summary.sampleSkips.push(skip);
  }

  const publishedIdentitySet = parseIdentitySet(options.phase5PublishedIdentities || []);
  const publishRunId = normalizeText(options.phase5PublishRunId || new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14));
  const touchedBatchIdsForCleanup = new Set();

  emitProgress(progressCallback, {
    stage: 'phase5_publish',
    percent: 25,
    counts: summary,
    message:
      phase5Mode === 'B'
        ? `Phase 5: Scheduled auto-push publishing (${governanceEligible.length})...`
        : `Phase 5: Publishing approved listings (${governanceEligible.length})...`
  });

  for (let i = 0; i < governanceEligible.length; i += 1) {
    const record = governanceEligible[i];
    const recordId = normalizeText(record?.id);
    const identity = approvalService.buildRecordIdentity(record, schema);
    const recordFields = record?.fields || {};
    const itemId = normalizeText(schema?.itemIdField ? recordFields[schema.itemIdField] : '');
    const sku = firstNonEmptyField(recordFields, ['SKU', 'Sku', 'sku']);
    const linkedBatchIds = extractLinkedRecordIds(recordFields[batchContext.batchLinkField]);

    if (identity && publishedIdentitySet.has(identity)) {
      summary.skippedAlreadyPublished += 1;
      if (!dryRun) {
        try {
          await airtableService.deleteRecord(schema.tableId, recordId);
          summary.removedFromQueue += 1;
          for (const batchId of linkedBatchIds) {
            touchedBatchIdsForCleanup.add(batchId);
          }
        } catch (error) {
          const detail =
            error?.response?.data?.error?.message ||
            error?.response?.data?.error ||
            error?.message ||
            String(error);
          summary.errors.push(`delete_reintroduced_failed record='${recordId}' identity='${identity}': ${detail}`);
        }
      }
      emitProgress(progressCallback, {
        stage: 'phase5_publish',
        percent: Math.min(95, 25 + Math.floor(((i + 1) / Math.max(1, governanceEligible.length)) * 70)),
        counts: summary,
        message:
          `Phase 5: Publishing ${i + 1}/${governanceEligible.length} ` +
          `(success=${summary.publishedSuccess}, failed=${summary.publishedFailed}, logged=${summary.loggedToSheets}, removed=${summary.removedFromQueue})`
      });
      continue;
    }

    if (!sku) {
      summary.skippedMissingSku += 1;
      summary.skippedMissingItemId += 1;
      if (summary.sampleSkips.length < 20) {
        summary.sampleSkips.push(`skip=missing_sku record='${recordId}'`);
      }
      emitProgress(progressCallback, {
        stage: 'phase5_publish',
        percent: Math.min(95, 25 + Math.floor(((i + 1) / Math.max(1, governanceEligible.length)) * 70)),
        counts: summary,
        message:
          `Phase 5: Publishing ${i + 1}/${governanceEligible.length} ` +
          `(success=${summary.publishedSuccess}, failed=${summary.publishedFailed}, logged=${summary.loggedToSheets}, removed=${summary.removedFromQueue})`
      });
      continue;
    }

    const payloadHash = buildListingPayloadHash(recordFields, {
      categoryIdField: options.phase5RequiredCategoryIdFieldName || schema.categoryIdField || 'eBay Category ID',
      titleField: options.phase5RequiredTitleFieldName || schema.titleField || 'Item Title',
      descriptionField: options.phase5RequiredDescriptionFieldName || schema.descriptionField || 'Item Description',
      itemSpecificsField: options.phase5RequiredItemSpecificsFieldName || schema.itemSpecificsField || 'Item Specifics',
      quantityField: options.phase5QuantityFieldName || 'Quantity',
      priceField: options.phase5PriceFieldName || 'Price',
      includeFieldNames: options.phase5PayloadHashFields || ''
    });

    const currentPublishStatus = normalizeTextOrComparable(schema.publishStatusField ? recordFields[schema.publishStatusField] : '');
    const isLogRetryOnly = schema.publishStatusField && currentPublishStatus.toLowerCase() === pendingLogValue.toLowerCase();

    try {
      let publishSucceeded = false;
      let publishedAt = normalizeTextOrComparable(schema.publishedAtField ? recordFields[schema.publishedAtField] : '');
      if (!publishedAt) publishedAt = new Date().toISOString();

      if (isLogRetryOnly) {
        summary.logRetryOnlyCount += 1;
      } else {
        const publishResult = await publishService.publishRecord(record, schema, { dryRun });
        if (publishResult?.success) {
          summary.publishedSuccess += 1;
          publishSucceeded = true;
          const op = normalizeText(publishResult?.operation || '');
          const ack = normalizeText(publishResult?.response?.ack || '');
          const messages = Array.isArray(publishResult?.response?.messages)
            ? publishResult.response.messages.map(value => normalizeText(value)).filter(Boolean)
            : [];
          if (messages.length > 0 && summary.errors.length < 200) {
            summary.errors.push(
              `publish_warning record='${recordId}' sku='${sku}' op='${op || 'unknown'}' ack='${ack || 'unknown'}': ${messages.join(' | ')}`
            );
          }
          if (summary.samplePublished.length < 20) {
            summary.samplePublished.push(
              `publish_result record='${recordId}' sku='${sku}' op='${op || 'unknown'}' ack='${ack || 'unknown'}'`
            );
          }
        } else {
          summary.publishedFailed += 1;
          summary.errors.push(`publish_failed record='${recordId}' unknown_failure`);
        }
      }

      if ((publishSucceeded || isLogRetryOnly) && !dryRun) {
        const logRow = buildLogRow(record, schema, { publishedAt, publishRunId, payloadHash });
        try {
          const logResult = await publishLogService.appendLogRow(logRow);
          summary.loggedToSheets += 1;
          if (summary.samplePublished.length < 20) {
            const logRange = normalizeText(logResult?.updates?.updatedRange || '');
            const logTarget = `${publishLogService.spreadsheetId || 'unknown'}:${publishLogService.tabName || 'Log'}`;
            summary.samplePublished.push(
              `publish_log_written record='${recordId}' target='${logTarget}' range='${logRange || 'n/a'}'`
            );
          }

          if (schema.publishStatusField || schema.payloadHashField || schema.publishedAtField || schema.publishRunIdField) {
            await patchListingRecordFields(airtableService, schema.tableId, recordId, {
              ...(schema.publishStatusField ? { [schema.publishStatusField]: 'Published' } : {}),
              ...(schema.payloadHashField ? { [schema.payloadHashField]: payloadHash } : {}),
              ...(schema.publishedAtField ? { [schema.publishedAtField]: publishedAt } : {}),
              ...(schema.publishRunIdField ? { [schema.publishRunIdField]: publishRunId } : {})
            });
          }

          await airtableService.deleteRecord(schema.tableId, recordId);
          summary.removedFromQueue += 1;
          for (const batchId of linkedBatchIds) {
            touchedBatchIdsForCleanup.add(batchId);
          }

        } catch (appendError) {
          summary.loggingPending += 1;
          const appendDetail =
            appendError?.response?.data?.error?.message ||
            appendError?.response?.data?.error ||
            appendError?.message ||
            String(appendError);
          summary.errors.push(`publish_log_failed record='${recordId}': ${appendDetail}`);

          if (schema.publishStatusField) {
            await patchListingRecordFields(airtableService, schema.tableId, recordId, {
              [schema.publishStatusField]: pendingLogValue,
              ...(schema.payloadHashField ? { [schema.payloadHashField]: payloadHash } : {}),
              ...(schema.publishedAtField ? { [schema.publishedAtField]: publishedAt } : {}),
              ...(schema.publishRunIdField ? { [schema.publishRunIdField]: publishRunId } : {})
            });
          }
        }
      }

      if ((publishSucceeded || isLogRetryOnly) && summary.samplePublished.length < 20) {
        summary.samplePublished.push(
          `${isLogRetryOnly ? 'log_retry' : 'published'} record='${recordId}' sku='${sku}' itemId='${itemId}' hash='${payloadHash}'`
        );
      }
    } catch (error) {
      summary.publishedFailed += 1;
      const detail =
        error?.response?.data?.error?.message ||
        error?.response?.data?.error ||
        error?.message ||
        String(error);
      summary.errors.push(`publish_failed record='${recordId}': ${detail}`);
    }

    emitProgress(progressCallback, {
      stage: 'phase5_publish',
      percent: Math.min(95, 25 + Math.floor(((i + 1) / Math.max(1, governanceEligible.length)) * 70)),
      counts: summary,
      message:
        `Phase 5: Publishing ${i + 1}/${governanceEligible.length} ` +
        `(success=${summary.publishedSuccess}, failed=${summary.publishedFailed}, logged=${summary.loggedToSheets}, removed=${summary.removedFromQueue})`
    });
  }

  if (summary.errors.length > 200) {
    summary.errors = summary.errors.slice(0, 200);
  }

  if (!dryRun && touchedBatchIdsForCleanup.size > 0) {
    emitProgress(progressCallback, {
      stage: 'phase5_batch_cleanup',
      percent: 96,
      counts: summary,
      message: `Phase 5: Checking ${touchedBatchIdsForCleanup.size} affected batch(es) for cleanup...`
    });

    const cleanup = await cleanupPublishedBatches({
      airtableService,
      listingsTableId: schema.tableId,
      batchTableId: batchContext.batchTableId,
      batchLinkField: batchContext.batchLinkField,
      batchIds: Array.from(touchedBatchIdsForCleanup)
    });
    summary.batchesCheckedForCleanup = cleanup.checked;
    summary.batchesDeleted = cleanup.deleted;
    summary.batchesRetainedWithRemainingItems = cleanup.retained;
    if (cleanup.errors.length > 0) {
      summary.errors.push(...cleanup.errors);
    }
  }

  const result = {
    ...summary
  };

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: result,
    message: `Phase 5 completed (${dryRun ? 'dry run' : 'write run'}).`
  });

  return result;
}

module.exports = {
  runPhase5PublishApproved
};
