const axios = require('axios');

/**
 * Webhook Service
 * Handles sending data to n8n webhook
 */

/**
 * Send inventory data to n8n webhook
 * @param {string} webhookUrl - n8n webhook URL
 * @param {Array} data - Inventory data to send
 * @returns {Promise<Object>} Result with success status
 */
async function sendToWebhook(webhookUrl, data) {
  try {
    if (!webhookUrl) {
      throw new Error('Webhook URL is required');
    }

    if (!data || data.length === 0) {
      throw new Error('No data to send');
    }

    const startTime = Date.now();
    
    // Send POST request to n8n webhook
    const response = await axios.post(webhookUrl, {
      timestamp: new Date().toISOString(),
      recordCount: data.length,
      data: data
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 60000 // 60 second timeout
    });

    const duration = Date.now() - startTime;

    console.log(`✅ Webhook push successful: ${data.length} records in ${duration}ms`);

    return {
      success: true,
      message: `Successfully sent ${data.length} records to webhook`,
      recordCount: data.length,
      duration: duration,
      statusCode: response.status
    };

  } catch (error) {
    console.error('❌ Webhook push failed:', error.message);
    
    let errorMessage = error.message;
    
    // Provide more specific error messages
    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'Connection refused. Please check if the webhook URL is correct and accessible.';
    } else if (error.code === 'ETIMEDOUT') {
      errorMessage = 'Request timed out. The webhook server is not responding.';
    } else if (error.response) {
      errorMessage = `Webhook returned error ${error.response.status}: ${error.response.statusText}`;
    }

    return {
      success: false,
      message: `Failed to send to webhook: ${errorMessage}`,
      error: error.message
    };
  }
}

/**
 * Test webhook connectivity
 * @param {string} webhookUrl - n8n webhook URL to test
 * @returns {Promise<Object>} Test result
 */
async function testWebhook(webhookUrl) {
  try {
    if (!webhookUrl) {
      throw new Error('Webhook URL is required');
    }

    // Send a small test payload
    const response = await axios.post(webhookUrl, {
      test: true,
      timestamp: new Date().toISOString(),
      message: 'Test connection from Seymour Auto Reporting'
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    return {
      success: true,
      message: 'Webhook is accessible and responding',
      statusCode: response.status
    };

  } catch (error) {
    let errorMessage = error.message;
    
    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'Connection refused. Please verify the webhook URL.';
    } else if (error.code === 'ETIMEDOUT') {
      errorMessage = 'Connection timed out.';
    }

    return {
      success: false,
      message: `Webhook test failed: ${errorMessage}`
    };
  }
}

module.exports = {
  sendToWebhook,
  testWebhook
};
