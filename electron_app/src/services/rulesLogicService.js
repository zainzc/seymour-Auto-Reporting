const rulesLogicRowsCache = new Map();
const rulesLogicAllowlistCache = new Map();
const rulesLogicRuleSetCache = new Map();
const rulesLogicFixedRuleSetCache = new Map();
const DEFAULT_RULES_LOGIC_TABLE_NAME = 'Rule Logic';
const RULES_LOGIC_TABLE_NAME_ALIASES = new Map([
  ['rule logic', DEFAULT_RULES_LOGIC_TABLE_NAME],
  ['rules logic', DEFAULT_RULES_LOGIC_TABLE_NAME]
]);
const LEGACY_RULES_LOGIC_TABLE_NAMES = new Set([
  'ebay item specific rules',
  'ebay item specifics rules',
  'item specific rules',
  'item specifics rules',
  'fixed item specifics (global defaults)'
]);

function normalizeText(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    return normalizeText(value[0]);
  }
  if (value && typeof value === 'object') {
    return normalizeText(value.name || value.value || value.label || value.id || value.text || value.title || '');
  }
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function resolveRulesLogicTableName(...values) {
  const candidates = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      candidates.push(...value);
      continue;
    }
    if (value && typeof value === 'object') {
      candidates.push(
        value.rulesLogicTableName,
        value.phase5RulesLogicTable,
        value.ebayRulesLogicTable,
        value.phase4RulesLogicTable
      );
      continue;
    }
    candidates.push(value);
  }

  for (const candidate of candidates) {
    const tableName = normalizeText(candidate);
    if (!tableName) continue;
    const normalizedTableKey = normalizeKey(tableName);
    if (LEGACY_RULES_LOGIC_TABLE_NAMES.has(normalizedTableKey)) continue;
    if (RULES_LOGIC_TABLE_NAME_ALIASES.has(normalizedTableKey)) {
      return RULES_LOGIC_TABLE_NAME_ALIASES.get(normalizedTableKey);
    }
    return tableName;
  }

  return DEFAULT_RULES_LOGIC_TABLE_NAME;
}

