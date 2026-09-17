const CLIENT_V5_SWAPS = [
  ['Headlamp', 'Headlight'],
  ['Tail Lamp', 'Tail Light'],
  ['Door Mirror', 'Side View Mirror'],
  ['Door Side View Mirror', 'Side View Mirror'],
  ['Inside Mirror', 'Rear View Mirror'],
  ['High Mounted Stop Light', 'Third Brake Light'],
  ['Mount Stop Light', 'Third Brake Light'],
  ['Throttle Valve Assembly', 'Throttle Body'],
  ['Throttle Valve', 'Throttle Body'],
  ['Anti-Lock Brake Part', 'ABS Module'],
  ['Blower Motor Fan', 'HVAC Blower Motor'],
  ['Door Lock Actuator Latch', 'Door Lock Actuator'],
  ['Fog-driving', 'Fog Light'],
  ['Audio Equipment', 'Radio Stereo Receiver'],
  ['Steering Gear', 'Steering Rack'],
  ['Wiper Transmission', 'Wiper Linkage'],
  ['Speedometer Head', 'Speedometer'],
  ['Speedometer Cluster', 'Instrument Cluster'],
  ['Fuel Vapor Canister', 'EVAP Charcoal Canister'],
  ['Coil / Ignitor', 'Ignition Coil'],
  ['Coil Pack', 'Ignition Coil'],
  ['Floor Shift Assembly', 'Shifter Assembly'],
  ['Air Cleaner', 'Air Filter Box'],
  ['Info-GPS-TV Screen', 'Navigation Display Screen'],
  ['Temperature Control AC Climate', 'Temperature Control'],
  ['Fuel / Filler Door', 'Gas Fuel Door'],
  ['Spindle / Knuckle', 'Steering Knuckle Spindle'],
  ['Am-fm', 'AM FM'],
  ['Am-fm-cd', 'AM FM CD'],
  ['Chassis ECM', 'Control Module'],
  ['Auto', 'Automatic'],
  ['Radio', 'Radio Stereo Receiver'],
  ['User Defined', null],
  ['Accelerator Gas Pedal', 'Accelerator Pedal']
];

const CONDITIONS = new Set(['always', 'transmission-context', 'context-verified']);
const ACTIONS = new Set(['replace', 'remove']);
const APPLIES_TO = new Set(['all', 'transmission']);

