const { google } = require('googleapis');
const oauth2Service = require('./oauth2Service');

/**
 * Google Sheets Inventory Service
 * Handles writing inventory data to Google Sheets following Phase 1 requirements
 */

const CURRENT_INVENTORY_TIME_ZONE = 'America/New_York';

function toDateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateForNewYorkSheet(value) {
  const date = toDateValue(value);
  if (!date) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CURRENT_INVENTORY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(date);
}

function formatInventoryCellValue(fieldName, value) {
  if (value === null || value === undefined) return '';
  if (fieldName === 'LastDateModified') {
    return formatDateForNewYorkSheet(value);
  }
  if (value instanceof Date) return value.toISOString().split('T')[0];
  return String(value);
}

async function writeInventoryToSheets(spreadsheetId, worksheetName, inventoryData, progressCallback = () => {}) {
  try {
    const startTime = Date.now();
    const sheets = await getAuthenticatedSheetsClient();

    if (!inventoryData || inventoryData.length === 0) {
      throw new Error('No inventory data to write to Google Sheets');
    }

    console.log(`Writing ${inventoryData.length} inventory records to Google Sheets...`);
    progressCallback({
      stage: 'sheet_prepare',
      message: `Preparing ${inventoryData.length} rows for Google Sheets...`,
      percent: 55
    });

    const columnSpecs = [
      { header: 'RNumber', field: 'RNumber' },
      { header: 'Last Modified Date/Time', field: 'LastDateModified' },
      { header: 'InventoryNumber', field: 'InventoryNumber' },
      { header: 'ModelYear', field: 'ModelYear' },
      { header: 'ModelName', field: 'ModelName' },
      { header: 'CategoryCode', field: 'CategoryCode' },
      { header: 'StockTicketNumber', field: 'StockTicketNumber' },
      { header: 'PartType', field: 'PartType' },
      { header: 'LocationCode', field: 'LocationCode' },
      { header: 'PrimaryARADamageCode', field: 'PrimaryARADamageCode' },
      { header: 'SecondaryARADamageCode', field: 'SecondaryARADamageCode' },
      { header: 'ConditionsAndOptions', field: 'ConditionsAndOptions' },
      { header: 'PartNotes', field: 'PartNotes' },
      { header: 'IsAlternate', field: 'IsAlternate' },
      { header: 'PartRating', field: 'PartRating' },
      { header: 'InventoriedDate', field: 'InventoriedDate' },
      { header: 'DateAcquired', field: 'DateAcquired' },
      { header: 'ConditionCode', field: 'ConditionCode' },
      { header: 'QuantityAvailable', field: 'QuantityAvailable' },
      { header: 'QuantityQuoted', field: 'QuantityQuoted' },
      { header: 'QuantityOnHold', field: 'QuantityOnHold' },
      { header: 'InventorierID', field: 'InventorierID' },
      { header: 'DismantlerID', field: 'DismantlerID' },
      { header: 'Mileage', field: 'Mileage' },
      { header: 'RetailPrice', field: 'RetailPrice' },
      { header: 'WholesalePrice', field: 'WholesalePrice' },
      { header: 'CostPrice', field: 'CostPrice' },
      { header: 'ValuePrice', field: 'ValuePrice' },
      { header: 'EbayPrice', field: 'EbayPrice' },
      { header: 'EcomPrice', field: 'EcomPrice' },
      { header: 'DamageReported', field: 'DamageReported' },
      { header: 'UnitsOfDamage', field: 'UnitsOfDamage' },
      { header: 'DateBPGGraded', field: 'DateBPGGraded' },
      { header: 'EComDescription', field: 'EComDescription' },
      { header: 'PrivacyIndicator', field: 'PrivacyIndicator' },
      { header: 'BlockOnlineSale', field: 'BlockOnlineSale' },
      { header: 'ReferenceNumber', field: 'ReferenceNumber' }
    ];
    const headers = columnSpecs.map(column => column.header);

    const dataRows = inventoryData.map(record =>
      columnSpecs.map(column => formatInventoryCellValue(column.field, record?.[column.field]))
    );

    const limiter = createRequestLimiter(
      Number(process.env.INVENTORY_SHEETS_MIN_REQUEST_INTERVAL_MS || 1100)
    );
    const chunkSize = Math.max(200, Number(process.env.INVENTORY_SHEETS_CHUNK_SIZE || 2000));
    await ensureWorksheetCapacity(
      sheets,
      spreadsheetId,
      worksheetName,
      dataRows.length + 1,
      headers.length,
      limiter
    );
    progressCallback({
      stage: 'sheet_resize',
      message: 'Worksheet capacity verified.',
      percent: 62
    });

    await clearWorksheet(sheets, spreadsheetId, worksheetName, limiter);
    progressCallback({
      stage: 'sheet_clear',
      message: 'Cleared existing worksheet data.',
      percent: 66
    });

    await withSheetsRetry(
      () =>
        limiter.call(() =>
          sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${worksheetName}!A1`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [headers] }
          })
        ),
      'write header'
    );
    progressCallback({
      stage: 'sheet_header',
      message: 'Header row written.',
      percent: 68
    });

    const lastCol = columnIndexToLetter(headers.length);
    let writtenRows = 0;
    let totalUpdatedCells = headers.length;

    for (let i = 0; i < dataRows.length; i += chunkSize) {
      const chunk = dataRows.slice(i, i + chunkSize);
      const startRow = 2 + i;
      const endRow = startRow + chunk.length - 1;
      const range = `${worksheetName}!A${startRow}:${lastCol}${endRow}`;

      const response = await withSheetsRetry(
        () =>
          limiter.call(() =>
            sheets.spreadsheets.values.update({
              spreadsheetId,
              range,
              valueInputOption: 'USER_ENTERED',
              resource: { values: chunk }
            })
          ),
        `write rows ${startRow}-${endRow}`
      );

      writtenRows += chunk.length;
      totalUpdatedCells += Number(response?.data?.updatedCells || 0);
      if (writtenRows % 5000 === 0 || writtenRows === dataRows.length) {
        console.log(`Google Sheets progress: ${writtenRows}/${dataRows.length} rows written`);
      }
      const progress = 68 + Math.floor((writtenRows / Math.max(1, dataRows.length)) * 30);
      progressCallback({
        stage: 'sheet_write_rows',
        message: `Wrote ${writtenRows}/${dataRows.length} rows to '${worksheetName}'.`,
        percent: Math.min(98, progress)
      });
    }

    const duration = Date.now() - startTime;
    console.log(`Google Sheets write successful: ${inventoryData.length} records in ${duration}ms`);

    return {
      success: true,
      message: `Successfully wrote ${inventoryData.length} records to Google Sheets`,
      recordCount: inventoryData.length,
      duration,
      updatedRows: inventoryData.length + 1,
      updatedColumns: headers.length,
      updatedCells: totalUpdatedCells
    };
  } catch (error) {
    const formatted = formatGoogleApiError(error);
    console.error('Google Sheets write failed:', formatted);

    let errorMessage = formatted;
    const text = String(formatted || '').toLowerCase();
    if (text.includes('not found')) {
      errorMessage = 'Spreadsheet or worksheet not found. Please check the spreadsheet ID and worksheet name.';
    } else if (text.includes('permission') || text.includes('forbidden')) {
      errorMessage = 'Permission denied. Please ensure you have edit access to the Google Sheet.';
    } else if (text.includes('quota') || text.includes('rate')) {
      errorMessage = 'Google Sheets API quota/rate limit exceeded. Please try again later.';
    }

    return {
      success: false,
      message: `Failed to write to Google Sheets: ${errorMessage}`,
      error: formatted
    };
  }
}

async function clearWorksheet(sheets, spreadsheetId, worksheetName, limiter = null) {
  try {
    const sheetInfo = await (limiter
      ? limiter.call(() =>
          sheets.spreadsheets.get({
            spreadsheetId,
            ranges: [`${worksheetName}!A1:ZZ`],
            includeGridData: false
          })
        )
      : sheets.spreadsheets.get({
          spreadsheetId,
          ranges: [`${worksheetName}!A1:ZZ`],
          includeGridData: false
        }));

    if (!sheetInfo.data.sheets || sheetInfo.data.sheets.length === 0) {
      throw new Error(`Worksheet '${worksheetName}' not found`);
    }

    await withSheetsRetry(
      () =>
        (limiter
          ? limiter.call(() =>
              sheets.spreadsheets.values.clear({
                spreadsheetId,
                range: `${worksheetName}!A:ZZ`
              })
            )
          : sheets.spreadsheets.values.clear({
              spreadsheetId,
              range: `${worksheetName}!A:ZZ`
            })),
      'clear worksheet'
    );

    console.log(`Cleared existing data from worksheet: ${worksheetName}`);
  } catch (error) {
    console.error('Failed to clear worksheet:', formatGoogleApiError(error));
    throw error;
  }
}

async function ensureWorksheetCapacity(sheets, spreadsheetId, worksheetName, requiredRows, requiredCols, limiter = null) {
  const meta = await withSheetsRetry(
    () =>
      (limiter
        ? limiter.call(() =>
            sheets.spreadsheets.get({
              spreadsheetId,
              fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))'
            })
          )
        : sheets.spreadsheets.get({
            spreadsheetId,
            fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))'
          })),
    'read worksheet metadata'
  );

  const sheet = (meta?.data?.sheets || []).find(
    item => String(item?.properties?.title || '') === worksheetName
  );
  if (!sheet?.properties?.sheetId) {
    throw new Error(`Worksheet '${worksheetName}' not found`);
  }

  const sheetId = Number(sheet.properties.sheetId);
  const currentRows = Number(sheet?.properties?.gridProperties?.rowCount || 0);
  const currentCols = Number(sheet?.properties?.gridProperties?.columnCount || 0);

  const targetRows = Math.max(currentRows, Number(requiredRows || 0));
  const targetCols = Math.max(currentCols, Number(requiredCols || 0));
  if (targetRows <= currentRows && targetCols <= currentCols) {
    return;
  }

  await withSheetsRetry(
    () =>
      (limiter
        ? limiter.call(() =>
            sheets.spreadsheets.batchUpdate({
              spreadsheetId,
              resource: {
                requests: [
                  {
                    updateSheetProperties: {
                      properties: {
                        sheetId,
                        gridProperties: {
                          rowCount: targetRows,
                          columnCount: targetCols
                        }
                      },
                      fields: 'gridProperties.rowCount,gridProperties.columnCount'
                    }
                  }
                ]
              }
            })
          )
        : sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            resource: {
              requests: [
                {
                  updateSheetProperties: {
                    properties: {
                      sheetId,
                      gridProperties: {
                        rowCount: targetRows,
                        columnCount: targetCols
                      }
                    },
                    fields: 'gridProperties.rowCount,gridProperties.columnCount'
                  }
                }
              ]
            }
          })),
    'expand worksheet grid'
  );

  console.log(
    `Expanded worksheet '${worksheetName}' grid to rows=${targetRows}, cols=${targetCols}`
  );
}

async function testSheetsConnection(spreadsheetId, worksheetName) {
  try {
    if (!spreadsheetId) {
      throw new Error('Spreadsheet ID is required');
    }

    if (!worksheetName) {
      throw new Error('Worksheet name is required');
    }

    if (!oauth2Service.isAuthenticated('inventory')) {
      throw new Error('Not authenticated with Google. Please connect to Google Sheets first.');
    }

    const sheets = await getAuthenticatedSheetsClient();

    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [`${worksheetName}!A1`],
      includeGridData: false
    });

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
      worksheetName
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

async function getAuthenticatedSheetsClient() {
  try {
    const auth = oauth2Service.getAuthenticatedClient('inventory');
    return google.sheets({ version: 'v4', auth });
  } catch (error) {
    throw new Error(`Failed to get authenticated Google Sheets client: ${error.message}`);
  }
}

function validateAndExtractSpreadsheetId(sheetsUrl) {
  try {
    if (!sheetsUrl) {
      throw new Error('Google Sheets URL is required');
    }

    const regex = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;
    const match = sheetsUrl.match(regex);

    if (!match) {
      throw new Error('Invalid Google Sheets URL format. Please use a valid Google Sheets URL.');
    }

    const spreadsheetId = match[1];

    return {
      success: true,
      spreadsheetId
    };
  } catch (error) {
    return {
      success: false,
      message: error.message
    };
  }
}

function columnIndexToLetter(index) {
  let n = Number(index || 0);
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result || 'A';
}

function formatGoogleApiError(error) {
  const primary =
    String(error?.response?.data?.error?.message || '').trim() ||
    String(error?.message || '').trim() ||
    'Unknown Google Sheets API error';
  const code = String(error?.response?.data?.error?.code || error?.code || '').trim();
  const reason = String(error?.response?.data?.error?.status || '').trim();
  const status = String(error?.response?.status || '').trim();
  const details = [status ? `http=${status}` : '', code ? `code=${code}` : '', reason ? `status=${reason}` : '']
    .filter(Boolean)
    .join(', ');
  return details ? `${primary} (${details})` : primary;
}

function isRetryableGoogleError(error) {
  const status = Number(error?.response?.status || 0);
  const message = String(error?.response?.data?.error?.message || error?.message || '').toLowerCase();
  if ([403, 429, 500, 502, 503, 504].includes(status)) return true;
  if (message.includes('quota') || message.includes('rate limit') || message.includes('user rate limit')) return true;
  if (message.includes('internal error')) return true;
  if (message.includes('backend error')) return true;
  if (message.includes('timed out') || message.includes('timeout')) return true;
  return false;
}

async function withSheetsRetry(fn, label = 'Google Sheets request') {
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableGoogleError(error)) {
        throw error;
      }
      const delayMs = Math.min(15000, 1000 * Math.pow(2, attempt - 1));
      console.warn(`${label} failed (attempt ${attempt}/${maxAttempts}): ${formatGoogleApiError(error)}. Retrying in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`${label} failed after retries`);
}

function createRequestLimiter(minIntervalMs = 1100) {
  let lastAt = 0;
  const wait = async () => {
    const now = Date.now();
    const delay = Number(minIntervalMs || 0) - (now - lastAt);
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    lastAt = Date.now();
  };
  return {
    async call(fn) {
      await wait();
      return fn();
    }
  };
}

module.exports = {
  writeInventoryToSheets,
  testSheetsConnection,
  validateAndExtractSpreadsheetId
};