function canonicalFieldName(value = '') {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizeSpecificName(value) {
  return normalizeText(value).replace(/^c:\s*/i, '').trim();
}

function getFieldValueByName(fields = {}, name = '') {
  if (!fields || typeof fields !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(fields, name)) return normalizeText(fields[name]);

  const target = normalizeKey(name);
  if (!target) return '';

  const match = Object.keys(fields).find(item => normalizeKey(item) === target);
  if (!match) return '';
  return normalizeText(fields[match]);
}

function parseIpnPrefix(ipn = '') {
  const text = normalizeText(ipn);
  if (!text) return '';

  const firstSegment = normalizeText(text.split('-')[0]);
  if (/^\d{3}$/.test(firstSegment)) return firstSegment;

  const match = text.match(/^(\d{3})/);
  if (match && match[1]) return match[1];

  return firstSegment;
}

function normalizeAspectValues(rawValue) {
  const out = [];
  const push = value => {
    const text = normalizeText(value);
    if (text) out.push(text);
  };

  if (Array.isArray(rawValue)) {
    for (const value of rawValue) {
      if (Array.isArray(value)) {
        value.forEach(push);
        continue;
      }
      if (value && typeof value === 'object') {
        push(value.id || value.name || value.label || value.value || '');
        continue;
      }
      push(value);
    }
    return out;
  }

  if (rawValue && typeof rawValue === 'object') {
    push(rawValue.id || rawValue.name || rawValue.label || rawValue.value || '');
    return out;
  }

  push(rawValue);
  return out;
}

function mergeAspectValue(target = {}, name = '', rawValue = null) {
  const aspectName = normalizeText(name);
  if (!aspectName) return;

  const values = normalizeAspectValues(rawValue);
  if (values.length === 0) return;

  const existing = Array.isArray(target[aspectName]) ? target[aspectName] : [];
  const seen = new Set(existing.map(item => canonicalFieldName(item)).filter(Boolean));
  for (const value of values) {
    const key = canonicalFieldName(value);
    if (!key || seen.has(key)) continue;
    existing.push(value);
    seen.add(key);
  }

  if (existing.length > 0) {
    target[aspectName] = existing;
  }
}

const RULE_SPECIFIC_ALIAS_GROUPS = [
  ['Brand', ['Brand']],
  ['Color', ['Color', 'Colour']],
  ['Features', ['Features', 'Feature']],
  ['Number of Pieces', ['Number of Pieces', 'Pieces', 'No. of Pieces', 'No of Pieces']],
  ['Placement on Vehicle', ['Placement on Vehicle', 'Placement', 'Vehicle Placement']],
  ['Mirror Adjustment Method', ['Mirror Adjustment Method', 'Mirror Adjustment']],
  ['Finish', ['Finish']],
  ['Type', ['Type']],
  [
    'Manufacturer Part Number',
    ['Manufacturer Part Number', 'MPN', 'Mfr Part Number', 'Mfr. Part Number', 'ManufacturerPartNumber']
  ],
  ['OE/OEM Part Number', ['OE/OEM Part Number', 'OE OEM Part Number', 'OEM Part Number', 'OEOEMPartNumber']],
  ['Interchange Part Number', ['Interchange Part Number', 'IPN', 'InterchangePartNumber', 'IPN (Interchange Part Number)']],
  ['GTIN', ['GTIN']],
  ['Genuine OEM', ['Genuine OEM', 'OEM']],
  ['Condition', ['Condition']],
  ['Warranty', ['Warranty']],
  ['Part Number', ['Part Number', 'PartNumber', 'Part No', 'Part No.']],
  ['Material', ['Material']],
  ['VIN #', ['VIN #', 'VIN Number', 'VIN']]
];

const RULE_SPECIFIC_ALIAS_LOOKUP = new Map(
  RULE_SPECIFIC_ALIAS_GROUPS.map(([canonicalName, aliases]) => {
    const canonical = normalizeSpecificName(canonicalName);
    return [
      canonicalFieldName(canonical),
      {
        canonical,
        aliases: Array.isArray(aliases) ? aliases.map(alias => normalizeSpecificName(alias)).filter(Boolean) : []
      }
    ];
  })
);

function buildSpecificNameAliases(name = '') {
  const base = normalizeSpecificName(name);
  const out = new Set();
  if (!base) return out;

  const canonical = normalizeSpecificName(base);
  const group = RULE_SPECIFIC_ALIAS_LOOKUP.get(canonicalFieldName(canonical));
  const variants = new Set([
    canonical,
    `C:${canonical}`,
    ...(group?.aliases || [])
  ]);

  for (const variant of variants) {
    const normalized = normalizeSpecificName(variant);
    if (!normalized) continue;
    const key = normalizeKey(normalized);
    const canonicalKey = canonicalFieldName(normalized);
    if (key) out.add(key);
    if (canonicalKey) out.add(canonicalKey);
  }

  return out;
}

function canonicalizeSpecificsForComparison(aspects = {}) {
  const out = {};
  const entries = Object.entries(aspects || {})
    .map(([name, value]) => [normalizeSpecificName(name), value])
    .filter(([name]) => Boolean(name))
    .sort((a, b) => canonicalFieldName(a[0]).localeCompare(canonicalFieldName(b[0])) || a[0].localeCompare(b[0]));

  for (const [name, rawValue] of entries) {
    const values = normalizeAspectValues(rawValue);
    if (values.length === 0) continue;
    const unique = [];
    const seen = new Set();
    for (const value of values) {
      const key = canonicalFieldName(value);
      if (!key || seen.has(key)) continue;
      unique.push(value);
      seen.add(key);
    }
    unique.sort((a, b) => canonicalFieldName(a).localeCompare(canonicalFieldName(b)) || a.localeCompare(b));
    out[name] = unique;
  }

  return out;
}

function stringifySpecificsForComparison(aspects = {}) {
  try {
    return JSON.stringify(canonicalizeSpecificsForComparison(aspects));
  } catch (_) {
    return '';
  }
}

async function loadRulesLogicRows(airtableService, tableName = '') {
  const baseId = normalizeText(airtableService?.baseId || '');
  const table = normalizeText(tableName);
  const cacheKey = `${baseId}::${table.toLowerCase()}`;
  if (rulesLogicRowsCache.has(cacheKey)) {
    return rulesLogicRowsCache.get(cacheKey);
  }

  if (!airtableService || typeof airtableService.fetchAllRecords !== 'function') {
    throw new Error('Rules Logic lookup requires a valid Airtable service.');
  }
  if (!table) {
    throw new Error('Rules Logic table name is required.');
  }

  const rows = await airtableService.fetchAllRecords(table, []);
  rulesLogicRowsCache.set(cacheKey, rows);
  return rows;
}

function parseAllowedValues(value = '') {
  const text = normalizeText(value);
  if (!text) return [];
  return text
    .split(/[\n|;,]+/)
    .map(item => normalizeText(item))
    .filter(Boolean);
}

function normalizeRulesLogicPrefix(prefixValue = '') {
  const raw = normalizeText(prefixValue).toUpperCase();
  if (!raw || raw === 'ALL' || raw === '*') return 'ALL';
  const match = raw.match(/^(\d{3})$/);
  return match ? match[1] : raw;
}

function getRulesLogicItemSpecific(fields = {}) {
  return normalizeText(
    getFieldValueByName(fields, 'Item Specific') ||
      getFieldValueByName(fields, 'Item Specifics') ||
      getFieldValueByName(fields, 'Item Specific (eBay Download Only)') ||
      getFieldValueByName(fields, 'Item Specific(eBay Download Only)')
  );
}

function getRulesLogicAllowedValues(fields = {}) {
  return parseAllowedValues(
    getFieldValueByName(fields, 'Allowed Values') ||
      getFieldValueByName(fields, 'Valid Values') ||
      getFieldValueByName(fields, 'Valid Value') ||
      getFieldValueByName(fields, 'Format') ||
      getFieldValueByName(fields, 'Allowed/Valid Values')
  );
}

function getRulesLogicFixedValue(fields = {}) {
  return normalizeText(
    getFieldValueByName(fields, '(F) Value') ||
      getFieldValueByName(fields, 'F Value') ||
      getFieldValueByName(fields, 'Fixed Value') ||
      getFieldValueByName(fields, 'Value')
  );
}

function resolveRulesForPrefix(ruleSet = {}, ipnPrefix = '') {
  const out = new Map();
  const prefix = normalizeRulesLogicPrefix(ipnPrefix);
  const all = ruleSet?.all instanceof Map ? ruleSet.all : new Map();
  const byPrefix = ruleSet?.byPrefix instanceof Map ? ruleSet.byPrefix : new Map();

  for (const [key, payload] of all.entries()) {
    out.set(key, payload);
  }
  if (prefix !== 'ALL' && byPrefix.has(prefix)) {
    for (const [key, payload] of byPrefix.get(prefix).entries()) {
      out.set(key, payload);
    }
  }
  return out;
}

function buildRulesLogicRuleSetFromRows(rows = [], allowedRules = []) {
  const allowed = new Set(
    (Array.isArray(allowedRules) ? allowedRules : [])
      .map(value => normalizeText(value).toUpperCase())
      .filter(Boolean)
  );
  const all = new Map();
  const byPrefix = new Map();
  let scannedRows = 0;
  let loadedRules = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    scannedRows += 1;
    const fields = row?.fields || {};
    const ruleType = normalizeText(getFieldValueByName(fields, 'Rule')).toUpperCase();
    if (!ruleType || (allowed.size > 0 && !allowed.has(ruleType))) continue;

    const fieldName = getRulesLogicItemSpecific(fields);
    if (!fieldName) continue;

    const prefix = normalizeRulesLogicPrefix(getFieldValueByName(fields, 'IPN Prefix'));
    const ruleKey = normalizeKey(fieldName);
    if (!ruleKey) continue;

    const bucket = prefix === 'ALL'
      ? all
      : (() => {
          if (!byPrefix.has(prefix)) byPrefix.set(prefix, new Map());
          return byPrefix.get(prefix);
        })();

    if (!bucket.has(ruleKey)) {
      bucket.set(ruleKey, {
        fieldName,
        ruleType,
        allowedValues: getRulesLogicAllowedValues(fields),
        prefix
      });
      loadedRules += 1;
    }
  }

  return {
    all,
    byPrefix,
    scannedRows,
    loadedRules
  };
}

