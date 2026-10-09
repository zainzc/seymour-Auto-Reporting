function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/\s+/g, ' ');
}

function singularizeToken(token) {
  if (token.endsWith('ies') && token.length > 3) return `${token.slice(0, -3)}y`;
  if (/(?:ches|shes|sses|xes|zes)$/.test(token) && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && token.length > 3) return token.slice(0, -1);
  return token;
}

function normalizedMatchKey(value) {
  const expanded = normalizeText(value)
    .toLocaleLowerCase('en-US')
    .replace(/\btaillight\b/g, 'tail light')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const tokens = expanded.split(/\s+/).filter(Boolean).map(singularizeToken);
  if (tokens[tokens.length - 1] === 'assembly') tokens.pop();
  return tokens.join(' ');
}

function equivalentKeys(value, terminologyRules = [], synonymRules = []) {
  const initial = normalizedMatchKey(value);
  const keys = new Set(initial ? [initial] : []);
  const groups = [];

  for (const rule of terminologyRules || []) {
    const terms = [rule?.sourceTerm, rule?.replacementTerm].map(normalizedMatchKey).filter(Boolean);
    if (terms.length > 1) groups.push(terms);
  }
  for (const rule of synonymRules || []) {
    const terms = [rule?.primaryTerm, ...(rule?.synonyms || [])].map(normalizedMatchKey).filter(Boolean);
    if (terms.length > 1) groups.push(terms);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (!group.some(key => keys.has(key))) continue;
      for (const key of group) {
        if (!keys.has(key)) {
          keys.add(key);
          changed = true;
        }
      }
    }
  }
  return [...keys];
}

function matchCategoryRule({ rule = {}, context = {}, terminologyRules = [], synonymRules = [] } = {}) {
  const ruleKeys = equivalentKeys(rule.categoryName, terminologyRules, synonymRules);
  const evidenceValues = [
    { source: 'resolved-category-part', value: context.categoryPart },
    { source: 'item-specific-part', value: context.itemSpecificPart }
  ].filter(item => normalizeText(item.value));
  const evidence = [];

  for (const item of evidenceValues) {
    const valueKeys = equivalentKeys(item.value, terminologyRules, synonymRules);
    for (const ruleKey of ruleKeys) {
      for (const valueKey of valueKeys) {
        const exact = ruleKey === valueKey;
        const suffix = ruleKey.split(' ').length === 1 && valueKey.endsWith(` ${ruleKey}`);
        if (!exact && !suffix) continue;
        evidence.push({
          source: item.source,
          value: normalizeText(item.value),
          ruleKey,
          valueKey,
          method: exact ? 'normalized-exact' : 'normalized-suffix'
        });
      }
    }
  }

  return {
    matched: evidence.length > 0,
    methods: [...new Set(evidence.map(item => item.method))],
    evidence,
    specificity: Math.max(0, ...ruleKeys.map(key => key.split(' ').filter(Boolean).length))
  };
}

function splitPriorityDetails(details = []) {
  const output = [];
  for (const rawDetail of Array.isArray(details) ? details : []) {
    const detail = normalizeText(rawDetail);
    if (!detail) continue;
    const values = /^with\s*\/\s*without\b/i.test(detail)
      ? [detail]
      : detail.split(/\s*\/\s*/).map(normalizeText).filter(Boolean);
    for (const value of values) {
      if (!output.some(existing => normalizedMatchKey(existing) === normalizedMatchKey(value))) output.push(value);
    }
  }
  return output;
}

module.exports = {
  matchCategoryRule,
  normalizedMatchKey,
  splitPriorityDetails
};
