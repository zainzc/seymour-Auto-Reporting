const { randomUUID } = require('node:crypto');
const { seedRestrictedTermsConfiguration, validateRestrictedTerm, hydrateRestrictedTermsConfiguration, enabledRestrictedTerms } = require('./titleOptimizationRestrictedTermsService');

function failure(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function createTitleOptimizationRestrictedTermsRepository(dependencies = {}) {
  const getStored = dependencies.getStored || (() => undefined);
  const setStored = dependencies.setStored || (() => {});
  const getActor = dependencies.getActor || (async () => 'system');
  const now = dependencies.now || (() => new Date().toISOString());
  const createId = dependencies.createId || (() => `custom-${randomUUID()}`);
  let mutationQueue = Promise.resolve();

  function serializeMutation(operation) {
    const pending = mutationQueue.then(operation, operation);
    mutationQueue = pending.catch(() => {});
    return pending;
  }

  async function actor() {
    try { return String(await getActor() || 'system').trim() || 'system'; }
    catch { return 'system'; }
  }
  function readRaw() {
    try { return getStored(); }
    catch (cause) { throw failure('CONFIG_READ_FAILED', `Unable to read Restricted Terms: ${cause?.message || cause}`); }
  }
  function persist(config) {
    try { setStored(config); }
    catch (cause) { throw failure('PERSISTENCE_ERROR', `Unable to save Restricted Terms: ${cause?.message || cause}`); }
  }
  async function ensureRaw() {
    const raw = readRaw();
    if (raw !== undefined) return raw;
    const initial = seedRestrictedTermsConfiguration({ now: now(), actor: await actor() });
    persist(initial);
    return initial;
  }
  function mutable(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.rules)) {
      throw failure('CONFIG_INVALID', 'Saved Restricted Terms configuration is malformed and cannot be changed safely.');
    }
    return raw;
  }
  function display(raw) {
    const hydrated = hydrateRestrictedTermsConfiguration(raw);
    return { version: raw?.version || 1, rules: hydrated.rules.filter(rule => !rule.deletedAt), issues: hydrated.issues,
      updatedAt: raw?.updatedAt || null, updatedBy: raw?.updatedBy || null };
  }
  async function load() { return display(await ensureRaw()); }
  function validRecord(raw, id) {
    return hydrateRestrictedTermsConfiguration(raw).rules.find(rule => rule.id === id && !rule.deletedAt) || null;
  }
  function findIndex(raw, id) {
    const valid = validRecord(raw, id);
    return valid ? raw.rules.indexOf(valid) : -1;
  }
  function candidatePeers(raw, id) {
    return raw.rules.filter(rule => rule && rule.id !== id && !rule.deletedAt);
  }
  function validateCandidate(candidate, raw) {
    const issues = validateRestrictedTerm(candidate, candidatePeers(raw, candidate.id));
    if (issues.length) throw failure('VALIDATION_ERROR', 'Please correct the rule fields and try again.', issues);
  }
  async function saveRule(input) {
    const raw = mutable(await ensureRaw());
    const id = input?.id ? String(input.id) : String(createId());
    const index = findIndex(raw, id);
    if (input?.id && index < 0) throw failure('NOT_FOUND', 'The rule no longer exists. Refresh and try again.');
    if (!input?.id && raw.rules.some(rule => rule?.id === id)) throw failure('DUPLICATE_ID', 'A rule with this ID already exists.');
    const old = index >= 0 ? raw.rules[index] : null;
    if (old?.locked && input?.enabled !== true) throw failure('LOCKED_RULE', 'Locked client-v5 rules must remain enabled.');
    const at = now(), by = await actor();
    const candidate = {
      id,
      term: typeof input?.term === 'string' ? input.term.trim() : input?.term,
      ruleType: input?.ruleType, scope: input?.scope,
      note: input?.note === undefined ? old?.note ?? null : input.note,
      enabled: input?.enabled,
      locked: old?.locked || false, origin: old?.origin || 'custom',
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
    const old = raw.rules[index];
    if (old.locked && !enabled) throw failure('LOCKED_RULE', 'Locked client-v5 rules must remain enabled.');
    const at = now(), by = await actor();
    const candidate = { ...old, enabled, updatedAt: at, updatedBy: by };
    validateCandidate(candidate, raw);
    const rules = [...raw.rules]; rules[index] = candidate;
    persist({ ...raw, rules, updatedAt: at, updatedBy: by });
    return candidate;
  }
  async function softDelete(id) {
    const raw = mutable(await ensureRaw());
    const index = findIndex(raw, id);
    if (index < 0) throw failure('NOT_FOUND', 'The rule no longer exists. Refresh and try again.');
    if (raw.rules[index].origin !== 'custom') throw failure('PROTECTED_RULE', 'Client-v5 rules cannot be deleted.');
    const at = now(), by = await actor();
    const candidate = { ...raw.rules[index], enabled: false, deletedAt: at, deletedBy: by, updatedAt: at, updatedBy: by };
    const rules = [...raw.rules]; rules[index] = candidate;
    persist({ ...raw, rules, updatedAt: at, updatedBy: by });
    return candidate;
  }
  async function getTitleOptimizationRestrictedTerms() {
    return enabledRestrictedTerms(hydrateRestrictedTermsConfiguration(await ensureRaw()));
  }
  return {
    load,
    saveRule: input => serializeMutation(() => saveRule(input)),
    setRuleEnabled: (id, enabled) => serializeMutation(() => setRuleEnabled(id, enabled)),
    softDelete: id => serializeMutation(() => softDelete(id)),
    getTitleOptimizationRestrictedTerms
  };
}

module.exports = { createTitleOptimizationRestrictedTermsRepository };
