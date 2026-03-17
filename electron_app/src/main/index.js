const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { loadEnv } = require('../config/loadEnv');
loadEnv();

const config = require('../config/env');

const { getUsers, syncUsers, getAllTables, syncTables } = require('../services/userService');
const {
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
  saveInventoryConfig,
  getInventoryConfig
} = require('../config/configStore');

const { initDb, initDbWindowsAuth } = require('../services/db');
// Reporting services
const { getInvoices, getSalespeople } = require('../services/reportingService');
const { generateExcelFile } = require('../services/excelService');
const { initialize: initSheets, writeToRawTab } = require('../services/sheetsService');
const { startSchedule, stopSchedule, resumeSchedule, logExecution, getExecutionLogs, executeScheduledJob } = require('../services/scheduleService');
const oauth2Service = require('../services/oauth2Service');
const { runPhase2, buildPhase2Config } = require('../services/phase2Service');
const { runPhase3, buildPhase3Config, PARTSHUNTER_STORE_ID } = require('../services/phase3Service');
const { runPhase4Mirroring, buildPhase4Config, MIRROR_STATE_KEY } = require('../services/phase4MirroringService');
const { runItemSpecificTableSync } = require('../scripts/syncItemSpecificTables');
const { runPhase4RulesPopulate } = require('../scripts/runPhase4RulesPopulate');
const { runPhase4BLite, runPhase4BWritebackOnly, runPhase4CMFWritebackOnly, runPhase4CMF, runPhase4DListing } = require('../scripts/runPhase4BLite');
const { runEbayMockImport } = require('../scripts/runEbayMockImport');
const ClickUpService = require('../services/clickupService');
const AirtableService = require('../services/airtableService');
const phase2WritebackPoller = require('../services/phase2WritebackPollerService');
const phase2AutoRunService = require('../services/phase2AutoRunService');

let mainWindow;
let autoSyncInterval = null;
let phase4WritebackInterval = null;
let isPhase4WritebackPollerRunning = false;
let dbReady = false;

function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return defaultValue;
}

function formatDetailedErrorMessage(error) {
  const status = error?.response?.status;
  const payload = error?.response?.data;
  const detail =
    payload?.error?.message ||
    payload?.error?.type ||
    payload?.error ||
    error?.message ||
    'Unknown error';
  return status ? `HTTP ${status}: ${detail}` : String(detail);
}

function emitInventoryAutoChainLog(text, level = 'info') {
  const message = String(text || '').trim();
  if (!message) return;

  if (level === 'error') {
    console.error(message);
  } else {
    console.log(message);
  }

  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send('inventory:auto-chain-log', {
        at: new Date().toISOString(),
        level,
        message
      });
    }
  } catch (_) {}
}

/* ---------------------------
   WINDOWS INSTALLER SAFETY
---------------------------- */
if (require('electron-squirrel-startup')) {
  app.quit();
}

/* ---------------------------
   PAGE LOADERS (ONLY PLACE!)
---------------------------- */
function loadSetup() {
  mainWindow.loadFile(path.join(__dirname, '../renderer/pages/shared/setup.html'));
}

function loadWebhook() {
  mainWindow.loadFile(path.join(__dirname, '../renderer/pages/shared/webhook.html'));
}

function loadDashboard() {
  mainWindow.loadFile(path.join(__dirname, '../renderer/pages/main-dashboard.html'));
}

/* ---------------------------
   AUTO SYNC (SAFE)
---------------------------- */
function startAutoSync() {
  if (autoSyncInterval) clearInterval(autoSyncInterval);

  const webhook = getWebhookConfig();
  const selectedTables = getSelectedTables();

  if (!webhook || selectedTables.length === 0) return;

  autoSyncInterval = setInterval(async () => {
    try {
      await syncTables(selectedTables);
      console.log(`✅ Auto-synced ${selectedTables.length} tables: ${selectedTables.join(', ')}`);
    } catch (err) {
      console.error('❌ Auto-sync failed:', err.message);
    }
  }, 5 * 60 * 1000);
}

/* ---------------------------
   IPC HANDLERS
---------------------------- */
ipcMain.handle('save-db-config', async (_, config) => {
  try {
    saveDbConfig(config);
    
    // Use appropriate connection method based on auth type
    if (config.authType === 'windows') {
      await initDbWindowsAuth(config.server, config.database);
    } else {
      await initDb();
    }
    
    dbReady = true;

    // Let frontend handle navigation (setup.html redirects to reporting.html)
    // Don't force webhook page here

    return { success: true };
  } catch (err) {
    dbReady = false;
    return { success: false, message: err.message };
  }
});

ipcMain.handle('test-windows-auth', async (_, config) => {
  try {
    const sql = require('mssql/msnodesqlv8');
    
    console.log(`🔐 Testing Windows Auth connection to ${config.server}...`);
    console.log(`💾 Database: ${config.database}`);
    
    const poolConfig = {
      connectionString: `Driver={ODBC Driver 18 for SQL Server};Server=${config.server};Database=${config.database};Trusted_Connection=yes;TrustServerCertificate=yes;Connection Timeout=30;`,
      connectionTimeout: 30000,
      requestTimeout: 30000,
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
      }
    };
    
    const pool = new sql.ConnectionPool(poolConfig);
    pool.on('error', err => {
      console.error('❌ Pool error:', err.message);
    });
    
    console.log('⏳ Connecting...');
    await pool.connect();
    console.log('✅ Connected! Testing query...');
    
    const result = await pool.request().query('SELECT @@VERSION as version');
    console.log('✅ Query successful');
    
    await pool.close();
    
    return { success: true, message: 'Connection successful!' };
  } catch (err) {
    console.error('❌ Raw error:', err);
    console.error('❌ Error type:', typeof err);
    console.error('❌ Error constructor:', err?.constructor?.name);
    
    let errorMsg = 'Unknown error';
    
    if (err?.originalError) {
      console.error('❌ Original error:', err.originalError);
      errorMsg = String(err.originalError);
    } else if (err?.message && err.message !== '[object Object]') {
      errorMsg = String(err.message);
    } else if (typeof err === 'string') {
      errorMsg = err;
    } else {
      console.error('❌ Error properties:', {
        code: err?.code,
        state: err?.state,
        sqlState: err?.sqlState,
        number: err?.number
      });
      try {
        errorMsg = JSON.stringify(err);
      } catch {
        errorMsg = String(err);
      }
    }
    
    console.error('❌ Final error message:', errorMsg);
    return { success: false, message: errorMsg };
  }
});

ipcMain.handle('test-db-connection', async (_, config) => {
  try {
    const sql = require('mssql/msnodesqlv8');  // Use Windows ODBC driver
    
    // Use server name exactly as provided (SSMS uses just "STR" without port)
    let serverName = config.server.trim();
    
    console.log(`🔐 Testing connection to ${serverName}...`);
    console.log(`👤 User: ${config.user}`);
    console.log(`💾 Database: ${config.database}`);
    
    const poolConfig = {
      connectionString: `Driver={ODBC Driver 18 for SQL Server};Server=${serverName};Database=${config.database};Uid=${config.user};Pwd=${config.password};Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=30;`,
      connectionTimeout: 30000,
      requestTimeout: 30000,
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
      }
    };
    
    const pool = new sql.ConnectionPool(poolConfig);
    pool.on('error', err => {
      console.error('❌ Pool error:', err.message);
    });
    
    console.log('⏳ Connecting...');
    await pool.connect();
    console.log('✅ Connected! Testing query...');
    
    const result = await pool.request().query('SELECT @@VERSION as version');
    console.log('✅ Query successful');
    
    await pool.close();
    
    return { success: true, message: 'Connection successful!' };
  } catch (err) {
    console.error('❌ Raw error:', err);
    console.error('❌ Error type:', typeof err);
    console.error('❌ Error constructor:', err?.constructor?.name);
    
    // Try to extract the real error message
    let errorMsg = 'Unknown error';
    
    // Check if there's an underlying ODBC error
    if (err?.originalError) {
      console.error('❌ Original error:', err.originalError);
      errorMsg = String(err.originalError);
    } else if (err?.message && err.message !== '[object Object]') {
      errorMsg = String(err.message);
    } else if (typeof err === 'string') {
      errorMsg = err;
    } else {
      // Try to extract info from the error object itself
      console.error('❌ Error properties:', {
        code: err?.code,
        state: err?.state,
        sqlState: err?.sqlState,
        number: err?.number
      });
      try {
        errorMsg = JSON.stringify(err);
      } catch {
        errorMsg = String(err);
      }
    }
    
    console.error('❌ Final error message:', errorMsg);
    return { success: false, message: errorMsg };
  }
});

ipcMain.handle('save-webhook', async (_, url) => {
  if (!url) return { success: false, message: 'Webhook required' };

  saveWebhookConfig(url);
  // startAutoSync(); // Removed: Only sync when user clicks button

  return { success: true, message: 'Webhook saved successfully!' };
});

ipcMain.handle('get-webhook-config', async () => {
  return getWebhookConfig();
});

ipcMain.handle('get-users', async () => {
  if (!dbReady) throw new Error('DB not ready');
  return await getUsers();
});

ipcMain.handle('get-tables', async () => {
  if (!dbReady) throw new Error('DB not ready');
  return await getAllTables();
});

