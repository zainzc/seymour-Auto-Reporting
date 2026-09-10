function serializeError(error) {
  return {
    code: error?.code || 'SOURCE_PRIORITY_ERROR',
    message: String(error?.message || 'Unable to complete the Source Priority request.'),
    details: error?.details || null
  };
}

function registerTitleOptimizationSourcePriorityIpc(ipcMain, repository) {
  const register = (channel, operation) => {
    ipcMain.handle(channel, async (...args) => {
      try {
        return { success: true, data: await operation(...args) };
      } catch (error) {
        return { success: false, error: serializeError(error) };
      }
    });
  };

  register('title-optimization-source-priority:load', () => repository.load());
  register('title-optimization-source-priority:save', (_event, order) => repository.save(order));
}

module.exports = { registerTitleOptimizationSourcePriorityIpc, serializeError };