function normalizedSource(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function seedTerminologyRules({ now, actor } = {}) {
  const timestamp = now || new Date().toISOString();
  const author = String(actor || 'system').trim() || 'system';
  return CLIENT_V5_SWAPS.map(([sourceTerm, replacementTerm], index) => {
    const action = sourceTerm === 'User Defined' ? 'remove' : 'replace';
    const transmission = sourceTerm === 'Auto';
    const verified = sourceTerm === 'Anti-Lock Brake Part' || sourceTerm === 'Coil / Ignitor';
    const conditionConfig = sourceTerm === 'Anti-Lock Brake Part'
      ? { criterion: 'pump-verified', whenVerified: 'ABS Pump', otherwise: 'ABS Module' }
      : sourceTerm === 'Coil / Ignitor'
        ? { criterion: 'identity-confirmed', whenVerified: 'Ignition Coil', otherwise: null }
        : null;
    return {
      id: `client-v5-${String(index + 1).padStart(2, '0')}`,
      sourceTerm,
      action,
      replacementTerm: action === 'remove' ? null : replacementTerm,
      condition: verified ? 'context-verified' : transmission ? 'transmission-context' : 'always',
      conditionConfig,
      appliesTo: transmission ? 'transmission' : 'all',
      priority: (index + 1) * 10,
      enabled: true,
      origin: 'client-v5',
      note: sourceTerm === 'Chassis ECM' ? 'Retain ECM when useful as a buyer search term.' : sourceTerm === 'User Defined' ? 'Use verified Category/Part information; no runtime substitution is implemented yet.' : null,
      createdAt: timestamp,
      createdBy: author,
      updatedAt: timestamp,
      updatedBy: author,
      deletedAt: null,
      deletedBy: null
    };
  });
}

function validateRule(rule, existing = []) {
  const issues = [];
  const add = (field, message) => issues.push({ field, message });
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return [{ field: 'rule', message: 'Rule must be an object.' }];
  if (!String(rule.sourceTerm || '').trim()) add('sourceTerm', 'Source Term is required.');
  if (!ACTIONS.has(rule.action)) add('action', 'Choose Replace or Remove.');
  if (rule.action === 'replace' && !String(rule.replacementTerm || '').trim()) add('replacementTerm', 'Replacement Term is required for Replace.');
  if (rule.action === 'remove' && rule.replacementTerm !== null) add('replacementTerm', 'Remove rules must store a null replacement term.');
  if (!CONDITIONS.has(rule.condition)) add('condition', 'Choose a valid condition.');
  if (!APPLIES_TO.has(rule.appliesTo)) add('appliesTo', 'Choose a valid Applies To value.');
  if (!Number.isSafeInteger(rule.priority) || rule.priority <= 0) add('priority', 'Priority must be a positive whole number.');
  if (typeof rule.enabled !== 'boolean') add('enabled', 'Enabled must be on or off.');
  if (rule.condition === 'context-verified') {
    const config = rule.conditionConfig;
    if (!config || typeof config !== 'object' || !String(config.criterion || '').trim()) add('conditionConfig.criterion', 'Verification criterion is required.');
    if (!config || typeof config !== 'object' || !String(config.whenVerified || '').trim()) add('conditionConfig.whenVerified', 'Verified replacement is required.');
    if (config && config.otherwise != null && typeof config.otherwise !== 'string') add('conditionConfig.otherwise', 'Otherwise replacement must be text or blank.');
  }
  const fingerprint = [normalizedSource(rule.sourceTerm), rule.action, rule.condition, rule.appliesTo].join('|');
  if (rule.enabled === true && (Array.isArray(existing) ? existing : []).some(other => other && other.id !== rule.id && other.enabled === true && !other.deletedAt && [normalizedSource(other.sourceTerm), other.action, other.condition, other.appliesTo].join('|') === fingerprint)) {
    add('sourceTerm', 'An active rule with this source, action, condition, and context already exists.');
  }
  return issues;
}

function hydrateTerminologyConfiguration(configuration) {
  const rules = [];
  const issues = [];
  const quarantined = [];
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) || !Array.isArray(configuration.rules)) {
    return { rules, issues: [{ id: null, message: 'Saved terminology configuration is malformed.' }], quarantined: configuration == null ? [] : [configuration] };
  }
  configuration.rules.forEach((entry, index) => {
    const id = typeof entry?.id === 'string' && entry.id.trim() ? entry.id : `entry-${index + 1}`;
    const errors = [
      ...(typeof entry?.id === 'string' && entry.id.trim() ? [] : [{ field: 'id', message: 'Rule ID is missing.' }]),
      ...(rules.some(rule => rule.id === entry?.id) ? [{ field: 'id', message: 'Duplicate rule ID.' }] : []),
      ...validateRule(entry, rules)
    ];
    if (errors.length) {
      issues.push({ id, message: `${id}: ${errors.map(error => error.message).join(' ')}` });
      quarantined.push(entry);
    } else {
      rules.push(entry);
    }
  });
  return { rules, issues, quarantined };
}

function visibleRules(configuration = {}) {
  return [...(Array.isArray(configuration.rules) ? configuration.rules : [])]
    .filter(rule => rule && !rule.deletedAt)
    .sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)));
}

function enabledRules(configuration = {}) {
  return visibleRules(configuration).filter(rule => rule.enabled);
}

module.exports = { seedTerminologyRules, validateRule, hydrateTerminologyConfiguration, visibleRules, enabledRules, normalizedSource };
