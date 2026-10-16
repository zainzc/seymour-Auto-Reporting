function normalizeText(value) {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function titleWords(value, sku = '') {
  const normalizedSku = normalizeText(sku).replace(/^#+/, '').toLocaleLowerCase('en-US');
  return (normalizeText(value).toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) || [])
    .filter(word => !normalizedSku || word.replace(/^#+/, '') !== normalizedSku)
    .sort();
}

function sameTitleWords(left, right, sku) {
  const leftWords = titleWords(left, sku);
  const rightWords = titleWords(right, sku);
  return leftWords.length === rightWords.length && leftWords.every((word, index) => word === rightWords[index]);
}

function removeSkuToken(value, sku) {
  const bareSku = normalizeText(sku).replace(/^#+/, '').toLocaleLowerCase('en-US');
  if (!bareSku) return normalizeText(value);
  return normalizeText(value).split(' ').filter(token => {
    const word = token.replace(/^[^\p{L}\p{N}#]+|[^\p{L}\p{N}#]+$/gu, '').replace(/^#+/, '');
    return word.toLocaleLowerCase('en-US') !== bareSku;
  }).join(' ');
}

function makeValueWithConfiguredTerminology(make, terminologyRules = []) {
  const matches = terminologyRules.filter(rule =>
    normalizeText(rule?.sourceTerm).toLocaleLowerCase('en-US') === make.toLocaleLowerCase('en-US'));
  if (matches.length !== 1 || matches[0]?.action !== 'replace') return make;
  return normalizeText(matches[0].replacementTerm) || make;
}

function assembleTitleFromConfiguredSegments(aiResult = {}, ruleResolution = {}, sourceResolution = {}) {
  const selected = ruleResolution?.titleStructure?.selected;
  const configured = Array.isArray(selected?.segments) ? selected.segments : [];
  if (!configured.length) return aiResult;

  const errors = [];
  const entries = Array.isArray(aiResult.titleSegments) ? aiResult.titleSegments : [];
  const expectedCounts = new Map();
  const requiredCounts = new Map();
  const valuesByKey = new Map();
  for (const segment of configured) {
    const key = normalizeText(segment?.key);
    if (!key) {
      errors.push('The selected Title Structure contains a segment without a key.');
      continue;
    }
    expectedCounts.set(key, (expectedCounts.get(key) || 0) + 1);
    if (segment.optional !== true) requiredCounts.set(key, (requiredCounts.get(key) || 0) + 1);
  }

  for (const entry of entries) {
    const key = normalizeText(entry?.key);
    if (!key) {
      errors.push('AI returned a title segment without a key.');
      continue;
    }
    if (key !== 'sku' && !expectedCounts.has(key)) {
      errors.push(`AI returned an unconfigured title segment: ${key}.`);
      continue;
    }
    const values = valuesByKey.get(key) || [];
    values.push(normalizeText(entry?.value));
    valuesByKey.set(key, values);
  }

  for (const [key, count] of expectedCounts) {
    if (key === 'sku') continue;
    const actualCount = valuesByKey.get(key)?.length || 0;
    const requiredCount = requiredCounts.get(key) || 0;
    if (actualCount < requiredCount || actualCount > count) {
      errors.push(`AI returned ${actualCount} values for configured segment ${key}; expected between ${requiredCount} and ${count}.`);
    }
  }
  if ((valuesByKey.get('sku')?.length || 0) > 1) {
    errors.push('AI returned the SKU segment more than once.');
  }

  const sku = normalizeText(sourceResolution?.resolved?.fields?.sku?.resolvedValue ||
    sourceResolution?.normalized?.fields?.sku?.value || ruleResolution?.listingContext?.sku).replace(/^#+/, '');
  const prefix = normalizeText(ruleResolution?.listingContext?.ipnPrefix || ruleResolution?.prefixRule?.normalizedPrefix);
  const skuSuffix = sku ? `${prefix === '257' ? '#' : ''}${sku}` : '';
  const bodySegments = [];
  const aiBodySegments = [];
  const assembledSegments = [];
  const resolvedMake = normalizeText(sourceResolution?.resolved?.fields?.brandMake?.resolvedValue);
  const authoritativeMake = resolvedMake
    ? makeValueWithConfiguredTerminology(resolvedMake, ruleResolution?.terminologyRules)
    : '';

  for (const segment of configured) {
    const key = normalizeText(segment?.key);
    if (!key || key === 'sku') continue;
    const supplied = valuesByKey.get(key)?.shift();
    if (segment.optional === true && (supplied === undefined || !normalizeText(supplied))) {
      assembledSegments.push({ key, value: '' });
      continue;
    }
    const aiValue = segment.kind === 'literal'
      ? normalizeText(segment.label)
      : removeSkuToken(supplied, sku);
    if (aiValue) aiBodySegments.push(aiValue);
    const isMakeSegment = ['make', 'brandmake', 'brand'].includes(key.toLocaleLowerCase('en-US')) ||
      ['make', 'brand / make', 'brand/make'].includes(normalizeText(segment.label).toLocaleLowerCase('en-US'));
    const value = isMakeSegment && authoritativeMake ? authoritativeMake : aiValue;
    if (value) bodySegments.push(value);
    assembledSegments.push({ key, value });
  }
  if (skuSuffix) assembledSegments.push({ key: 'sku', value: skuSuffix });

  const generatedTitle = normalizeText(aiResult.generatedTitle);
  const aiAssembledTitle = normalizeText([...aiBodySegments, skuSuffix].filter(Boolean).join(' '));
  const assembledTitle = normalizeText([...bodySegments, skuSuffix].filter(Boolean).join(' '));
  if (!sameTitleWords(generatedTitle, aiAssembledTitle, sku)) {
    errors.push('AI title content does not match the configured segment content.');
  }

  if (errors.length) {
    return {
      ...aiResult,
      titleStructureAssembly: {
        status: 'invalid',
        structureId: selected.id || null,
        errors
      }
    };
  }

  return {
    ...aiResult,
    generatedTitle: assembledTitle,
    titleSegments: assembledSegments,
    titleStructureAssembly: {
      status: 'assembled',
      structureId: selected.id || null,
      errors: []
    }
  };
}

module.exports = { assembleTitleFromConfiguredSegments };