ipcMain.handle('execute-query', async (_, query, limit) => {
  if (!dbReady) throw new Error('DB not ready');
  
  // Validate it's a SELECT query
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery.startsWith('select')) {
    throw new Error('Only SELECT queries are allowed');
  }
  
  const pool = require('../services/db').getDB();
  
  // Apply limit if not "all"
  let finalQuery = query;
  let limited = false;
  
  if (limit && limit !== 'all') {
    const limitNum = parseInt(limit);
    // Check if query already has TOP or LIMIT clause
    if (!trimmedQuery.includes(' top ') && !trimmedQuery.includes(' limit ')) {
      // For SQL Server, inject TOP after SELECT
      finalQuery = query.replace(/select\s+/i, `SELECT TOP ${limitNum} `);
      limited = true;
    }
  }
  
  const result = await pool.request().query(finalQuery);
  
  return {
    rows: result.recordset,
    rowCount: result.recordset.length,
    limited: limited
  };
});

ipcMain.handle('sync-users', async () => {
  if (!dbReady) throw new Error('DB not ready');
  if (!getWebhookConfig()) throw new Error('Webhook not configured');

  const users = await getUsers();
  await syncUsers(users);

  return { success: true, count: users.length };
});

ipcMain.handle('sync-tables', async (_, tableNames) => {
  if (!dbReady) throw new Error('DB not ready');
  
  // Check if webhook is configured
  if (!getWebhookConfig()) {
    return { 
      success: false, 
      needsWebhook: true,
      message: 'Webhook not configured. Would you like to configure it now?' 
    };
  }
  
  if (!Array.isArray(tableNames) || tableNames.length === 0) {
    throw new Error('Select at least one table');
  }

  // Save selected tables
  saveSelectedTables(tableNames);
  
  // Removed auto-sync - only manual sync on button click
  // startAutoSync();
  
  await syncTables(tableNames);

  return { success: true, count: tableNames.length };
});

ipcMain.handle('reset-config', async () => {
  if (autoSyncInterval) clearInterval(autoSyncInterval);

  dbReady = false;
  clearDbConfig();
  clearWebhookConfig();
  clearSelectedTables();

  return { success: true };
});

/* ---------------------------
   REPORTING IPC HANDLERS
---------------------------- */

// Get salespeople list
ipcMain.handle('reporting-get-salespeople', async () => {
  if (!dbReady) throw new Error('DB not ready');
  return await getSalespeople();
});

// Manual Excel export
ipcMain.handle('reporting-export-excel', async (_, params) => {
  if (!dbReady) throw new Error('DB not ready');

  try {
    const data = await getInvoices(params);
    const result = await generateExcelFile(data, mainWindow);
    
    logExecution('Manual', result.success, result.message);
    
    return result;
  } catch (error) {
    // Convert technical database errors to user-friendly messages
    let userMessage = error.message;
    
    if (error.message.includes('Invalid object name') || 
        error.message.includes('table not found') ||
        error.message.includes('does not exist')) {
      userMessage = 'Database table not found. Please check your database configuration.';
    } else if (error.message.includes('Login failed') || 
               error.message.includes('Cannot open database')) {
      userMessage = 'Database connection failed. Please check your database credentials.';
    } else if (error.message.includes('timeout')) {
      userMessage = 'Database request timed out. Please try again.';
    }
    
    const errorMsg = `Export failed: ${userMessage}`;
    logExecution('Manual', false, errorMsg);
    return { success: false, message: errorMsg };
  }
});

// Save scheduled download
ipcMain.handle('reporting-save-schedule', async (_, scheduleConfig) => {
  try {
    // Check if user is authenticated with Google
    const isAuthenticated = await oauth2Service.isAuthenticated('reporting');
    if (!isAuthenticated) {
      return {
        success: false,
        message: 'Please connect to Google Sheets first using the Connect button.'
      };
    }

    // Validate spreadsheet ID is provided
    if (!scheduleConfig.spreadsheetId) {
      return {
        success: false,
        message: 'Google Sheet ID is required. Please enter your Google Sheets ID.'
      };
    }

    // Initialize Google Sheets with OAuth2 client
    try {
      const authClient = await oauth2Service.getAuthenticatedClient('reporting');
      await initSheets(authClient);
    } catch (err) {
      return {
        success: false,
        message: `Failed to initialize Google Sheets: ${err.message}`
      };
    }

    // Test the spreadsheet ID - try to access it
    try {
      const { google } = require('googleapis');
      const authClient = await oauth2Service.getAuthenticatedClient('reporting');
      const sheets = google.sheets({ version: 'v4', auth: authClient });
      
      // Try to get spreadsheet metadata to verify access
      const response = await sheets.spreadsheets.get({
        spreadsheetId: scheduleConfig.spreadsheetId
      });
      
      console.log(`✅ Successfully verified access to sheet: ${response.data.properties.title}`);
      
      // Check if RAW tab exists
      const sheetNames = response.data.sheets.map(s => s.properties.title);
      if (!sheetNames.includes('RAW')) {
        return {
          success: false,
          message: 'The spreadsheet does not have a "RAW" tab. Please create a sheet named "RAW" in your Google Spreadsheet first.'
        };
      }
      
      console.log('✅ RAW tab found');
      
    } catch (err) {
      return {
        success: false,
        message: `Failed to access Google Sheet: ${err.message}. Please verify the Sheet ID is correct and you have access to it.`
      };
    }

    // Save spreadsheet ID to config
    saveReportingConfig('spreadsheetId', scheduleConfig.spreadsheetId);

    // Start the schedule with received config (already includes spreadsheetId)
    const started = startSchedule(scheduleConfig);

    if (started) {
      return {
        success: true,
        message: `Schedule activated: ${scheduleConfig.frequency} at midnight`
      };
    } else {
      return {
        success: false,
        message: 'Failed to start schedule'
      };
    }

  } catch (error) {
    return {
      success: false,
      message: error.message
    };
  }
});

// Cancel schedule
ipcMain.handle('reporting-cancel-schedule', async () => {
  try {
    stopSchedule();
    return {
      success: true,
      message: 'Schedule cancelled successfully'
    };
  } catch (error) {
    return {
      success: false,
      message: error.message
    };
  }
});

// Get current schedule
ipcMain.handle('reporting-get-schedule', async () => {
  return getReportingConfig('activeSchedule') || null;
});

// Get saved spreadsheet ID
ipcMain.handle('reporting-get-sheet-id', async () => {
  return getReportingConfig('spreadsheetId') || null;
});

// Get execution logs
ipcMain.handle('reporting-get-logs', async (_, limit) => {
  return getExecutionLogs(limit);
});

// Test schedule immediately
ipcMain.handle('reporting-test-schedule', async () => {
  try {
    if (!dbReady) {
      return {
        success: false,
        message: 'Database not ready'
      };
    }

    const schedule = getReportingConfig('activeSchedule');
    
    if (!schedule) {
      return {
        success: false,
        message: 'No active schedule found. Please save a schedule first.'
      };
    }

    console.log('Testing schedule immediately...');
    
    // Check if user is authenticated with Google
    const isAuthenticated = await oauth2Service.isAuthenticated('reporting');
    if (!isAuthenticated) {
      return {
        success: false,
        message: 'Please connect to Google Sheets first using the Connect button.'
      };
    }

    // Initialize Google Sheets with OAuth2 client
    const spreadsheetId = schedule.spreadsheetId;
    try {
      const authClient = await oauth2Service.getAuthenticatedClient('reporting');
      await initSheets(authClient);
      console.log('Google Sheets initialized for test');
    } catch (initErr) {
      return {
        success: false,
        message: `Failed to initialize Google Sheets: ${initErr.message}`
      };
    }

    // Verify spreadsheet access and RAW tab
    const hasAccess = await require('../services/sheetsService').verifyAccess(spreadsheetId);
    if (!hasAccess) {
      return {
        success: false,
        message: 'Cannot access the spreadsheet. Verify the Spreadsheet ID and sharing permissions.'
      };
    }

    const rawExists = await require('../services/sheetsService').rawTabExists(spreadsheetId);
    if (!rawExists) {
      return {
        success: false,
        message: 'RAW tab not found. Create a sheet named RAW (uppercase).'
      };
    }

    const result = await executeScheduledJob(schedule);
    
    return {
      success: result.success,
      message: result.success 
        ? `Schedule executed successfully! ${result.message}` 
        : `Schedule execution failed: ${result.message}`
    };
  } catch (error) {
    console.error('Test schedule error:', error);
    return {
      success: false,
      message: `Test failed: ${error.message}`
    };
  }
});

// OAuth2 handlers (Reporting / Milestone 11)
ipcMain.handle('oauth2-get-auth-url', async () => {
  try {
    // Return the auth URL string directly
    return oauth2Service.getAuthUrl('reporting');
  } catch (error) {
    throw error;
  }
});

