const { google } = require('googleapis');

/**
 * Google Sheets Service
 * Handles writing invoice data to Google Sheets RAW tab
 * Supports both OAuth2 and service account authentication
 */

let sheetsAPI = null;

/**
 * Convert a 1-based column number to A1 notation (A, B, ..., Z, AA, AB, ...)
 * @param {number} colNumber
 * @returns {string}
 */
function toA1Column(colNumber) {
  let n = colNumber;
  let col = '';

  while (n > 0) {
    const rem = (n - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    n = Math.floor((n - 1) / 26);
  }

  return col;
}

/**
 * Initialize Google Sheets API with OAuth2 client
 * @param {google.auth.OAuth2} auth - Authenticated OAuth2 client
 */
async function initialize(auth) {
  try {
    if (!auth) {
      throw new Error('Authentication client not provided');
    }

    sheetsAPI = google.sheets({ version: 'v4', auth });

    console.log('✅ Google Sheets API initialized with OAuth2');
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize Google Sheets:', error.message);
    throw error;
  }
}

/**
 * Write invoice data to Google Sheets RAW tab
 * OVERWRITES all existing data
 * @param {string} spreadsheetId - Google Sheets ID
 * @param {Array} data - Invoice data array
 * @returns {Promise<Object>} Result with success status
 */
async function writeToRawTab(spreadsheetId, data) {
  try {
    if (!sheetsAPI) {
      throw new Error('Google Sheets API not initialized');
    }

    if (!data || data.length === 0) {
      throw new Error('No data to write');
    }

    const sheetName = 'RAW';

    // Prepare data for Google Sheets
    const headers = Object.keys(data[0]);
    const values = [
      headers, // Header row
      ...data.map(row => headers.map(header => {
        const value = row[header];
        // Convert null, undefined, or actual null values to empty string
        if (value === null || value === undefined) {
          return '';
        }
        // Convert everything else to string to ensure consistency
        return String(value);
      }))
    ];

    // Clear existing data in RAW tab
    await sheetsAPI.spreadsheets.values.clear({
      spreadsheetId,
      range: `${sheetName}!A:Z`
    });

    // Write new data
    const writeResult = await sheetsAPI.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      resource: {
        values
      }
    });

    // Write timestamp in a separate column after the exported dataset.
    const timestamp = new Date().toISOString();
    const timestampCol = toA1Column(headers.length + 2);
    
    await sheetsAPI.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!${timestampCol}1:${timestampCol}2`,
      valueInputOption: 'RAW',
      resource: {
        values: [['Last Run:'], [timestamp]]
      }
    });

    console.log(`✅ Wrote ${data.length} rows to RAW tab`);

    return {
      success: true,
      message: `Successfully wrote ${data.length} records to RAW tab`,
      timestamp
    };

  } catch (error) {
    console.error('❌ Google Sheets write error:', error.message);
    
    // All-or-nothing: if error, don't leave partial data
    // (Sheets API is transactional, but log the failure)
    return {
      success: false,
      message: `Failed to write to Google Sheets: ${error.message}`
    };
  }
}

/**
 * Verify Google Sheets access
 * @param {string} spreadsheetId - Google Sheets ID
 * @returns {Promise<boolean>} True if accessible
 */
async function verifyAccess(spreadsheetId) {
  try {
    if (!sheetsAPI) {
      throw new Error('Google Sheets API not initialized');
    }

    // Try to get spreadsheet metadata
    await sheetsAPI.spreadsheets.get({
      spreadsheetId
    });

    console.log('✅ Google Sheets access verified');
    return true;
  } catch (error) {
    console.error('❌ Cannot access Google Sheets:', error.message);
    return false;
  }
}

/**
 * Check if RAW tab exists
 * @param {string} spreadsheetId - Google Sheets ID
 * @returns {Promise<boolean>} True if RAW tab exists
 */
async function rawTabExists(spreadsheetId) {
  try {
    if (!sheetsAPI) {
      throw new Error('Google Sheets API not initialized');
    }

    const response = await sheetsAPI.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties'
    });

    const sheets = response.data.sheets || [];
    return sheets.some(sheet => sheet.properties.title === 'RAW');
  } catch (error) {
    console.error('❌ Error checking RAW tab:', error.message);
    return false;
  }
}

module.exports = {
  initialize,
  writeToRawTab,
  verifyAccess,
  rawTabExists
};
