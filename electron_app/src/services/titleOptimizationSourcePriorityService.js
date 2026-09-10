const DEFAULT_SOURCE_PRIORITY = Object.freeze([
  'manualOverride',
  'lockedFixedIpn',
  'itemSpecifics',
  'categoryConditions',
  'manufacturerPartNumber',
  'brandMake',
  'otherStructuredFields',
  'currentEbay',
  'rawHollander'
]);

const SOURCE_PRIORITY_METADATA = Object.freeze({
  manualOverride: {
    label: 'Manually Overridden Listing Value',
    description: 'A title or value explicitly approved or overridden by a Seymour Auto user. Always has highest authority.',
    locked: true
  },
  lockedFixedIpn: {
    label: 'Locked / Fixed IPN-Level Airtable Value',
    description: 'Authoritative IPN-level values explicitly locked or marked Fixed.'
  },
  itemSpecifics: {
    label: 'Structured Item Specifics',
    description: 'Structured verified item-specific attributes supplied to title optimization.'
  },
  categoryConditions: {
    label: 'Category Definitions / Conditions & Options',
    description: 'Approved category, part identity, fitment, and Conditions & Options data.'
  },
  manufacturerPartNumber: {
    label: 'Manufacturer Part Number',
    description: 'Verified MPN from C:Manufacturer Part Number or another explicitly approved structured MPN source.'
  },
  brandMake: {
    label: 'Brand / Make',
    description: 'Verified C:Brand / Make data.'
  },
  otherStructuredFields: {
    label: 'Other Approved Structured Airtable Fields',
    description: 'Additional configured structured source fields approved for title optimization.'
  },
  currentEbay: {
    label: 'Current eBay Listing Fields',
    description: 'Values already present on the current eBay listing.'
  },
  rawHollander: {
    label: 'Raw Hollander / Source Title',
    description: 'Original Hollander/source text. Lowest-authority fallback source.'
  }
});

const EXPECTED_KEYS = new Set(DEFAULT_SOURCE_PRIORITY);

function issue(code, message, key = null, index = null) {
  return { code, message, key, index };
}

function validateSourcePriority(order) {
  if (!Array.isArray(order)) return [issue('INVALID_ORDER', 'Source Priority order must be an array.')];
  const issues = [];
  const seen = new Set();

  order.forEach((key, index) => {
    if (!EXPECTED_KEYS.has(key)) {
      issues.push(issue('UNKNOWN_KEY', `Unknown Source Priority key '${String(key)}'.`, key, index));
      return;
    }
    if (seen.has(key)) issues.push(issue('DUPLICATE_KEY', `Duplicate Source Priority key '${key}'.`, key, index));
    seen.add(key);
  });

  DEFAULT_SOURCE_PRIORITY.forEach((key) => {
    if (!seen.has(key)) issues.push(issue('MISSING_KEY', `Missing Source Priority source '${key}'.`, key));
  });

  if (order.length !== DEFAULT_SOURCE_PRIORITY.length) {
    issues.push(issue('INVALID_COUNT', `Source Priority must contain exactly ${DEFAULT_SOURCE_PRIORITY.length} sources.`));
  }
  if (order[0] !== 'manualOverride') {
    issues.push(issue('MANUAL_OVERRIDE_POSITION', 'Manual Override must remain at priority 1.', 'manualOverride', order.indexOf('manualOverride')));
  }
  return issues;
}

function hydrateSourcePriority(raw = {}) {
  const persistedOrder = Array.isArray(raw.order) ? [...raw.order] : raw.order;
  const issues = validateSourcePriority(raw.order);
  const validUnique = [];
  const seen = new Set();
  (Array.isArray(raw.order) ? raw.order : []).forEach((key) => {
    if (!EXPECTED_KEYS.has(key) || seen.has(key) || key === 'manualOverride') return;
    seen.add(key);
    validUnique.push(key);
  });
  const order = [
    'manualOverride',
    ...validUnique,
    ...DEFAULT_SOURCE_PRIORITY.filter((key) => key !== 'manualOverride' && !seen.has(key))
  ];
  return {
    version: Number(raw.version) || 1,
    policy: raw.policy || 'titleOptimizationSourcePriority',
    order,
    persistedOrder,
    updatedAt: raw.updatedAt || null,
    updatedBy: raw.updatedBy || null,
    issues,
    requiresCorrection: issues.length > 0
  };
}

function moveSource(order, key, direction) {
  const next = Array.isArray(order) ? [...order] : [];
  const index = next.indexOf(key);
  if (key === 'manualOverride' || index < 1) return next;
  const target = direction === 'up' ? index - 1 : direction === 'down' ? index + 1 : index;
  if (target < 1 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function rowsForOrder(order, issues = []) {
  const missing = new Set(issues.filter((entry) => entry.code === 'MISSING_KEY').map((entry) => entry.key));
  return order.map((key, index) => ({
    key,
    priority: index + 1,
    ...SOURCE_PRIORITY_METADATA[key],
    locked: key === 'manualOverride',
    status: missing.has(key) ? 'Needs correction' : key === 'manualOverride' ? 'Locked' : 'Reorderable'
  }));
}

module.exports = {
  DEFAULT_SOURCE_PRIORITY,
  SOURCE_PRIORITY_METADATA,
  validateSourcePriority,
  hydrateSourcePriority,
  moveSource,
  rowsForOrder
};
