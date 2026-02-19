const { resolveCategory } = require('./phase2CategoryService');

function hasCategoriesSet(fields) {
  const value = fields?.Categories;
  return Array.isArray(value) && value.length > 0;
}

function getExistingQoh(fields) {
  const value = fields?.['Quantity (QOH)'];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildTaskKey(ipn, reason) {
  return `${ipn}::${reason}`;
}

function buildPhase2Plan({
  normalizedRows,
  existingMap,
  categoryIndex,
  taskCache
}) {
  const creates = [];
  const updates = [];
  const clickupTasks = [];
  const seenTaskKeys = new Set();
  let categoryResolved = 0;

  for (const row of normalizedRows) {
    const existing = existingMap.get(row.ipn) || null;
    const existingFields = existing?.fields || {};
    const existingHasCategory = hasCategoriesSet(existingFields);

    const candidateKey = Number.isFinite(row.ipnPrefix) ? String(row.ipnPrefix) : '';
    const candidates = candidateKey ? (categoryIndex.get(candidateKey) || []) : [];

    let categoryDecision;
    if (!Number.isFinite(row.ipnPrefix)) {
      categoryDecision = { resolved: false, reason: 'invalid_prefix' };
    } else {
      categoryDecision = resolveCategory(row, candidates);
    }

    if (categoryDecision.resolved) {
      categoryResolved += 1;
    }

    if (!existing) {
      const fields = {
        IPN: row.ipn,
        'Quantity (QOH)': row.qoh
      };

      if (categoryDecision.resolved) {
        fields.Categories = [categoryDecision.recordId];
      }

      creates.push({ fields });
    } else {
      const fields = {};
      const existingQoh = getExistingQoh(existingFields);
      if (existingQoh !== row.qoh) {
        fields['Quantity (QOH)'] = row.qoh;
      }

      if (categoryDecision.resolved && !existingHasCategory) {
        fields.Categories = [categoryDecision.recordId];
      }

      if (Object.keys(fields).length > 0) {
        updates.push({ id: existing.id, fields });
      }
    }

    const shouldCreateTask = !categoryDecision.resolved && !existingHasCategory;
    if (shouldCreateTask) {
      const taskKey = buildTaskKey(row.ipn, categoryDecision.reason);
      if (seenTaskKeys.has(taskKey)) {
        continue;
      }
      seenTaskKeys.add(taskKey);

      if (!taskCache[taskKey]) {
        clickupTasks.push({
          taskKey,
          ipn: row.ipn,
          ipnPrefix: row.ipnPrefix,
          categoryCode: row.categoryCode,
          conditionsAndOptions: row.conditionsAndOptions,
          partType: row.partType,
          modelYear: row.modelYear,
          modelName: row.modelName,
          locationCode: row.locationCode,
          stockTicketNumber: row.stockTicketNumber,
          referenceNumber: row.referenceNumber,
          reason: categoryDecision.reason
        });
      }
    }
  }

  return {
    creates,
    updates,
    clickupTasks,
    categoryResolved
  };
}

module.exports = {
  buildPhase2Plan,
  buildTaskKey
};
