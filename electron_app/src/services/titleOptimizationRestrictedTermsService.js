const SEED_DEFINITIONS = [
  ['long-block', 'Long Block', 'never-introduce', 'engine', true, 'Never introduce Long Block into an optimized engine title. Do not infer it from category, interchange prefix, engine size, engine code, VIN, item specifics, description, fitment, or general automotive knowledge.'],
  ['short-block', 'Short Block', 'never-introduce', 'engine', true, 'Never introduce Short Block into an optimized engine title. Do not infer it from category, interchange prefix, engine size, engine code, VIN, item specifics, description, fitment, or general automotive knowledge.'],
  ['complete', 'Complete', 'requires-authorization', 'engine', false, null],
  ['complete-engine', 'Complete Engine', 'requires-authorization', 'engine', false, null],
  ['complete-assembly', 'Complete Assembly', 'requires-authorization', 'engine', false, null],
  ['rebuilt', 'Rebuilt', 'requires-authorization', 'engine', false, null],
  ['remanufactured', 'Remanufactured', 'requires-authorization', 'engine', false, null],
  ['tested', 'Tested', 'requires-authorization', 'engine', false, 'May only be used when explicitly authorized by Seymour Auto for applicable engine listings.'],
  ['6-mo-warranty', '6 Mo Warranty', 'requires-authorization', 'engine', false, 'May only be used when explicitly authorized by Seymour Auto for applicable engine listings.'],
  ['oem-part', 'OEM Part', 'remove-noise', 'all', false, 'Do not prepend OEM Part; remove it when it is not legitimate product information.'],
  ['used-auto', 'Used Auto', 'remove-noise', 'all', false, null],
  ['redundant-part', 'Redundant Part', 'remove-noise', 'all', false, null],
  ['ecm', 'ECM', 'must-preserve', 'all', false, 'When verified and relevant, do not remove merely to save title space.'],
  ['abs', 'ABS', 'must-preserve', 'all', false, 'When verified and relevant, do not remove merely to save title space.'],
  ['bcm', 'BCM', 'must-preserve', 'all', false, 'When verified and relevant, do not remove merely to save title space.'],
  ['pcm', 'PCM', 'must-preserve', 'all', false, 'When verified and relevant, do not remove merely to save title space.'],
  ['tcm', 'TCM', 'must-preserve', 'all', false, 'When verified and relevant, do not remove merely to save title space.'],
  ['evap', 'EVAP', 'must-preserve', 'all', false, 'When verified and relevant, do not remove merely to save title space.'],
  ['hvac', 'HVAC', 'must-preserve', 'all', false, 'When verified and relevant, do not remove merely to save title space.'],
  ['tpms', 'TPMS', 'must-preserve', 'all', false, 'When verified and relevant, do not remove merely to save title space.']
];

const RULE_TYPES = new Set(['never-introduce', 'requires-authorization', 'remove-noise', 'must-preserve']);
const SCOPES = new Set(['all', 'engine']);
const LOCKED_DEFINITIONS = SEED_DEFINITIONS.filter(([, , , , locked]) => locked);
const SEED_ORDER = new Map(SEED_DEFINITIONS.map(([slug], index) => [`client-v5-${slug}`, index]));
const SEED_BY_ID = new Map(SEED_DEFINITIONS.map(definition => [`client-v5-${definition[0]}`, definition]));

function normalizedTerm(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') : '';
}

function seededRule([slug, term, ruleType, scope, locked, note], at, by) {
  return {
    id: `client-v5-${slug}`, term, ruleType, scope, enabled: true, locked,
    origin: 'client-v5', note, createdAt: at, createdBy: by, updatedAt: at, updatedBy: by,
    deletedAt: null, deletedBy: null
  };
}

function seedRestrictedTermsConfiguration({ now, actor } = {}) {
  const at = now || new Date().toISOString();
  const by = String(actor || 'system').trim() || 'system';
  return { version: 1, rules: SEED_DEFINITIONS.map(definition => seededRule(definition, at, by)), updatedAt: at, updatedBy: by };
}

function validateRestrictedTerm(rule, peers = []) {
  const issues = [];
  const add = (field, message) => issues.push({ field, message });
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return [{ field: 'rule', message: 'Rule must be an object.' }];
  if (typeof rule.id !== 'string' || !rule.id.trim()) add('id', 'Rule ID is required.');
  if (typeof rule.term !== 'string' || !rule.term.trim()) add('term', 'Term is required.');
  if (!RULE_TYPES.has(rule.ruleType)) add('ruleType', 'Choose a valid rule type.');
  if (!SCOPES.has(rule.scope)) add('scope', 'Choose a valid scope.');
  if (typeof rule.enabled !== 'boolean') add('enabled', 'Enabled must be on or off.');
  if (rule.note != null && typeof rule.note !== 'string') add('note', 'Notes must be text.');
  if (!Array.isArray(peers)) peers = [];
  if (peers.some(other => other?.id === rule.id)) add('id', 'Duplicate rule ID.');
  const normalized = normalizedTerm(rule.term);
  if (normalized && peers.some(other => !other?.deletedAt && normalizedTerm(other?.term) === normalized)) {
    add('term', 'This term already has a rule. Edit or re-enable the existing rule.');
  }
  return issues;
}

