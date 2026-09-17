function serializeError(error) {
  return {
    code: error?.code || 'PREFIX_RULES_ERROR',
    message: String(error?.message || 'Unable to complete the Prefix Rules request.'),
    details: error?.details || null
  };
}

function registerTitleOptimizationPrefixRulesIpc(ipcMain, repository) {
  const register = (channel, operation) => ipcMain.handle(channel, async (...args) => {
    try { return { success: true, data: await operation(...args) }; }
    catch (error) { return { success: false, error: serializeError(error) }; }
  });
  register('title-optimization-prefix-rules:load', () => repository.load());
  register('title-optimization-prefix-rules:save', (_event, input) => repository.saveRule(input));
  register('title-optimization-prefix-rules:toggle', (_event, id, enabled) => repository.setRuleEnabled(id, enabled));
  register('title-optimization-prefix-rules:delete', (_event, id) => repository.softDelete(id));
}

module.exports = { registerTitleOptimizationPrefixRulesIpc, serializeError };