async function loadRulesLogicRuleSet(airtableService, tableName = '', allowedRules = []) {
  const baseId = normalizeText(airtableService?.baseId || '');
  const table = normalizeText(tableName);
  const allowedKey = (Array.isArray(allowedRules) ? allowedRules : [])
    .map(value => normalizeText(value).toUpperCase())
    .filter(Boolean)
    .sort()
    .join(',');
  const cacheKey = `${baseId}::${table.toLowerCase()}::${allowedKey}`;
  if (rulesLogicRuleSetCache.has(cacheKey)) return rulesLogicRuleSetCache.get(cacheKey);

  const rows = await loadRulesLogicRows(airtableService, table);
  const result = buildRulesLogicRuleSetFromRows(rows, allowedRules);
  const payload = {
    tableName: table,
    ...result,
    rowsLoaded: Array.isArray(rows) ? rows.length : 0
  };
  rulesLogicRuleSetCache.set(cacheKey, payload);
  return payload;
}

function buildRulesLogicFixedRuleSetFromRows(rows = []) {
  const all = new Map();
  const byPrefix = new Map();
  let scannedRows = 0;
  let loadedRules = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    scannedRows += 1;
    const fields = row?.fields || {};
    const ruleType = normalizeText(getFieldValueByName(fields, 'Rule')).toUpperCase();
    if (ruleType !== 'F') continue;

    const fieldName = getRulesLogicItemSpecific(fields);
    const fixedValue = getRulesLogicFixedValue(fields);
    if (!fieldName || !fixedValue) continue;

    const prefix = normalizeRulesLogicPrefix(getFieldValueByName(fields, 'IPN Prefix'));
    const ruleKey = normalizeKey(fieldName);
    if (!ruleKey) continue;

    const bucket = prefix === 'ALL'
      ? all
      : (() => {
          if (!byPrefix.has(prefix)) byPrefix.set(prefix, new Map());
          return byPrefix.get(prefix);
        })();

    if (!bucket.has(ruleKey)) {
      bucket.set(ruleKey, {
        fieldName,
        value: fixedValue,
        prefix
      });
      loadedRules += 1;
    }
  }

  return {
    all,
    byPrefix,
    scannedRows,
    loadedRules
  };
}