function validatePersistedRestrictedTerm(rule, peers = []) {
  const issues = validateRestrictedTerm(rule, peers);
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return issues;
  const add = (field, message) => issues.push({ field, message });
  if (!['client-v5', 'custom'].includes(rule.origin)) add('origin', 'Rule origin is missing or invalid.');
  if (typeof rule.locked !== 'boolean') add('locked', 'Rule lock state is missing or invalid.');
  if (rule.origin === 'client-v5') {
    const definition = SEED_BY_ID.get(rule.id);
    if (!definition) add('id', 'Unknown client-v5 rule ID.');
    else {
      const [, , , , locked] = definition;
      if (rule.locked !== locked) {
        add('rule', 'Client-v5 lock metadata is invalid.');
      }
    }
  }
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

function canonicalLockedRule(definition) {
  return seededRule(definition, '1970-01-01T00:00:00.000Z', 'system');
}

function isAvailableLockedRule(rule, definition) {
  const [slug] = definition;
  return rule && !rule.deletedAt && rule.enabled === true && rule.locked === true && rule.origin === 'client-v5'
    && rule.id === `client-v5-${slug}`;
}

function lockedWarnings(rules) {
  return LOCKED_DEFINITIONS.flatMap(definition => {
    const [, term] = definition;
    return rules.some(rule => isAvailableLockedRule(rule, definition)) ? [] : [{
      id: `client-v5-${definition[0]}`,
      message: `Locked restricted term ${term} is missing or unavailable; a canonical enabled rule will be used in memory.`
    }];
  });
}

function hydrateRestrictedTermsConfiguration(raw) {
  const rules = [], issues = [], quarantined = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.rules)) {
    const rootIssue = { id: null, message: 'Saved Restricted Terms configuration is malformed.' };
    return { rules, issues: [rootIssue, ...lockedWarnings(rules)], quarantined: raw === undefined ? [] : [raw] };
  }
  const seenIds = new Set();
  const seenTerms = new Set();
  raw.rules.forEach((entry, index) => {
    const id = typeof entry?.id === 'string' && entry.id.trim() ? entry.id : `entry-${index + 1}`;
    const errors = validatePersistedRestrictedTerm(entry, rules);
    const normalized = normalizedTerm(entry?.term);
    if (seenIds.has(entry?.id) && !errors.some(issue => issue.field === 'id')) errors.push({ field: 'id', message: 'Duplicate rule ID.' });
    if (!entry?.deletedAt && normalized && seenTerms.has(normalized) && !errors.some(issue => issue.field === 'term')) errors.push({ field: 'term', message: 'Duplicate term.' });
    if (errors.length) {
      issues.push({ id, message: `${id}: ${errors.map(issue => issue.message).join(' ')}` });
      quarantined.push(entry);
    } else {
      rules.push(entry);
      seenIds.add(entry.id);
      if (!entry.deletedAt) seenTerms.add(normalized);
    }
  });
  return { rules, issues: [...issues, ...lockedWarnings(rules)], quarantined };
}

function compareRules(a, b) {
  const left = SEED_ORDER.has(a.id) ? SEED_ORDER.get(a.id) : Number.MAX_SAFE_INTEGER;
  const right = SEED_ORDER.has(b.id) ? SEED_ORDER.get(b.id) : Number.MAX_SAFE_INTEGER;
  return left - right || String(a.term).localeCompare(String(b.term)) || String(a.id).localeCompare(String(b.id));
}

function enabledRestrictedTerms(config = {}) {
  const rules = Array.isArray(config.rules) ? config.rules : [];
  const lockedIds = new Set(LOCKED_DEFINITIONS.map(([slug]) => `client-v5-${slug}`));
  const enabled = rules.filter(rule => rule && rule.enabled && !rule.deletedAt && !lockedIds.has(rule.id));
  const locked = LOCKED_DEFINITIONS.map(definition => rules.find(rule => isAvailableLockedRule(rule, definition)) || canonicalLockedRule(definition));
  return [...locked, ...enabled].sort(compareRules);
}

module.exports = { seedRestrictedTermsConfiguration, validateRestrictedTerm, hydrateRestrictedTermsConfiguration, enabledRestrictedTerms };
