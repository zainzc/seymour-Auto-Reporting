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

// Inventory Webhook API
contextBridge.exposeInMainWorld('inventoryWebhookAPI', {
  testConnection: (url) => ipcRenderer.invoke('inventory-webhook-test', url),
  saveConfig: (url) => ipcRenderer.invoke('inventory-webhook-save-config', url),
  startSchedule: (url) => ipcRenderer.invoke('inventory-webhook-start', url),
  stopSchedule: () => ipcRenderer.invoke('inventory-webhook-stop'),
  pushNow: (url) => ipcRenderer.invoke('inventory-webhook-push-now', url),
  getStatus: () => ipcRenderer.invoke('inventory-webhook-get-status'),
  getLogs: () => ipcRenderer.invoke('inventory-webhook-get-logs')
});
