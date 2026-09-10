const {
  seedSourceMappings,
  validateAndHydrateConfiguration,
  getMappingStatus,
  validateMappingsForSave,
  softDeleteCustomMapping,
  restoreCustomMapping
} = require('./titleOptimizationSourceFieldsService');

const TABLE_NAME = 'eBay Listings (API)';
const CURRENT_VERSION = 2;
const LEGACY_AUTO_REQUIRED_KEYS = new Set(['existingTitle', 'manualOverrideStatus', 'sku', 'ipnPrefix']);

function sanitizeFields(fields = []) {
  return fields.map((field) => ({
    id: String(field?.id || '').trim(),
    name: String(field?.name || '').trim(),
    type: String(field?.type || '').trim()
  })).filter((field) => field.id && field.name);
}

function decorate(configuration) {
  const fields = Array.isArray(configuration.fields) ? configuration.fields : [];
  return {
    ...configuration,
    mappings: configuration.mappings
      .filter((mapping) => !mapping.deletedAt)
      .sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder))
      .map((mapping) => ({ ...mapping, status: getMappingStatus(mapping, fields) }))
  };
}

function friendlySchemaError(error) {
  const status = error?.status || error?.response?.status;
  if (status === 429) return 'Airtable rate limit reached. Wait a moment and refresh fields manually.';
  if (status === 401 || status === 403) return 'Airtable credentials are unavailable or do not permit schema access.';
  return String(error?.message || 'Unable to refresh Airtable fields.');
}

function createTitleOptimizationSourceFieldsRepository(dependencies = {}) {
  const getStored = dependencies.getStored || (() => undefined);
  const setStored = dependencies.setStored || (() => {});
  const getCredentials = dependencies.getCredentials || (() => ({}));
  const listTables = dependencies.listTables;
  const getActor = dependencies.getActor || (async () => 'system');
  const now = dependencies.now || (() => new Date().toISOString());

  function hydrateStored() {
    const raw = getStored();
    if (!raw || !Array.isArray(raw.mappings)) return null;
    const hydrated = validateAndHydrateConfiguration(raw);
    if (Number(raw.version) >= CURRENT_VERSION) return hydrated;
    const migrated = {
      ...hydrated,
      version: CURRENT_VERSION,
      mappings: hydrated.mappings.map((mapping) => LEGACY_AUTO_REQUIRED_KEYS.has(mapping.logicalKey)
        ? { ...mapping, required: false }
        : mapping)
    };
    setStored(migrated);
    return migrated;
  }

  async function fetchSchema() {
    const credentials = getCredentials() || {};
    if (!credentials.token || !credentials.baseId) {
      const error = new Error('Airtable credentials or configured base are unavailable.');
      error.status = 401;
      throw error;
    }
    const tables = await listTables({ ...credentials, maxAttempts: 1 });
    const table = (Array.isArray(tables) ? tables : []).find((entry) => entry?.name === TABLE_NAME);
    if (!table) throw new Error(`Airtable table '${TABLE_NAME}' was not found in the configured base.`);
    const fields = sanitizeFields(table.fields);
    if (!fields.length) throw new Error(`Airtable table '${TABLE_NAME}' returned no fields.`);
    return { table: { id: table.id, name: table.name }, fields };
  }

  async function load() {
    const existing = hydrateStored();
    if (existing) return decorate(existing);

    const actor = await getActor();
    let schema = { table: { id: null, name: TABLE_NAME }, fields: [] };
    let schemaError = null;
    try {
      schema = await fetchSchema();
    } catch (error) {
      schemaError = friendlySchemaError(error);
    }
    const at = now();
    const configuration = {
      version: CURRENT_VERSION,
      ...schema,
      mappings: seedSourceMappings(schema.fields, { actor, now: at }),
      updatedAt: at,
      updatedBy: actor,
      quarantined: []
    };
    setStored(configuration);
    return { ...decorate(configuration), schemaError };
  }

  async function refreshFields() {
    const existing = hydrateStored();
    try {
      const schema = await fetchSchema();
      const actor = await getActor();
      const at = now();
      const configuration = existing || {
        version: CURRENT_VERSION,
        mappings: seedSourceMappings(schema.fields, { actor, now: at }),
        quarantined: []
      };
      const mappings = configuration.mappings.map((mapping) => {
        const field = schema.fields.find((entry) => mapping.sourceFieldId && entry.id === mapping.sourceFieldId);
        return field ? {
          ...mapping,
          sourceFieldName: field.name,
          sourceFieldType: field.type
        } : mapping;
      });
      const updated = { ...configuration, ...schema, mappings, updatedAt: at, updatedBy: actor };
      setStored(updated);
      return decorate(updated);
    } catch (cause) {
      const error = new Error(friendlySchemaError(cause));
      error.code = 'SCHEMA_REFRESH_FAILED';
      error.current = decorate(existing || { version: CURRENT_VERSION, table: { id: null, name: TABLE_NAME }, fields: [], mappings: [], quarantined: [] });
      throw error;
    }
  }

  async function save(mappings = []) {
    const existing = hydrateStored() || { version: CURRENT_VERSION, table: { id: null, name: TABLE_NAME }, fields: [], quarantined: [] };
    const hydrated = validateAndHydrateConfiguration({ mappings });
    if (hydrated.quarantined.length) {
      const error = new Error('One or more source mappings are malformed.');
      error.code = 'VALIDATION_ERROR';
      error.details = hydrated.quarantined;
      throw error;
    }
    const errors = validateMappingsForSave(hydrated.mappings, existing.fields || []);
    if (errors.length) {
      const error = new Error('Required source mappings must use available Airtable fields.');
      error.code = 'VALIDATION_ERROR';
      error.details = errors;
      throw error;
    }
    const actor = await getActor();
    const at = now();
    const updatedMappings = hydrated.mappings.map((mapping) => ({ ...mapping, updatedAt: at, updatedBy: actor }));
    const configuration = { ...existing, mappings: updatedMappings, updatedAt: at, updatedBy: actor };
    setStored(configuration);
    return decorate(configuration);
  }

  async function softDelete(id) {
    const existing = hydrateStored();
    if (!existing) throw new Error('Source Fields configuration was not found.');
    const actor = await getActor();
    const at = now();
    const mappings = softDeleteCustomMapping(id, existing.mappings, { actor, now: at });
    const updated = { ...existing, mappings, updatedAt: at, updatedBy: actor };
    setStored(updated);
    return decorate(updated);
  }

  async function restore(id) {
    const existing = hydrateStored();
    if (!existing) throw new Error('Source Fields configuration was not found.');
    const actor = await getActor();
    const at = now();
    const mappings = restoreCustomMapping(id, existing.mappings, { actor, now: at });
    const updated = { ...existing, mappings, updatedAt: at, updatedBy: actor };
    setStored(updated);
    return decorate(updated);
  }

  async function getTitleOptimizationSourceMappings() {
    return (await load()).mappings;
  }

  return { load, refreshFields, save, softDelete, restore, getTitleOptimizationSourceMappings };
}

module.exports = { TABLE_NAME, sanitizeFields, createTitleOptimizationSourceFieldsRepository };
