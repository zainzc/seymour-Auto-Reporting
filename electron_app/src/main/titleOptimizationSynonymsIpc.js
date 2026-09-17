function serializeError(error) {
  return {
    code: error?.code || 'SYNONYMS_ERROR',
    message: String(error?.message || 'Unable to complete the Synonyms request.'),
    details: error?.details || null
  };
}

function registerTitleOptimizationSynonymsIpc(ipcMain, repository) {
  const register = (channel, operation) => ipcMain.handle(channel, async (...args) => {
    try { return { success: true, data: await operation(...args) }; }
    catch (error) { return { success: false, error: serializeError(error) }; }
  });
  register('title-optimization-synonyms:load', () => repository.load());
  register('title-optimization-synonyms:save', (_event, input) => repository.saveRule(input));
  register('title-optimization-synonyms:toggle-rule', (_event, id, enabled) => repository.setRuleEnabled(id, enabled));
  register('title-optimization-synonyms:toggle-master', (_event, enabled) => repository.setMasterEnabled(enabled));
  register('title-optimization-synonyms:delete', (_event, id) => repository.softDelete(id));
}

module.exports = { registerTitleOptimizationSynonymsIpc, serializeError };