ipcMain.handle('oauth2-exchange-code', async (_, code) => {
  try {
    await oauth2Service.getTokensFromCode(code, 'reporting');
    return {
      success: true,
      message: 'Successfully connected to Google!'
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to connect: ${error.message}`
    };
  }
});

ipcMain.handle('oauth2-get-user-info', async () => {
  try {
    if (!oauth2Service.isAuthenticated('reporting')) {
      return null;
    }

    // Return plain user info object
    const userInfo = await oauth2Service.getUserInfo('reporting');
    return userInfo;
  } catch (error) {
    throw error;
  }
});

ipcMain.handle('oauth2-is-authenticated', async () => {
  // Return a simple boolean so renderer can do `if (isAuthenticated)`
  return oauth2Service.isAuthenticated('reporting');
});

ipcMain.handle('oauth2-disconnect', async () => {
  try {
    oauth2Service.disconnect('reporting');
    return {
      success: true,
      message: 'Disconnected from Google'
    };
  } catch (error) {
    return {
      success: false,
      message: error.message
    };
  }
});

// OAuth2 handlers (Inventory / Milestone 1)
ipcMain.handle('oauth2-inventory-get-auth-url', async () => {
  try {
    return oauth2Service.getAuthUrl('inventory');
  } catch (error) {
    throw error;
  }
});

ipcMain.handle('oauth2-inventory-get-user-info', async () => {
  try {
    if (!oauth2Service.isAuthenticated('inventory')) {
      return null;
    }
    return await oauth2Service.getUserInfo('inventory');
  } catch (error) {
    throw error;
  }
});

ipcMain.handle('oauth2-inventory-is-authenticated', async () => {
  return oauth2Service.isAuthenticated('inventory');
});

ipcMain.handle('oauth2-inventory-get-auth-source', async () => {
  return oauth2Service.getAuthSource('inventory');
});

ipcMain.handle('oauth2-inventory-disconnect', async () => {
  try {
    oauth2Service.disconnect('inventory');
    return {
      success: true,
      message: 'Disconnected from Google'
    };
  } catch (error) {
    return {
      success: false,
      message: error.message
    };
  }
});

/* ---------------------------
   INVENTORY GOOGLE SHEETS HANDLERS - PHASE 1
---------------------------- */
const { getAllInventory } = require('../services/inventoryService');
const { testSheetsConnection, validateAndExtractSpreadsheetId } = require('../services/googleSheetsInventoryService');
const { 
  startInventorySchedule, 
  stopInventorySchedule, 
  executeInventoryPush,
  setPostPushHook,
  getScheduleStatus,
  getExecutionLogs: getInventoryLogs,
  initializeSchedule: initInventorySchedule
} = require('../services/inventoryScheduleService');

setPostPushHook(async payload => {
  const phase2Result = await phase2AutoRunService.onPhase1PushSuccess(payload);
  if (phase2Result?.skipped) {
    emitInventoryAutoChainLog(
      `Phase3/Phase4 auto-run skipped after Phase1 push: Phase2 did not run (reason=${phase2Result.reason || 'unknown'})`
    );
    return;
  }

  const stored = getInventoryConfig('phase2Config') || {};
  const phase3Config = buildPhase3Config(stored);
  const hasPhase3MinimumConfig =
    Boolean(phase3Config?.sheetId) &&
    Boolean(phase3Config?.tabName) &&
    Boolean(phase3Config?.airtableToken) &&
    Boolean(phase3Config?.airtableBaseId) &&
    Boolean(phase3Config?.shipstationApiKey) &&
    Boolean(phase3Config?.shipstationApiSecret);

  if (!hasPhase3MinimumConfig) {
    emitInventoryAutoChainLog('Phase3/Phase4 auto-run skipped after Phase2 success: missing Phase3 config');
    return;
  }

  try {
    const phase3Summary = await runPhase3(phase3Config, () => {});
    emitInventoryAutoChainLog(
      `Phase3 auto-run completed after Phase1+Phase2 success ` +
        `(shipmentsFetched=${phase3Summary?.shipmentsFetched || 0}, ` +
        `skusMappedToIpn=${phase3Summary?.skusMappedToIpn || 0}, ` +
        `ipnsUpdated=${phase3Summary?.ipnsUpdated || 0}, ` +
        `dryRun=${Boolean(phase3Config?.phase3DryRun)})`
    );
  } catch (error) {
    emitInventoryAutoChainLog(
      `Phase3 auto-run failed after Phase2 success. Phase4 auto-run blocked: ${error.message}`,
      'error'
    );
    return;
  }

  const phase4Stored = getInventoryConfig('phase2Config') || {};
  const phase4RulesDriveFile = String(
    phase4Stored.phase4RulesDriveFile ||
      process.env.PHASE4_RULES_DRIVE_FILE ||
      process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
      ''
  ).trim();
  const phase4OpenAiKey = String(
    phase4Stored.openaiApiKey ||
      process.env.OPENAI_API_KEY ||
      ''
  ).trim();
  const phase4BListId = String(
    phase4Stored.phase4BClickupListId ||
      process.env.PHASE4B_CLICKUP_LIST_ID ||
      ''
  ).trim();
  const phase4CListId = String(
    phase4Stored.phase4CClickupListId ||
      process.env.PHASE4C_CLICKUP_LIST_ID ||
      phase4BListId
  ).trim();
  const hasPhase4MinimumConfig =
    Boolean(phase4Stored?.airtableToken) &&
    Boolean(phase4Stored?.airtableBaseId) &&
    Boolean(phase4Stored?.itemSpecificsBaseId) &&
    Boolean(phase4Stored?.clickupToken) &&
    Boolean(phase4RulesDriveFile) &&
    Boolean(phase4OpenAiKey) &&
    Boolean(phase4BListId) &&
    Boolean(phase4CListId);
  if (!hasPhase4MinimumConfig) {
    emitInventoryAutoChainLog('Phase4 auto-run skipped after Phase3 success: missing Phase4 config');
    return;
  }

  try {
    emitInventoryAutoChainLog('Phase4 auto-run started after Phase1+Phase2+Phase3 success');

    const mirrorOptions = {
      ...phase4Stored,
      authContext: 'inventory',
      itemSpecificsBaseId: String(phase4Stored.itemSpecificsBaseId || '').trim(),
      dryRun:
        typeof phase4Stored.phase4DryRun === 'boolean'
          ? phase4Stored.phase4DryRun
          : true,
      incrementalEnabled:
        typeof phase4Stored.phase4IncrementalEnabled === 'boolean'
          ? phase4Stored.phase4IncrementalEnabled
          : true
    };
    const mirrorSummary = await runPhase4Mirroring(mirrorOptions, () => {});
    emitInventoryAutoChainLog(
      `Phase4 auto-run: mirroring completed ` +
        `(scanned=${mirrorSummary?.masterRecordsScanned || 0}, ` +
        `eligible=${mirrorSummary?.masterRecordsEligible || 0}, ` +
        `created=${mirrorSummary?.ipnRowsCreated || 0}, ` +
        `planned=${mirrorSummary?.ipnRowsPlanned || 0})`
    );

    const rulesDryRun =
      typeof phase4Stored.phase4RulesDryRun === 'boolean'
        ? phase4Stored.phase4RulesDryRun
        : true;
    const phase4ASummary = await runPhase4RulesPopulate({
      ...phase4Stored,
      dryRun: rulesDryRun,
      execute: !rulesDryRun,
      ruleTypes: ['F'],
      authContext: 'inventory',
      rulesDriveFile: phase4RulesDriveFile,
      globalDefaultsTable: String(
        phase4Stored.phase4GlobalDefaultsTable ||
          process.env.PHASE4_GLOBAL_DEFAULTS_TABLE ||
          'Fixed Item Specifics (Global Defaults)'
      ).trim(),
      logicSheetName: String(phase4Stored.phase4RulesLogicSheet || 'Logic').trim()
    }, () => {});
    emitInventoryAutoChainLog(
      `Phase4 auto-run: 4A completed (updated=${phase4ASummary?.fixedFieldsUpdated || 0})`
    );

    const bliteDryRun =
      typeof phase4Stored.phase4BLiteDryRun === 'boolean'
        ? phase4Stored.phase4BLiteDryRun
        : true;
    const phase4BSummary = await runPhase4BLite({
      ...phase4Stored,
      dryRun: bliteDryRun,
      execute: !bliteDryRun,
      authContext: 'inventory',
      rulesDriveFile: phase4RulesDriveFile,
      logicSheetName: String(phase4Stored.phase4RulesLogicSheet || 'Logic').trim(),
      openaiApiKey: phase4OpenAiKey,
      openaiModel: String(phase4Stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
      openaiBaseUrl: String(phase4Stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
      phase4BClickupListName: String(phase4Stored.phase4BClickupListName || '').trim(),
      phase4BClickupListId: phase4BListId,
      clickupOpenStatus: String(
        phase4Stored.phase4BClickupOpenStatus ||
          process.env.PHASE4B_CLICKUP_OPEN_STATUS ||
          'To Do'
      ).trim()
    }, () => {});
    emitInventoryAutoChainLog(
      `Phase4 auto-run: 4B completed ` +
        `(vmfUpdated=${phase4BSummary?.vmfFieldsUpdated || 0}, ` +
        `vmfTasksCreated=${phase4BSummary?.vmfTasksCreated || 0})`
    );

    const cmfDryRun =
      typeof phase4Stored.phase4CMFDryRun === 'boolean'
        ? phase4Stored.phase4CMFDryRun
        : true;
    const phase4CSummary = await runPhase4CMF({
      ...phase4Stored,
      dryRun: cmfDryRun,
      execute: !cmfDryRun,
      authContext: 'inventory',
      rulesDriveFile: phase4RulesDriveFile,
      logicSheetName: String(phase4Stored.phase4RulesLogicSheet || 'Logic').trim(),
      phase4CClickupListName: String(phase4Stored.phase4CClickupListName || phase4Stored.phase4BClickupListName || '').trim(),
      phase4CClickupListId: phase4CListId,
      phase4CClickupOpenStatus: String(
        phase4Stored.phase4CClickupOpenStatus ||
          phase4Stored.phase4BClickupOpenStatus ||
          process.env.PHASE4C_CLICKUP_OPEN_STATUS ||
          process.env.PHASE4B_CLICKUP_OPEN_STATUS ||
          'To Do'
      ).trim()
    }, () => {});
    emitInventoryAutoChainLog(
      `Phase4 auto-run: 4C completed ` +
        `(mfTasksCreated=${phase4CSummary?.mfTasksCreated || 0}, ` +
        `mfWritebacksCompleted=${phase4CSummary?.mfWritebacksCompleted || 0})`
    );

    const dDryRun =
      typeof phase4Stored.phase4DDryRun === 'boolean'
        ? phase4Stored.phase4DDryRun
        : true;
    const phase4DSummary = await runPhase4DListing({
      ...phase4Stored,
      dryRun: dDryRun,
      execute: !dDryRun,
      authContext: 'inventory',
      rulesDriveFile: phase4RulesDriveFile,
      logicSheetName: String(phase4Stored.phase4RulesLogicSheet || 'Logic').trim(),
      phase4DListingsTable: String(phase4Stored.phase4DListingsTable || 'eBay Listings (API)').trim(),
      openaiApiKey: phase4OpenAiKey,
      openaiModel: String(phase4Stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
      openaiBaseUrl: String(phase4Stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim()
    }, () => {});
    emitInventoryAutoChainLog(
      `Phase4 auto-run: 4D completed ` +
        `(listingsEligible=${phase4DSummary?.listingsEligible || 0}, ` +
        `writes=${(phase4DSummary?.fsvFieldsUpdated || 0) + (phase4DSummary?.v1FieldsUpdated || 0) + (phase4DSummary?.v2FieldsUpdated || 0) + (phase4DSummary?.vbFieldsUpdated || 0)})`
    );

    emitInventoryAutoChainLog('Phase4 auto-run completed after Phase1+Phase2+Phase3 success');
  } catch (error) {
    emitInventoryAutoChainLog(`Phase4 auto-run failed after Phase3 success: ${error.message}`, 'error');
  }
});

// Test Google Sheets connection
ipcMain.handle('inventory-sheets-test', async (_, spreadsheetId, worksheetName) => {
  try {
    const result = await testSheetsConnection(spreadsheetId, worksheetName);
    return result;
  } catch (error) {
    return {
      success: false,
      message: `Test failed: ${error.message}`
    };
  }
});

// Validate and extract spreadsheet ID from URL
ipcMain.handle('inventory-sheets-validate-url', async (_, sheetsUrl) => {
  try {
    const result = validateAndExtractSpreadsheetId(sheetsUrl);
    return result;
  } catch (error) {
    return {
      success: false,
      message: `URL validation failed: ${error.message}`
    };
  }
});

// Save Google Sheets configuration
ipcMain.handle('inventory-sheets-save-config', async (_, spreadsheetId, worksheetName) => {
  try {
    const { saveInventoryConfig } = require('../config/configStore');
    saveInventoryConfig('spreadsheetId', spreadsheetId);
    saveInventoryConfig('worksheetName', worksheetName);
    
    return {
      success: true,
      message: 'Google Sheets configuration saved successfully'
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to save: ${error.message}`
    };
  }
});

