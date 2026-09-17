const MAPPINGS = [
  ['Headlight', ['Headlamp']], ['Tail Light', ['Tail Lamp']],
  ['Side View Mirror', ['Door Mirror', 'Side Mirror']], ['Fuel Tank', ['Gas Tank']],
  ['Air Filter Box', ['Air Cleaner']], ['Sun Visor', ['Sunvisor']],
  ['Instrument Cluster', ['Speedometer', 'Gauge Cluster']], ['Caliper', ['Disc Brake']],
  ['Blower Motor', ['Heater Fan']], ['Radio', ['Stereo Receiver']]
];
const CONDITIONS = new Set(['always']);
const SCOPES = new Set(['all']);
const CV_AXLE_NOTE = 'CV Axle may only be used for a confirmed FRONT half-shaft; never for rear axle or axle housing.';
const normalize = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') : '';

function seedSynonymConfiguration({ now, actor } = {}) {
  const at = now || new Date().toISOString();
  const by = String(actor || 'system').trim() || 'system';
  return {
    version: 1, enabled: true,
    rules: MAPPINGS.map(([primaryTerm, synonyms], index) => ({
      id: `client-v5-${String(index + 1).padStart(2, '0')}`, primaryTerm, synonyms: [...synonyms],
      condition: 'always', appliesTo: 'all', priority: (index + 1) * 10,
      enabled: true, origin: 'client-v5', note: null,
      createdAt: at, createdBy: by, updatedAt: at, updatedBy: by,
      deletedAt: null, deletedBy: null
    })),
    policies: { cvAxleFrontHalfShaft: {
      condition: 'confirmed-front-half-shaft',
      note: CV_AXLE_NOTE
    } },
    updatedAt: at, updatedBy: by
  };
}

function validateSynonymRule(rule, existing = []) {
  const issues = [];
  const add = (field, message) => issues.push({ field, message });
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return [{ field: 'rule', message: 'Rule must be an object.' }];
  if (typeof rule.id !== 'string' || !rule.id.trim()) add('id', 'Rule ID is required.');
  if (typeof rule.primaryTerm !== 'string' || !rule.primaryTerm.trim()) add('primaryTerm', 'Primary Term is required.');
  if (!Array.isArray(rule.synonyms) || !rule.synonyms.length) add('synonyms', 'At least one synonym is required.');
  else {
    const seen = new Set();
    for (const synonym of rule.synonyms) {
      const key = normalize(synonym);
      if (!key) add('synonyms', 'Synonyms cannot be blank.');
      else if (seen.has(key)) add('synonyms', 'Synonyms must be unique.');
      seen.add(key);
    }
  }
  if (!CONDITIONS.has(rule.condition)) add('condition', 'Choose a valid condition.');
  if (!SCOPES.has(rule.appliesTo)) add('appliesTo', 'Choose a valid Applies To value.');
  if (!Number.isSafeInteger(rule.priority) || rule.priority <= 0) add('priority', 'Priority must be a positive whole number.');
  if (typeof rule.enabled !== 'boolean') add('enabled', 'Enabled must be on or off.');
  const others = Array.isArray(existing) ? existing : [];
  if (others.some(other => other?.id === rule.id)) add('id', 'Duplicate rule ID.');
  const fingerprint = [normalize(rule.primaryTerm), rule.condition, rule.appliesTo].join('|');
  if (rule.enabled === true && others.some(other => other?.enabled === true && !other.deletedAt &&
      [normalize(other.primaryTerm), other.condition, other.appliesTo].join('|') === fingerprint)) {
    add('primaryTerm', 'An active rule with this primary term, condition, and scope already exists.');
  }
  return issues;
}

function hydrateSynonymConfiguration(raw) {
  const rules = [], issues = [], quarantined = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.rules)) {
    return { enabled: false, rules, policies: {}, issues: [{ id: null, message: 'Saved synonym configuration is malformed.' }], quarantined: raw === undefined ? [] : [raw] };
  }
  const ids = new Set();
  raw.rules.forEach((entry, index) => {
    const id = typeof entry?.id === 'string' && entry.id.trim() ? entry.id : `entry-${index + 1}`;
    const errors = validateSynonymRule(entry, rules);
    if (ids.has(entry?.id) && !errors.some(issue => issue.field === 'id')) errors.push({ field: 'id', message: 'Duplicate rule ID.' });
    if (errors.length) {
      issues.push({ id, message: `${id}: ${errors.map(issue => issue.message).join(' ')}` });
      quarantined.push(entry);
    } else rules.push(entry);
    if (typeof entry?.id === 'string') ids.add(entry.id);
  });
  if (typeof raw.enabled !== 'boolean') issues.push({ id: null, message: 'Saved master enabled value is malformed.' });
  const cvPolicy = raw.policies?.cvAxleFrontHalfShaft;
  const validCvPolicy = cvPolicy?.condition === 'confirmed-front-half-shaft' && cvPolicy?.note === CV_AXLE_NOTE;
  if (!validCvPolicy) issues.push({ id: 'cvAxleFrontHalfShaft', message: 'CV Axle policy is missing or malformed.' });
  return { enabled: raw.enabled === true, rules, policies: validCvPolicy ? { cvAxleFrontHalfShaft: cvPolicy } : {}, issues, quarantined };
}

function enabledSynonymRules(config = {}) {
  return [...(Array.isArray(config.rules) ? config.rules : [])]
    .filter(rule => rule && rule.enabled && !rule.deletedAt)
    .sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)));
}

module.exports = { seedSynonymConfiguration, validateSynonymRule, hydrateSynonymConfiguration, enabledSynonymRules };
