const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
require('dotenv').config({ debug: process.env.DEBUG_DOTENV === 'true' });

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
const ClickUpService = require('../services/clickupService');
const AirtableService = require('../services/airtableService');

let mainWindow;
let autoSyncInterval = null;
let dbReady = false;

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
  getScheduleStatus,
  getExecutionLogs: getInventoryLogs,
  initializeSchedule: initInventorySchedule
} = require('../services/inventoryScheduleService');

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
ipcMain.handle('phase2-get-config', async () => {
  const stored = getInventoryConfig('phase2Config') || {};
  const merged = buildPhase2Config(stored);

  return {
    sheetId: merged.sheetId || '',
    tabName: merged.tabName || '',
    airtableBaseId: merged.airtableBaseId || '',
    airtableMasterTable: merged.airtableMasterTable || 'Master Parts Table',
    airtableCategoryTable: merged.airtableCategoryTable || 'Category Names',
    clickupListId: merged.clickupListId || '',
    ignoreTaskCache: Boolean(merged.ignoreTaskCache),
    dryRun: Boolean(merged.dryRun),
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
    event.sender.send('phase2-progress', {
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
