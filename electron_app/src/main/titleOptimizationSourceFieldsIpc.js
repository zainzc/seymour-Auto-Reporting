function serializeError(error) {
  return {
    code: error?.code || 'SOURCE_FIELDS_ERROR',
    message: String(error?.message || 'Unable to complete the Source Fields request.'),
    details: error?.details || null
  };
}

function registerTitleOptimizationSourceFieldsIpc(ipcMain, repository) {
  const register = (channel, operation) => {
    ipcMain.handle(channel, async (...args) => {
      try {
        return { success: true, data: await operation(...args) };
      } catch (error) {
        const result = { success: false, error: serializeError(error) };
        if (error?.current) result.current = error.current;
        return result;
      }
    });
  };

  register('title-optimization-source-fields:load', () => repository.load());
  register('title-optimization-source-fields:refresh', () => repository.refreshFields());
  register('title-optimization-source-fields:save', (_event, mappings) => repository.save(mappings));
  register('title-optimization-source-fields:delete', (_event, id) => repository.softDelete(id));
}

module.exports = { registerTitleOptimizationSourceFieldsIpc, serializeError };
