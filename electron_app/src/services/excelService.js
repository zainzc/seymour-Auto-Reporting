const ExcelJS = require('exceljs');
const { dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Generate Excel file from invoice data and trigger download
 * @param {Array} data - Invoice data array
 * @param {Object} mainWindow - Electron BrowserWindow instance
 * @returns {Promise<Object>} Result with success status and message
 */
async function generateExcelFile(data, mainWindow) {
  try {
    if (!data || data.length === 0) {
      return { success: false, message: 'No data to export' };
    }

    // Create workbook and worksheet
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Invoices');

    // Define columns based on data structure
    const columns = Object.keys(data[0]).map(key => ({
      header: key,
      key: key,
      width: 15
    }));

    worksheet.columns = columns;

    // Add header row styling
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF38BDF8' }
    };

    // Add data rows
    data.forEach(row => {
      worksheet.addRow(row);
    });

    // Auto-fit columns
    worksheet.columns.forEach(column => {
      let maxLength = 0;
      column.eachCell({ includeEmpty: true }, cell => {
        const columnLength = cell.value ? cell.value.toString().length : 10;
        if (columnLength > maxLength) {
          maxLength = columnLength;
        }
      });
      column.width = maxLength < 10 ? 10 : maxLength + 2;
    });

    // Show save dialog
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Invoice Export',
      defaultPath: path.join(os.homedir(), 'Downloads', `Invoices_${Date.now()}.xlsx`),
      filters: [
        { name: 'Excel Files', extensions: ['xlsx', 'xls'] }
      ]
    });

    if (canceled || !filePath) {
      return { success: false, message: 'Export cancelled' };
    }

    // Write file
    await workbook.xlsx.writeFile(filePath);

    return {
      success: true,
      message: `Exported ${data.length} records to ${path.basename(filePath)}`
    };

  } catch (error) {
    console.error('Excel generation error:', error);
    return {
      success: false,
      message: `Export failed: ${error.message}`
    };
  }
}

/**
 * Generate Excel buffer (for testing or alternative use)
 * @param {Array} data - Invoice data array
 * @returns {Promise<Buffer>} Excel file buffer
 */
async function generateExcelBuffer(data) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Invoices');

  if (data.length > 0) {
    const columns = Object.keys(data[0]).map(key => ({
      header: key,
      key: key,
      width: 15
    }));

    worksheet.columns = columns;
    worksheet.getRow(1).font = { bold: true };

    data.forEach(row => {
      worksheet.addRow(row);
    });
  }

  return await workbook.xlsx.writeBuffer();
}

module.exports = {
  generateExcelFile,
  generateExcelBuffer
};
