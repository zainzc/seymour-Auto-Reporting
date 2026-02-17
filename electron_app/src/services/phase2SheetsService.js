const { google } = require('googleapis');
const oauth2Service = require('./oauth2Service');

async function getAuthenticatedSheetsClient(authContext = 'inventory') {
  if (!oauth2Service.isAuthenticated(authContext)) {
    throw new Error('Google account is not connected for Milestone 1. Please connect first.');
  }

  const auth = oauth2Service.getAuthenticatedClient(authContext);
  return google.sheets({ version: 'v4', auth });
}

async function readSheetRows(spreadsheetId, tabName, authContext = 'inventory') {
  if (!spreadsheetId || !tabName) {
    throw new Error('Sheet configuration is missing spreadsheetId or tabName.');
  }

  const sheets = await getAuthenticatedSheetsClient(authContext);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A:ZZ`
  });

  const values = response.data.values || [];
  if (values.length === 0) {
    throw new Error('Source sheet is empty.');
  }

  return values;
}

module.exports = {
  readSheetRows
};

