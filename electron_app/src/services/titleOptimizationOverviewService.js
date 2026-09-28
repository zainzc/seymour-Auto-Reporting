const SECTION_ORDER = ['Source Fields','Source Priority','Terminology Rules','Synonyms','Prefix Rules','Restricted Terms','Category Rules','Title Structure','Flag Reasons','System Rules'];
const EDITABLE_SECTIONS = SECTION_ORDER.slice(0, -1);
const PATHS = {'Source Fields':'source-fields.html','Source Priority':'source-priority.html','Terminology Rules':'terminology-rules.html','Synonyms':'synonyms.html','Prefix Rules':'prefix-rules.html','Restricted Terms':'restricted-terms.html','Category Rules':'category-rules.html','Title Structure':'title-structure.html','Flag Reasons':'flag-reasons.html','System Rules':'system-rules.html'};
const KEYS = {'Source Fields':'mappings','Source Priority':'rows','Terminology Rules':'rules','Synonyms':'rules','Prefix Rules':'rules','Restricted Terms':'rules','Category Rules':'rules','Title Structure':'structures','Flag Reasons':'reasons'};
const PREVIEW_LIMITS = Object.freeze({ 'Source Fields': 9, 'Source Priority': 9, 'Terminology Rules': 9, 'Synonyms': 5, 'Prefix Rules': 5 });

function itemsFor(name, value) {
  if (name === 'System Rules') return Array.isArray(value) ? value : [];
  const items = value?.[KEYS[name]];
  return Array.isArray(items) ? items : [];
}

function warningItems(value) {
  const warnings = [];
  for (const key of ['issues', 'warnings']) {
    for (const item of Array.isArray(value?.[key]) ? value[key] : []) {
      warnings.push(typeof item === 'string' ? { id: null, message: item } : { ...item, message: item?.message || JSON.stringify(item) });
    }
  }
  if (value?.schemaError) warnings.push(typeof value.schemaError === 'string' ? { id: 'schema', message: value.schemaError } : { ...value.schemaError, message: value.schemaError.message || JSON.stringify(value.schemaError) });
  return warnings;
}

function isActive(item) { return Boolean(item && item.enabled !== false && !item.deletedAt); }

function activeCount(name, value) {
  const items = itemsFor(name, value);
  if (name === 'Source Priority') return warningItems(value).length ? 0 : items.length;
  if (name === 'Synonyms' && value?.enabled !== true) return 0;
  return items.filter(isActive).length;
}

function sectionSummary(name, value) {
  const items = itemsFor(name, value);
  const warnings = warningItems(value);
  return { name, path: PATHS[name], available: true, state: warnings.length ? 'Needs Correction' : name === 'System Rules' ? 'Locked' : 'Configured', activeCount: activeCount(name, value), seededCount: items.filter(item => item?.origin === 'client-v5' || item?.source === 'client-v5').length, customCount: items.filter(item => item?.origin === 'custom' || item?.source === 'custom').length, warningCount: warnings.length, warnings };
}

function preview(name, values, sections) {
  const keys = { 'Source Fields':'sourceFields', 'Source Priority':'sourcePriority', 'Terminology Rules':'terminologyRules', 'Synonyms':'synonyms', 'Prefix Rules':'prefixRules' };
  const section = sections.find(candidate => candidate.name === name);
  return [keys[name], { available: section?.available === true, path: PATHS[name], rows: section?.available ? itemsFor(name, values[name]).slice(0, PREVIEW_LIMITS[name]) : [], totalCount: section?.available ? itemsFor(name, values[name]).length : 0, error: section?.error || null }];
}

function compactSummary(name, values, sections) {
  const section = sections.find(candidate => candidate.name === name);
  const value = values[name];
  const result = { available: section?.available === true, path: PATHS[name], activeCount: section?.available ? section.activeCount : null, seededCount: section?.available ? section.seededCount : null, customCount: section?.available ? section.customCount : null, warningCount: section?.available ? section.warningCount : null, error: section?.error || null };
  if (name === 'Restricted Terms') result.lockedCount = result.available ? itemsFor(name, value).filter(item => item?.locked && isActive(item)).length : null;
  if (name === 'Title Structure') result.names = result.available ? itemsFor(name, value).filter(isActive).slice(0, 3).map(item => item.structureName).filter(Boolean) : [];
  if (name === 'Flag Reasons') {
    result.requiredCount = result.available ? itemsFor(name, value).filter(item => item?.required && isActive(item)).length : null;
    result.customActiveCount = result.available ? itemsFor(name, value).filter(item => item?.origin === 'custom' && isActive(item)).length : null;
  }
  if (name === 'System Rules') {
    result.lockedCount = result.available ? itemsFor(name, value).filter(item => item?.locked).length : null;
    result.version = result.available ? itemsFor(name, value).find(item => item?.version)?.version || null : null;
  }
  return result;
}

