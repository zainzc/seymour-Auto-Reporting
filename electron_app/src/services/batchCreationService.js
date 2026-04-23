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

function detectLinkedRecordFieldNames(fields = [], linkedTableId = '') {
  const targetLinkedTableId = normalizeText(linkedTableId);
  return (Array.isArray(fields) ? fields : [])
    .filter(field => {
      if (normalizeText(field?.type) !== 'multipleRecordLinks') return false;
      const fieldLinkedTableId = normalizeText(field?.options?.linkedTableId);
      return targetLinkedTableId && fieldLinkedTableId === targetLinkedTableId;
    })
    .map(field => normalizeText(field?.name))
    .filter(Boolean);
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
  let batchTableFields = Array.isArray(batchTable?.fields) ? batchTable.fields : [];
  const existing = new Set(batchTableFields.map(f => normalizeText(f?.name)).filter(Boolean));

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

  const preferredItemsField = normalizeText(options.phase5BatchItemsFieldName || process.env.PHASE5_BATCH_ITEMS_FIELD || 'Items');
  const existingItemsLinkField =
    detectLinkedRecordField(batchTableFields, linkedListingsTableId, [preferredItemsField, 'Items']) || '';
  if (!existingItemsLinkField) {
    const createdItemsField = await createFieldWithFallback(schemaService, tableId, [
      {
        name: preferredItemsField || 'Items',
        type: 'multipleRecordLinks',
        options: { linkedTableId: linkedListingsTableId }
      },
      {
        name: preferredItemsField || 'Items',
        type: 'multipleRecordLinks',
        options: { linkedTableId: linkedListingsTableId, prefersSingleRecordLink: false }
      },
      {
        name: preferredItemsField || 'Items',
        type: 'multipleRecordLinks',
        options: { linkedTableId: linkedListingsTableId, isReversed: false }
      }
    ]);
    const createdName = normalizeText(createdItemsField?.name || preferredItemsField || 'Items');
    if (createdName) existing.add(createdName);
    batchTableFields = [...batchTableFields, ...(createdItemsField ? [createdItemsField] : [])];
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
  let listingsTable = (tables || []).find(t => normalizeText(t?.name).toLowerCase() === listingsTableName.toLowerCase());
  if (!listingsTable?.id) throw new Error(`Listings table not found: '${listingsTableName}'.`);

  // Always ensure batch table + required fields first. This can also create reciprocal
  // linked fields in listings, so we must refresh schema before resolving link fields.
  const ensuredBatch = await ensureBatchTableExists(schemaService, listingsTable, tables, options);
  tables = await schemaService.listTables();
  listingsTable =
    (tables || []).find(t => normalizeText(t?.id) === normalizeText(listingsTable.id)) ||
    (tables || []).find(t => normalizeText(t?.name).toLowerCase() === listingsTableName.toLowerCase());
  let batchesTable =
    (tables || []).find(t => normalizeText(t?.id) === normalizeText(ensuredBatch.id)) ||
    (tables || []).find(t => normalizeText(t?.name).toLowerCase() === batchTableName.toLowerCase());

  if (!listingsTable?.id) throw new Error(`Listings table not found after schema refresh: '${listingsTableName}'.`);
  if (!batchesTable?.id) throw new Error(`Batch table not found: '${batchTableName}'.`);

  let listingFields = Array.isArray(listingsTable.fields) ? listingsTable.fields : [];
  let listingFieldNames = listingFields.map(f => normalizeText(f?.name)).filter(Boolean);
  const batchFields = Array.isArray(batchesTable.fields) ? batchesTable.fields : [];
  const batchFieldNames = (batchesTable.fields || []).map(f => normalizeText(f?.name)).filter(Boolean);

  let listingBatchLinkFields = detectLinkedRecordFieldNames(listingFields, normalizeText(batchesTable.id));
  let batchLinkField =
    detectFieldByName(listingBatchLinkFields, [batchLinkFieldPreferred, 'Listing Batches', 'Batch', 'Batch Link']) ||
    listingBatchLinkFields[0] ||
    '';
  if (!batchLinkField) {
    batchLinkField = await ensureListingsBatchLinkField(
      schemaService,
      listingsTable,
      normalizeText(batchesTable.id),
      batchLinkFieldPreferred || 'Listing Batches'
    );
    tables = await schemaService.listTables();
    const refreshedListingsTable = (tables || []).find(t => normalizeText(t?.id) === normalizeText(listingsTable.id));
    listingFields = Array.isArray(refreshedListingsTable?.fields) ? refreshedListingsTable.fields : [];
    listingFieldNames = listingFields.map(f => normalizeText(f?.name)).filter(Boolean);
    listingBatchLinkFields = detectLinkedRecordFieldNames(listingFields, normalizeText(batchesTable.id));
    batchLinkField =
      detectFieldByName(listingBatchLinkFields, [batchLinkField, batchLinkFieldPreferred, 'Listing Batches', 'Batch', 'Batch Link']) ||
      listingBatchLinkFields[0] ||
      '';
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
  const batchItemsField = detectLinkedRecordField(batchFields, normalizeText(listingsTable.id), [
    options.phase5BatchItemsFieldName,
    process.env.PHASE5_BATCH_ITEMS_FIELD,
    'Items',
    listingsTableName
  ]);

  return {
    listingsTableId: normalizeText(listingsTable.id),
    listingsTableName: normalizeText(listingsTable.name),
    batchesTableId: normalizeText(batchesTable.id),
    batchesTableName: normalizeText(batchesTable.name),
    batchStatusField,
    batchLinkField,
    listingBatchLinkFields: Array.isArray(listingBatchLinkFields) ? listingBatchLinkFields : [],
    publishStatusField,
    batchItemsField,
    batchCreatedAtField,
    batchRunIdField,
    batchCreatedBySystemField
  };
}

async function fetchCandidateListings(airtableService, resolved = {}, options = {}) {
  const linkFieldNames = Array.isArray(resolved.listingBatchLinkFields) && resolved.listingBatchLinkFields.length > 0
    ? resolved.listingBatchLinkFields
    : [resolved.batchLinkField].filter(Boolean);
  const fieldsToFetch = [...linkFieldNames];
  if (resolved.publishStatusField) fieldsToFetch.push(resolved.publishStatusField);
  const rows = await airtableService.fetchAllRecords(resolved.listingsTableId, Array.from(new Set(fieldsToFetch)));

  const publishedStatusValues = new Set(
    String(options.phase5PublishedStatuses || 'published,published (log pending)')
      .split(',')
      .map(v => normalizeText(v).toLowerCase())
      .filter(Boolean)
  );

  let excludedAlreadyLinked = 0;
  let excludedAlreadyPublished = 0;
  const candidates = rows.filter(row => {
    const fields = row?.fields || {};
    const hasAnyBatchLink = linkFieldNames.some(fieldName => {
      const links = extractLinkedRecordIds(fields[fieldName]);
      return links.length > 0;
    });
    if (hasAnyBatchLink) {
      excludedAlreadyLinked += 1;
      return false;
    }
    if (resolved.publishStatusField) {
      const status = normalizeTextOrComparable(fields[resolved.publishStatusField]).toLowerCase();
      if (status && publishedStatusValues.has(status)) {
        excludedAlreadyPublished += 1;
        return false;
      }
    }
    return true;
  });

  return {
    candidates,
    diagnostics: {
      totalRows: rows.length,
      excludedAlreadyLinked,
      excludedAlreadyPublished,
      candidates: candidates.length
    }
  };
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

async function linkListingsToBatchViaBatchItemsField(airtableService, resolved = {}, batchId = '', rows = []) {
  const attempted = Array.isArray(rows) ? rows.length : 0;
  const listingIds = Array.from(
    new Set(
      (Array.isArray(rows) ? rows : [])
        .map(row => normalizeText(row?.id))
        .filter(Boolean)
    )
  );

  if (!batchId || !resolved.batchItemsField || listingIds.length === 0) {
    return { attempted, linked: 0, failed: attempted > 0 ? [{ recordId: '', error: 'Batch items link field not resolved.' }] : [] };
  }

  try {
    await withRetry(
      () =>
        airtableService.request('PATCH', `/${encodeURIComponent(resolved.batchesTableId)}`, {
          data: {
            records: [{ id: batchId, fields: { [resolved.batchItemsField]: listingIds } }],
            typecast: true
          }
        }),
      { maxAttempts: 3, baseDelayMs: 450 }
    );
    return { attempted, linked: listingIds.length, failed: [] };
  } catch (error) {
    return {
      attempted,
      linked: 0,
      failed: [{ recordId: '', error: formatAirtableError(error) }]
    };
  }
}

async function verifyBatchLinkCount(airtableService, resolved = {}, batchId = '') {
  if (resolved.batchItemsField) {
    try {
      const batchRow = await airtableService.request(
        'GET',
        `/${encodeURIComponent(resolved.batchesTableId)}/${encodeURIComponent(batchId)}`
      );
      return extractLinkedRecordIds(batchRow?.fields?.[resolved.batchItemsField]).length;
    } catch (_) {}
  }

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

    const candidateResult = await fetchCandidateListings(airtableService, resolved, options);
    const candidates = Array.isArray(candidateResult?.candidates) ? candidateResult.candidates : [];
    const diagnostics = candidateResult?.diagnostics || {};
    if (candidates.length === 0) {
      const totalRows = Number(diagnostics.totalRows || 0) || 0;
      const excludedAlreadyLinked = Number(diagnostics.excludedAlreadyLinked || 0) || 0;
      const excludedAlreadyPublished = Number(diagnostics.excludedAlreadyPublished || 0) || 0;
      return {
        success: true,
        batchId: null,
        attempted: 0,
        linkedRecords: 0,
        failedRecords: 0,
        status: 'NoCandidates',
        runId: '',
        diagnostics: {
          totalRows,
          excludedAlreadyLinked,
          excludedAlreadyPublished,
          candidates: 0
        },
        message:
          'No listings available for batch creation.' +
          ` totalRows=${totalRows}, excludedAlreadyLinked=${excludedAlreadyLinked}, excludedAlreadyPublished=${excludedAlreadyPublished}`
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
      const linkResult = resolved.batchItemsField
        ? await linkListingsToBatchViaBatchItemsField(airtableService, resolved, batchId, candidateChunk)
        : await linkListingsToBatchInChunks(airtableService, resolved, batchId, candidateChunk);
      const verifiedCount = await verifyBatchLinkCount(airtableService, resolved, batchId);

      const failedForBatch = linkResult.failed.length + Math.max(0, linkResult.attempted - verifiedCount);
      const allLinked = linkResult.failed.length === 0 && verifiedCount === linkResult.attempted;
      const batchStatus = allLinked ? 'Ready' : 'PartialFailure';
      if (allLinked) {
        await updateBatchStatus(airtableService, resolved, batchId, 'Ready');
      } else {
        await updateBatchStatus(airtableService, resolved, batchId, 'PartialFailure');
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
      diagnostics: {
        totalRows: Number(diagnostics.totalRows || 0) || 0,
        excludedAlreadyLinked: Number(diagnostics.excludedAlreadyLinked || 0) || 0,
        excludedAlreadyPublished: Number(diagnostics.excludedAlreadyPublished || 0) || 0,
        candidates: Number(diagnostics.candidates || candidates.length) || candidates.length
      },
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
