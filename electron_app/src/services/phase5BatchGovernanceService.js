const AirtableService = require('./airtableService');
const AirtableSchemaService = require('./airtableSchemaService');
const { Phase5ApprovalService, DEFAULT_LISTINGS_TABLE, normalizeText } = require('./phase5ApprovalService');
const {
  parseBoolean,
  normalizeComparableValue,
  parseCsvList,
  extractLinkedRecordIds
} = require('./phase5GovernanceService');

function normalizeTextOrComparable(value) {
  return normalizeText(normalizeComparableValue(value));
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

function isExceptionResolved(value, resolvedValues = []) {
  const resolved = normalizeValueSet(resolvedValues);
  const text = normalizeTextOrComparable(value).toLowerCase();
  if (!text) return true;
  if (resolved.size === 0) return false;
  return resolved.has(text);
}

function passCoreGate(fields = {}, schema = {}, options = {}) {
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
  const itemIdField = normalizeText(schema.itemIdField || '');

  const hasItemId = itemIdField ? !!normalizeTextOrComparable(fields[itemIdField]) : false;
  const hasCategory = categoryIdField ? !!normalizeTextOrComparable(fields[categoryIdField]) : true;
  const hasTitle = titleField ? !!normalizeTextOrComparable(fields[titleField]) : true;
  const hasDescription = descriptionField ? !!normalizeTextOrComparable(fields[descriptionField]) : true;
  const hasItemSpecifics = itemSpecificsField ? !!normalizeTextOrComparable(fields[itemSpecificsField]) : true;
  const hasRequiredSpecifics = requiredItemSpecificNames.every(name => !!normalizeTextOrComparable(fields[name]));
  const isBlocked = blockedField ? parseBoolean(fields[blockedField], false) : false;
  const hasException = exceptionField ? !isExceptionResolved(fields[exceptionField], resolvedExceptionValues) : false;

  const eligible =
    hasItemId &&
    hasCategory &&
    hasTitle &&
    hasDescription &&
    hasItemSpecifics &&
    hasRequiredSpecifics &&
    !isBlocked &&
    !hasException;

  return {
    eligible,
    isBlocked,
    hasException
  };
}

async function resolvePhase5Schema(options = {}) {
  const airtableToken = normalizeText(options.airtableToken || process.env.AIRTABLE_TOKEN || '');
  const airtableBaseId = normalizeText(options.airtableBaseId || process.env.AIRTABLE_BASE_ID || '');
  const listingsTableName = normalizeText(
    options.phase5ListingsTable || options.phase4DListingsTable || process.env.PHASE5_LISTINGS_TABLE || DEFAULT_LISTINGS_TABLE
  );
  if (!airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (!airtableBaseId) throw new Error('Missing AIRTABLE_BASE_ID.');

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
    exceptionFieldName: options.phase5ClickupExceptionFieldName
  });
  const schema = await approvalService.resolveTableSchema(schemaService, {
    requireApprovalField: false,
    requireEligibilityField: false
  });

  return {
    schema,
    airtableToken,
    airtableBaseId
  };
}

function resolveBatchSchemaFieldNames(options = {}) {
  return {
    batchIdField: normalizeText(options.phase5BatchIdFieldName || process.env.PHASE5_BATCH_ID_FIELD || 'Batch ID'),
    batchStatusField: normalizeText(options.phase5BatchStatusFieldName || process.env.PHASE5_BATCH_STATUS_FIELD || 'Batch Status'),
    itemsField: normalizeText(options.phase5BatchItemsFieldName || process.env.PHASE5_BATCH_ITEMS_FIELD || 'Items'),
    totalItemsField: normalizeText(options.phase5BatchTotalItemsFieldName || process.env.PHASE5_BATCH_TOTAL_ITEMS_FIELD || 'Total Items'),
    eligibleItemsField: normalizeText(
      options.phase5BatchEligibleItemsFieldName || process.env.PHASE5_BATCH_ELIGIBLE_ITEMS_FIELD || 'Eligible Items Count'
    ),
    blockedItemsField: normalizeText(
      options.phase5BatchBlockedItemsFieldName || process.env.PHASE5_BATCH_BLOCKED_ITEMS_FIELD || 'Blocked Items Count'
    ),
    exceptionItemsField: normalizeText(
      options.phase5BatchExceptionItemsFieldName || process.env.PHASE5_BATCH_EXCEPTION_ITEMS_FIELD || 'Exception Items Count'
    )
  };
}

async function validateBatchGovernanceSchema(options = {}) {
  const { schema, airtableToken, airtableBaseId } = await resolvePhase5Schema(options);
  const schemaService = new AirtableSchemaService({ token: airtableToken, baseId: airtableBaseId });
  const tables = await schemaService.listTables();
  const batchTableName = normalizeText(options.phase5BatchesTable || schema.batchTableName || 'Listing Batches');
  const batchTable = (tables || []).find(t => normalizeText(t?.name).toLowerCase() === batchTableName.toLowerCase());
  if (!batchTable?.id) {
    return {
      ok: false,
      batchTableName,
      missing: ['<table>'],
      message: `Batch table '${batchTableName}' not found.`
    };
  }

  const required = resolveBatchSchemaFieldNames(options);
  const names = new Set((batchTable.fields || []).map(f => normalizeText(f?.name)).filter(Boolean));
  const missing = Object.values(required).filter(name => name && !names.has(name));
  const ok = missing.length === 0;
  return {
    ok,
    batchTableName,
    missing,
    required,
    message: ok
      ? 'Batch schema is valid.'
      : `Batch schema missing required fields: ${missing.join(', ')}`
  };
}

