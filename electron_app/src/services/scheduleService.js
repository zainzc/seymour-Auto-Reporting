const cron = require('node-cron');
const { getScheduledInvoices } = require('./reportingService');
const { writeToRawTab, initialize: initSheets } = require('./sheetsService');
const { getReportingConfig, saveReportingConfig } = require('../config/configStore');
const oauth2Service = require('./oauth2Service');

/**
 * Schedule Management Service
 * Handles cron-based scheduled data extraction
 */

let activeJob = null;

/**
 * Start scheduled reporting job
 * @param {Object} config - Schedule configuration
 * @param {string} config.frequency - 'nightly' or 'weekly'
 * @param {number} config.weekStartDay - Day of week (0=Sunday, 1=Monday, etc.)
 * @param {string} config.endDate - Optional end date (YYYY-MM-DD)
 * @param {string} config.spreadsheetId - Google Sheets ID
 * @returns {boolean} True if started successfully
 */
function startSchedule(config) {
  try {
    // Stop any existing job
    stopSchedule();

    // Determine cron expression
    let cronExpression;
    
    if (config.frequency === 'nightly') {
      // Run at midnight every day
      cronExpression = '0 0 * * *';
    } else if (config.frequency === 'weekly') {
      // Run at midnight on the week start day
      // Cron format: minute hour day month dayOfWeek
      const dayOfWeek = config.weekStartDay || 1; // Default Monday
      cronExpression = `0 0 * * ${dayOfWeek}`;
    } else {
      throw new Error('Invalid frequency');
    }

    console.log(`📅 Scheduling job: ${cronExpression}`);

    // Create cron job
    activeJob = cron.schedule(cronExpression, async () => {
      await executeScheduledJob(config);
    }, {
      scheduled: true,
      timezone: 'America/New_York' // Adjust as needed
    });

    // Save active schedule to config
    const scheduleConfig = {
      ...config,
      active: true,
      cronExpression,
      createdAt: new Date().toISOString()
    };
    saveReportingConfig('activeSchedule', scheduleConfig);

    console.log('✅ Schedule started successfully');
    return true;

  } catch (error) {
    console.error('❌ Failed to start schedule:', error.message);
    return false;
  }
}

/**
 * Execute scheduled reporting job
 * @param {Object} config - Schedule configuration
 */
