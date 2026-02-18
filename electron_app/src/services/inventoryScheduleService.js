const cron = require('node-cron');
const { getAllInventory } = require('./inventoryService');
const { writeInventoryToSheets } = require('./googleSheetsInventoryService');
const { saveInventoryConfig, getInventoryConfig } = require('../config/configStore');

/**
 * Inventory Schedule Service - Phase 1: Powerlink → Google Sheets Integration
 * Manages 24-hour automated inventory data push to Google Sheets
 */

let scheduledTask = null;
let isScheduleActive = false;
let postPushHook = null;

function setPostPushHook(hook) {
  postPushHook = typeof hook === 'function' ? hook : null;
}

/**
 * Start the 24-hour inventory Google Sheets schedule
 * Runs daily at midnight - Phase 1 requirement
 * @param {string} spreadsheetId - Google Sheets spreadsheet ID
 * @param {string} worksheetName - Target worksheet name
 * @returns {boolean} True if started successfully
 */
function startInventorySchedule(spreadsheetId, worksheetName) {
  try {
    // Stop any existing schedule first
    stopInventorySchedule();

    if (!spreadsheetId || !worksheetName) {
      console.error('❌ Cannot start schedule: Spreadsheet ID and worksheet name are required');
      return false;
    }

    // Schedule to run daily at midnight (00:00) - Phase 1 requirement
    // Cron format: minute hour day month dayOfWeek
    scheduledTask = cron.schedule('0 0 * * *', async () => {
      console.log('🔄 Running scheduled inventory Google Sheets push...');
      await executeInventoryPush(spreadsheetId, worksheetName);
    });

    isScheduleActive = true;
    
    // Save configuration
    saveInventoryConfig('spreadsheetId', spreadsheetId);
    saveInventoryConfig('worksheetName', worksheetName);
    saveInventoryConfig('scheduleActive', true);
    saveInventoryConfig('lastScheduleStart', new Date().toISOString());
    
    console.log('✅ Inventory Google Sheets schedule started: Daily at midnight');
    return true;
  } catch (error) {
    console.error('❌ Failed to start inventory schedule:', error.message);
    return false;
  }
}

/**
 * Stop the inventory Google Sheets schedule
 */
function stopInventorySchedule() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  
  isScheduleActive = false;
  saveInventoryConfig('scheduleActive', false);
  
  console.log('⏹️ Inventory Google Sheets schedule stopped');
}

/**
 * Execute inventory Google Sheets push - Phase 1 implementation
 * Fully refreshes the dataset (overwrite) as required
 * @param {string} spreadsheetId - Google Sheets spreadsheet ID
 * @param {string} worksheetName - Target worksheet name
 * @returns {Promise<Object>} Execution result
 */
async function executeInventoryPush(spreadsheetId, worksheetName) {
  const startTime = new Date();
  
  try {
    console.log('📦 Fetching inventory data from Powerlink...');
    const inventoryData = await getAllInventory();
    
    console.log(`📊 Writing ${inventoryData.length} records to Google Sheets (full refresh)...`);
    const result = await writeInventoryToSheets(spreadsheetId, worksheetName, inventoryData);
    
    const endTime = new Date();
    const duration = endTime - startTime;

    // Log execution
    logExecution(result.success, result.message, inventoryData.length, duration);

    if (result.success && postPushHook) {
      try {
        await postPushHook({
          spreadsheetId,
          worksheetName,
          recordCount: inventoryData.length,
          duration,
          source: 'inventory_push'
        });
      } catch (hookError) {
        console.error('⚠️ Post push hook failed:', hookError.message);
      }
    }
    
    return result;
    
  } catch (error) {
    const errorMsg = `Execution failed: ${error.message}`;
    console.error('❌', errorMsg);
    
    logExecution(false, errorMsg, 0, 0);
    
    return {
      success: false,
      message: errorMsg
    };
  }
}

/**
 * Log execution to config store
 * @param {boolean} success - Whether execution was successful
 * @param {string} message - Result message
 * @param {number} recordCount - Number of records sent
 * @param {number} duration - Execution duration in ms
 */
function logExecution(success, message, recordCount, duration) {
  const logs = getInventoryConfig('executionLogs') || [];
  
  const logEntry = {
    timestamp: new Date().toISOString(),
    success,
    message,
    recordCount,
    duration
  };
  
  // Keep last 50 logs
  logs.unshift(logEntry);
  if (logs.length > 50) {
    logs.pop();
  }
  
  saveInventoryConfig('executionLogs', logs);
  saveInventoryConfig('lastExecution', logEntry);
}

/**
 * Get schedule status
 * @returns {Object} Current schedule status
 */
function getScheduleStatus() {
  return {
    active: isScheduleActive,
    spreadsheetId: getInventoryConfig('spreadsheetId'),
    worksheetName: getInventoryConfig('worksheetName'),
    lastExecution: getInventoryConfig('lastExecution'),
    lastScheduleStart: getInventoryConfig('lastScheduleStart')
  };
}

/**
 * Get execution logs
 * @returns {Array} Execution history
 */
function getExecutionLogs() {
  return getInventoryConfig('executionLogs') || [];
}

/**
 * Initialize schedule on app startup if it was previously active
 */
function initializeSchedule() {
  const wasActive = getInventoryConfig('scheduleActive');
  const spreadsheetId = getInventoryConfig('spreadsheetId');
  const worksheetName = getInventoryConfig('worksheetName');
  
  if (wasActive && spreadsheetId && worksheetName) {
    console.log('🔄 Restoring inventory Google Sheets schedule...');
    startInventorySchedule(spreadsheetId, worksheetName);
  }
}

module.exports = {
  startInventorySchedule,
  stopInventorySchedule,
  executeInventoryPush,
  setPostPushHook,
  getScheduleStatus,
  getExecutionLogs,
  initializeSchedule
};
