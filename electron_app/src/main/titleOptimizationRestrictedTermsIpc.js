function serializeError(error) {
  return {
    code: error?.code || 'RESTRICTED_TERMS_ERROR',
    message: String(error?.message || 'Unable to complete the Restricted Terms request.'),
    details: error?.details || null
  };
}

function registerTitleOptimizationRestrictedTermsIpc(ipcMain, repository) {
  const register = (channel, operation) => ipcMain.handle(channel, async (...args) => {
    try { return { success: true, data: await operation(...args) }; }
    catch (error) { return { success: false, error: serializeError(error) }; }
  });
  register('title-optimization-restricted-terms:load', () => repository.load());
  register('title-optimization-restricted-terms:save', (_event, input) => repository.saveRule(input));
  register('title-optimization-restricted-terms:toggle', (_event, id, enabled) => repository.setRuleEnabled(id, enabled));
  register('title-optimization-restricted-terms:delete', (_event, id) => repository.softDelete(id));
}

module.exports = { registerTitleOptimizationRestrictedTermsIpc, serializeError };
