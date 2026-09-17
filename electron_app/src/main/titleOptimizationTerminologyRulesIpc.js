function serializeError(error) {
  return {
    code: error?.code || 'TERMINOLOGY_RULES_ERROR',
    message: String(error?.message || 'Unable to complete the Terminology Rules request.'),
    details: error?.details || null
  };
}

function registerTitleOptimizationTerminologyRulesIpc(ipcMain, repository) {
  const register = (channel, operation) => {
    ipcMain.handle(channel, async (...args) => {
      try { return { success: true, data: await operation(...args) }; }
      catch (error) { return { success: false, error: serializeError(error) }; }
    });
  };
  register('title-optimization-terminology-rules:load', () => repository.load());
  register('title-optimization-terminology-rules:save', (_event, input) => repository.saveRule(input));
  register('title-optimization-terminology-rules:toggle', (_event, id, enabled) => repository.setEnabled(id, enabled));
  register('title-optimization-terminology-rules:delete', (_event, id) => repository.softDelete(id));
}

module.exports = { registerTitleOptimizationTerminologyRulesIpc, serializeError };
