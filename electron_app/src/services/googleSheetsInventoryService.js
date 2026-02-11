const { google } = require('googleapis');
const oauth2Service = require('./oauth2Service');

/**
 * Google Sheets Inventory Service
 * Handles writing inventory data to Google Sheets following Phase 1 requirements
 */

/**
 * Write inventory data to Google Sheets
 * Follows Phase 1 requirements: fully refresh dataset (overwrite)
 * @param {string} spreadsheetId - Google Sheets spreadsheet ID
 * @param {string} worksheetName - Name of the worksheet to write to
 * @param {Array} inventoryData - Array of inventory records
 * @returns {Promise<Object>} Write operation result
 */
async function writeInventoryToSheets(spreadsheetId, worksheetName, inventoryData) {
  try {
    const startTime = Date.now();
    
    // Get authenticated sheets client
    const sheets = await getAuthenticatedSheetsClient();
    
    if (!inventoryData || inventoryData.length === 0) {
      throw new Error('No inventory data to write to Google Sheets');
    }

    console.log(`📊 Writing ${inventoryData.length} inventory records to Google Sheets...`);

    // Prepare headers (column definitions based on inventoryService.js query)
    const headers = [
      'RNumber',
      'InventoryNumber', 
      'ModelYear',
      'ModelName',
      'CategoryCode',
      'StockTicketNumber',
      'PartType',
      'LocationCode', 
      'PrimaryARADamageCode',
      'SecondaryARADamageCode',
      'ConditionsAndOptions',
      'PartNotes',
      'IsAlternate',
      'PartRating',
      'InventoriedDate',
      'DateAcquired',
      'ConditionCode',
      'QuantityAvailable',
      'QuantityQuoted',
      'QuantityOnHold',
      'InventorierID',
      'DismantlerID',
      'Mileage',
      'RetailPrice',
      'WholesalePrice',
      'CostPrice',
      'ValuePrice',
      'EbayPrice',
      'EcomPrice',
      'DamageReported',
      'UnitsOfDamage',
      'DateBPGGraded',
      'EComDescription',
      'PrivacyIndicator'
    ];

    // Convert inventory data to 2D array format expected by Sheets API
    const values = [
      headers, // Header row
      ...inventoryData.map(record => headers.map(header => {
        const value = record[header];
        // Handle null/undefined values and dates
        if (value === null || value === undefined) {
          return '';
        }
        if (value instanceof Date) {
          return value.toISOString().split('T')[0]; // Format as YYYY-MM-DD
        }
        return String(value);
      }))
    ];

    // Phase 1 Requirement: Fully refresh the dataset (overwrite)
    // Clear existing data first
    await clearWorksheet(sheets, spreadsheetId, worksheetName);
    
    // Write new data
    const range = `${worksheetName}!A1`;
    const response = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED', // Allow auto-formatting of dates, numbers
      resource: {
        values: values
      }
    });

    const duration = Date.now() - startTime;
    
    console.log(`✅ Google Sheets write successful: ${inventoryData.length} records in ${duration}ms`);

    return {
      success: true,
      message: `Successfully wrote ${inventoryData.length} records to Google Sheets`,
      recordCount: inventoryData.length,
      duration: duration,
      updatedRows: response.data.updatedRows,
      updatedColumns: response.data.updatedColumns,
      updatedCells: response.data.updatedCells
    };

  } catch (error) {
    console.error('❌ Google Sheets write failed:', error.message);
    
    let errorMessage = error.message;
    
    // Provide more specific error messages
    if (error.message.includes('not found')) {
      errorMessage = 'Spreadsheet or worksheet not found. Please check the spreadsheet ID and worksheet name.';
    } else if (error.message.includes('permission')) {
      errorMessage = 'Permission denied. Please ensure you have edit access to the Google Sheet.';
    } else if (error.message.includes('quota')) {
      errorMessage = 'Google Sheets API quota exceeded. Please try again later.';
    }

    return {
      success: false,
      message: `Failed to write to Google Sheets: ${errorMessage}`,
      error: error.message
    };
  }
}

