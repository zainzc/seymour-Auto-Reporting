function registerTitleOptimizationSystemRulesIpc(ipcMain, getRules) {
  ipcMain.handle('title-optimization-system-rules:load', async () => {
    try { return { success:true, data:getRules() }; }
    catch (error) { return { success:false, error:{ code:error?.code || 'SYSTEM_RULES_ERROR', message:String(error?.message || 'Unable to load System Rules.') } }; }
  });
}
module.exports = { registerTitleOptimizationSystemRulesIpc };
