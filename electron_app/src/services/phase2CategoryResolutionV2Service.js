function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function parsePrefix(value) {
  const parsed = parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasLinkedCategory(fields = {}, linkFieldName = '') {
  const candidates = [linkFieldName, 'Category Definitions', 'Categories']
    .map(name => String(name || '').trim())
    .filter(Boolean);
  for (const fieldName of candidates) {
    const value = fields?.[fieldName];
    if (Array.isArray(value) && value.length > 0) return true;
  }
  return false;
}

function getExistingQoh(fields) {
  const value = fields?.['Quantity (QOH)'];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildCategoryDefinitionsIndex(categoryRecords = []) {
  const index = new Map();

  for (const record of categoryRecords) {
    const fields = record?.fields || {};
    const prefix = parsePrefix(fields['IPN Prefix']);
    if (!Number.isFinite(prefix)) continue;

    const key = String(prefix);
    const identifier =
      normalizeText(fields['Category Identifier / Conditions & Options']) ||
      normalizeText(fields['Conditions & Options']) ||
      normalizeText(fields['Category Name']);

    const row = {
      recordId: record.id,
      categoryName: normalizeText(fields['Category Name']),
      identifier
    };

    if (!index.has(key)) {
      index.set(key, []);
    }
    index.get(key).push(row);
  }

  return index;
}

function selectTrackingFields(masterFieldNames) {
  const has = name => masterFieldNames.has(name);
  return {
    statusField: has('Category Resolution Status') ? 'Category Resolution Status' : '',
    identifierField: has('Resolved Category Identifier') ? 'Resolved Category Identifier' : '',
    taskIdField: has('ClickUp Task ID') ? 'ClickUp Task ID' : ''
  };
}

function buildTaskKey(ipn, type = '') {
  const ipnKey = String(ipn || '').trim().toUpperCase();
  const typeKey = String(type || '').trim().toLowerCase() || 'unknown';
  return `${ipnKey}::${typeKey}`;
}

function formatIdentifierWithPrefix(identifier, ipnPrefix) {
  const text = normalizeText(identifier);
  if (!text) return '';
  const prefix = parsePrefix(ipnPrefix);
  return Number.isFinite(prefix) ? `${prefix}-${text}` : text;
}

function buildPhase2PlanV2({
  normalizedRows,
  existingMap,
  categoryIndex,
  taskCache,
  categoryLinkFieldName,
  masterFieldNames
}) {
  const creates = [];
  const updates = [];
  const categoryLinks = [];
  const clickupTasks = [];
  const seenTaskKeys = new Set();
  const tracking = selectTrackingFields(masterFieldNames);
  const unmappedPrefixes = new Set();

  const summary = {
    deterministicPlanned: 0,
    multiCategoryTasksPlanned: 0,
    exceptionTasksPlanned: 0
  };

  for (const row of normalizedRows) {
    const existing = existingMap.get(row.ipn) || null;
    const existingFields = existing?.fields || {};
    const existingHasCategory = hasLinkedCategory(existingFields, categoryLinkFieldName);

    const prefixKey = Number.isFinite(row.ipnPrefix) ? String(row.ipnPrefix) : '';
    const candidates = prefixKey ? categoryIndex.get(prefixKey) || [] : [];
    const decision = {
      type: 'exception',
      reason: 'no_match',
      recordId: '',
      identifier: '',
      options: []
    };

    if (candidates.length === 1) {
      decision.type = 'deterministic';
      decision.reason = 'unique_prefix_match';
      decision.recordId = candidates[0].recordId;
      decision.identifier = candidates[0].identifier;
      summary.deterministicPlanned += 1;
    } else if (candidates.length > 1) {
      decision.type = 'multi';
      decision.reason = 'multiple_category_definitions';
      decision.options = [
        ...new Set(
          candidates
            .map(item => formatIdentifierWithPrefix(item.identifier, row.ipnPrefix))
            .filter(Boolean)
        )
      ];
      summary.multiCategoryTasksPlanned += 1;
    } else {
      if (prefixKey) unmappedPrefixes.add(prefixKey);
      summary.exceptionTasksPlanned += 1;
    }

    if (!existing) {
      const fields = {
        IPN: row.ipn,
        'Quantity (QOH)': row.qoh
      };

      if (decision.type !== 'deterministic' && tracking.statusField) {
        fields[tracking.statusField] = decision.type === 'multi' ? 'Unresolved' : 'Exception';
      }

      creates.push({ fields });
      if (decision.type === 'deterministic' && decision.recordId) {
        categoryLinks.push({
          ipn: row.ipn,
          masterRecordId: '',
          categoryRecordId: decision.recordId,
          identifier: decision.identifier,
          source: 'sheet'
        });
      }
    } else {
      const fields = {};
      const existingQoh = getExistingQoh(existingFields);
      if (existingQoh !== row.qoh) {
        fields['Quantity (QOH)'] = row.qoh;
      }

      if (!existingHasCategory && decision.type !== 'deterministic' && tracking.statusField) {
        fields[tracking.statusField] = decision.type === 'multi' ? 'Unresolved' : 'Exception';
      }

      if (Object.keys(fields).length > 0) {
        updates.push({ id: existing.id, fields });
      }
      if (!existingHasCategory && decision.type === 'deterministic' && decision.recordId) {
        categoryLinks.push({
          ipn: row.ipn,
          masterRecordId: existing.id,
          categoryRecordId: decision.recordId,
          identifier: decision.identifier,
          source: 'sheet'
        });
      }
    }

    const shouldCreateOrUpdateTask = !existingHasCategory && decision.type !== 'deterministic';
    if (shouldCreateOrUpdateTask) {
      const taskType = decision.type === 'multi' ? 'multi' : 'exception';
      const taskKey = buildTaskKey(row.ipn, taskType);
      if (seenTaskKeys.has(taskKey)) {
        continue;
      }
      seenTaskKeys.add(taskKey);

      clickupTasks.push({
        taskKey,
        ipn: row.ipn,
        ipnPrefix: row.ipnPrefix,
        masterRecordId: existing?.id || '',
        categoryCode: row.categoryCode,
        conditionsAndOptions: row.conditionsAndOptions,
        partType: row.partType,
        modelYear: row.modelYear,
        modelName: row.modelName,
        locationCode: row.locationCode,
        stockTicketNumber: row.stockTicketNumber,
        referenceNumber: row.referenceNumber,
        type: taskType,
        reason: decision.reason,
        validOptions: decision.options
      });
    }
  }

  return {
    creates,
    updates,
    categoryLinks,
    clickupTasks,
    deterministicPlanned: summary.deterministicPlanned,
    multiCategoryTasksPlanned: summary.multiCategoryTasksPlanned,
    exceptionTasksPlanned: summary.exceptionTasksPlanned,
    unmappedPrefixes: [...unmappedPrefixes]
  };
}

module.exports = {
  buildCategoryDefinitionsIndex,
  buildPhase2PlanV2,
  buildTaskKey,
  hasLinkedCategory
};
