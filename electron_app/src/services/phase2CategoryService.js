const { normalizeString } = require('./phase2ValidationService');

function buildCategoryIndex(categoryRecords) {
  const index = new Map();

  for (const record of categoryRecords || []) {
    const fields = record.fields || {};
    const rawPrefix = fields['IPN Prefix'];
    const parsedPrefix = parseInt(String(rawPrefix || '').trim(), 10);
    if (!Number.isFinite(parsedPrefix)) continue;

    const key = String(parsedPrefix);
    const candidate = {
      recordId: record.id,
      categoryName: normalizeString(fields['Category Name']),
      keyword: normalizeString(fields['Conditions & Options']).toLowerCase()
    };

    if (!index.has(key)) {
      index.set(key, []);
    }
    index.get(key).push(candidate);
  }

  return index;
}

function resolveCategory(row, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { resolved: false, reason: 'no_reference_rows' };
  }

  if (candidates.length === 1) {
    return { resolved: true, recordId: candidates[0].recordId, reason: 'unique_prefix' };
  }

  const rowText = String(row.conditionsAndOptionsLower || '');
  const withKeyword = candidates.filter(candidate => candidate.keyword);
  const pool = withKeyword.length > 0 ? withKeyword : candidates;

  const matched = pool.filter(candidate => rowText.includes(candidate.keyword));
  if (matched.length === 1) {
    return { resolved: true, recordId: matched[0].recordId, reason: 'keyword_match' };
  }

  return { resolved: false, reason: 'ambiguous_prefix' };
}

module.exports = {
  buildCategoryIndex,
  resolveCategory
};

