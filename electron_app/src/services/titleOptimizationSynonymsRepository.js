const { randomUUID } = require('node:crypto');
const { seedSynonymConfiguration, validateSynonymRule, hydrateSynonymConfiguration, enabledSynonymRules } = require('./titleOptimizationSynonymsService');

function failure(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function createTitleOptimizationSynonymsRepository(dependencies = {}) {
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
    catch (cause) { throw failure('CONFIG_READ_FAILED', `Unable to read Synonyms: ${cause?.message || cause}`); }
  }
  function persist(config) {
    try { setStored(config); }
    catch (cause) { throw failure('PERSISTENCE_ERROR', `Unable to save Synonyms: ${cause?.message || cause}`); }
  }
  async function ensureRaw() {
    const raw = readRaw();
    if (raw !== undefined) return raw;
    const initial = seedSynonymConfiguration({ now: now(), actor: await actor() });
    persist(initial);
    return initial;
  }
  function mutable(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.rules)) {
      throw failure('CONFIG_INVALID', 'Saved Synonyms configuration is malformed and cannot be changed safely.');
    }
    return raw;
  }
  function display(raw) {
    const hydrated = hydrateSynonymConfiguration(raw);
    return { version: raw?.version || 1, enabled: hydrated.enabled,
      rules: hydrated.rules.filter(rule => !rule.deletedAt).sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id))),
      policies: hydrated.policies, issues: hydrated.issues,
      updatedAt: raw?.updatedAt || null, updatedBy: raw?.updatedBy || null };
  }
  async function load() { return display(await ensureRaw()); }
  function otherValidRules(raw, id) {
    return hydrateSynonymConfiguration(raw).rules.filter(rule => rule.id !== id);
  }
  async function saveRule(input) {
    const raw = mutable(await ensureRaw());
    const id = input?.id ? String(input.id) : String(createId());
    const index = raw.rules.findIndex(rule => rule?.id === id);
    if (input?.id && index < 0) throw failure('NOT_FOUND', 'The rule no longer exists. Refresh and try again.');
    if (!input?.id && index >= 0) throw failure('DUPLICATE_ID', 'A rule with this ID already exists.');
    const old = index >= 0 ? raw.rules[index] : null;
    if (old?.deletedAt) throw failure('DELETED_RULE', 'Deleted rules cannot be edited.');
    if (old && validateSynonymRule(old, otherValidRules(raw, id)).length) throw failure('CONFIG_INVALID', 'This saved rule is malformed and cannot be edited safely.');
    const at = now(), by = await actor();
    const candidate = {
      id, primaryTerm: input?.primaryTerm, synonyms: input?.synonyms,
      condition: input?.condition, appliesTo: input?.appliesTo,
      priority: input?.priority, enabled: input?.enabled,
      origin: old?.origin || 'custom', note: input?.note ?? old?.note ?? null,
      createdAt: old?.createdAt || at, createdBy: old?.createdBy || by,
      updatedAt: at, updatedBy: by, deletedAt: null, deletedBy: null
    };
    const issues = validateSynonymRule(candidate, otherValidRules(raw, id));
    if (issues.length) throw failure('VALIDATION_ERROR', 'Please correct the rule fields and try again.', issues);
    const rules = [...raw.rules];
    if (index >= 0) rules[index] = candidate;
    else rules.push(candidate);
    persist({ ...raw, version: 1, rules, updatedAt: at, updatedBy: by });
    return candidate;
  }
  async function setRuleEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') throw failure('VALIDATION_ERROR', 'Enabled must be on or off.', [{ field: 'enabled', message: 'Choose on or off.' }]);
    const raw = mutable(await ensureRaw());
    const index = raw.rules.findIndex(rule => rule?.id === id && !rule.deletedAt);
    if (index < 0) throw failure('NOT_FOUND', 'The rule no longer exists. Refresh and try again.');
    const at = now(), by = await actor();
    const candidate = { ...raw.rules[index], enabled, updatedAt: at, updatedBy: by };
    const issues = validateSynonymRule(candidate, otherValidRules(raw, id));
    if (issues.length) throw failure('VALIDATION_ERROR', 'This rule cannot be toggled until it is corrected.', issues);
    const rules = [...raw.rules];
    rules[index] = candidate;
    persist({ ...raw, rules, updatedAt: at, updatedBy: by });
    return candidate;
  }
  async function setMasterEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw failure('VALIDATION_ERROR', 'Enabled must be on or off.', [{ field: 'enabled', message: 'Choose on or off.' }]);
    const raw = mutable(await ensureRaw());
    const at = now(), by = await actor();
    persist({ ...raw, enabled, updatedAt: at, updatedBy: by });
    return { enabled, updatedAt: at };
  }
  async function softDelete(id) {
    const raw = mutable(await ensureRaw());
    const index = raw.rules.findIndex(rule => rule?.id === id && !rule.deletedAt);
    if (index < 0) throw failure('NOT_FOUND', 'The rule no longer exists. Refresh and try again.');
    if (raw.rules[index].origin !== 'custom') throw failure('PROTECTED_RULE', 'Client-v5 rules cannot be deleted. Disable the rule instead.');
    const at = now(), by = await actor();
    const candidate = { ...raw.rules[index], enabled: false, deletedAt: at, deletedBy: by, updatedAt: at, updatedBy: by };
    const rules = [...raw.rules];
    rules[index] = candidate;
    persist({ ...raw, rules, updatedAt: at, updatedBy: by });
    return candidate;
  }
  async function getTitleOptimizationSynonymConfig() {
    const hydrated = hydrateSynonymConfiguration(await ensureRaw());
    return { enabled: hydrated.enabled, rules: enabledSynonymRules(hydrated), policies: hydrated.policies };
  }
  return { load, saveRule, setRuleEnabled, setMasterEnabled, softDelete, getTitleOptimizationSynonymConfig };
}

module.exports = { createTitleOptimizationSynonymsRepository };
