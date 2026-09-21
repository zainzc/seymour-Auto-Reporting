function serializeError(error) {
  return { code: error?.code || 'CATEGORY_RULES_ERROR', message: String(error?.message || 'Unable to complete the Category Rules request.'), details: error?.details || null };
}

function registerTitleOptimizationCategoryRulesIpc(ipcMain, repository) {
  const register = (channel, operation) => ipcMain.handle(channel, async (...args) => {
    try { return { success: true, data: await operation(...args) }; }
    catch (error) { return { success: false, error: serializeError(error) }; }
  });
  register('title-optimization-category-rules:load', () => repository.load());
  register('title-optimization-category-rules:save', (_event, input) => repository.saveRule(input));
  register('title-optimization-category-rules:toggle', (_event, id, enabled) => repository.setRuleEnabled(id, enabled));
  register('title-optimization-category-rules:delete', (_event, id) => repository.softDelete(id));
}

module.exports = { registerTitleOptimizationCategoryRulesIpc, serializeError };