function latestTimestamp(values) {
  const valid = EDITABLE_SECTIONS.map(name => values[name]?.updatedAt).filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  return valid.length ? valid.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest) : null;
}

function canonicalMetadata(systemRules) {
  const find = id => systemRules.find(rule => rule?.id === id);
  const maximum = find('SR-07');
  const maximumMatch = `${maximum?.title || ''} ${maximum?.behavior || ''}`.match(/\b(\d+)\s*(?:character|char)/i);
  return { version: systemRules.find(rule => typeof rule?.version === 'string')?.version || null, protections: { maximumTitleLength: maximumMatch ? Number(maximumMatch[1]) : null, manualOverrideProtection: Boolean(find('SR-02')), skuRequirement: find('SR-05') ? 'SKU exactly once at end' : null } };
}

function createTitleOptimizationOverviewService(loaders = {}) {
  async function load() {
    const sections = [], values = {}, warningGroups = [];
    let unavailable = false;
    for (const name of SECTION_ORDER) {
      try {
        if (typeof loaders[name] !== 'function') throw Error('Service is unavailable.');
        const value = await loaders[name]();
        values[name] = value;
        const section = sectionSummary(name, value);
        sections.push(section);
        if (section.warnings.length) warningGroups.push({ section: name, items: section.warnings });
      } catch (error) {
        unavailable = true;
        sections.push({ name, path: PATHS[name], available: false, state: 'Unavailable', activeCount: null, seededCount: null, customCount: null, warningCount: null, warnings: [], error: String(error?.message || error || 'Service is unavailable.') });
      }
    }
    const warningCount = warningGroups.reduce((total, group) => total + group.items.length, 0);
    const systemRules = itemsFor('System Rules', values['System Rules']);
    const canonical = canonicalMetadata(systemRules);
    const editableAvailable = EDITABLE_SECTIONS.every(name => sections.find(section => section.name === name)?.available);
    const activeConfigurationItems = editableAvailable ? EDITABLE_SECTIONS.reduce((total, name) => total + activeCount(name, values[name]), 0) : null;
    const previews = Object.fromEntries(['Source Fields','Source Priority','Terminology Rules','Synonyms','Prefix Rules'].map(name => preview(name, values, sections)));
    const summaryNames = ['Restricted Terms','Category Rules','Title Structure','Flag Reasons','System Rules'];
    const summaryKeys = ['restrictedTerms','categoryRules','titleStructure','flagReasons','systemRules'];
    const summaries = Object.fromEntries(summaryNames.map((name, index) => [summaryKeys[index], compactSummary(name, values, sections)]));
    const highlightIds = new Set(['SR-01','SR-02','SR-03','SR-05','SR-07','SR-14','SR-15']);
    return {
      status: unavailable ? 'Unavailable' : warningCount ? 'Needs Attention' : 'Healthy',
      configuredTabs: sections.filter(section => section.available).length,
      totalTabs: SECTION_ORDER.length,
      configurationVersion: canonical.version,
      lastUpdated: latestTimestamp(values),
      warningCount,
      warningGroups,
      warnings: warningGroups.flatMap(group => group.items.map(item => ({ section: group.section, ...item }))),
      activeConfigurationItems,
      systemRuleCount: systemRules.length,
      globalProtections: { ...canonical.protections, synonymEnrichment: sections.find(section => section.name === 'Synonyms')?.available ? values.Synonyms?.enabled === true : null },
      previews,
      summaries,
      sections,
      safetyHighlights: systemRules.filter(rule => highlightIds.has(rule.id)).map(rule => ({ id: rule.id, title: rule.title, behavior: rule.behavior }))
    };
  }
  return { load };
}

module.exports = { SECTION_ORDER, EDITABLE_SECTIONS, PREVIEW_LIMITS, createTitleOptimizationOverviewService };