async function getBatchSummaries(options = {}) {
  const { schema, airtableToken, airtableBaseId } = await resolvePhase5Schema(options);
  const airtableService = new AirtableService({ token: airtableToken, baseId: airtableBaseId });
  const schemaService = new AirtableSchemaService({ token: airtableToken, baseId: airtableBaseId });

  const batchTableName = normalizeText(options.phase5BatchesTable || schema.batchTableName || 'Listing Batches');
  const batchStatusField = normalizeText(options.phase5BatchStatusFieldName || schema.batchStatusFieldName || 'Batch Status');
  const batchApprovedValue = normalizeText(options.phase5BatchApprovedValue || schema.batchApprovedValue || 'Approved') || 'Approved';
  const batchLinkField = normalizeText(options.phase5BatchLinkFieldName || schema.batchLinkField || schema.groupField || '');
  if (!batchLinkField) {
    throw new Error('Batch link field is required to compute batch summaries.');
  }

  const tables = await schemaService.listTables();
  const batchTable = (tables || []).find(t => normalizeText(t?.name).toLowerCase() === batchTableName.toLowerCase());
  if (!batchTable?.id) {
    throw new Error(`Batch table '${batchTableName}' not found.`);
  }

  const batchSchemaFields = resolveBatchSchemaFieldNames(options);
  const batchRows = await airtableService.fetchAllRecords(batchTable.id, [
    batchStatusField,
    batchSchemaFields.batchIdField,
    batchSchemaFields.totalItemsField,
    batchSchemaFields.eligibleItemsField,
    batchSchemaFields.blockedItemsField,
    batchSchemaFields.exceptionItemsField
  ]);

  const byBatch = new Map();
  for (const batch of batchRows) {
    const fields = batch?.fields || {};
    byBatch.set(normalizeText(batch.id), {
      batchRecordId: normalizeText(batch.id),
      batchId: normalizeTextOrComparable(fields[batchSchemaFields.batchIdField]) || normalizeText(batch.id),
      batchStatus: normalizeTextOrComparable(fields[batchStatusField]) || '',
      isApproved: normalizeTextOrComparable(fields[batchStatusField]).toLowerCase() === batchApprovedValue.toLowerCase(),
      totalItems: Number(fields[batchSchemaFields.totalItemsField] || 0) || 0,
      eligibleItemsCount: Number(fields[batchSchemaFields.eligibleItemsField] || 0) || 0,
      blockedItemsCount: Number(fields[batchSchemaFields.blockedItemsField] || 0) || 0,
      exceptionItemsCount: Number(fields[batchSchemaFields.exceptionItemsField] || 0) || 0,
      createdTime: normalizeText(batch?.createdTime || '')
    });
  }

  // Fallback only when rollup metrics are unavailable, to preserve backward compatibility.
  const shouldFallbackRecompute = Array.from(byBatch.values()).some(
    b =>
      !Number.isFinite(Number(b.totalItems)) ||
      !Number.isFinite(Number(b.eligibleItemsCount)) ||
      !Number.isFinite(Number(b.blockedItemsCount)) ||
      !Number.isFinite(Number(b.exceptionItemsCount))
  );
  if (shouldFallbackRecompute) {
    const listingRows = await airtableService.fetchAllRecords(schema.tableId, []);
    for (const row of listingRows) {
      const fields = row?.fields || {};
      const links = extractLinkedRecordIds(fields[batchLinkField]);
      if (links.length === 0) continue;
      const gate = passCoreGate(fields, schema, options);
      for (const batchId of links) {
        const target = byBatch.get(batchId);
        if (!target) continue;
        target.totalItems += 1;
        if (gate.eligible) target.eligibleItemsCount += 1;
        if (gate.isBlocked) target.blockedItemsCount += 1;
        if (gate.hasException) target.exceptionItemsCount += 1;
      }
    }
  }

  return {
    batchTableName,
    batchStatusField,
    batchApprovedValue,
    batches: Array.from(byBatch.values())
  };
}

