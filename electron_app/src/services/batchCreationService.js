const AirtableService = require('./airtableService');
const AirtableSchemaService = require('./airtableSchemaService');
const { normalizeText, normalizeComparableValue, extractLinkedRecordIds } = require('./phase5GovernanceService');

let runLock = false;

function normalizeTextOrComparable(value) {
  return normalizeText(normalizeComparableValue(value));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, options = {}) {
  const maxAttempts = Number(options.maxAttempts || 3);
  const baseDelayMs = Number(options.baseDelayMs || 400);
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      const retryable = status === 429 || status >= 500 || !status;
      if (!retryable || attempt >= maxAttempts) throw error;
      const waitMs = baseDelayMs * (2 ** (attempt - 1));
      await sleep(waitMs);
    }
  }
  throw new Error('Unexpected retry loop exit.');
}

function chunkArray(items = [], size = 10) {
  const out = [];
  const safe = Math.max(1, Number(size || 10));
  for (let i = 0; i < items.length; i += safe) {
    out.push(items.slice(i, i + safe));
  }
  return out;
}

function formatAirtableError(error) {
  const status = error?.response?.status;
  const detail =
    error?.response?.data?.error?.message ||
    error?.response?.data?.error ||
    error?.message ||
    String(error);
  return status ? `HTTP ${status}: ${detail}` : String(detail);
}

function detectFieldByName(fieldNames = [], preferred = []) {
  const map = new Map((fieldNames || []).map(name => [normalizeText(name).toLowerCase(), normalizeText(name)]));
  for (const candidate of preferred) {
    const key = normalizeText(candidate).toLowerCase();
    if (map.has(key)) return map.get(key);
  }
  return '';
}

