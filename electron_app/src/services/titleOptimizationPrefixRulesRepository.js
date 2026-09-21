const { randomUUID } = require('node:crypto');
const { seedPrefixRulesConfiguration, validatePrefixRule, hydratePrefixRulesConfiguration, enabledPrefixRules } = require('./titleOptimizationPrefixRulesService');

function failure(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function createTitleOptimizationPrefixRulesRepository(dependencies = {}) {
  const getStored = dependencies.getStored || (() => undefined);
  const setStored = dependencies.setStored || (() => {});
  const getActor = dependencies.getActor || (async () => 'system');
  const now = dependencies.now || (() => new Date().toISOString());
  const createId = dependencies.createId || (() => `custom-${randomUUID()}`);

  async function actor() {
    try { return String(await getActor() || 'system').trim() || 'system'; }
    catch { return 'system'; }
  }
  function readRaw() {
    try { return getStored(); }
    catch (cause) { throw failure('CONFIG_READ_FAILED', `Unable to read Prefix Rules: ${cause?.message || cause}`); }
  }
  function persist(config) {
    try { setStored(config); }
    catch (cause) { throw failure('PERSISTENCE_ERROR', `Unable to save Prefix Rules: ${cause?.message || cause}`); }
  }
  async function ensureRaw() {
    const raw = readRaw();
    if (raw !== undefined) return raw;
    const initial = seedPrefixRulesConfiguration({ now: now(), actor: await actor() });
    persist(initial);
    return initial;
  }
  function mutable(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.rules)) {
      throw failure('CONFIG_INVALID', 'Saved Prefix Rules configuration is malformed and cannot be changed safely.');
    }
    return raw;
  }
  function display(raw) {
    const hydrated = hydratePrefixRulesConfiguration(raw);
    return { version: raw?.version || 1,
      rules: hydrated.rules.filter(rule => !rule.deletedAt).sort((a, b) => (a.priority || 0) - (b.priority || 0) || a.prefix.localeCompare(b.prefix)),
      issues: hydrated.issues, updatedAt: raw?.updatedAt || null, updatedBy: raw?.updatedBy || null };
  }
  async function load() { return display(await ensureRaw()); }
  function findIndex(raw, id) {
    const valid = hydratePrefixRulesConfiguration(raw).rules.find(rule => rule.id === id && !rule.deletedAt);
    return valid ? raw.rules.indexOf(valid) : raw.rules.findIndex(rule => rule?.id === id && !rule.deletedAt);
  }
  function validateCandidate(candidate, raw) {
    const peers = hydratePrefixRulesConfiguration(raw).rules.filter(rule => rule.id !== candidate.id);
    const issues = validatePrefixRule(candidate, peers);
    if (issues.length) throw failure('VALIDATION_ERROR', 'Please correct the rule fields and try again.', issues);
  }
  async function saveRule(input) {
    const raw = mutable(await ensureRaw());
    const id = input?.id ? String(input.id) : String(createId());
    const index = findIndex(raw, id);
    if (input?.id && index < 0) throw failure('NOT_FOUND', 'The rule no longer exists. Refresh and try again.');
    if (!input?.id && raw.rules.some(rule => rule?.id === id)) throw failure('DUPLICATE_ID', 'A rule with this ID already exists.');
    const old = index >= 0 ? raw.rules[index] : null;
    if (old?.deletedAt) throw failure('DELETED_RULE', 'Deleted rules cannot be edited.');
    if (old && !hydratePrefixRulesConfiguration(raw).rules.some(rule => rule.id === id)) throw failure('CONFIG_INVALID', 'This saved rule is malformed and cannot be edited safely.');
    const at = now(), by = await actor();
    const maxPriority = raw.rules.reduce((max, rule) => Math.max(max, Number.isSafeInteger(rule?.priority) ? rule.priority : 0), 0);
    const candidate = {
      id, prefix: input?.prefix, approvedPartTerms: input?.approvedPartTerms,
      specialTrigger: input?.specialTrigger ?? null, specialReplacement: input?.specialReplacement ?? null,
      note: input?.note === undefined ? old?.note ?? null : input.note, enabled: input?.enabled,
      origin: old?.origin || 'custom', priority: old?.priority || maxPriority + 10,
      createdAt: old?.createdAt || at, createdBy: old?.createdBy || by,
      updatedAt: at, updatedBy: by, deletedAt: null, deletedBy: null
    };
    validateCandidate(candidate, raw);
    const rules = [...raw.rules];
    if (index >= 0) rules[index] = candidate;
    else rules.push(candidate);
    persist({ ...raw, version: 1, rules, updatedAt: at, updatedBy: by });
    return candidate;
  }
  async function setRuleEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') throw failure('VALIDATION_ERROR', 'Enabled must be on or off.', [{ field: 'enabled', message: 'Choose on or off.' }]);
    const raw = mutable(await ensureRaw());
    const index = findIndex(raw, id);
    if (index < 0) throw failure('NOT_FOUND', 'The rule no longer exists. Refresh and try again.');
    const at = now(), by = await actor();
    const candidate = { ...raw.rules[index], enabled, updatedAt: at, updatedBy: by };
    if (!hydratePrefixRulesConfiguration(raw).rules.some(rule => rule.id === id)) throw failure('CONFIG_INVALID', 'This saved rule is malformed and cannot be toggled safely.');
    validateCandidate(candidate, raw);
    const rules = [...raw.rules];
    rules[index] = candidate;
    persist({ ...raw, rules, updatedAt: at, updatedBy: by });
    return candidate;
  }
  async function softDelete(id) {
    const raw = mutable(await ensureRaw());
    const index = findIndex(raw, id);
    if (index < 0) throw failure('NOT_FOUND', 'The rule no longer exists. Refresh and try again.');
    if (raw.rules[index].origin !== 'custom') throw failure('PROTECTED_RULE', 'Client-v5 rules cannot be deleted. Disable the rule instead.');
    const at = now(), by = await actor();
    const candidate = { ...raw.rules[index], enabled: false, deletedAt: at, deletedBy: by, updatedAt: at, updatedBy: by };
    const rules = [...raw.rules];
    rules[index] = candidate;
    persist({ ...raw, rules, updatedAt: at, updatedBy: by });
    return candidate;
  }
  async function getTitleOptimizationPrefixRules() {
    return enabledPrefixRules(hydratePrefixRulesConfiguration(await ensureRaw()));
  }
  return { load, saveRule, setRuleEnabled, softDelete, getTitleOptimizationPrefixRules };
}

module.exports = { createTitleOptimizationPrefixRulesRepository };
