const ElectronStore = require('electron-store').default;

const store = new ElectronStore({
  encryptionKey: 'client-secret-key'
});

/* ---------------------------
   DATABASE CONFIG
---------------------------- */
function saveDbConfig(config) {
  store.set('db', config);
}

function getDbConfig() {
  return store.get('db');
}

function clearDbConfig() {
  store.delete('db');
}

/* ---------------------------
   WEBHOOK CONFIG
---------------------------- */
function saveWebhookConfig(url) {
  store.set('webhook', url);
}

function getWebhookConfig() {
  return store.get('webhook');
}

function clearWebhookConfig() {
  store.delete('webhook');
}

/* ---------------------------
   SELECTED TABLES CONFIG
---------------------------- */
function saveSelectedTables(tables) {
  store.set('selectedTables', tables);
}

function getSelectedTables() {
  return store.get('selectedTables') || [];
}

function clearSelectedTables() {
  store.delete('selectedTables');
}

/* ---------------------------
   REPORTING CONFIG
---------------------------- */
function saveReportingConfig(key, value) {
  store.set(`reporting.${key}`, value);
}

function getReportingConfig(key) {
  return store.get(`reporting.${key}`);
}

function clearReportingConfig() {
  store.delete('reporting');
}

module.exports = {
  saveDbConfig,
  getDbConfig,
  clearDbConfig,
  saveWebhookConfig,
  getWebhookConfig,
  clearWebhookConfig,
  saveSelectedTables,
  getSelectedTables,
  clearSelectedTables,
  saveReportingConfig,
  getReportingConfig,
  clearReportingConfig
};
