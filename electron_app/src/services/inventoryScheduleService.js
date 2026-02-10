const cron = require('node-cron');
const { getAllInventory } = require('./inventoryService');
const { sendToWebhook } = require('./webhookService');
const { saveInventoryConfig, getInventoryConfig } = require('../config/configStore');

/**
 * Inventory Schedule Service
 * Manages 24-hour automated inventory webhook push
 */

let scheduledTask = null;
let isScheduleActive = false;

/**
 * Start the 24-hour inventory webhook schedule
 * Runs daily at midnight
 * @param {string} webhookUrl - n8n webhook URL
 * @returns {boolean} True if started successfully
 */
function startInventorySchedule(webhookUrl) {
  try {
    // Stop any existing schedule first
    stopInventorySchedule();

    if (!webhookUrl) {
      console.error('❌ Cannot start schedule: Webhook URL not provided');
      return false;
    }

    // Schedule to run daily at midnight (00:00)
    // Cron format: minute hour day month dayOfWeek
    scheduledTask = cron.schedule('0 0 * * *', async () => {
      console.log('🔄 Running scheduled inventory webhook push...');
      await executeInventoryPush(webhookUrl);
    });

    isScheduleActive = true;
    
    // Save configuration
    saveInventoryConfig('webhookUrl', webhookUrl);
    saveInventoryConfig('scheduleActive', true);
    saveInventoryConfig('lastScheduleStart', new Date().toISOString());

    console.log('✅ Inventory webhook schedule started: Daily at midnight');
    
    return true;
  } catch (error) {
    console.error('❌ Failed to start inventory schedule:', error.message);
    return false;
  }
}

/**
 * Stop the inventory webhook schedule
 */
function stopInventorySchedule() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  
  isScheduleActive = false;
  saveInventoryConfig('scheduleActive', false);
  
  console.log('⏹️ Inventory webhook schedule stopped');
}

/**
 * Execute inventory webhook push
 * @param {string} webhookUrl - n8n webhook URL
 * @returns {Promise<Object>} Execution result
 */
async function executeInventoryPush(webhookUrl) {
  const startTime = new Date();
  
  try {
    console.log('📦 Fetching inventory data...');
    const inventoryData = await getAllInventory();
    
    console.log(`📤 Sending ${inventoryData.length} records to webhook...`);
    const result = await sendToWebhook(webhookUrl, inventoryData);
    
    const endTime = new Date();
    const duration = endTime - startTime;

    // Log execution
    logExecution(result.success, result.message, inventoryData.length, duration);
    
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
    webhookUrl: getInventoryConfig('webhookUrl'),
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
  const webhookUrl = getInventoryConfig('webhookUrl');
  
  if (wasActive && webhookUrl) {
    console.log('🔄 Restoring inventory webhook schedule...');
    startInventorySchedule(webhookUrl);
  }
}

module.exports = {
  startInventorySchedule,
  stopInventorySchedule,
  executeInventoryPush,
  getScheduleStatus,
  getExecutionLogs,
  initializeSchedule
};
