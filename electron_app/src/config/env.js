// Load environment variables
require('dotenv').config();


const config = {
  // Reporting
  reporting: {
    enabled: process.env.REPORTING_ENABLED === 'true',
    maxLogs: parseInt(process.env.MAX_EXECUTION_LOGS) || 100
  },

  // Scheduling
  schedule: {
    timezone: process.env.SCHEDULE_TIMEZONE || 'America/New_York'
  }
};

module.exports = config;
