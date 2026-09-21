const { randomUUID } = require('node:crypto');
const { seedCategoryRulesConfiguration, validateCategoryRule, hydrateCategoryRulesConfiguration, enabledCategoryRules } = require('./titleOptimizationCategoryRulesService');

function failure(code, message, details = null) {
  const error = new Error(message); error.code = code; error.details = details; return error;
}

function createTitleOptimizationCategoryRulesRepository(dependencies = {}) {
  const getStored = dependencies.getStored || (() => undefined);
  const setStored = dependencies.setStored || (() => {});
  const getActor = dependencies.getActor || (async () => 'system');
  const now = dependencies.now || (() => new Date().toISOString());
  const createId = dependencies.createId || (() => `custom-${randomUUID()}`);
  let mutationQueue = Promise.resolve();
  let initializationPromise = null;
  const serializeMutation = operation => {
    const pending = mutationQueue.then(operation, operation);
    mutationQueue = pending.catch(() => {});
    return pending;
  };
  async function actor() { try { return String(await getActor() || 'system').trim() || 'system'; } catch { return 'system'; } }
  function readRaw() { try { return getStored(); } catch (cause) { throw failure('CONFIG_READ_FAILED', `Unable to read Category Rules: ${cause?.message || cause}`); } }
  function persist(config) { try { setStored(config); } catch (cause) { throw failure('PERSISTENCE_ERROR', `Unable to save Category Rules: ${cause?.message || cause}`); } }
  async function ensureRaw() {
    const raw = readRaw();
    if (raw !== undefined) return raw;
    if (!initializationPromise) initializationPromise = (async () => {
      const initial = seedCategoryRulesConfiguration({ now: now(), actor: await actor() });
      const current = readRaw();
      if (current !== undefined) return current;
      persist(initial); return initial;
    })().finally(() => { initializationPromise = null; });
    return initializationPromise;
  }
  function mutable(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.rules)) throw failure('CONFIG_INVALID', 'Saved Category Rules configuration is malformed and cannot be changed safely.');
    return raw;
  }
  function display(raw) {
    const hydrated = hydrateCategoryRulesConfiguration(raw);
    return { version: raw?.version || 1, rules: hydrated.rules.filter(rule => !rule.deletedAt), issues: hydrated.issues, updatedAt: raw?.updatedAt || null, updatedBy: raw?.updatedBy || null };
  }
  async function load() { return display(await ensureRaw()); }
  function validRecord(raw, id) { return hydrateCategoryRulesConfiguration(raw).rules.find(rule => rule.id === id && !rule.deletedAt) || null; }
  function findIndex(raw, id) { const valid = validRecord(raw, id); return valid ? raw.rules.indexOf(valid) : -1; }
  function peers(raw, id) { return raw.rules.filter(rule => rule && rule.id !== id && !rule.deletedAt); }
  function validateCandidate(candidate, raw) {
    const issues = validateCategoryRule(candidate, peers(raw, candidate.id));
    if (issues.length) throw failure('VALIDATION_ERROR', 'Please correct the rule fields and try again.', issues);
  }
  function cleanedList(value) { return Array.isArray(value) ? value.map(entry => typeof entry === 'string' ? entry.trim() : entry) : value; }
  async function saveRuleImpl(input) {
    const raw = mutable(await ensureRaw());
    const id = input?.id ? String(input.id) : String(createId());
    const index = findIndex(raw, id);
    if (input?.id && index < 0) throw failure('NOT_FOUND', 'The rule no longer exists or requires configuration repair.');
    const old = index >= 0 ? raw.rules[index] : null;
    const at = now(), by = await actor();
    const candidate = {
      id, categoryName: typeof input?.categoryName === 'string' ? input.categoryName.trim() : input?.categoryName,
      prefixRefs: cleanedList(input?.prefixRefs), seriesRefs: cleanedList(input?.seriesRefs), priorityDetails: cleanedList(input?.priorityDetails),
      enabled: input?.enabled, origin: old?.origin || 'custom', seedOrder: old?.seedOrder ?? null,
      note: input?.note == null || input.note === '' ? null : input.note,
      createdAt: old?.createdAt || at, createdBy: old?.createdBy || by, updatedAt: at, updatedBy: by,
      deletedAt: null, deletedBy: null
    };
    validateCandidate(candidate, raw);
    const rules = [...raw.rules]; if (index >= 0) rules[index] = candidate; else rules.push(candidate);
    persist({ ...raw, version: 1, rules, updatedAt: at, updatedBy: by }); return candidate;
  }
  async function setRuleEnabledImpl(id, enabled) {
    if (typeof enabled !== 'boolean') throw failure('VALIDATION_ERROR', 'Enabled must be on or off.', [{ field: 'enabled', message: 'Choose on or off.' }]);
    const raw = mutable(await ensureRaw()), index = findIndex(raw, id);
    if (index < 0) throw failure('NOT_FOUND', 'The rule no longer exists or requires configuration repair.');
    const at = now(), by = await actor(), candidate = { ...raw.rules[index], enabled, updatedAt: at, updatedBy: by };
    validateCandidate(candidate, raw);
    const rules = [...raw.rules]; rules[index] = candidate; persist({ ...raw, rules, updatedAt: at, updatedBy: by }); return candidate;
  }
  async function softDeleteImpl(id) {
    const raw = mutable(await ensureRaw()), index = findIndex(raw, id);
    if (index < 0) throw failure('NOT_FOUND', 'The rule no longer exists or requires configuration repair.');
    if (raw.rules[index].origin !== 'custom') throw failure('PROTECTED_RULE', 'Client-v5 category rules cannot be deleted.');
    const at = now(), by = await actor();
    const candidate = { ...raw.rules[index], enabled: false, deletedAt: at, deletedBy: by, updatedAt: at, updatedBy: by };
    const rules = [...raw.rules]; rules[index] = candidate; persist({ ...raw, rules, updatedAt: at, updatedBy: by }); return candidate;
  }
  async function getTitleOptimizationCategoryRules() { return enabledCategoryRules(hydrateCategoryRulesConfiguration(await ensureRaw())); }
  return {
    load,
    saveRule: input => serializeMutation(() => saveRuleImpl(input)),
    setRuleEnabled: (id, enabled) => serializeMutation(() => setRuleEnabledImpl(id, enabled)),
    softDelete: id => serializeMutation(() => softDeleteImpl(id)),
    getTitleOptimizationCategoryRules
  };
}

module.exports = { createTitleOptimizationCategoryRulesRepository };