async function loadRulesLogicFixedRuleSet(airtableService, tableName = '') {
  const baseId = normalizeText(airtableService?.baseId || '');
  const table = normalizeText(tableName);
  const cacheKey = `${baseId}::${table.toLowerCase()}::fixed`;
  if (rulesLogicFixedRuleSetCache.has(cacheKey)) return rulesLogicFixedRuleSetCache.get(cacheKey);

  const rows = await loadRulesLogicRows(airtableService, table);
  const result = buildRulesLogicFixedRuleSetFromRows(rows);
  const payload = {
    tableName: table,
    ...result,
    rowsLoaded: Array.isArray(rows) ? rows.length : 0
  };
  rulesLogicFixedRuleSetCache.set(cacheKey, payload);
  return payload;
}

function resolveAllowlistEntry(allowlist, canonicalAllowlist, sourceName = '') {
  const source = normalizeSpecificName(sourceName);
  if (!source) return null;

  const sourceAliases = new Set([
    source,
    `C:${source}`
  ]);

  for (const alias of buildSpecificNameAliases(source)) {
    sourceAliases.add(alias);
  }

  for (const alias of sourceAliases) {
    const key = normalizeKey(alias);
    const canonicalKey = canonicalFieldName(alias);
    if (allowlist instanceof Map && key && allowlist.has(key)) return allowlist.get(key);
    if (allowlist instanceof Map && canonicalKey && allowlist.has(canonicalKey)) return allowlist.get(canonicalKey);
    if (canonicalAllowlist instanceof Map && key && canonicalAllowlist.has(key)) return canonicalAllowlist.get(key);
    if (canonicalAllowlist instanceof Map && canonicalKey && canonicalAllowlist.has(canonicalKey)) {
      return canonicalAllowlist.get(canonicalKey);
    }
  }

  return null;
}

