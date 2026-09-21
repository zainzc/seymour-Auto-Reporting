const SEEDS = [
  ['engines', 'Engines', [], ['300 Series'], ['Size', 'Engine Code', 'VIN Identifier', 'Authorized Tested/Warranty Terminology'], 'Engine-specific Restricted Terms remain controlled by Restricted Terms.\nDo not introduce Long Block or Short Block.\nTested/Warranty terminology requires applicable Seymour Auto authorization.'],
  ['transmissions', 'Transmissions', [], ['400 Series'], ['Transmission Code', 'Speed / Type', 'Drivetrain'], 'Future title behavior prefers "Automatic", not "Auto".\nIf expected transmission code cannot be verified, future runtime may flag it.'],
  ['mirrors', 'Mirrors', [], [], ['Adjustment', 'Type', 'Color', 'Paint Code'], null],
  ['rear-view-mirrors', 'Rear View Mirrors', [], [], ['Auto-Dimming / Manual'], 'Only use Auto-Dimming / Manual when verified.'],
  ['headlights', 'Headlights', [], [], ['Headlight', 'Verified Lighting Technology'], null],
  ['tail-lights', 'Tail Lights', [], [], ['Side', 'Lens Color', 'Lighting Technology'], null],
  ['sun-visors', 'Sun Visors', ['268'], [], ['Color', 'With / Without Illumination'], null],
  ['master-window-switch', 'Master Window Switch', ['641'], [], ['Master Power Window Switch'], null],
  ['column-switch', 'Column Switch', ['629'], [], ['Wiper / Turn Signal / Multifunction'], null],
  ['clusters-speedometers', 'Clusters / Speedometers', ['257'], [], ['Speedometer / Tachometer'], 'Apply #SKU rule where required.'],
  ['fuel-doors', 'Fuel Doors', [], [], ['Color', 'Paint Code'], null],
  ['fuel-pumps', 'Fuel Pumps', ['323'], [], ['Verified Fuel Type'], null],
  ['evap-canisters', 'EVAP Canisters', ['375'], [], ['EVAP Charcoal Canister', 'Manufacturer Part Number'], null],
  ['pedals', 'Pedals', ['234'], [], ['Gas Pedal', 'Accelerator Pedal'], null],
  ['actuators', 'Actuators', ['285'], [], ['Front / Rear', 'Side'], 'Use Side only when verified.'],
  ['airbags', 'Airbags', [], [], ['Verified Driver / Passenger Placement', 'Airbag'], 'Seymour Auto is authorized to sell applicable airbags.\nDo not automatically exclude airbag titles from optimization.'],
  ['fuse-boxes', 'Fuse Boxes', ['646', '663'], [], ['Engine Bay vs Interior according to verified prefix'], 'Do not infer Engine Bay vs Interior without verified prefix data.'],
  ['consoles', 'Consoles', [], [], ['Lid Only when applicable', 'Roof / Floor', 'Color'], null],
  ['seat-belts', 'Seat Belts', [], [], ['Buckle / Retractor / Receiver', 'Side', 'Color'], 'Do not infer component type when not verified.'],
  ['car-stereos', 'Car Stereos', [], [], ['Manufacturer Part Number', 'Stereo Receiver'], null]
];

const SEED_BY_ID = new Map(SEEDS.map((definition, index) => [`client-v5-${definition[0]}`, { definition, seedOrder: index + 1 }]));

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') : '';
}

function seedRule(definition, seedOrder, at, by) {
  const [slug, categoryName, prefixRefs, seriesRefs, priorityDetails, note] = definition;
  return {
    id: `client-v5-${slug}`, categoryName, prefixRefs: [...prefixRefs], seriesRefs: [...seriesRefs],
    priorityDetails: [...priorityDetails], enabled: true, origin: 'client-v5', seedOrder, note,
    createdAt: at, createdBy: by, updatedAt: at, updatedBy: by, deletedAt: null, deletedBy: null
  };
}

function seedCategoryRulesConfiguration({ now, actor } = {}) {
  const at = now || new Date().toISOString();
  const by = String(actor || 'system').trim() || 'system';
  return { version: 1, rules: SEEDS.map((definition, index) => seedRule(definition, index + 1, at, by)), updatedAt: at, updatedBy: by };
}

function listIssues(field, value, required = false) {
  if (!Array.isArray(value)) return [{ field, message: `${field} must be a list.` }];
  const issues = [];
  if (required && !value.length) issues.push({ field, message: 'Add at least one important verified detail.' });
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) { issues.push({ field, message: 'List values cannot be blank.' }); continue; }
    const normalized = normalizeText(entry);
    if (seen.has(normalized)) issues.push({ field, message: 'Duplicate values are not allowed in this list.' });
    seen.add(normalized);
  }
  return issues;
}

