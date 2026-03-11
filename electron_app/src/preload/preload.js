const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('api', {
  saveConfig: (config) => ipcRenderer.invoke('save-db-config', config),
  testDbConnection: (config) => ipcRenderer.invoke('test-db-connection', config),
  testWindowsAuth: (config) => ipcRenderer.invoke('test-windows-auth', config),
  saveWebhook: (url) => ipcRenderer.invoke('save-webhook', url),
  getWebhookConfig: () => ipcRenderer.invoke('get-webhook-config'),

  getUsers: () => ipcRenderer.invoke('get-users'),
  getTables: () => ipcRenderer.invoke('get-tables'),
  syncUsers: () => ipcRenderer.invoke('sync-users'),
  syncTables: (tableNames) => ipcRenderer.invoke('sync-tables', tableNames),
  executeQuery: (query, limit) => ipcRenderer.invoke('execute-query', query, limit),

  resetConfig: () => ipcRenderer.invoke('reset-config')
});

// Reporting API
contextBridge.exposeInMainWorld('reportingAPI', {
  getSalespeople: () => ipcRenderer.invoke('reporting-get-salespeople'),
  exportToExcel: (params) => ipcRenderer.invoke('reporting-export-excel', params),
  saveSchedule: (config) => ipcRenderer.invoke('reporting-save-schedule', config),
  cancelSchedule: () => ipcRenderer.invoke('reporting-cancel-schedule'),
  getCurrentSchedule: () => ipcRenderer.invoke('reporting-get-schedule'),
  getExecutionLogs: (limit) => ipcRenderer.invoke('reporting-get-logs', limit),
  testSchedule: () => ipcRenderer.invoke('reporting-test-schedule'),
  getSavedSheetId: () => ipcRenderer.invoke('reporting-get-sheet-id')
});

// OAuth2 API
contextBridge.exposeInMainWorld('oauth2API', {
  getAuthUrl: () => ipcRenderer.invoke('oauth2-get-auth-url'),
  exchangeCode: (code) => ipcRenderer.invoke('oauth2-exchange-code', code),
  getUserInfo: () => ipcRenderer.invoke('oauth2-get-user-info'),
  isAuthenticated: () => ipcRenderer.invoke('oauth2-is-authenticated'),
  disconnect: () => ipcRenderer.invoke('oauth2-disconnect'),
  onAuthorized: (callback) => ipcRenderer.on('oauth2-authorized', callback),
  openExternal: (url) => shell.openExternal(url)
});

// OAuth2 API (Inventory / Milestone 1)
contextBridge.exposeInMainWorld('oauth2InventoryAPI', {
  getAuthUrl: () => ipcRenderer.invoke('oauth2-inventory-get-auth-url'),
  getUserInfo: () => ipcRenderer.invoke('oauth2-inventory-get-user-info'),
  isAuthenticated: () => ipcRenderer.invoke('oauth2-inventory-is-authenticated'),
  getAuthSource: () => ipcRenderer.invoke('oauth2-inventory-get-auth-source'),
  disconnect: () => ipcRenderer.invoke('oauth2-inventory-disconnect'),
  onAuthorized: (callback) => ipcRenderer.on('oauth2-authorized-inventory', callback),
  openExternal: (url) => shell.openExternal(url)
});

// Inventory Google Sheets API - Phase 1
contextBridge.exposeInMainWorld('inventorySheetsAPI', {
  testConnection: (spreadsheetId, worksheetName) => ipcRenderer.invoke('inventory-sheets-test', spreadsheetId, worksheetName),
  validateUrl: (sheetsUrl) => ipcRenderer.invoke('inventory-sheets-validate-url', sheetsUrl),
  saveConfig: (spreadsheetId, worksheetName) => ipcRenderer.invoke('inventory-sheets-save-config', spreadsheetId, worksheetName),
  startSchedule: (spreadsheetId, worksheetName) => ipcRenderer.invoke('inventory-sheets-start', spreadsheetId, worksheetName),
  stopSchedule: () => ipcRenderer.invoke('inventory-sheets-stop'),
  pushNow: (spreadsheetId, worksheetName) => ipcRenderer.invoke('inventory-sheets-push-now', spreadsheetId, worksheetName),
  getStatus: () => ipcRenderer.invoke('inventory-sheets-get-status'),
  getLogs: () => ipcRenderer.invoke('inventory-sheets-get-logs')
});

