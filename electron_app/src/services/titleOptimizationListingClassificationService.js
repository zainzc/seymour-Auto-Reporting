function normalizeText(value) {
  if (Array.isArray(value)) return normalizeText(value[0]);
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/\s+/g, ' ');
}

const PREFIX_FAMILIES = Object.freeze({
  300: 'engine'
});

function familyFromPartIdentity(value) {
  const text = normalizeText(value);
  if (/\bengines?\b/i.test(text)) return 'engine';
  if (/\b(?:transmissions?|transaxles?)\b/i.test(text)) return 'transmission';
  return null;
}

function classifyTitleOptimizationListing({ listingResolution = {}, context = {}, prefixRule = null } = {}) {
  const sources = [];
  const prefix = normalizeText(prefixRule?.normalizedPrefix || context.ipnPrefix);
  const prefixFamily = PREFIX_FAMILIES[prefix] || null;
  if (prefixFamily) {
    sources.push({ type: 'ipn-prefix', value: prefix, family: prefixFamily, ruleId: prefixRule?.rule?.id || null });
  }

  for (const [type, value] of [
    ['resolved-category-part', context.categoryPart],
    ['item-specific-part', context.itemSpecificPart],
    ['existing-title', listingResolution?.normalized?.fields?.existingTitle?.value ||
      listingResolution?.resolved?.fields?.title?.resolvedValue]
  ]) {
    const family = familyFromPartIdentity(value);
    if (family) sources.push({ type, value: normalizeText(value), family });
  }

  const families = [...new Set(sources.map(source => source.family))];
  const family = prefixFamily || (families.length === 1 ? families[0] : 'general');
  const conflicts = sources.filter(source => source.family !== family);

  return {
    family,
    resolved: family !== 'general' && conflicts.length === 0,
    sources,
    conflicts,
    reason: prefixFamily
      ? 'canonical-ipn-prefix'
      : families.length === 1
        ? 'trusted-part-identity'
        : conflicts.length > 0
          ? 'conflicting-family-evidence'
          : 'no-specialized-family-evidence'
  };
}

module.exports = {
  classifyTitleOptimizationListing
};