function buildAllowlistFromRows(rows = [], ipnPrefix = '') {
  const normalizedPrefix = normalizeKey(ipnPrefix);
  const allowlist = new Map();
  const canonicalAllowlist = new Map();
  let prefixSpecificRows = 0;
  let globalRows = 0;

  const normalizedRows = Array.isArray(rows) ? rows : [];
  const rowsInPriorityOrder = [
    ...normalizedRows.filter(row => normalizeKey(getFieldValueByName(row?.fields || {}, 'IPN Prefix')) === normalizedPrefix && normalizedPrefix),
    ...normalizedRows.filter(row => normalizeKey(getFieldValueByName(row?.fields || {}, 'IPN Prefix')) === 'all')
  ];

  for (const row of rowsInPriorityOrder) {
    const fields = row?.fields || {};
    const prefixValue = normalizeText(getFieldValueByName(fields, 'IPN Prefix'));
    const itemSpecificRaw = normalizeText(
      getFieldValueByName(fields, 'Item Specific') ||
        getFieldValueByName(fields, 'Item Specifics')
    );
    if (!prefixValue || !itemSpecificRaw) continue;

    const normalizedRowPrefix = normalizeKey(prefixValue);
    if (normalizedRowPrefix !== 'all' && normalizedRowPrefix !== normalizedPrefix) continue;
    if (normalizedRowPrefix !== 'all' && !normalizedPrefix) continue;

    const canonicalName = normalizeSpecificName(itemSpecificRaw);
    if (!canonicalName) continue;

    const aliases = buildSpecificNameAliases(canonicalName);
    if (aliases.size === 0) continue;

    const entry = {
      name: canonicalName,
      rawName: itemSpecificRaw,
      prefix: prefixValue,
      priority: normalizedRowPrefix === 'all' ? 0 : 1
    };

    const canonicalKey = canonicalFieldName(canonicalName);
    const existingCanonical = canonicalAllowlist.get(canonicalKey);
    if (!existingCanonical || entry.priority >= existingCanonical.priority) {
      canonicalAllowlist.set(canonicalKey, entry);
    }

    for (const alias of aliases) {
      const keys = new Set([normalizeKey(alias), canonicalFieldName(alias)]);
      for (const key of keys) {
        if (!key) continue;
        const existing = allowlist.get(key);
        if (!existing || entry.priority >= existing.priority) {
          allowlist.set(key, entry);
        }
      }
    }

    if (normalizedRowPrefix === 'all') {
      globalRows += 1;
    } else {
      prefixSpecificRows += 1;
    }
  }

  return {
    allowlist,
    canonicalAllowlist,
    prefixSpecificRows,
    globalRows
  };
}

async function loadRulesLogicAllowlist(airtableService, tableName = '', ipnPrefix = '') {
  const baseId = normalizeText(airtableService?.baseId || '');
  const table = normalizeText(tableName);
  const prefix = normalizeText(ipnPrefix).trim();
  const cacheKey = `${baseId}::${table.toLowerCase()}::${prefix.toLowerCase()}`;

  if (rulesLogicAllowlistCache.has(cacheKey)) {
    return rulesLogicAllowlistCache.get(cacheKey);
  }

  const rows = await loadRulesLogicRows(airtableService, table);
  const result = buildAllowlistFromRows(rows, prefix);
  const payload = {
    tableName: table,
    ipnPrefix: prefix,
    allowlist: result.allowlist,
    canonicalAllowlist: result.canonicalAllowlist,
    prefixSpecificRows: result.prefixSpecificRows,
    globalRows: result.globalRows,
    rowsLoaded: Array.isArray(rows) ? rows.length : 0
  };
  rulesLogicAllowlistCache.set(cacheKey, payload);
  return payload;
}

function filterSpecificsByAllowlist(aspects = {}, allowlistContext = new Map()) {
  const filtered = {};
  const skipped = [];
  const entries = Object.entries(aspects || {});

  const allowlist = allowlistContext instanceof Map ? allowlistContext : allowlistContext?.allowlist;
  const canonicalAllowlist = allowlistContext instanceof Map ? allowlistContext : allowlistContext?.canonicalAllowlist;

  for (const [name, rawValue] of entries) {
    const sourceName = normalizeSpecificName(name);
    if (!sourceName) continue;

    const allowed = resolveAllowlistEntry(allowlist, canonicalAllowlist, sourceName);
    if (!allowed) {
      skipped.push(sourceName);
      continue;
    }

    mergeAspectValue(filtered, allowed.name || sourceName, rawValue);
  }

  return {
    filtered,
    skipped
  };
}

module.exports = {
  canonicalFieldName,
  canonicalizeSpecificsForComparison,
  filterSpecificsByAllowlist,
  getFieldValueByName,
  loadRulesLogicAllowlist,
  loadRulesLogicFixedRuleSet,
  loadRulesLogicRuleSet,
  normalizeAspectValues,
  normalizeKey,
  normalizeText,
  normalizeSpecificName,
  parseIpnPrefix,
  resolveRulesLogicTableName,
  resolveRulesForPrefix,
  stringifySpecificsForComparison
};

