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

/* ---------------------------
   TITLE OPTIMIZATION CONFIG
---------------------------- */
function saveTitleOptimizationSourceFields(config) {
  store.set('titleOptimization.sourceFields', config);
}

function getTitleOptimizationSourceFields() {
  return store.get('titleOptimization.sourceFields');
}

function saveTitleOptimizationSourcePriority(config) {
  store.set('titleOptimization.sourcePriority', config);
}

function getTitleOptimizationSourcePriority() {
  return store.get('titleOptimization.sourcePriority');
}

function saveTitleOptimizationTerminologyRules(config) {
  store.set('titleOptimization.terminologyRules', config);
}

function getTitleOptimizationTerminologyRules() {
  return store.get('titleOptimization.terminologyRules');
}

function saveTitleOptimizationSynonyms(config) {
  store.set('titleOptimization.synonyms', config);
}

function getTitleOptimizationSynonyms() {
  return store.get('titleOptimization.synonyms');
}

function saveTitleOptimizationPrefixRules(config) {
  store.set('titleOptimization.prefixRules', config);
}

function getTitleOptimizationPrefixRules() {
  return store.get('titleOptimization.prefixRules');
}

function saveTitleOptimizationRestrictedTerms(config) {
  store.set('titleOptimization.restrictedTerms', config);
}

function getTitleOptimizationRestrictedTerms() {
  return store.get('titleOptimization.restrictedTerms');
}

function saveTitleOptimizationCategoryRules(config) {
  store.set('titleOptimization.categoryRules', config);
}

function getTitleOptimizationCategoryRules() {
  return store.get('titleOptimization.categoryRules');
}

function saveTitleOptimizationTitleStructures(config) { store.set('titleOptimization.titleStructures', config); }
function getTitleOptimizationTitleStructures() { return store.get('titleOptimization.titleStructures'); }

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
  clearInventoryConfig,
  saveTitleOptimizationSourceFields,
  getTitleOptimizationSourceFields,
  saveTitleOptimizationSourcePriority,
  getTitleOptimizationSourcePriority,
  saveTitleOptimizationTerminologyRules,
  getTitleOptimizationTerminologyRules,
  saveTitleOptimizationSynonyms,
  getTitleOptimizationSynonyms,
  saveTitleOptimizationPrefixRules,
  getTitleOptimizationPrefixRules,
  saveTitleOptimizationRestrictedTerms,
  getTitleOptimizationRestrictedTerms,
  saveTitleOptimizationCategoryRules,
  getTitleOptimizationCategoryRules,
  saveTitleOptimizationTitleStructures,
  getTitleOptimizationTitleStructures
};
