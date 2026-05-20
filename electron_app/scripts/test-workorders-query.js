const { loadEnv } = require('../src/config/loadEnv');
const { getDbConfig } = require('../src/config/configStore');
const { initDb, initDbWindowsAuth } = require('../src/services/db');
const { fetchWorkOrderRows } = require('../src/services/workOrdersPowerlinkService');

async function initDatabase() {
  const dbConfig = getDbConfig();
  if (!dbConfig) {
    throw new Error('Database config not found in app settings');
  }

  if (dbConfig.authType === 'windows') {
    await initDbWindowsAuth(dbConfig.server, dbConfig.database);
  } else {
    await initDb();
  }
}

async function main() {
  loadEnv();
  await initDatabase();

  console.log('[Test] Running Work Orders SQL query...');
  const rows = await fetchWorkOrderRows();
  console.log(`[Test] Rows fetched: ${rows.length}`);
  console.log('[Test] First 3 rows:');
  console.dir(rows.slice(0, 3), { depth: null });
}

main().catch(error => {
  console.error('[Test] Failed:', error.message);
  process.exit(1);
});