async function executeScheduledJob(config) {
  const startTime = new Date();
  console.log(`\n🚀 Executing scheduled job at ${startTime.toISOString()}`);

  try {
    // Check if user is still authenticated
    const isAuthenticated = await oauth2Service.isAuthenticated();
    if (!isAuthenticated) {
      console.error('❌ User is no longer authenticated with Google');
      logExecution('Scheduled', false, 'Google authentication expired - please reconnect');
      return { success: false, message: 'Google authentication expired - please reconnect' };
    }

    // Check if end date reached
    if (config.endDate) {
      const endDate = new Date(config.endDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (today > endDate) {
        console.log('📅 End date reached. Deactivating schedule...');
        stopSchedule();
        
        // Mark as inactive but keep config
        const scheduleConfig = getReportingConfig('activeSchedule');
        saveReportingConfig('activeSchedule', { ...scheduleConfig, active: false });
        
        logExecution('Scheduled', false, 'End date reached - schedule deactivated');
        return { success: false, message: 'End date reached - schedule deactivated' };
      }
    }

    // Initialize Google Sheets with OAuth2 client
    try {
      const authClient = await oauth2Service.getAuthenticatedClient();
      await initSheets(authClient);
    } catch (err) {
      console.error('❌ Failed to initialize Google Sheets:', err.message);
      logExecution('Scheduled', false, `Google Sheets initialization failed: ${err.message}`);
      return { success: false, message: `Google Sheets initialization failed: ${err.message}` };
    }

    // Extract invoice data
    console.log('📊 Extracting invoice data...');
    const invoices = await getScheduledInvoices(config.frequency, config.weekStartDay);

    if (!invoices || invoices.length === 0) {
      console.log('⚠️ No invoices found for this period');
      logExecution('Scheduled', true, `No data for period (${config.frequency})`);
      return { success: true, message: `No data found for this period (${config.frequency})` };
    }

    console.log(`✅ Extracted ${invoices.length} invoices`);

    // Write to Google Sheets RAW tab
    console.log('📤 Writing to Google Sheets...');
    const result = await writeToRawTab(config.spreadsheetId, invoices);

    if (result.success) {
      console.log('✅ Successfully wrote to Google Sheets');
      
      // Update last run timestamp
      const scheduleConfig = getReportingConfig('activeSchedule');
      saveReportingConfig('activeSchedule', {
        ...scheduleConfig,
        lastRun: new Date().toISOString()
      });

      logExecution('Scheduled', true, `${invoices.length} records written to RAW tab`);
      
      const endTime = new Date();
      const duration = (endTime - startTime) / 1000;
      console.log(`⏱️ Job completed in ${duration.toFixed(2)}s\n`);
      
      return { success: true, message: `Successfully wrote ${invoices.length} records to RAW tab` };
    } else {
      console.error('❌ Failed to write to Google Sheets');
      logExecution('Scheduled', false, result.message);
      return { success: false, message: result.message };
    }

  } catch (error) {
    console.error('❌ Job execution failed:', error.message);
    
    // Provide user-friendly error messages
    let userMessage = 'An error occurred while executing the schedule.';
    
    if (error.message.includes('Invalid object name')) {
      userMessage = 'Database table not found. Please check your database configuration.';
    } else if (error.message.includes('Login failed') || error.message.includes('Cannot open database')) {
      userMessage = 'Database connection failed. Please verify your database credentials.';
    } else if (error.message.includes('permission')) {
      userMessage = 'Database permission denied. Please check user permissions.';
    } else if (error.message.includes('timeout') || error.message.includes('timed out')) {
      userMessage = 'Database query timed out. Please try again later.';
    } else if (error.message.includes('Spreadsheet') || error.message.includes('Sheet')) {
      userMessage = 'Failed to write to Google Sheets. Please verify Sheet ID and permissions.';
    }
    
    logExecution('Scheduled', false, error.message);

    const endTime = new Date();
    const duration = (endTime - startTime) / 1000;
    console.log(`⏱️ Job completed in ${duration.toFixed(2)}s\n`);
    
    return { success: false, message: userMessage };
  }
}

/**
 * Stop active schedule
 */
function stopSchedule() {
  if (activeJob) {
    activeJob.stop();
    activeJob = null;
    
    // Mark as inactive
    const scheduleConfig = getReportingConfig('activeSchedule');
    if (scheduleConfig) {
      saveReportingConfig('activeSchedule', { ...scheduleConfig, active: false });
    }

    console.log('🛑 Schedule stopped');
  }
}

/**
 * Resume schedule from stored config (on app start)
 */
function resumeSchedule() {
  const scheduleConfig = getReportingConfig('activeSchedule');
  
  if (scheduleConfig && scheduleConfig.active) {
    console.log('♻️ Resuming active schedule from config...');
    startSchedule(scheduleConfig);
  }
}

/**
 * Log execution result
 * @param {string} type - 'Manual' or 'Scheduled'
 * @param {boolean} success - Success status
 * @param {string} message - Log message
 */
function logExecution(type, success, message) {
  const logs = getReportingConfig('executionLogs') || [];
  
  const logEntry = {
    timestamp: new Date().toISOString(),
    type,
    success,
    message
  };

  logs.unshift(logEntry); // Add to beginning
  
  // Keep only last 100 logs
  if (logs.length > 100) {
    logs.splice(100);
  }

  saveReportingConfig('executionLogs', logs);
}

/**
 * Get execution logs
 * @param {number} limit - Maximum number of logs to return
 * @returns {Array} Log entries
 */
function getExecutionLogs(limit = 50) {
  const logs = getReportingConfig('executionLogs') || [];
  return logs.slice(0, limit);
}

module.exports = {
  startSchedule,
  stopSchedule,
  resumeSchedule,
  executeScheduledJob,
  logExecution,
  getExecutionLogs
};
