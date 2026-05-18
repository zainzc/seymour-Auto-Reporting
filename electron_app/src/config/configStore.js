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

/* ---------------------------
   INVENTORY WEBHOOK CONFIG
---------------------------- */
function saveInventoryConfig(key, value) {
  store.set(`inventoryWebhook.${key}`, value);
}

function getInventoryConfig(key) {
  return store.get(`inventoryWebhook.${key}`);
}

function clearInventoryConfig() {
  store.delete('inventoryWebhook');
}

module.exports = {
  saveDbConfig,
  getDbConfig,
  clearDbConfig,
  saveWebhookConfig,
  getWebhookConfig,
  clearWebhookConfig,
  saveReportingConfig,
  getReportingConfig,
  clearReportingConfig,
  saveInventoryConfig,
  getInventoryConfig,
  clearInventoryConfig
};
