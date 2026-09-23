const SECTION_ORDER = Object.freeze([
  'sourceFields',
  'sourcePriority',
  'terminologyRules',
  'synonyms',
  'prefixRules',
  'restrictedTerms',
  'categoryRules',
  'titleStructures',
  'flagReasons',
  'systemRules'
]);

const EDITABLE_SECTION_ORDER = Object.freeze(SECTION_ORDER.slice(0, -1));
const OPTIONAL_SECTIONS = new Set(['synonyms']);

const COLLECTION_KEYS = Object.freeze({
  sourceFields: 'mappings',
  sourcePriority: 'rows',
  terminologyRules: 'rules',
  synonyms: 'rules',
  prefixRules: 'rules',
  restrictedTerms: 'rules',
  categoryRules: 'rules',
  titleStructures: 'structures',
  flagReasons: 'reasons'
});

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizeSortText(value) {
  return normalizeText(value).toLocaleLowerCase('en-US');
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function warningItems(section, value) {
  const items = [];
  for (const key of ['issues', 'warnings']) {
    for (const item of Array.isArray(value?.[key]) ? value[key] : []) {
      const normalized = typeof item === 'string'
        ? { section, id: null, message: item }
        : { section, ...item, message: item?.message || JSON.stringify(item) };
      items.push(normalized);
    }
  }
  if (value?.schemaError) {
    const item = value.schemaError;
    items.push(typeof item === 'string'
      ? { section, id: 'schema', message: item }
      : { section, ...item, message: item?.message || JSON.stringify(item) });
  }
  return items;
}

function compareBy(...selectors) {
  return (a, b) => {
    for (const selector of selectors) {
      const left = selector(a);
      const right = selector(b);
      if (typeof left === 'number' || typeof right === 'number') {
        const result = (Number(left) || 0) - (Number(right) || 0);
        if (result) return result;
      } else {
        const result = String(left || '').localeCompare(String(right || ''));
        if (result) return result;
      }
    }
    return 0;
  };
}

function itemsFor(section, value) {
  if (section === 'systemRules') return Array.isArray(value) ? value : [];
  const key = COLLECTION_KEYS[section];
  const items = Array.isArray(value?.[key]) ? value[key] : [];
  return items.filter(item => item && item.enabled !== false && !item.deletedAt);
}

function sortedItems(section, value) {
  const items = [...itemsFor(section, value)];
  if (section === 'sourceFields') {
    return items.sort(compareBy(item => item.sortOrder, item => normalizeSortText(item.logicalKey), item => item.id));
  }
  if (section === 'sourcePriority') {
    return items.sort(compareBy(item => item.priority, item => item.key));
  }
  if (section === 'terminologyRules' || section === 'synonyms' || section === 'prefixRules') {
    return items.sort(compareBy(item => item.priority, item => normalizeSortText(item.prefix || item.sourceTerm || item.primaryTerm), item => item.id));
  }
  if (section === 'restrictedTerms') {
    return items.sort(compareBy(item => item.seedOrder ?? item.priority ?? Number.MAX_SAFE_INTEGER, item => normalizeSortText(item.term), item => item.id));
  }
  if (section === 'categoryRules') {
    return items.sort(compareBy(
      item => item.origin === 'client-v5' ? 0 : 1,
      item => item.origin === 'client-v5' ? item.seedOrder : Number.MAX_SAFE_INTEGER,
      item => normalizeSortText(item.categoryName),
      item => item.id
    ));
  }
  if (section === 'titleStructures') {
    return items.sort(compareBy(
      item => item.origin === 'client-v5' ? 0 : 1,
      item => item.origin === 'client-v5' ? item.seedOrder : Number.MAX_SAFE_INTEGER,
      item => normalizeSortText(item.structureName),
      item => item.id
    ));
  }
  if (section === 'flagReasons') {
    return items.sort(compareBy(
      item => item.origin === 'client-v5' ? 0 : 1,
      item => item.origin === 'client-v5' ? item.seedOrder : Number.MAX_SAFE_INTEGER,
      item => normalizeSortText(item.reason),
      item => item.id
    ));
  }
  if (section === 'systemRules') return items.sort(compareBy(item => item.order, item => item.id));
  return items;
}

function isRestrictedLockedFallbackWarning(warning) {
  const text = `${warning?.id || ''} ${warning?.message || ''}`.toLowerCase();
  return text.includes('locked') || text.includes('canonical enabled rule') || text.includes('restored in memory');
}

function warningBlocksRuntime(section, warning) {
  if (section === 'restrictedTerms' && isRestrictedLockedFallbackWarning(warning)) return false;
  return !OPTIONAL_SECTIONS.has(section);
}

function latestTimestamp(values) {
  const timestamps = EDITABLE_SECTION_ORDER
    .map(section => validTimestamp(values[section]?.updatedAt))
    .filter(Boolean);
  return timestamps.length
    ? timestamps.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest)
    : null;
}

function configurationVersion(systemRules = []) {
  const rule = systemRules.find(item => typeof item?.version === 'string' && item.version.trim());
  return rule?.version || null;
}

function createUnavailableSection(section, error) {
  return {
    name: section,
    available: false,
    optional: OPTIONAL_SECTIONS.has(section),
    items: [],
    warningCount: 0,
    error: String(error?.message || error || 'Service is unavailable.')
  };
}

function createAvailableSection(section, value) {
  const warnings = warningItems(section, value);
  return {
    name: section,
    available: true,
    optional: OPTIONAL_SECTIONS.has(section),
    items: sortedItems(section, value),
    warningCount: warnings.length,
    warnings
  };
}

function createTitleOptimizationRuntimeConfigService(loaders = {}, options = {}) {
  const now = options.now || (() => new Date().toISOString());

  async function loadSnapshot() {
    const values = {};
    const sections = {};
    const warnings = [];
    const unavailableSections = [];
    const blockingSections = new Set();

    for (const section of SECTION_ORDER) {
      try {
        if (typeof loaders[section] !== 'function') throw new Error('Service is unavailable.');
        const value = await loaders[section]();
        values[section] = value;
        const sectionState = createAvailableSection(section, value);
        sections[section] = sectionState;
        for (const warning of sectionState.warnings) {
          warnings.push(warning);
          if (warningBlocksRuntime(section, warning)) blockingSections.add(section);
        }
      } catch (error) {
        const sectionState = createUnavailableSection(section, error);
        sections[section] = sectionState;
        unavailableSections.push(section);
        if (!sectionState.optional) blockingSections.add(section);
      }
    }

    const systemRules = sections.systemRules?.items || [];
    const runtimeReady = blockingSections.size === 0;
    const hasWarnings = warnings.length > 0 || unavailableSections.some(section => sections[section]?.optional);
    const status = runtimeReady ? (hasWarnings ? 'ready-with-warnings' : 'ready') : 'blocked';

    return {
      mode: 'shadow-only',
      status,
      runtimeReady,
      metadata: {
        loadedAt: now(),
        configurationVersion: configurationVersion(systemRules),
        lastUpdated: latestTimestamp(values),
        sectionOrder: [...SECTION_ORDER],
        editableSectionOrder: [...EDITABLE_SECTION_ORDER]
      },
      sections,
      warnings,
      unavailableSections,
      blockingSections: [...blockingSections].filter(section => sections[section]?.available !== false || !sections[section]?.optional)
    };
  }

  return { loadSnapshot };
}

module.exports = {
  SECTION_ORDER,
  EDITABLE_SECTION_ORDER,
  createTitleOptimizationRuntimeConfigService
};