// Phase 2 API - Google Sheets -> Airtable Master Parts
contextBridge.exposeInMainWorld('phase2API', {
  getConfig: () => ipcRenderer.invoke('phase2-get-config'),
  saveConfig: (config) => ipcRenderer.invoke('phase2-save-config', config),
  getActivityLogs: () => ipcRenderer.invoke('phase2-get-activity-logs'),
  appendActivityLog: (entry) => ipcRenderer.invoke('phase2-append-activity-log', entry),
  clearActivityLogs: () => ipcRenderer.invoke('phase2-clear-activity-logs'),
  clearTaskCache: () => ipcRenderer.invoke('phase2-clear-task-cache'),
  fetchClickUpLists: (token) => ipcRenderer.invoke('phase2-fetch-clickup-lists', token),
  fetchAirtableBases: (token) => ipcRenderer.invoke('phase2-fetch-airtable-bases', token),
  validateClickUpConfig: (payload) => ipcRenderer.invoke('phase2-validate-clickup-config', payload),
  validateAirtableConfig: (payload) => ipcRenderer.invoke('phase2-validate-airtable-config', payload),
  run: (options) => ipcRenderer.invoke('phase2-run', options),
  startWriteback: (options) => ipcRenderer.invoke('phase2-writeback-start', options),
  stopWriteback: () => ipcRenderer.invoke('phase2-writeback-stop'),
  getWritebackStatus: () => ipcRenderer.invoke('phase2-writeback-status'),
  runWritebackOnce: (options) => ipcRenderer.invoke('phase2-writeback-run-once', options),
  getAutoRunStatus: () => ipcRenderer.invoke('phase2-autorun-status'),
  startAutoRun: (options) => ipcRenderer.invoke('phase2-autorun-start', options),
  stopAutoRun: () => ipcRenderer.invoke('phase2-autorun-stop'),
  runAutoRunNow: () => ipcRenderer.invoke('phase2-autorun-run-now'),
  onProgress: (callback) => ipcRenderer.on('phase2-progress', callback)
});

// Phase 3 API - ShipStation -> Airtable Master Parts dims/weight
contextBridge.exposeInMainWorld('phase3API', {
  getConfig: () => ipcRenderer.invoke('phase3:get-config'),
  run: (options) => ipcRenderer.invoke('phase3:run', options),
  onProgress: (callback) => ipcRenderer.on('phase3:progress', callback)
});

// Phase 4 API - Master Parts -> Item Specifics IPN mirroring
contextBridge.exposeInMainWorld('phase4API', {
  getConfig: () => ipcRenderer.invoke('phase4:get-config'),
  run: (options) => ipcRenderer.invoke('phase4:run', options),
  onProgress: (callback) => ipcRenderer.on('phase4:progress', callback)
});

// Phase 4 Rules API - Item Specific fixed rules population
contextBridge.exposeInMainWorld('phase4RulesAPI', {
  getConfig: () => ipcRenderer.invoke('phase4rules:get-config'),
  run: (options) => ipcRenderer.invoke('phase4rules:run', options),
  onProgress: (callback) => ipcRenderer.on('phase4rules:progress', callback)
});

// Phase 4B-lite API - Item Specific VF/VMF AI evaluation
contextBridge.exposeInMainWorld('phase4BLiteAPI', {
  getConfig: () => ipcRenderer.invoke('phase4blite:get-config'),
  run: (options) => ipcRenderer.invoke('phase4blite:run', options),
  onProgress: (callback) => ipcRenderer.on('phase4blite:progress', callback)
});

// Item Specific table automation API
contextBridge.exposeInMainWorld('itemSpecificSyncAPI', {
  run: (options) => ipcRenderer.invoke('item-specific-sync:run', options),
  onProgress: (callback) => ipcRenderer.on('item-specific-sync:progress', callback)
});
