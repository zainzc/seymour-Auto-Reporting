const {
  DEFAULT_SOURCE_PRIORITY,
  validateSourcePriority,
  hydrateSourcePriority,
  rowsForOrder
} = require('./titleOptimizationSourcePriorityService');

const POLICY = 'titleOptimizationSourcePriority';
const VERSION = 1;

function createTitleOptimizationSourcePriorityRepository(dependencies = {}) {
  const getStored = dependencies.getStored || (() => undefined);
  const setStored = dependencies.setStored || (() => {});
  const getActor = dependencies.getActor || (async () => 'system');
  const now = dependencies.now || (() => new Date().toISOString());

  function readStored() {
    try {
      return getStored();
    } catch (cause) {
      const error = new Error(`Unable to read Source Priority configuration: ${cause?.message || cause}`);
      error.code = 'CONFIG_READ_FAILED';
      throw error;
    }
  }

  function persist(configuration) {
    try {
      setStored(configuration);
    } catch (cause) {
      const error = new Error(`Unable to save Source Priority configuration: ${cause?.message || cause}`);
      error.code = 'PERSISTENCE_ERROR';
      throw error;
    }
  }

  function decorate(configuration) {
    const hydrated = hydrateSourcePriority(configuration);
    return { ...hydrated, rows: rowsForOrder(hydrated.order, hydrated.issues) };
  }

  async function load() {
    const existing = readStored();
    if (existing !== undefined && existing !== null) return decorate(existing);

    const configuration = {
      version: VERSION,
      policy: POLICY,
      order: [...DEFAULT_SOURCE_PRIORITY],
      updatedAt: now(),
      updatedBy: String(await getActor() || 'system').trim() || 'system'
    };
    persist(configuration);
    return decorate(configuration);
  }

  async function save(order) {
    const issues = validateSourcePriority(order);
    if (issues.length) {
      const error = new Error('Source Priority must contain every approved source exactly once with Manual Override at priority 1.');
      error.code = 'VALIDATION_ERROR';
      error.details = issues;
      throw error;
    }
    const configuration = {
      version: VERSION,
      policy: POLICY,
      order: [...order],
      updatedAt: now(),
      updatedBy: String(await getActor() || 'system').trim() || 'system'
    };
    persist(configuration);
    return decorate(configuration);
  }

  async function getTitleOptimizationSourcePriority() {
    const configuration = await load();
    if (configuration.requiresCorrection) {
      const error = new Error('Source Priority configuration requires correction before runtime use.');
      error.code = 'CONFIG_INVALID';
      error.details = configuration.issues;
      throw error;
    }
    return [...configuration.order];
  }

  return { load, save, getTitleOptimizationSourcePriority };
}

module.exports = { POLICY, VERSION, createTitleOptimizationSourcePriorityRepository };
