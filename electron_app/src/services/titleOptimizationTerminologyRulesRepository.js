const { randomUUID } = require('node:crypto');
const {
  seedTerminologyRules,
  validateRule,
  hydrateTerminologyConfiguration,
  visibleRules,
  enabledRules
} = require('./titleOptimizationTerminologyRulesService');

const VERSION = 1;

function failure(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function createTitleOptimizationTerminologyRulesRepository(dependencies = {}) {
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
    catch (cause) { throw failure('CONFIG_READ_FAILED', `Unable to read Terminology Rules: ${cause?.message || cause}`); }
  }

  function persist(configuration) {
    try { setStored(configuration); }
    catch (cause) { throw failure('PERSISTENCE_ERROR', `Unable to save Terminology Rules: ${cause?.message || cause}`); }
  }

  async function ensureRaw() {
    const stored = readRaw();
    if (stored !== undefined) return stored;
    const at = now();
    const by = await actor();
    const initial = { version: VERSION, rules: seedTerminologyRules({ now: at, actor: by }), updatedAt: at, updatedBy: by };
    persist(initial);
    return initial;
  }

  function display(configuration) {
    const hydrated = hydrateTerminologyConfiguration(configuration);
    return {
      version: configuration?.version || VERSION,
      rules: visibleRules(hydrated),
      issues: hydrated.issues,
      quarantinedCount: hydrated.quarantined.length,
      updatedAt: configuration?.updatedAt || null,
      updatedBy: configuration?.updatedBy || null
    };
  }

  async function load() {
    return display(await ensureRaw());
  }

  function mutableRaw(configuration) {
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) || !Array.isArray(configuration.rules)) {
      throw failure('CONFIG_INVALID', 'Saved Terminology Rules configuration is malformed and cannot be changed safely.');
    }
    return configuration;
  }

  function validOthers(configuration, id) {
    return hydrateTerminologyConfiguration(configuration).rules.filter(rule => rule.id !== id);
  }

  async function saveRule(input) {
    const raw = mutableRaw(await ensureRaw());
    const id = input?.id ? String(input.id) : String(createId());
    const index = raw.rules.findIndex(rule => rule?.id === id);
    if (input?.id && index < 0) throw failure('NOT_FOUND', 'The rule no longer exists. Refresh and try again.');
    if (!input?.id && index >= 0) throw failure('DUPLICATE_ID', 'A rule with this ID already exists.');
    const old = index >= 0 ? raw.rules[index] : null;
    if (old?.deletedAt) throw failure('DELETED_RULE', 'Deleted rules cannot be edited.');
    const at = now();
    const by = await actor();
    const action = input?.action;
    const candidate = {
      id,
      sourceTerm: input?.sourceTerm,
      action,
      replacementTerm: action === 'remove' && !String(input?.replacementTerm || '').trim() ? null : input?.replacementTerm,
      condition: input?.condition,
      conditionConfig: input?.condition === 'context-verified' ? input?.conditionConfig : null,
      appliesTo: input?.appliesTo,
      priority: input?.priority,
      enabled: input?.enabled,
      origin: old?.origin || 'custom',
      note: input?.note ?? old?.note ?? null,
      createdAt: old?.createdAt || at,
      createdBy: old?.createdBy || by,
      updatedAt: at,
      updatedBy: by,
      deletedAt: null,
      deletedBy: null
    };
    const issues = validateRule(candidate, validOthers(raw, id));
    if (issues.length) throw failure('VALIDATION_ERROR', 'Please correct the rule fields and try again.', issues);
    const rules = [...raw.rules];
    if (index >= 0) rules[index] = candidate;
    else rules.push(candidate);
    persist({ ...raw, version: VERSION, rules, updatedAt: at, updatedBy: by });
    return candidate;
  }

  async function setEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') throw failure('VALIDATION_ERROR', 'Enabled must be on or off.', [{ field: 'enabled', message: 'Choose on or off.' }]);
    const raw = mutableRaw(await ensureRaw());
    const index = raw.rules.findIndex(rule => rule?.id === id && !rule.deletedAt);
    if (index < 0) throw failure('NOT_FOUND', 'The rule no longer exists. Refresh and try again.');
    const at = now();
    const by = await actor();
    const candidate = { ...raw.rules[index], enabled, updatedAt: at, updatedBy: by };
    const issues = validateRule(candidate, validOthers(raw, id));
    if (issues.length) throw failure('VALIDATION_ERROR', 'This rule cannot be enabled until it is corrected.', issues);
    const rules = [...raw.rules];
    rules[index] = candidate;
    persist({ ...raw, rules, updatedAt: at, updatedBy: by });
    return candidate;
  }

  async function softDelete(id) {
    const raw = mutableRaw(await ensureRaw());
    const index = raw.rules.findIndex(rule => rule?.id === id && !rule.deletedAt);
    if (index < 0) throw failure('NOT_FOUND', 'The rule no longer exists. Refresh and try again.');
    if (raw.rules[index].origin !== 'custom') throw failure('PROTECTED_RULE', 'Client-v5 rules cannot be deleted. Disable the rule instead.');
    const at = now();
    const by = await actor();
    const candidate = { ...raw.rules[index], enabled: false, deletedAt: at, deletedBy: by, updatedAt: at, updatedBy: by };
    const rules = [...raw.rules];
    rules[index] = candidate;
    persist({ ...raw, rules, updatedAt: at, updatedBy: by });
    return candidate;
  }

  async function getTitleOptimizationTerminologyRules() {
    const raw = await ensureRaw();
    return enabledRules(hydrateTerminologyConfiguration(raw));
  }

  return { load, saveRule, setEnabled, softDelete, getTitleOptimizationTerminologyRules };
}

module.exports = { createTitleOptimizationTerminologyRulesRepository };
