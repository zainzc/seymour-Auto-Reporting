const DEFAULTS = [
  ['234', ['Gas Pedal', 'Accelerator Pedal']],
  ['257', ['Speedometer', 'Instrument Cluster']],
  ['268', ['Sun Visor']],
  ['285', ['Door Lock Actuator']],
  ['323', ['Fuel Pump Assembly']],
  ['375', ['EVAP Charcoal Canister']],
  ['629', ['Wiper Switch', 'Turn Signal Switch', 'Multifunction Switch']],
  ['641', ['Master Power Window Switch']],
  ['646', ['Fuse Box Engine Bay']],
  ['659', ['Headlight Dimmer Switch']],
  ['663', ['Fuse Box Interior']]
];

const SKU_NOTE = 'Future runtime may use #SKU for confirmed cluster/speedometer/gauge listings where a bare trailing number could resemble mileage.';

function seedPrefixRulesConfiguration({ now, actor } = {}) {
  const at = now || new Date().toISOString();
  const by = String(actor || 'system').trim() || 'system';
  return {
    version: 1,
    rules: DEFAULTS.map(([prefix, approvedPartTerms], index) => ({
      id: `client-v5-${prefix}`, prefix, approvedPartTerms: [...approvedPartTerms],
      specialTrigger: prefix === '629' ? 'Column Switch' : prefix === '641' ? 'Front Door Switch' : null,
      specialReplacement: prefix === '629' ? 'Wiper / Turn Signal / Multifunction Switch' : prefix === '641' ? 'Master Power Window Switch' : null,
      note: prefix === '257' ? SKU_NOTE : null,
      enabled: true, origin: 'client-v5', priority: (index + 1) * 10,
      createdAt: at, createdBy: by, updatedAt: at, updatedBy: by,
      deletedAt: null, deletedBy: null
    })),
    updatedAt: at, updatedBy: by
  };
}

function validatePrefixRule(rule, existing = []) {
  const issues = [];
  const add = (field, message) => issues.push({ field, message });
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return [{ field: 'rule', message: 'Rule must be an object.' }];
  if (typeof rule.id !== 'string' || !rule.id.trim()) add('id', 'Rule ID is required.');
  if (typeof rule.prefix !== 'string' || !rule.prefix.trim()) add('prefix', 'Prefix is required as text.');
  else if (rule.prefix !== rule.prefix.trim()) add('prefix', 'Remove spaces before or after the prefix.');
  if (!Array.isArray(rule.approvedPartTerms) || rule.approvedPartTerms.length === 0) add('approvedPartTerms', 'Add at least one approved part term.');
  else {
    const seen = new Set();
    for (const term of rule.approvedPartTerms) {
      if (typeof term !== 'string' || !term.trim()) add('approvedPartTerms', 'Approved part terms cannot be blank.');
      else if (seen.has(term.trim().toLocaleLowerCase('en-US'))) add('approvedPartTerms', 'Approved part terms must be unique.');
      else seen.add(term.trim().toLocaleLowerCase('en-US'));
    }
  }
  const trigger = typeof rule.specialTrigger === 'string' ? rule.specialTrigger.trim() : '';
  const replacement = typeof rule.specialReplacement === 'string' ? rule.specialReplacement.trim() : '';
  if (rule.specialTrigger != null && typeof rule.specialTrigger !== 'string') add('specialTrigger', 'Special trigger must be text.');
  if (rule.specialReplacement != null && typeof rule.specialReplacement !== 'string') add('specialReplacement', 'Special replacement must be text.');
  if (trigger && !replacement) add('specialReplacement', 'Enter a replacement when a special trigger is provided.');
  if (replacement && !trigger) add('specialTrigger', 'Enter a trigger when a special replacement is provided.');
  if (rule.note != null && typeof rule.note !== 'string') add('note', 'Note must be text.');
  if (typeof rule.enabled !== 'boolean') add('enabled', 'Enabled must be on or off.');
  if (rule.priority != null && (!Number.isSafeInteger(rule.priority) || rule.priority <= 0)) add('priority', 'Priority must be a positive whole number.');
  if (!Array.isArray(existing)) existing = [];
  if (existing.some(other => other?.id === rule.id)) add('id', 'Duplicate rule ID.');
  if (typeof rule.prefix === 'string' && existing.some(other => !other?.deletedAt && other?.prefix === rule.prefix)) add('prefix', 'This prefix already has a rule. Edit or re-enable the existing rule.');
  return issues;
}

function validatePersistedPrefixRule(rule, existing = []) {
  const issues = validatePrefixRule(rule, existing);
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return issues;
  const add = (field, message) => issues.push({ field, message });
  if (!['client-v5', 'custom'].includes(rule.origin)) add('origin', 'Rule origin is missing or invalid.');
  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof rule[field] !== 'string' || !Number.isFinite(Date.parse(rule[field]))) add(field, `${field} is missing or invalid.`);
  }
  for (const field of ['createdBy', 'updatedBy']) {
    if (typeof rule[field] !== 'string' || !rule[field].trim()) add(field, `${field} is missing or invalid.`);
  }
  if (rule.deletedAt != null && (typeof rule.deletedAt !== 'string' || !Number.isFinite(Date.parse(rule.deletedAt)))) add('deletedAt', 'Deleted timestamp is invalid.');
  if (rule.deletedAt != null && (typeof rule.deletedBy !== 'string' || !rule.deletedBy.trim())) add('deletedBy', 'Deleted actor is required.');
  return issues;
}

function hydratePrefixRulesConfiguration(raw) {
  const rules = [], issues = [], quarantined = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.rules)) {
    return { rules, issues: [{ id: null, message: 'Saved Prefix Rules configuration is malformed.' }], quarantined: raw === undefined ? [] : [raw] };
  }
  const seenIds = new Set();
  const seenPrefixes = new Set();
  raw.rules.forEach((entry, index) => {
    const id = typeof entry?.id === 'string' && entry.id.trim() ? entry.id : `entry-${index + 1}`;
    const errors = validatePersistedPrefixRule(entry, rules);
    if (seenIds.has(entry?.id) && !errors.some(issue => issue.field === 'id')) errors.push({ field: 'id', message: 'Duplicate rule ID.' });
    if (!entry?.deletedAt && seenPrefixes.has(entry?.prefix) && !errors.some(issue => issue.field === 'prefix')) errors.push({ field: 'prefix', message: 'Duplicate prefix.' });
    if (errors.length) {
      issues.push({ id, message: `${id}: ${errors.map(issue => issue.message).join(' ')}` });
      quarantined.push(entry);
    } else {
      rules.push(entry);
      seenIds.add(entry.id);
      if (!entry.deletedAt) seenPrefixes.add(entry.prefix);
    }
  });
  return { rules, issues, quarantined };
}

function enabledPrefixRules(config = {}) {
  return [...(Array.isArray(config.rules) ? config.rules : [])]
    .filter(rule => rule && rule.enabled && !rule.deletedAt)
    .sort((a, b) => (a.priority || 0) - (b.priority || 0) || String(a.prefix).localeCompare(String(b.prefix)) || String(a.id).localeCompare(String(b.id)));
}

module.exports = { seedPrefixRulesConfiguration, validatePrefixRule, hydratePrefixRulesConfiguration, enabledPrefixRules };