async function setBatchStatus(options = {}) {
  const { schema, airtableToken, airtableBaseId } = await resolvePhase5Schema(options);
  const airtableService = new AirtableService({ token: airtableToken, baseId: airtableBaseId });
  const schemaService = new AirtableSchemaService({ token: airtableToken, baseId: airtableBaseId });

  const batchTableName = normalizeText(options.phase5BatchesTable || schema.batchTableName || 'Listing Batches');
  const batchStatusField = normalizeText(options.phase5BatchStatusFieldName || schema.batchStatusFieldName || 'Batch Status');
  const batchRecordId = normalizeText(options.batchRecordId || '');
  const batchStatusValue = normalizeText(options.batchStatusValue || '');
  if (!batchRecordId) throw new Error('batchRecordId is required.');
  if (!batchStatusValue) throw new Error('batchStatusValue is required.');

  const tables = await schemaService.listTables();
  const batchTable = (tables || []).find(t => normalizeText(t?.name).toLowerCase() === batchTableName.toLowerCase());
  if (!batchTable?.id) {
    throw new Error(`Batch table '${batchTableName}' not found.`);
  }

  await airtableService.request('PATCH', `/${encodeURIComponent(batchTable.id)}`, {
    data: {
      records: [
        {
          id: batchRecordId,
          fields: {
            [batchStatusField]: batchStatusValue
          }
        }
      ],
      typecast: true
    }
  });

  return {
    success: true,
    batchRecordId,
    batchStatusField,
    batchStatusValue
  };
}

async function getBatchListings(options = {}) {
  const { schema, airtableToken, airtableBaseId } = await resolvePhase5Schema(options);
  const airtableService = new AirtableService({ token: airtableToken, baseId: airtableBaseId });
  const schemaService = new AirtableSchemaService({ token: airtableToken, baseId: airtableBaseId });
  const batchRecordId = normalizeText(options.batchRecordId || '');
  if (!batchRecordId) throw new Error('batchRecordId is required.');
  const batchTableName = normalizeText(options.phase5BatchesTable || schema.batchTableName || 'Listing Batches');
  const batchSchemaFields = resolveBatchSchemaFieldNames(options);
  const itemsField = normalizeText(batchSchemaFields.itemsField || 'Items');

  const tables = await schemaService.listTables();
  const batchTable = (tables || []).find(t => normalizeText(t?.name).toLowerCase() === batchTableName.toLowerCase());
  if (!batchTable?.id) {
    throw new Error(`Batch table '${batchTableName}' not found.`);
  }

  const batchRow = await airtableService.request(
    'GET',
    `/${encodeURIComponent(batchTable.id)}/${encodeURIComponent(batchRecordId)}`
  );
  const linkedListingIds = extractLinkedRecordIds(batchRow?.fields?.[itemsField]);
  if (linkedListingIds.length === 0) {
    return {
      batchRecordId,
      batchLinkField: itemsField,
      total: 0,
      listings: []
    };
  }

  const rows = [];
  const uniqueIds = Array.from(new Set(linkedListingIds.map(id => normalizeText(id)).filter(Boolean)));
  for (let i = 0; i < uniqueIds.length; i += 80) {
    const group = uniqueIds.slice(i, i + 80);
    const clauses = group.map(id => `RECORD_ID()='${id}'`);
    const formula = clauses.length === 1 ? clauses[0] : `OR(${clauses.join(',')})`;
    try {
      const subset = await airtableService.fetchRecordsByFormula(schema.tableId, formula, []);
      rows.push(...subset);
    } catch (_) {
      // Fallback to single-record requests for this chunk if formula is rejected.
      for (const id of group) {
        try {
          const one = await airtableService.request('GET', `/${encodeURIComponent(schema.tableId)}/${encodeURIComponent(id)}`);
          if (one?.id) rows.push(one);
        } catch (_) {}
      }
    }
  }

  const rowById = new Map(rows.map(r => [normalizeText(r?.id), r]));
  const orderedRows = uniqueIds.map(id => rowById.get(id)).filter(Boolean);

  const listingRows = orderedRows.map(row => {
    const fields = row?.fields || {};
    const gate = passCoreGate(fields, schema, options);
    return {
      recordId: normalizeText(row?.id),
      createdTime: normalizeText(row?.createdTime || ''),
      recordKey:
        normalizeTextOrComparable(fields['eBay Item ID']) ||
        normalizeTextOrComparable(fields['Ebay Item ID']) ||
        normalizeTextOrComparable(fields['Record Key']),
      ipn: normalizeTextOrComparable(fields['c: partshunter203 ebay MOTORS interchange part number']),
      productTitle: normalizeTextOrComparable(fields['Product Title(New)']),
      description: normalizeTextOrComparable(fields['Description']),
      ebayCategoryId:
        normalizeTextOrComparable(fields['eBay Category ID (from Category Definitions) (from Master Part Record)']) ||
        normalizeTextOrComparable(fields[schema.categoryIdField || '']),
      eligibilityComputed:
        normalizeTextOrComparable(fields['Eligibility Computed']) ||
        (gate.eligible ? 'Eligible' : 'Not Eligible'),
      hasException:
        normalizeTextOrComparable(fields['Has Exception']) ||
        (gate.hasException ? 'Yes' : 'No'),
      masterPartRecord: normalizeTextOrComparable(fields['Master Part Record'])
    };
  });

  return {
    batchRecordId,
    batchLinkField: itemsField,
    total: listingRows.length,
    listings: listingRows
  };
}

module.exports = {
  validateBatchGovernanceSchema,
  getBatchSummaries,
  setBatchStatus,
  getBatchListings
};