/**
 * Clear all data from a worksheet
 * Phase 1 requirement: fully refresh (overwrite) rather than append
 * @param {Object} sheets - Authenticated Google Sheets client
 * @param {string} spreadsheetId - Spreadsheet ID
 * @param {string} worksheetName - Worksheet name to clear
 */
async function clearWorksheet(sheets, spreadsheetId, worksheetName) {
  try {
    // Get worksheet properties to determine how much to clear
    const sheetInfo = await sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [`${worksheetName}!A1:ZZ`],
      includeGridData: false
    });

    if (!sheetInfo.data.sheets || sheetInfo.data.sheets.length === 0) {
      throw new Error(`Worksheet '${worksheetName}' not found`);
    }

    // Clear all existing data
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${worksheetName}!A:ZZ`
    });

    console.log(`🗑️ Cleared existing data from worksheet: ${worksheetName}`);
    
  } catch (error) {
    console.error('❌ Failed to clear worksheet:', error.message);
    throw error;
  }
}

/**
 * Test connection to Google Sheets
 * @param {string} spreadsheetId - Spreadsheet ID to test
 * @param {string} worksheetName - Worksheet name to test
 * @returns {Promise<Object>} Test result
 */
async function testSheetsConnection(spreadsheetId, worksheetName) {
  try {
    if (!spreadsheetId) {
      throw new Error('Spreadsheet ID is required');
    }

    if (!worksheetName) {
      throw new Error('Worksheet name is required');
    }

    // Check if user is authenticated with Google
    if (!oauth2Service.isAuthenticated()) {
      throw new Error('Not authenticated with Google. Please connect to Google Sheets first.');
    }

    const sheets = await getAuthenticatedSheetsClient();
    
    // Test access to the spreadsheet
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [`${worksheetName}!A1`],
      includeGridData: false
    });

    // Check if worksheet exists
    const worksheet = response.data.sheets?.find(
      sheet => sheet.properties.title === worksheetName
    );

    if (!worksheet) {
      throw new Error(`Worksheet '${worksheetName}' not found in the spreadsheet`);
    }

    return {
      success: true,
      message: `Successfully connected to Google Sheet: "${response.data.properties.title}" - Worksheet: "${worksheetName}"`,
      spreadsheetTitle: response.data.properties.title,
      worksheetName: worksheetName
    };

  } catch (error) {
    let errorMessage = error.message;
    
    if (error.message.includes('not found')) {
      errorMessage = 'Spreadsheet not found. Please check the spreadsheet ID and ensure you have access.';
    } else if (error.message.includes('permission')) {
      errorMessage = 'Permission denied. Please ensure you have edit access to the Google Sheet.';
    }

    return {
      success: false,
      message: `Connection test failed: ${errorMessage}`,
      error: error.message
    };
  }
}

/**
 * Get authenticated Google Sheets client
 * @returns {Promise<Object>} Authenticated sheets client
 */
async function getAuthenticatedSheetsClient() {
  try {
    const auth = oauth2Service.getAuthenticatedClient();
    return google.sheets({ version: 'v4', auth });
  } catch (error) {
    throw new Error(`Failed to get authenticated Google Sheets client: ${error.message}`);
  }
}

/**
 * Validate Google Sheets URL and extract spreadsheet ID
 * @param {string} sheetsUrl - Google Sheets URL
 * @returns {Object} Validation result with spreadsheet ID
 */
function validateAndExtractSpreadsheetId(sheetsUrl) {
  try {
    if (!sheetsUrl) {
      throw new Error('Google Sheets URL is required');
    }

    // Google Sheets URL patterns:
    // https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
    // https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit#gid=0
    
    const regex = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;
    const match = sheetsUrl.match(regex);
    
    if (!match) {
      throw new Error('Invalid Google Sheets URL format. Please use a valid Google Sheets URL.');
    }

    const spreadsheetId = match[1];
    
    return {
      success: true,
      spreadsheetId: spreadsheetId
    };

  } catch (error) {
    return {
      success: false,
      message: error.message
    };
  }
}

module.exports = {
  writeInventoryToSheets,
  testSheetsConnection,
  validateAndExtractSpreadsheetId
};
