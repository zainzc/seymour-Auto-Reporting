const { loadEnv } = require('../src/config/loadEnv');
const { getDbConfig, getReportingConfig } = require('../src/config/configStore');
const { initDb, initDbWindowsAuth } = require('../src/services/db');
const oauth2Service = require('../src/services/oauth2Service');
const { runWorkOrdersSync, DEFAULT_WORK_ORDERS_SHEET_NAME } = require('../src/services/workOrdersGoogleSheetsSync');

async function initDatabase() {
  const dbConfig = getDbConfig();
  if (!dbConfig) throw new Error('Database config not found in app settings');

  if (dbConfig.authType === 'windows') {
    await initDbWindowsAuth(dbConfig.server, dbConfig.database);
  } else {
    await initDb();
  }
}

async function main() {
  loadEnv();
  await initDatabase();

  const spreadsheetId =
    process.argv[2] ||
    getReportingConfig('workOrdersSpreadsheetId') ||
    '';
  const sheetName =
    process.argv[3] ||
    getReportingConfig('workOrdersSheetName') ||
    DEFAULT_WORK_ORDERS_SHEET_NAME;

  if (!spreadsheetId) {
    throw new Error('Spreadsheet ID is required. Pass it as arg1 or save from UI first.');
  }

  const isAuthenticated = oauth2Service.isAuthenticated('reporting');
  if (!isAuthenticated) {
    throw new Error('Google reporting auth not found. Connect from app first.');
  }

  const authClient = oauth2Service.getAuthenticatedClient('reporting');
  const summary = await runWorkOrdersSync({
    authClient,
    spreadsheetId,
    sheetName
  });

  console.log('[Test] Work Orders sync summary:');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error('[Test] Failed:', error.message);
  if (error?.summary) {
    console.error('[Test] Partial summary:');
    console.error(JSON.stringify(error.summary, null, 2));
  }
  process.exit(1);
});