function validateCategoryRule(rule, peers = []) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return [{ field: 'rule', message: 'Rule must be an object.' }];
  const issues = [];
  const add = (field, message) => issues.push({ field, message });
  if (typeof rule.id !== 'string' || !rule.id.trim()) add('id', 'Rule ID is required.');
  if (typeof rule.categoryName !== 'string' || !rule.categoryName.trim()) add('categoryName', 'Category Name is required.');
  issues.push(...listIssues('prefixRefs', rule.prefixRefs), ...listIssues('seriesRefs', rule.seriesRefs), ...listIssues('priorityDetails', rule.priorityDetails, true));
  if (typeof rule.enabled !== 'boolean') add('enabled', 'Enabled must be on or off.');
  if (rule.note != null && typeof rule.note !== 'string') add('note', 'Notes must be text.');
  const normalized = normalizeText(rule.categoryName);
  if (normalized && peers.some(peer => peer && !peer.deletedAt && peer.id !== rule.id && normalizeText(peer.categoryName) === normalized)) add('categoryName', 'This Category Name already has a rule. Edit or re-enable the existing rule.');
  return issues;
}

function validatePersisted(rule) {
  const issues = validateCategoryRule(rule, []);
  const add = (field, message) => issues.push({ field, message });
  if (!['client-v5', 'custom'].includes(rule?.origin)) add('origin', 'Rule origin is missing or invalid.');
  if (rule?.origin === 'client-v5') {
    const seed = SEED_BY_ID.get(rule.id);
    if (!seed) add('id', 'Unknown client-v5 rule ID.');
    else if (rule.seedOrder !== seed.seedOrder) add('seedOrder', 'Client-v5 seed order is invalid.');
  } else if (rule?.seedOrder != null) add('seedOrder', 'Custom rules cannot use a client seed order.');
  for (const field of ['createdAt', 'updatedAt']) if (typeof rule?.[field] !== 'string' || !Number.isFinite(Date.parse(rule[field]))) add(field, `${field} is missing or invalid.`);
  for (const field of ['createdBy', 'updatedBy']) if (typeof rule?.[field] !== 'string' || !rule[field].trim()) add(field, `${field} is missing or invalid.`);
  if (rule?.deletedAt != null && (typeof rule.deletedAt !== 'string' || !Number.isFinite(Date.parse(rule.deletedAt)))) add('deletedAt', 'Deleted timestamp is invalid.');
  if (rule?.deletedAt != null && (typeof rule.deletedBy !== 'string' || !rule.deletedBy.trim())) add('deletedBy', 'Deleted actor is required.');
  return issues;
}

function compareCategoryRules(a, b) {
  const aSeed = a.origin === 'client-v5', bSeed = b.origin === 'client-v5';
  if (aSeed !== bSeed) return aSeed ? -1 : 1;
  if (aSeed) return a.seedOrder - b.seedOrder || String(a.id).localeCompare(String(b.id));
  return normalizeText(a.categoryName).localeCompare(normalizeText(b.categoryName)) || String(a.id).localeCompare(String(b.id));
}

function hydrateCategoryRulesConfiguration(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.rules)) {
    return { rules: [], issues: [{ id: null, message: 'Saved Category Rules configuration is malformed.' }], quarantined: raw === undefined ? [] : [raw] };
  }
  const preliminary = raw.rules.map((entry, index) => ({ entry, index, errors: validatePersisted(entry) }));
  const ids = new Map(), names = new Map();
  for (const item of preliminary) {
    const id = item.entry?.id;
    if (typeof id === 'string') ids.set(id, [...(ids.get(id) || []), item]);
    if (!item.entry?.deletedAt) {
      const name = normalizeText(item.entry?.categoryName);
      if (name) names.set(name, [...(names.get(name) || []), item]);
    }
  }
  for (const [id, group] of ids) if (group.length > 1) group.forEach(item => item.errors.push({ field: 'id', message: `Duplicate rule ID ${id}.` }));
  for (const [name, group] of names) if (group.length > 1) {
    const ruleIds = group.map(item => item.entry?.id || `entry-${item.index + 1}`).join(', ');
    group.forEach(item => item.errors.push({ field: 'categoryName', message: `Duplicate normalized Category Name "${name}" conflicts across rule IDs: ${ruleIds}.` }));
  }
  const rules = [], issues = [], quarantined = [];
  for (const item of preliminary) {
    const id = item.entry?.id || `entry-${item.index + 1}`;
    if (item.errors.length) {
      issues.push({ id, message: `${id}: ${item.errors.map(error => error.message).join(' ')}` });
      quarantined.push(item.entry);
    } else rules.push(item.entry);
  }
  return { rules: rules.sort(compareCategoryRules), issues, quarantined };
}

function enabledCategoryRules(config = {}) {
  return (Array.isArray(config.rules) ? config.rules : []).filter(rule => rule && rule.enabled && !rule.deletedAt).sort(compareCategoryRules);
}

module.exports = { seedCategoryRulesConfiguration, validateCategoryRule, hydrateCategoryRulesConfiguration, enabledCategoryRules, compareCategoryRules, normalizeText };