// Start inventory Google Sheets schedule
ipcMain.handle('inventory-sheets-start', async (_, spreadsheetId, worksheetName) => {
  try {
    const isAuthenticated = await oauth2Service.isAuthenticated('inventory');
    if (!isAuthenticated) {
      return {
        success: false,
        message: 'Please connect to Google Sheets first using the Connect button.'
      };
    }

    const started = startInventorySchedule(spreadsheetId, worksheetName);
    
    if (started) {
      return {
        success: true,
        message: 'Schedule started successfully. Inventory data will be written to Google Sheets daily at midnight.'
      };
    } else {
      return {
        success: false,
        message: 'Failed to start schedule'
      };
    }
  } catch (error) {
    return {
      success: false,
      message: `Failed to start schedule: ${error.message}`
    };
  }
});

// Stop inventory Google Sheets schedule
ipcMain.handle('inventory-sheets-stop', async () => {
  try {
    stopInventorySchedule();
    
    return {
      success: true,
      message: 'Schedule stopped successfully'
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to stop schedule: ${error.message}`
    };
  }
});

// Push inventory to Google Sheets now (manual test)
ipcMain.handle('inventory-sheets-push-now', async (_, spreadsheetId, worksheetName) => {
  try {
    const isAuthenticated = await oauth2Service.isAuthenticated('inventory');
    if (!isAuthenticated) {
      return {
        success: false,
        message: 'Please connect to Google Sheets first using the Connect button.'
      };
    }

    const result = await executeInventoryPush(spreadsheetId, worksheetName);
    return result;
  } catch (error) {
    return {
      success: false,
      message: `Push failed: ${error.message}`
    };
  }
});

// Get schedule status
ipcMain.handle('inventory-sheets-get-status', async () => {
  try {
    const status = getScheduleStatus();
    return status;
  } catch (error) {
    return {
      active: false,
      spreadsheetId: null,
      worksheetName: null
    };
  }
});

// Get execution logs
ipcMain.handle('inventory-sheets-get-logs', async () => {
  try {
    const logs = getInventoryLogs();
    return logs;
  } catch (error) {
    return [];
  }
});

/* ---------------------------
   PHASE 2 HANDLERS (GOOGLE SHEETS -> AIRTABLE)
---------------------------- */
function buildPhase2WritebackConfig(overrides = {}) {
  const stored = getInventoryConfig('phase2Config') || {};
  const merged = buildPhase2Config({
    ...stored,
    ...overrides
  });
  const normalizedCategoryTable = String(merged.airtableCategoryTable || '').trim();
  const resolvedCategoryTable =
    normalizedCategoryTable.toLowerCase() === 'category names'
      ? 'Category Definitions'
      : normalizedCategoryTable || 'Category Definitions';

  return {
    clickupToken: merged.clickupToken,
    clickupListId: merged.clickupListId,
    airtableToken: merged.airtableToken,
    airtableBaseId: merged.airtableBaseId,
    airtableMasterTable: merged.airtableMasterTable,
    airtableCategoryTable: resolvedCategoryTable,
    clickupResolvedCategoryFieldName: merged.clickupResolvedCategoryFieldName,
    clickupStatusDetermined: merged.clickupStatusDetermined,
    clickupStatusCompleted: merged.clickupStatusCompleted,
    clickupStatusNeedsReview: merged.clickupStatusNeedsReview,
    clickupStatusWritebackError: merged.clickupStatusWritebackError,
    categoryLinkFieldName: merged.categoryLinkFieldName,
    pollIntervalMinutes: 1,
    enabled: merged.phase2WritebackEnabled
  };
}

function stopPhase4WritebackPoller() {
  if (phase4WritebackInterval) {
    clearInterval(phase4WritebackInterval);
    phase4WritebackInterval = null;
  }
}

function startPhase4WritebackPoller() {
  stopPhase4WritebackPoller();

  phase4WritebackInterval = setInterval(async () => {
    if (isPhase4WritebackPollerRunning) return;
    isPhase4WritebackPollerRunning = true;
    try {
      const vmfSummary = await runPhase4BWritebackOnly({}, () => {});
      const mfSummary = await runPhase4CMFWritebackOnly({}, () => {});

      const vmfFound = vmfSummary?.vmfDeterminedTasksFound || 0;
      const vmfWritten = vmfSummary?.vmfDeterminedWritebackSucceeded || 0;
      const vmfClosed = vmfSummary?.vmfDeterminedTasksClosed || 0;
      const vmfFailed = vmfSummary?.vmfDeterminedWritebackFailed || 0;
      const mfWritten = mfSummary?.mfWritebacksCompleted || 0;
      const mfSkipped = mfSummary?.mfWritebacksSkippedAlreadyFilled || 0;
      const mfErrors = Array.isArray(mfSummary?.errors) ? mfSummary.errors.length : 0;

      if (vmfFound > 0 || vmfWritten > 0 || vmfClosed > 0 || mfWritten > 0 || mfSkipped > 0 || mfErrors > 0) {
        console.log(
          `Phase4 writeback poller: ` +
            `VMF(found=${vmfFound}, writeback=${vmfWritten}, closed=${vmfClosed}, failed=${vmfFailed}) ` +
            `MF(writeback=${mfWritten}, skippedAlreadyFilled=${mfSkipped}, errors=${mfErrors})`
        );
      }
    } catch (error) {
      console.error(`Phase4 writeback poller failed: ${formatDetailedErrorMessage(error)}`);
    } finally {
      isPhase4WritebackPollerRunning = false;
    }
  }, 60 * 1000);
}

ipcMain.handle('phase2-get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  const merged = buildPhase2Config(stored);
  const phase3Config = buildPhase3Config(stored);

  return {
    sheetId: merged.sheetId || '',
    tabName: merged.tabName || '',
    airtableBaseId: merged.airtableBaseId || '',
    airtableMasterTable: merged.airtableMasterTable || 'Master Parts Table',
    airtableCategoryTable: merged.airtableCategoryTable || 'Category Definitions',
    clickupListId: merged.clickupListId || '',
    phase2AutoRunEnabled: Boolean(merged.phase2AutoRunEnabled),
    phase2AutoRunPollMinutes: Number(merged.phase2AutoRunPollMinutes || 3),
    phase2AutoRunCooldownMinutes: Number(merged.phase2AutoRunCooldownMinutes || 5),
    phase2WritebackEnabled: Boolean(merged.phase2WritebackEnabled),
    writebackPollIntervalMinutes: 1,
    clickupResolvedCategoryFieldName: merged.clickupResolvedCategoryFieldName || 'Category Identifier Selection',
    clickupStatusDetermined: merged.clickupStatusDetermined || 'Category Determined',
    clickupStatusCompleted: merged.clickupStatusCompleted || 'Completed',
    clickupStatusNeedsReview: merged.clickupStatusNeedsReview || 'Needs Review',
    clickupStatusWritebackError: merged.clickupStatusWritebackError || 'Writeback Error',
    categoryLinkFieldName: merged.categoryLinkFieldName || 'Category Definitions Link',
    shipstationApiKey: stored.shipstationApiKey || phase3Config.shipstationApiKey || '',
    shipstationApiSecret: stored.shipstationApiSecret || phase3Config.shipstationApiSecret || '',
    shipstationStoreId: Number(phase3Config.shipstationStoreId || PARTSHUNTER_STORE_ID),
    phase3LookbackDays: Number(phase3Config.phase3LookbackDays || 90),
    phase3DryRun: Boolean(phase3Config.phase3DryRun),
    itemSpecificsBaseId: stored.itemSpecificsBaseId || '',
    phase4RulesDriveFile: stored.phase4RulesDriveFile || process.env.PHASE4_RULES_DRIVE_FILE || process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE || '',
    phase4RulesLogicSheet: stored.phase4RulesLogicSheet || process.env.PHASE4_LOGIC_SHEET || 'Logic',
    phase4GlobalDefaultsTable: stored.phase4GlobalDefaultsTable || process.env.PHASE4_GLOBAL_DEFAULTS_TABLE || 'Fixed Item Specifics (Global Defaults)',
    phase4RulesDryRun:
      typeof stored.phase4RulesDryRun === 'boolean'
        ? stored.phase4RulesDryRun
        : true,
    phase4BLiteDryRun:
      typeof stored.phase4BLiteDryRun === 'boolean'
        ? stored.phase4BLiteDryRun
        : true,
    testTableName: '',
    testMaxTables: 0,
    openaiApiKey: stored.openaiApiKey || '',
    openaiModel: stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    openaiBaseUrl: stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '',
    phase4BClickupOpenStatus:
      stored.phase4BClickupOpenStatus || process.env.PHASE4B_CLICKUP_OPEN_STATUS || 'To Do',
    phase4BClickupListName:
      stored.phase4BClickupListName || '',
    phase4BClickupListId:
      stored.phase4BClickupListId || process.env.PHASE4B_CLICKUP_LIST_ID || merged.clickupListId || '',
    ebayMockCsvPath: stored.ebayMockCsvPath || '',
    ebayMockTableName: stored.ebayMockTableName || 'eBay Listings (API) (Mock)',
    ebayMockDryRun:
      typeof stored.ebayMockDryRun === 'boolean'
        ? stored.ebayMockDryRun
        : true,
    airtableToken: stored.airtableToken || '',
    clickupToken: stored.clickupToken || ''
  };
});

ipcMain.handle('phase2-save-config', async (_, configPayload = {}) => {
  const existing = getInventoryConfig('phase2Config') || {};
  const merged = {
    ...existing,
    ...configPayload
  };

  saveInventoryConfig('phase2Config', merged);
  return { success: true, message: 'Phase 2 configuration saved.' };
});

ipcMain.handle('phase2-get-activity-logs', async () => {
  return getInventoryConfig('phase2ActivityLogs') || [];
});

ipcMain.handle('phase2-append-activity-log', async (_, entry = {}) => {
  const logs = getInventoryConfig('phase2ActivityLogs') || [];
  const normalized = {
    time: String(entry.time || new Date().toLocaleTimeString()),
    text: String(entry.text || '').trim(),
    level: String(entry.level || 'info')
  };
  if (!normalized.text) {
    return { success: false, message: 'Log text is required.' };
  }
  logs.unshift(normalized);
  if (logs.length > 300) logs.length = 300;
  saveInventoryConfig('phase2ActivityLogs', logs);
  return { success: true };
});

ipcMain.handle('phase2-clear-activity-logs', async () => {
  saveInventoryConfig('phase2ActivityLogs', []);
  return { success: true };
});

ipcMain.handle('phase2-clear-task-cache', async () => {
  saveInventoryConfig('phase2TaskCache', {});
  return { success: true, message: 'Phase 2 task cache cleared.' };
});

ipcMain.handle('phase2-writeback-start', async (_, options = {}) => {
  try {
    const config = buildPhase2WritebackConfig(options);
    const status = phase2WritebackPoller.start(config);
    return { success: true, status };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('phase2-writeback-stop', async () => {
  try {
    const status = phase2WritebackPoller.stop();
    return { success: true, status };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('phase2-writeback-status', async () => {
  return phase2WritebackPoller.getStatus();
});

ipcMain.handle('phase2-writeback-run-once', async (_, options = {}) => {
  try {
    const config = buildPhase2WritebackConfig(options);
    const result = await phase2WritebackPoller.executeOnce(config);
    return { success: true, result };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('phase2-autorun-status', async () => {
  return phase2AutoRunService.getStatus();
});

ipcMain.handle('phase2-autorun-start', async (_, options = {}) => {
  try {
    const status = phase2AutoRunService.start(options);
    return { success: true, status };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('phase2-autorun-stop', async () => {
  try {
    const status = phase2AutoRunService.stop();
    return { success: true, status };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('phase2-autorun-run-now', async () => {
  try {
    const result = await phase2AutoRunService.trigger('manual_run_now', { force: true });
    return { success: true, result };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('phase2-fetch-clickup-lists', async (_, token = '') => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const resolvedToken = String(token || '').trim() || String(stored.clickupToken || '').trim();
    if (!resolvedToken) {
      return {
        success: false,
        message: 'ClickUp token is required to fetch lists.',
        lists: []
      };
    }

    const clickupService = new ClickUpService({ token: resolvedToken });
    const lists = await clickupService.fetchAllLists();
    return { success: true, lists };
  } catch (error) {
    const message =
      error?.response?.data?.err ||
      error?.response?.data?.error ||
      error?.message ||
      'Failed to fetch ClickUp lists.';
    return { success: false, message, lists: [] };
  }
});

ipcMain.handle('phase2-fetch-airtable-bases', async (_, token = '') => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const resolvedToken = String(token || '').trim() || String(stored.airtableToken || '').trim();
    if (!resolvedToken) {
      return {
        success: false,
        message: 'Airtable token is required to fetch bases.',
        bases: []
      };
    }

    const bases = await AirtableService.fetchAllBases(resolvedToken);
    return { success: true, bases };
  } catch (error) {
    const message =
      error?.response?.data?.error?.message ||
      error?.response?.data?.error ||
      error?.message ||
      'Failed to fetch Airtable bases.';
    return { success: false, message, bases: [] };
  }
});

ipcMain.handle('phase2-validate-clickup-config', async (_, payload = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const token = String(payload.clickupToken || stored.clickupToken || '').trim();
    const listId = String(payload.clickupListId || stored.clickupListId || '').trim();
    if (!token || !listId) {
      return { success: false, message: 'ClickUp token and list ID are required.' };
    }

    const clickupService = new ClickUpService({ token, listId });
    const list = await clickupService.getList();
    return {
      success: true,
      list: {
        id: String(list?.id || listId),
        name: String(list?.name || 'Unknown List')
      }
    };
  } catch (error) {
    const message =
      error?.response?.data?.err ||
      error?.response?.data?.error ||
      error?.message ||
      'Failed to validate ClickUp list access.';
    return { success: false, message };
  }
});

ipcMain.handle('phase2-validate-airtable-config', async (_, payload = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const token = String(payload.airtableToken || stored.airtableToken || '').trim();
    const baseId = String(payload.airtableBaseId || stored.airtableBaseId || '').trim();
    const masterTable = String(payload.airtableMasterTable || stored.airtableMasterTable || 'Master Parts Table').trim();
    const categoryTable = String(payload.airtableCategoryTable || stored.airtableCategoryTable || 'Category Definitions').trim();
    if (!token || !baseId) {
      return { success: false, message: 'Airtable token and base ID are required.' };
    }

    const airtableService = new AirtableService({
      token,
      baseId,
      masterTable,
      categoryTable
    });
    const result = await airtableService.validateConfig();
    return { success: true, result };
  } catch (error) {
    const message =
      error?.response?.data?.error?.message ||
      error?.response?.data?.error ||
      error?.message ||
      'Failed to validate Airtable base access.';
    return { success: false, message };
  }
});

ipcMain.handle('phase2-run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptions = {
      ...stored,
      ...options
    };

    const summary = await runPhase2(runOptions, progress => {
      event.sender.send('phase2-progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase2-progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });

    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase3:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  const merged = buildPhase3Config(stored);

  return {
    sheetId: merged.sheetId || '',
    tabName: merged.tabName || '',
    airtableBaseId: merged.airtableBaseId || '',
    airtableMasterTable: merged.airtableMasterTable || 'Master Parts Table',
    airtableToken: stored.airtableToken || merged.airtableToken || '',
    shipstationApiKey: stored.shipstationApiKey || merged.shipstationApiKey || '',
    shipstationApiSecret: stored.shipstationApiSecret || merged.shipstationApiSecret || '',
    shipstationStoreId: Number(merged.shipstationStoreId || PARTSHUNTER_STORE_ID),
    phase3LookbackDays: Number(merged.phase3LookbackDays || 90),
    phase3DryRun: Boolean(merged.phase3DryRun)
  };
});

ipcMain.handle('phase3:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptions = {
      ...stored,
      ...options
    };

    const summary = await runPhase3(runOptions, progress => {
      event.sender.send('phase3:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    event.sender.send('phase3:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message: error.message
    });

    return {
      success: false,
      message: error.message
    };
  }
});

ipcMain.handle('phase4:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  const merged = buildPhase4Config(stored);
  const state = getInventoryConfig(MIRROR_STATE_KEY) || {};

  return {
    airtableToken: stored.airtableToken || merged.airtableToken || '',
    masterBaseId: merged.masterBaseId || '',
    masterTable: merged.masterTable || 'Master Parts Table',
    itemSpecificsBaseId: merged.itemSpecificsBaseId || '',
    incrementalEnabled: Boolean(merged.incrementalEnabled),
    dryRun: Boolean(merged.dryRun),
    lastMirrorRunAt: state?.lastMirrorRunAt || '',
    lastRunStatus: state?.lastRunStatus || ''
  };
});

ipcMain.handle('phase4:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runOptions = {
      ...stored,
      ...options
    };

    const summary = await runPhase4Mirroring(runOptions, progress => {
      event.sender.send('phase4:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase4:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });

    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase4rules:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  return {
    rulesDriveFile:
      String(
        stored.phase4RulesDriveFile ||
          process.env.PHASE4_RULES_DRIVE_FILE ||
          process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
          ''
      ).trim(),
    globalDefaultsTable:
      String(
        stored.phase4GlobalDefaultsTable ||
          process.env.PHASE4_GLOBAL_DEFAULTS_TABLE ||
          'Fixed Item Specifics (Global Defaults)'
      ).trim(),
    logicSheetName: String(stored.phase4RulesLogicSheet || process.env.PHASE4_LOGIC_SHEET || 'Logic').trim(),
    dryRun:
      typeof stored.phase4RulesDryRun === 'boolean'
        ? stored.phase4RulesDryRun
        : true,
    authContext: 'inventory'
  };
});

ipcMain.handle('phase4rules:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const dryRun =
      typeof options.phase4RulesDryRun === 'boolean'
        ? options.phase4RulesDryRun
        : typeof stored.phase4RulesDryRun === 'boolean'
          ? stored.phase4RulesDryRun
          : true;
    const runOptions = {
      ...stored,
      ...options,
      dryRun,
      execute: !dryRun,
      ruleTypes: ['F'],
      authContext: 'inventory',
      rulesDriveFile:
        String(
          options.phase4RulesDriveFile ||
            stored.phase4RulesDriveFile ||
            process.env.PHASE4_RULES_DRIVE_FILE ||
            process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
            ''
        ).trim(),
      globalDefaultsTable: String(
        options.phase4GlobalDefaultsTable ||
          stored.phase4GlobalDefaultsTable ||
          process.env.PHASE4_GLOBAL_DEFAULTS_TABLE ||
          'Fixed Item Specifics (Global Defaults)'
      ).trim(),
      logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim()
    };

    const summary = await runPhase4RulesPopulate(runOptions, progress => {
      event.sender.send('phase4rules:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase4rules:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase4blite:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  return {
    rulesDriveFile:
      String(
        stored.phase4RulesDriveFile ||
          process.env.PHASE4_RULES_DRIVE_FILE ||
          process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
          ''
      ).trim(),
    logicSheetName: String(stored.phase4RulesLogicSheet || process.env.PHASE4_LOGIC_SHEET || 'Logic').trim(),
    dryRun:
      typeof stored.phase4BLiteDryRun === 'boolean'
        ? stored.phase4BLiteDryRun
        : true,
    testTableName: '',
    testMaxTables: 0,
    openaiApiKey: String(stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
    openaiModel: String(stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
    openaiBaseUrl: String(stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
    clickupListName: String(stored.phase4BClickupListName || '').trim(),
    clickupListId: String(
      stored.phase4BClickupListId ||
        process.env.PHASE4B_CLICKUP_LIST_ID ||
        ''
    ).trim(),
    clickupOpenStatus:
      String(stored.phase4BClickupOpenStatus || process.env.PHASE4B_CLICKUP_OPEN_STATUS || 'To Do').trim(),
    authContext: 'inventory'
  };
});

ipcMain.handle('phase4blite:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const dryRun =
      typeof options.phase4BLiteDryRun === 'boolean'
        ? options.phase4BLiteDryRun
        : typeof stored.phase4BLiteDryRun === 'boolean'
          ? stored.phase4BLiteDryRun
          : true;

    const runOptions = {
      ...stored,
      ...options,
      dryRun,
      execute: !dryRun,
      authContext: 'inventory',
      rulesDriveFile:
        String(
          options.phase4RulesDriveFile ||
            stored.phase4RulesDriveFile ||
            process.env.PHASE4_RULES_DRIVE_FILE ||
            process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
            ''
        ).trim(),
      logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim(),
      testTableName: '',
      testMaxTables: 0,
      openaiApiKey: String(options.openaiApiKey || stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
      openaiModel: String(options.openaiModel || stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
      openaiBaseUrl: String(options.openaiBaseUrl || stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
      phase4BClickupListName: String(
        options.phase4BClickupListName || stored.phase4BClickupListName || ''
      ).trim(),
      phase4BClickupListId: String(
        options.phase4BClickupListId ||
          stored.phase4BClickupListId ||
          process.env.PHASE4B_CLICKUP_LIST_ID ||
          ''
      ).trim(),
      clickupOpenStatus: String(
        options.phase4BClickupOpenStatus ||
          stored.phase4BClickupOpenStatus ||
          process.env.PHASE4B_CLICKUP_OPEN_STATUS ||
          'To Do'
      ).trim()
    };

    const summary = await runPhase4BLite(runOptions, progress => {
      event.sender.send('phase4blite:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase4blite:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase4cmf:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  return {
    rulesDriveFile:
      String(
        stored.phase4RulesDriveFile ||
          process.env.PHASE4_RULES_DRIVE_FILE ||
          process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
          ''
      ).trim(),
    logicSheetName: String(stored.phase4RulesLogicSheet || process.env.PHASE4_LOGIC_SHEET || 'Logic').trim(),
    dryRun:
      typeof stored.phase4CMFDryRun === 'boolean'
        ? stored.phase4CMFDryRun
        : true,
    testTableName: '',
    testMaxTables: 0,
    clickupListName: String(stored.phase4CClickupListName || stored.phase4BClickupListName || '').trim(),
    clickupListId: String(
      stored.phase4CClickupListId ||
        stored.phase4BClickupListId ||
        process.env.PHASE4C_CLICKUP_LIST_ID ||
        process.env.PHASE4B_CLICKUP_LIST_ID ||
        ''
    ).trim(),
    clickupOpenStatus: String(
      stored.phase4CClickupOpenStatus ||
        stored.phase4BClickupOpenStatus ||
        process.env.PHASE4C_CLICKUP_OPEN_STATUS ||
        process.env.PHASE4B_CLICKUP_OPEN_STATUS ||
        'To Do'
    ).trim(),
    authContext: 'inventory'
  };
});

ipcMain.handle('phase4cmf:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const dryRun =
      typeof options.phase4CMFDryRun === 'boolean'
        ? options.phase4CMFDryRun
        : typeof stored.phase4CMFDryRun === 'boolean'
          ? stored.phase4CMFDryRun
          : true;
    const runOptions = {
      ...stored,
      ...options,
      dryRun,
      execute: !dryRun,
      authContext: 'inventory',
      rulesDriveFile:
        String(
          options.phase4RulesDriveFile ||
            stored.phase4RulesDriveFile ||
            process.env.PHASE4_RULES_DRIVE_FILE ||
            process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
            ''
        ).trim(),
      logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim(),
      testTableName: '',
      testMaxTables: 0,
      phase4CClickupListName: String(
        options.phase4CClickupListName ||
          stored.phase4CClickupListName ||
          stored.phase4BClickupListName ||
          ''
      ).trim(),
      phase4CClickupListId: String(
        options.phase4CClickupListId ||
          stored.phase4CClickupListId ||
          stored.phase4BClickupListId ||
          process.env.PHASE4C_CLICKUP_LIST_ID ||
          process.env.PHASE4B_CLICKUP_LIST_ID ||
          ''
      ).trim(),
      phase4CClickupOpenStatus: String(
        options.phase4CClickupOpenStatus ||
          stored.phase4CClickupOpenStatus ||
          stored.phase4BClickupOpenStatus ||
          process.env.PHASE4C_CLICKUP_OPEN_STATUS ||
          process.env.PHASE4B_CLICKUP_OPEN_STATUS ||
          'To Do'
      ).trim()
    };

    const summary = await runPhase4CMF(runOptions, progress => {
      event.sender.send('phase4cmf:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase4cmf:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase4d:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  return {
    rulesDriveFile:
      String(
        stored.phase4RulesDriveFile ||
          process.env.PHASE4_RULES_DRIVE_FILE ||
          process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
          ''
      ).trim(),
    logicSheetName: String(stored.phase4RulesLogicSheet || process.env.PHASE4_LOGIC_SHEET || 'Logic').trim(),
    dryRun:
      typeof stored.phase4DDryRun === 'boolean'
        ? stored.phase4DDryRun
        : true,
    listingsTableName: String(stored.phase4DListingsTable || process.env.PHASE4D_LISTINGS_TABLE || 'eBay Listings (API)').trim(),
    openaiModel: String(stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
    authContext: 'inventory'
  };
});

ipcMain.handle('phase4d:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const dryRun =
      typeof options.phase4DDryRun === 'boolean'
        ? options.phase4DDryRun
        : typeof stored.phase4DDryRun === 'boolean'
          ? stored.phase4DDryRun
          : true;
    const runOptions = {
      ...stored,
      ...options,
      dryRun,
      execute: !dryRun,
      authContext: 'inventory',
      rulesDriveFile:
        String(
          options.phase4RulesDriveFile ||
            stored.phase4RulesDriveFile ||
            process.env.PHASE4_RULES_DRIVE_FILE ||
            process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
            ''
        ).trim(),
      logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim(),
      phase4DListingsTable: String(
        options.phase4DListingsTable ||
          stored.phase4DListingsTable ||
          process.env.PHASE4D_LISTINGS_TABLE ||
          'eBay Listings (API)'
      ).trim(),
      testTableName: '',
      testMaxTables: 0,
      openaiApiKey: String(options.openaiApiKey || stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
      openaiModel: String(options.openaiModel || stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
      openaiBaseUrl: String(options.openaiBaseUrl || stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim()
    };

    event.sender.send('phase4d:progress', {
      stage: 'phase4d_load_rules',
      percent: 1,
      counts: null,
      message: 'Starting Phase 4D run...'
    });

    const summary = await runPhase4DListing(runOptions, progress => {
      event.sender.send('phase4d:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase4d:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase4pipeline:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const runMirror = options.phase4RunMirror !== false;
    const run4A = options.phase4Run4A !== false;
    const run4B = options.phase4Run4B !== false;
    const run4C = options.phase4Run4C !== false;
    const run4D = options.phase4Run4D !== false;

    const phases = [];
    if (runMirror) phases.push('mirror');
    if (run4A) phases.push('4a');
    if (run4B) phases.push('4b');
    if (run4C) phases.push('4c');
    if (run4D) phases.push('4d');
    if (phases.length === 0) {
      return { success: false, message: 'Select at least one Phase 4 subphase.' };
    }

    const phaseSummary = {};
    const progressBase = 2;
    const progressSpan = 96;
    const segment = Math.max(1, Math.floor(progressSpan / phases.length));
    let phaseIndex = 0;

    const mapProgress = (innerPercent = 0) =>
      Math.min(
        98,
        progressBase + phaseIndex * segment + Math.floor((Math.max(0, Math.min(100, Number(innerPercent || 0))) / 100) * segment)
      );

    event.sender.send('phase4pipeline:progress', {
      stage: 'phase4pipeline_start',
      percent: 1,
      counts: null,
      message: `Starting Phase 4 pipeline (${phases.join(' -> ')})...`
    });

    if (runMirror) {
      const mirrorOptions = {
        ...stored,
        ...options,
        authContext: 'inventory',
        itemSpecificsBaseId: String(options.itemSpecificsBaseId || stored.itemSpecificsBaseId || '').trim(),
        dryRun:
          typeof options.phase4DryRun === 'boolean'
            ? options.phase4DryRun
            : true,
        incrementalEnabled:
          typeof options.phase4IncrementalEnabled === 'boolean'
            ? options.phase4IncrementalEnabled
            : true
      };
      const mirrorSummary = await runPhase4Mirroring(mirrorOptions, progress => {
        event.sender.send('phase4pipeline:progress', {
          ...progress,
          stage: `phase4pipeline_mirror_${String(progress?.stage || 'running')}`,
          percent: mapProgress(progress?.percent),
          message: `[Mirror] ${String(progress?.message || '').trim()}`
        });
      });
      phaseSummary.mirror = mirrorSummary || {};
      phaseIndex += 1;
    }

    if (run4A) {
      const rulesDryRun =
        typeof options.phase4RulesDryRun === 'boolean'
          ? options.phase4RulesDryRun
          : typeof stored.phase4RulesDryRun === 'boolean'
            ? stored.phase4RulesDryRun
            : true;
      const rulesOptions = {
        ...stored,
        ...options,
        dryRun: rulesDryRun,
        execute: !rulesDryRun,
        ruleTypes: ['F'],
        authContext: 'inventory',
        rulesDriveFile:
          String(
            options.phase4RulesDriveFile ||
              stored.phase4RulesDriveFile ||
              process.env.PHASE4_RULES_DRIVE_FILE ||
              process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
              ''
          ).trim(),
        globalDefaultsTable: String(
          options.phase4GlobalDefaultsTable ||
            stored.phase4GlobalDefaultsTable ||
            process.env.PHASE4_GLOBAL_DEFAULTS_TABLE ||
            'Fixed Item Specifics (Global Defaults)'
        ).trim(),
        logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim()
      };
      const phase4ASummary = await runPhase4RulesPopulate(rulesOptions, progress => {
        event.sender.send('phase4pipeline:progress', {
          ...progress,
          stage: `phase4pipeline_4a_${String(progress?.stage || 'running')}`,
          percent: mapProgress(progress?.percent),
          message: `[4A] ${String(progress?.message || '').trim()}`
        });
      });
      phaseSummary.phase4A = phase4ASummary || {};
      phaseIndex += 1;
    }

    if (run4B) {
      const bliteDryRun =
        typeof options.phase4BLiteDryRun === 'boolean'
          ? options.phase4BLiteDryRun
          : typeof stored.phase4BLiteDryRun === 'boolean'
            ? stored.phase4BLiteDryRun
            : true;
      const bliteOptions = {
        ...stored,
        ...options,
        dryRun: bliteDryRun,
        execute: !bliteDryRun,
        authContext: 'inventory',
        rulesDriveFile:
          String(
            options.phase4RulesDriveFile ||
              stored.phase4RulesDriveFile ||
              process.env.PHASE4_RULES_DRIVE_FILE ||
              process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
              ''
          ).trim(),
        logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim(),
        testTableName: '',
        testMaxTables: 0,
        openaiApiKey: String(options.openaiApiKey || stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
        openaiModel: String(options.openaiModel || stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
        openaiBaseUrl: String(options.openaiBaseUrl || stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
        phase4BClickupListName: String(
          options.phase4BClickupListName || stored.phase4BClickupListName || ''
        ).trim(),
        phase4BClickupListId: String(
          options.phase4BClickupListId ||
            stored.phase4BClickupListId ||
            process.env.PHASE4B_CLICKUP_LIST_ID ||
            ''
        ).trim(),
        clickupOpenStatus: String(
          options.phase4BClickupOpenStatus ||
            stored.phase4BClickupOpenStatus ||
            process.env.PHASE4B_CLICKUP_OPEN_STATUS ||
            'To Do'
        ).trim()
      };
      const phase4BSummary = await runPhase4BLite(bliteOptions, progress => {
        event.sender.send('phase4pipeline:progress', {
          ...progress,
          stage: `phase4pipeline_4b_${String(progress?.stage || 'running')}`,
          percent: mapProgress(progress?.percent),
          message: `[4B] ${String(progress?.message || '').trim()}`
        });
      });
      phaseSummary.phase4B = phase4BSummary || {};
      phaseIndex += 1;
    }

    if (run4C) {
      const cmfDryRun =
        typeof options.phase4CMFDryRun === 'boolean'
          ? options.phase4CMFDryRun
          : typeof stored.phase4CMFDryRun === 'boolean'
            ? stored.phase4CMFDryRun
            : true;
      const cmfOptions = {
        ...stored,
        ...options,
        dryRun: cmfDryRun,
        execute: !cmfDryRun,
        authContext: 'inventory',
        rulesDriveFile:
          String(
            options.phase4RulesDriveFile ||
              stored.phase4RulesDriveFile ||
              process.env.PHASE4_RULES_DRIVE_FILE ||
              process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
              ''
          ).trim(),
        logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim(),
        phase4CClickupListName: String(
          options.phase4CClickupListName || stored.phase4CClickupListName || ''
        ).trim(),
        phase4CClickupListId: String(
          options.phase4CClickupListId ||
            stored.phase4CClickupListId ||
            process.env.PHASE4C_CLICKUP_LIST_ID ||
            ''
        ).trim(),
        phase4CClickupOpenStatus: String(
          options.phase4CClickupOpenStatus ||
            stored.phase4CClickupOpenStatus ||
            process.env.PHASE4C_CLICKUP_OPEN_STATUS ||
            'To Do'
        ).trim()
      };
      const phase4CSummary = await runPhase4CMF(cmfOptions, progress => {
        event.sender.send('phase4pipeline:progress', {
          ...progress,
          stage: `phase4pipeline_4c_${String(progress?.stage || 'running')}`,
          percent: mapProgress(progress?.percent),
          message: `[4C] ${String(progress?.message || '').trim()}`
        });
      });
      phaseSummary.phase4C = phase4CSummary || {};
      phaseIndex += 1;
    }

    if (run4D) {
      const dDryRun =
        typeof options.phase4DDryRun === 'boolean'
          ? options.phase4DDryRun
          : typeof stored.phase4DDryRun === 'boolean'
            ? stored.phase4DDryRun
            : true;
      const dOptions = {
        ...stored,
        ...options,
        dryRun: dDryRun,
        execute: !dDryRun,
        authContext: 'inventory',
        rulesDriveFile:
          String(
            options.phase4RulesDriveFile ||
              stored.phase4RulesDriveFile ||
              process.env.PHASE4_RULES_DRIVE_FILE ||
              process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
              ''
          ).trim(),
        logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim(),
        phase4DListingsTable: String(options.phase4DListingsTable || stored.phase4DListingsTable || 'eBay Listings (API)').trim(),
        openaiApiKey: String(options.openaiApiKey || stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
        openaiModel: String(options.openaiModel || stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
        openaiBaseUrl: String(options.openaiBaseUrl || stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim()
      };
      const phase4DSummary = await runPhase4DListing(dOptions, progress => {
        event.sender.send('phase4pipeline:progress', {
          ...progress,
          stage: `phase4pipeline_4d_${String(progress?.stage || 'running')}`,
          percent: mapProgress(progress?.percent),
          message: `[4D] ${String(progress?.message || '').trim()}`
        });
      });
      phaseSummary.phase4D = phase4DSummary || {};
    }

    event.sender.send('phase4pipeline:progress', {
      stage: 'completed',
      percent: 100,
      counts: phaseSummary,
      message: 'Phase 4 pipeline completed.'
    });

    return {
      success: true,
      summary: phaseSummary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase4pipeline:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('phase4combined:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const rulesDryRun =
      typeof options.phase4RulesDryRun === 'boolean'
        ? options.phase4RulesDryRun
        : typeof stored.phase4RulesDryRun === 'boolean'
          ? stored.phase4RulesDryRun
          : true;
    const bliteDryRun =
      typeof options.phase4BLiteDryRun === 'boolean'
        ? options.phase4BLiteDryRun
        : typeof stored.phase4BLiteDryRun === 'boolean'
          ? stored.phase4BLiteDryRun
          : true;

    const rulesRunOptions = {
      ...stored,
      ...options,
      dryRun: rulesDryRun,
      execute: !rulesDryRun,
      ruleTypes: ['F'],
      authContext: 'inventory',
      rulesDriveFile:
        String(
          options.phase4RulesDriveFile ||
            stored.phase4RulesDriveFile ||
            process.env.PHASE4_RULES_DRIVE_FILE ||
            process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
            ''
        ).trim(),
      globalDefaultsTable: String(
        options.phase4GlobalDefaultsTable ||
          stored.phase4GlobalDefaultsTable ||
          process.env.PHASE4_GLOBAL_DEFAULTS_TABLE ||
          'Fixed Item Specifics (Global Defaults)'
      ).trim(),
      logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim()
    };

    event.sender.send('phase4combined:progress', {
      stage: 'phase4combined_start',
      percent: 1,
      counts: null,
      message: 'Starting Phase 4 combined run (4A -> 4B-lite).'
    });

    const phase4ASummary = await runPhase4RulesPopulate(rulesRunOptions, progress => {
      const innerPercent = Number(progress?.percent || 0);
      const mappedPercent = Math.max(1, Math.min(49, Math.floor((innerPercent / 100) * 49)));
      event.sender.send('phase4combined:progress', {
        ...progress,
        stage: `phase4combined_4a_${String(progress?.stage || 'running')}`,
        percent: mappedPercent,
        message: `[4A] ${String(progress?.message || '').trim()}`
      });
    });

    const bliteRunOptions = {
      ...stored,
      ...options,
      dryRun: bliteDryRun,
      execute: !bliteDryRun,
      authContext: 'inventory',
      rulesDriveFile:
        String(
          options.phase4RulesDriveFile ||
            stored.phase4RulesDriveFile ||
            process.env.PHASE4_RULES_DRIVE_FILE ||
            process.env.ITEM_SPECIFIC_RULES_DRIVE_FILE ||
            ''
        ).trim(),
      logicSheetName: String(options.phase4RulesLogicSheet || stored.phase4RulesLogicSheet || 'Logic').trim(),
      testTableName: '',
      testMaxTables: 0,
      openaiApiKey: String(options.openaiApiKey || stored.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
      openaiModel: String(options.openaiModel || stored.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
      openaiBaseUrl: String(options.openaiBaseUrl || stored.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim(),
      phase4BClickupListName: String(
        options.phase4BClickupListName || stored.phase4BClickupListName || ''
      ).trim(),
      phase4BClickupListId: String(
        options.phase4BClickupListId ||
          stored.phase4BClickupListId ||
          process.env.PHASE4B_CLICKUP_LIST_ID ||
          ''
      ).trim(),
      clickupOpenStatus: String(
        options.phase4BClickupOpenStatus ||
          stored.phase4BClickupOpenStatus ||
          process.env.PHASE4B_CLICKUP_OPEN_STATUS ||
          'To Do'
      ).trim()
    };

    const phase4BSummary = await runPhase4BLite(bliteRunOptions, progress => {
      const innerPercent = Number(progress?.percent || 0);
      const mappedPercent = Math.max(50, Math.min(99, 50 + Math.floor((innerPercent / 100) * 49)));
      event.sender.send('phase4combined:progress', {
        ...progress,
        stage: `phase4combined_4b_${String(progress?.stage || 'running')}`,
        percent: mappedPercent,
        message: `[4B-lite] ${String(progress?.message || '').trim()}`
      });
    });

    const summary = {
      phase4A: phase4ASummary || {},
      phase4BLite: phase4BSummary || {}
    };

    event.sender.send('phase4combined:progress', {
      stage: 'completed',
      percent: 100,
      counts: summary,
      message: 'Phase 4 combined run completed.'
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('phase4combined:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('ebaymock:get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  return {
    csvPath: String(stored.ebayMockCsvPath || '').trim(),
    tableName: String(stored.ebayMockTableName || 'eBay Listings (API) (Mock)').trim(),
    dryRun:
      typeof stored.ebayMockDryRun === 'boolean'
        ? stored.ebayMockDryRun
        : true
  };
});

ipcMain.handle('ebaymock:run', async (event, options = {}) => {
  try {
    const stored = getInventoryConfig('phase2Config') || {};
    const dryRun =
      typeof options.ebayMockDryRun === 'boolean'
        ? options.ebayMockDryRun
        : typeof stored.ebayMockDryRun === 'boolean'
          ? stored.ebayMockDryRun
          : true;
    const runOptions = {
      ...stored,
      ...options,
      dryRun,
      csvPath: String(options.ebayMockCsvPath || stored.ebayMockCsvPath || '').trim(),
      tableName: String(
        options.ebayMockTableName || stored.ebayMockTableName || 'eBay Listings (API) (Mock)'
      ).trim()
    };

    const summary = await runEbayMockImport(runOptions, progress => {
      event.sender.send('ebaymock:progress', progress);
    });

    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('ebaymock:progress', {
      stage: 'error',
      percent: 100,
      counts: null,
      message
    });
    return {
      success: false,
      message
    };
  }
});

ipcMain.handle('item-specific-sync:run', async (event, options = {}) => {
  try {
    const summary = await runItemSpecificTableSync(options, progress => {
      event.sender.send('item-specific-sync:progress', progress);
    });
    return {
      success: true,
      summary
    };
  } catch (error) {
    const message = formatDetailedErrorMessage(error);
    event.sender.send('item-specific-sync:progress', {
      stage: 'error',
      at: new Date().toISOString(),
      message
    });
    return {
      success: false,
      message
    };
  }
});

/* ---------------------------
   WINDOW CREATION (STRICT)
---------------------------- */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
    },
  });

  const dbConfig = getDbConfig();
  const webhook = getWebhookConfig();

  console.log('Startup:', {
    db: !!dbConfig,
    webhook: !!webhook
  });

  // 🚦 STRICT ROUTING - Show page immediately
  if (!dbConfig) {
    return loadSetup();
  }

  // Missing webhook should not block app startup; users can configure it from dashboard flows.
  if (!webhook) {
    console.log('Webhook not configured, continuing to dashboard.');
  }

  // Initialize DB asynchronously in background AFTER loading dashboard
  loadDashboard();
  
  // Try to init DB after a short delay so UI renders first
  setImmediate(async () => {
    try {
      if (dbConfig.authType === 'windows') {
        await initDbWindowsAuth(dbConfig.server, dbConfig.database);
      } else {
        await initDb();
      }
      dbReady = true;
      // startAutoSync(); // Removed: Only sync on manual button click
      console.log('✅ DB ready');
      
      // Resume any active reporting schedules
      resumeSchedule();
      
      // Initialize inventory webhook schedule if it was previously active
      initInventorySchedule();

      const writebackConfig = buildPhase2WritebackConfig();
      if (parseBoolean(writebackConfig.enabled, false)) {
        phase2WritebackPoller.start(writebackConfig);
        console.log(
          `Phase2 write-back poller started (${Number(writebackConfig.pollIntervalMinutes) || 1} min interval)`
        );
      }
      startPhase4WritebackPoller();
      console.log('Phase4 writeback poller started (1 min interval)');
    } catch (err) {
      console.error('❌ DB init failed:', err.message);
      dbReady = false;
    }
  });
}

/* ---------------------------
   APP LIFECYCLE
---------------------------- */

// Start OAuth2 callback server
const http = require('http');
const url = require('url');
const { shell } = require('electron');

http.createServer(async (req, res) => {
  const queryUrl = url.parse(req.url, true);
  const code = queryUrl.query.code;
  const state = queryUrl.query.state;
  const authContext = state === 'inventory' ? 'inventory' : 'reporting';

  if (code) {
    // Exchange code for tokens
    try {
      await oauth2Service.getTokensFromCode(code, authContext);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <head><title>Authorization Successful</title></head>
          <body style="font-family: Arial; text-align: center; padding: 50px;">
            <h2 style="color: green;">Authorization Successful!</h2>
            <p>You can close this window and return to the app.</p>
            <p>The window will close automatically in 5 seconds...</p>
            <script>setTimeout(() => window.close(), 5000);</script>
          </body>
        </html>
      `);
      
      // Send message to renderer to update UI
      if (mainWindow) {
        if (authContext === 'inventory') {
          mainWindow.webContents.send('oauth2-authorized-inventory');
        } else {
          mainWindow.webContents.send('oauth2-authorized');
        }
      }
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <head><title>Authorization Failed</title></head>
          <body style="font-family: Arial; text-align: center; padding: 50px;">
            <h2 style="color: red;">Authorization Failed</h2>
            <p>${error.message}</p>
            <p>The window will close automatically in 5 seconds...</p>
            <script>setTimeout(() => window.close(), 5000);</script>
          </body>
        </html>
      `);
    }
  } else {
    res.writeHead(400);
    res.end('No authorization code received');
  }
}).listen(9999, () => {
  console.log('OAuth2 callback server listening on http://localhost:9999');
});

app.whenReady().then(createWindow);

app.on('before-quit', () => {
  phase2AutoRunService.stop();
  phase2WritebackPoller.stop();
  stopPhase4WritebackPoller();
});

app.on('window-all-closed', () => {
  phase2AutoRunService.stop();
  phase2WritebackPoller.stop();
  stopPhase4WritebackPoller();
  if (process.platform !== 'darwin') app.quit();
});