async function createFieldWithFallback(schemaService, tableId = '', payloadVariants = []) {
  let lastError = null;
  for (const payload of payloadVariants) {
    try {
      const created = await schemaService.createField(tableId, payload);
      return created;
    } catch (error) {
      lastError = error;
      const status = Number(error?.response?.status || 0);
      if (status !== 422) throw error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function ensureBatchTableExists(schemaService, listingsTable = {}, tables = [], options = {}) {
  const batchTableName = normalizeText(options.phase5BatchesTable || process.env.PHASE5_BATCHES_TABLE || 'Listing Batches');
  const batchStatusField = normalizeText(options.phase5BatchStatusFieldName || process.env.PHASE5_BATCH_STATUS_FIELD || 'Batch Status');
  const linkedListingsTableId = normalizeText(listingsTable?.id || '');
  if (!linkedListingsTableId) {
    throw new Error('Cannot create batch table because listings table id is missing.');
  }

  let batchTable = (tables || []).find(t => normalizeText(t?.name).toLowerCase() === batchTableName.toLowerCase());
  if (!batchTable?.id) {
    batchTable = await schemaService.createTable({
      name: batchTableName,
      fields: [{ name: 'Batch ID', type: 'singleLineText' }]
    });
  }

  const tableId = normalizeText(batchTable?.id || '');
  if (!tableId) throw new Error(`Failed to create or resolve batch table '${batchTableName}'.`);
  const existing = new Set((batchTable?.fields || []).map(f => normalizeText(f?.name)).filter(Boolean));

  if (!existing.has(batchStatusField)) {
    await createFieldWithFallback(schemaService, tableId, [
      {
        name: batchStatusField,
        type: 'singleSelect',
        options: {
          choices: [
            { name: 'Building' },
            { name: 'Ready' },
            { name: 'Approved' },
            { name: 'Hold' }
          ]
        }
      },
      { name: batchStatusField, type: 'singleLineText' }
    ]);
    existing.add(batchStatusField);
  }

  const numberFields = ['Total Items', 'Eligible Items Count', 'Blocked Items Count', 'Exception Items Count'];
  for (const fieldName of numberFields) {
    if (existing.has(fieldName)) continue;
    await createFieldWithFallback(schemaService, tableId, [{ name: fieldName, type: 'number' }]);
    existing.add(fieldName);
  }

  if (!existing.has('Items')) {
    await createFieldWithFallback(schemaService, tableId, [
      {
        name: 'Items',
        type: 'multipleRecordLinks',
        options: { linkedTableId: linkedListingsTableId }
      },
      {
        name: 'Items',
        type: 'multipleRecordLinks',
        options: { linkedTableId: linkedListingsTableId, prefersSingleRecordLink: false }
      },
      {
        name: 'Items',
        type: 'multipleRecordLinks',
        options: { linkedTableId: linkedListingsTableId, isReversed: false }
      }
    ]);
    existing.add('Items');
  }

  return {
    id: tableId,
    name: batchTableName
  };
}

async function ensureListingsBatchLinkField(schemaService, listingsTable = {}, batchTableId = '', preferredFieldName = '') {
  const listingsTableId = normalizeText(listingsTable?.id || '');
  if (!listingsTableId || !batchTableId) return '';
  const fieldName = normalizeText(preferredFieldName || 'Listing Batches') || 'Listing Batches';
  const created = await createFieldWithFallback(schemaService, listingsTableId, [
    {
      name: fieldName,
      type: 'multipleRecordLinks',
      options: { linkedTableId: batchTableId }
    },
    {
      name: fieldName,
      type: 'multipleRecordLinks',
      options: { linkedTableId: batchTableId, prefersSingleRecordLink: false }
    },
    {
      name: fieldName,
      type: 'multipleRecordLinks',
      options: { linkedTableId: batchTableId, isReversed: false }
    }
  ]);
  return normalizeText(created?.name || fieldName);
}

async function resolveTablesAndFields(schemaService, options = {}) {
  const listingsTableName = normalizeText(
    options.phase5ListingsTable || options.phase4DListingsTable || process.env.PHASE5_LISTINGS_TABLE || 'eBay Listings (API) (Mock)'
  );
  const batchTableName = normalizeText(options.phase5BatchesTable || process.env.PHASE5_BATCHES_TABLE || 'Listing Batches');
  const batchStatusField = normalizeText(options.phase5BatchStatusFieldName || process.env.PHASE5_BATCH_STATUS_FIELD || 'Batch Status');
  const batchLinkFieldPreferred = normalizeText(options.phase5BatchLinkFieldName || process.env.PHASE5_BATCH_LINK_FIELD || 'Listing Batches');
  const publishStatusFieldPreferred = normalizeText(options.phase5PublishStatusFieldName || process.env.PHASE5_PUBLISH_STATUS_FIELD || 'Publish Status');
  const createdAtFieldPreferred = normalizeText(options.phase5BatchCreatedAtFieldName || process.env.PHASE5_BATCH_CREATED_AT_FIELD || 'Created At');
  const runIdFieldPreferred = normalizeText(options.phase5BatchRunIdFieldName || process.env.PHASE5_BATCH_RUN_ID_FIELD || 'Run ID');
  const createdBySystemFieldPreferred = normalizeText(
    options.phase5BatchCreatedBySystemFieldName || process.env.PHASE5_BATCH_CREATED_BY_SYSTEM_FIELD || 'Created By System'
  );

  let tables = await schemaService.listTables();
  const listingsTable = (tables || []).find(t => normalizeText(t?.name).toLowerCase() === listingsTableName.toLowerCase());
  if (!listingsTable?.id) throw new Error(`Listings table not found: '${listingsTableName}'.`);

  let batchesTable = (tables || []).find(t => normalizeText(t?.name).toLowerCase() === batchTableName.toLowerCase());
  if (!batchesTable?.id) {
    const created = await ensureBatchTableExists(schemaService, listingsTable, tables, options);
    tables = await schemaService.listTables();
    batchesTable = (tables || []).find(t => normalizeText(t?.id) === normalizeText(created.id));
  }
  if (!batchesTable?.id) throw new Error(`Batch table not found: '${batchTableName}'.`);

  let listingFieldNames = (listingsTable.fields || []).map(f => normalizeText(f?.name)).filter(Boolean);
  const batchFieldNames = (batchesTable.fields || []).map(f => normalizeText(f?.name)).filter(Boolean);

  let batchLinkField =
    detectFieldByName(listingFieldNames, [batchLinkFieldPreferred, 'Listing Batches', 'Batch', 'Batch Link']) || '';
  if (!batchLinkField) {
    batchLinkField = await ensureListingsBatchLinkField(
      schemaService,
      listingsTable,
      normalizeText(batchesTable.id),
      batchLinkFieldPreferred || 'Listing Batches'
    );
    tables = await schemaService.listTables();
    const refreshedListingsTable = (tables || []).find(t => normalizeText(t?.id) === normalizeText(listingsTable.id));
    listingFieldNames = (refreshedListingsTable?.fields || []).map(f => normalizeText(f?.name)).filter(Boolean);
    batchLinkField =
      detectFieldByName(listingFieldNames, [batchLinkField, batchLinkFieldPreferred, 'Listing Batches', 'Batch', 'Batch Link']) || '';
  }
  if (!batchLinkField) throw new Error(`Batch link field not found on listings table '${listingsTableName}'.`);

  const publishStatusField =
    detectFieldByName(listingFieldNames, [publishStatusFieldPreferred, 'Publish Status', 'Publishing Status']) || '';

  const batchCreatedAtField =
    detectFieldByName(batchFieldNames, [createdAtFieldPreferred, 'Created At', 'CreatedAt']) || '';
  const batchRunIdField =
    detectFieldByName(batchFieldNames, [runIdFieldPreferred, 'Run ID', 'RunId']) || '';
  const batchCreatedBySystemField =
    detectFieldByName(batchFieldNames, [createdBySystemFieldPreferred, 'Created By System']) || '';

  return {
    listingsTableId: normalizeText(listingsTable.id),
    listingsTableName: normalizeText(listingsTable.name),
    batchesTableId: normalizeText(batchesTable.id),
    batchesTableName: normalizeText(batchesTable.name),
    batchStatusField,
    batchLinkField,
    publishStatusField,
    batchCreatedAtField,
    batchRunIdField,
    batchCreatedBySystemField
  };
}

async function fetchCandidateListings(airtableService, resolved = {}, options = {}) {
  const fieldsToFetch = ['eBay Item ID', 'Record Key', resolved.batchLinkField];
  if (resolved.publishStatusField) fieldsToFetch.push(resolved.publishStatusField);
  const rows = await airtableService.fetchAllRecords(resolved.listingsTableId, Array.from(new Set(fieldsToFetch)));

  const publishedStatusValues = new Set(
    String(options.phase5PublishedStatuses || 'published,published (log pending)')
      .split(',')
      .map(v => normalizeText(v).toLowerCase())
      .filter(Boolean)
  );

  return rows.filter(row => {
    const fields = row?.fields || {};
    const links = extractLinkedRecordIds(fields[resolved.batchLinkField]);
    if (links.length > 0) return false;
    if (resolved.publishStatusField) {
      const status = normalizeTextOrComparable(fields[resolved.publishStatusField]).toLowerCase();
      if (status && publishedStatusValues.has(status)) return false;
    }
    return true;
  });
}

async function createBatchRecord(airtableService, resolved = {}, options = {}) {
  const runId = normalizeText(options.runId || new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14));
  const fields = {
    [resolved.batchStatusField]: 'Building'
  };
  if (resolved.batchCreatedAtField) fields[resolved.batchCreatedAtField] = new Date().toISOString();
  if (resolved.batchRunIdField) fields[resolved.batchRunIdField] = runId;
  if (resolved.batchCreatedBySystemField) fields[resolved.batchCreatedBySystemField] = true;

  const data = await airtableService.request('POST', `/${encodeURIComponent(resolved.batchesTableId)}`, {
    data: {
      records: [{ fields }],
      typecast: true
    }
  });
  const rec = Array.isArray(data?.records) ? data.records[0] : null;
  if (!rec?.id) throw new Error('Failed to create batch record.');
  return { batchId: normalizeText(rec.id), runId };
}

async function linkListingsToBatchInChunks(airtableService, resolved = {}, batchId = '', rows = []) {
  const attempted = Array.isArray(rows) ? rows.length : 0;
  let linked = 0;
  const failed = [];
  const updates = (rows || []).map(row => ({
    id: normalizeText(row?.id),
    fields: { [resolved.batchLinkField]: [batchId] }
  })).filter(r => r.id);

  for (const chunk of chunkArray(updates, 10)) {
    try {
      await withRetry(
        () =>
          airtableService.request('PATCH', `/${encodeURIComponent(resolved.listingsTableId)}`, {
            data: { records: chunk, typecast: true }
          }),
        { maxAttempts: 3, baseDelayMs: 450 }
      );
      linked += chunk.length;
    } catch (error) {
      // Attempt per-record retry to reduce blast radius.
      for (const record of chunk) {
        try {
          await withRetry(
            () =>
              airtableService.request('PATCH', `/${encodeURIComponent(resolved.listingsTableId)}`, {
                data: { records: [record], typecast: true }
              }),
            { maxAttempts: 3, baseDelayMs: 450 }
          );
          linked += 1;
        } catch (singleError) {
          failed.push({
            recordId: record.id,
            error: formatAirtableError(singleError)
          });
        }
      }
      if (failed.length === chunk.length) {
        // Keep original error context if full chunk failed.
        failed.push({ recordId: '', error: formatAirtableError(error) });
      }
    }
  }

  return { attempted, linked, failed };
}

async function verifyBatchLinkCount(airtableService, resolved = {}, batchId = '') {
  const escapedBatchId = String(batchId).replace(/"/g, '\\"');
  const escapedLinkField = String(resolved.batchLinkField || '').replace(/}/g, '\\}');
  const formula = `FIND("${escapedBatchId}", ARRAYJOIN({${escapedLinkField}}))`;
  try {
    const rows = await airtableService.fetchRecordsByFormula(resolved.listingsTableId, formula, [resolved.batchLinkField]);
    return Array.isArray(rows) ? rows.length : 0;
  } catch (_) {
    const allRows = await airtableService.fetchAllRecords(resolved.listingsTableId, [resolved.batchLinkField]);
    return allRows.filter(row => extractLinkedRecordIds(row?.fields?.[resolved.batchLinkField]).includes(batchId)).length;
  }
}

async function updateBatchStatus(airtableService, resolved = {}, batchId = '', status = '') {
  await airtableService.request('PATCH', `/${encodeURIComponent(resolved.batchesTableId)}`, {
    data: {
      records: [{ id: batchId, fields: { [resolved.batchStatusField]: status } }],
      typecast: true
    }
  });
}

async function createBatchFromListings(options = {}) {
  if (runLock) {
    return {
      success: true,
      batchId: null,
      attempted: 0,
      linkedRecords: 0,
      failedRecords: 0,
      status: 'NoCandidates',
      runId: '',
      message: 'Batch creation skipped: run already in progress.'
    };
  }
  runLock = true;
  try {
    const airtableToken = normalizeText(options.airtableToken || process.env.AIRTABLE_TOKEN || '');
    const airtableBaseId = normalizeText(options.airtableBaseId || process.env.AIRTABLE_BASE_ID || '');
    if (!airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
    if (!airtableBaseId) throw new Error('Missing AIRTABLE_BASE_ID.');

    const schemaService = new AirtableSchemaService({ token: airtableToken, baseId: airtableBaseId });
    const airtableService = new AirtableService({ token: airtableToken, baseId: airtableBaseId });
    const resolved = await resolveTablesAndFields(schemaService, options);

    const candidates = await fetchCandidateListings(airtableService, resolved, options);
    if (candidates.length === 0) {
      return {
        success: true,
        batchId: null,
        attempted: 0,
        linkedRecords: 0,
        failedRecords: 0,
        status: 'NoCandidates',
        runId: '',
        message: 'No listings available for batch creation.'
      };
    }

    const configuredMax = Number(options.phase5BatchMaxSize || process.env.PHASE5_BATCH_MAX_SIZE || 1000);
    const maxBatchSize = Math.max(1, Math.min(1000, Number.isFinite(configuredMax) ? configuredMax : 1000));
    const candidateChunks = chunkArray(candidates, maxBatchSize);

    const createdBatches = [];
    const allErrors = [];
    let totalAttempted = 0;
    let totalLinked = 0;
    let totalFailed = 0;
    let partialFailure = false;

    for (const candidateChunk of candidateChunks) {
      const { batchId, runId } = await createBatchRecord(airtableService, resolved, options);
      const linkResult = await linkListingsToBatchInChunks(airtableService, resolved, batchId, candidateChunk);
      const verifiedCount = await verifyBatchLinkCount(airtableService, resolved, batchId);

      const failedForBatch = linkResult.failed.length + Math.max(0, linkResult.attempted - verifiedCount);
      const allLinked = linkResult.failed.length === 0 && verifiedCount === linkResult.attempted;
      const batchStatus = allLinked ? 'Ready' : 'PartialFailure';
      if (allLinked) {
        await updateBatchStatus(airtableService, resolved, batchId, 'Ready');
      } else {
        partialFailure = true;
        if (Array.isArray(linkResult.failed) && linkResult.failed.length > 0) {
          allErrors.push(...linkResult.failed.slice(0, 100));
        }
      }

      totalAttempted += linkResult.attempted;
      totalLinked += verifiedCount;
      totalFailed += failedForBatch;
      createdBatches.push({
        batchId,
        runId,
        attempted: linkResult.attempted,
        linkedRecords: verifiedCount,
        failedRecords: failedForBatch,
        status: batchStatus
      });
    }

    const firstBatch = createdBatches[0] || null;
    const success = !partialFailure;
    const status = success ? 'Ready' : 'PartialFailure';

    return {
      success,
      batchId: firstBatch?.batchId || null,
      attempted: totalAttempted,
      linkedRecords: totalLinked,
      failedRecords: totalFailed,
      status,
      runId: firstBatch?.runId || '',
      batchesCreated: createdBatches.length,
      maxBatchSize,
      createdBatches,
      message: success
        ? `Batches created successfully. batches=${createdBatches.length}, linked=${totalLinked}, maxBatchSize=${maxBatchSize}`
        : `Batch linking incomplete. batches=${createdBatches.length}, attempted=${totalAttempted}, linked=${totalLinked}, failed=${totalFailed}`,
      errors: allErrors.slice(0, 100)
    };
  } finally {
    runLock = false;
  }
}

module.exports = {
  createBatchFromListings
};
