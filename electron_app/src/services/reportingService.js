const { getDB } = require('./db');

/**
 * Extract invoice data from Powerlink
 * @param {Object} params - Query parameters
 * @param {string} params.dateFrom - Start date (YYYY-MM-DD)
 * @param {string} params.dateTo - End date (YYYY-MM-DD)
 * @param {string} params.salesperson - Salesperson filter (or 'ALL')
 * @returns {Promise<Array>} Invoice records
 */
async function getInvoices({ dateFrom, dateTo, salesperson }) {
  const pool = getDB();
  
  let query = `
    SELECT
        i.DateCreated,
        i.CreatedBy,
        i.InvoiceID AS [Invoice#],
        i.CustomerNumber,
        i.OrderSource,

        inv.ReferenceNumber AS RNumber,
        inv.StockTicketNumber AS [Stock#],
        inv.InventoryNumber,
        ISNULL(inv.RetailPrice, 0) AS Price,
        inv.WarrantyInfo AS Warranty,

        i.TotalDiscountAmount AS Discount,

        /* Shipping: Freight + Freight Tax */
        ISNULL(i.TotalFreightAmount, 0) 
        + ISNULL(i.TotalFreightTaxAmount, 0) AS Shipping,

        /* Tax: Sum of all tax fields */
        ISNULL(i.TotalCityTaxAmount, 0) +
        ISNULL(i.TotalCountyTaxAmount, 0) +
        ISNULL(i.TotalStateProvTaxAmount, 0) +
        ISNULL(i.TotalOtherTax, 0) +
        ISNULL(i.TotalGSTTaxAmount, 0) AS Tax,

        /* Total: (Retail Price + Shipping + Tax) - Discount */
        (ISNULL(inv.RetailPrice, 0) + 
        (ISNULL(i.TotalFreightAmount, 0) + ISNULL(i.TotalFreightTaxAmount, 0)) + 
        (ISNULL(i.TotalCityTaxAmount, 0) + ISNULL(i.TotalCountyTaxAmount, 0) + ISNULL(i.TotalStateProvTaxAmount, 0) + ISNULL(i.TotalOtherTax, 0) + ISNULL(i.TotalGSTTaxAmount, 0)) - 
        ISNULL(i.TotalDiscountAmount, 0)) AS Total,

        inv.LocationCode,

        c.CustomerName AS CustomerName,
        c.BillToAddress1,
        c.BillToAddress2,
        c.BillToCity,
        c.BillToStateOrProvince,
        c.BillToPostalCode AS BillToZipCode,

        i.CustomerPO AS PONumber,
        i.EbayOrderNumber AS [EbayOrder#],
        i.InvoiceNotes,
        i.InvoiceNotes AS PaymentNotes,
        i.CreditCardApprovalCode AS CreditCardAuthNumber,
        i.CreditCardType AS PaymentType,

        /* PO DATA - Only populated if Stock# starts with 'P' */
        CASE WHEN inv.StockTicketNumber LIKE 'P%' THEN po.VendorName ELSE NULL END AS VendorName,
        CASE WHEN inv.StockTicketNumber LIKE 'P%' THEN po.PONumber ELSE NULL END AS PONumber,
        CASE WHEN inv.StockTicketNumber LIKE 'P%' THEN poli.UnitPrice ELSE NULL END AS UnitPrice,
        CASE WHEN inv.StockTicketNumber LIKE 'P%' THEN poli.ReceivedQty ELSE NULL END AS [Qty/Received],
        
        /* Mark-up: Calculated as ((Retail - Cost) / Cost) * 100, rounded to 2 decimals */
        CASE 
            WHEN inv.StockTicketNumber LIKE 'P%' AND ISNULL(poli.UnitPrice, 0) > 0 
            THEN ROUND(((ISNULL(inv.RetailPrice, 0) - poli.UnitPrice) / poli.UnitPrice) * 100, 2)
            ELSE 0 
        END AS MarkUp

    FROM dbo.INVOICE i
    JOIN dbo.CUSTOMER c
        ON c.CustomerNumber = i.CustomerNumber

    JOIN dbo.INVOICE_LINEITEM li
        ON li.InvoiceID = i.InvoiceID

    JOIN dbo.INVENTORY inv
        ON CAST(li.InventoryNumber AS VARCHAR(50))
         = CAST(inv.InventoryNumber AS VARCHAR(50))

    LEFT JOIN dbo.PURCHASE_ORDER_LINEITEM poli
        ON CAST(poli.InventoryNumber AS VARCHAR(50))
         = CAST(inv.InventoryNumber AS VARCHAR(50))

    LEFT JOIN dbo.PURCHASE_ORDER po
        ON po.PurchaseOrderID = poli.PurchaseOrderID
    
    WHERE i.DateCreated >= @dateFrom 
      AND i.DateCreated < DATEADD(day, 1, @dateTo)
  `;

  // Add salesperson filter if not ALL
  if (salesperson && salesperson !== 'ALL') {
    query += ` AND i.CreatedBy = @salesperson`;
  }

  query += ` ORDER BY i.DateCreated DESC`;

  const request = pool.request();
  request.input('dateFrom', dateFrom);
  request.input('dateTo', dateTo);
  
  if (salesperson && salesperson !== 'ALL') {
    request.input('salesperson', salesperson);
  }

  const result = await request.query(query);
  return result.recordset;
}

/**
 * Get list of unique salespeople from Powerlink
 * @returns {Promise<Array<string>>} List of salesperson names
 */
async function getSalespeople() {
  const pool = getDB();
  
  const query = `
    SELECT DISTINCT CreatedBy
    FROM dbo.INVOICE
    WHERE CreatedBy IS NOT NULL
    ORDER BY CreatedBy
  `;

  const result = await pool.request().query(query);
  return result.recordset.map(row => row.CreatedBy);
}

/**
 * Get invoice data for scheduled execution
 * @param {string} frequency - 'nightly' or 'weekly'
 * @param {number} weekStartDay - Day of week (0=Sunday, 1=Monday, etc.) - only for weekly
 * @returns {Promise<Array>} Invoice records
 */
async function getScheduledInvoices(frequency, weekStartDay = 1) {
  let dateFrom, dateTo;

  if (frequency === 'nightly') {
    // Previous calendar day
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    
    const endOfYesterday = new Date(yesterday);
    endOfYesterday.setHours(23, 59, 59, 999);

    dateFrom = formatDate(yesterday);
    dateTo = formatDate(endOfYesterday);
  } else if (frequency === 'weekly') {
    // Last completed week
    const today = new Date();
    const currentDay = today.getDay(); // 0=Sunday, 1=Monday, etc.
    
    // Calculate days back to get to the last occurrence of weekStartDay
    let daysBack = currentDay - weekStartDay;
    if (daysBack <= 0) {
      daysBack += 7; // Go to previous week
    }
    
    // End of last week
    const endOfWeek = new Date(today);
    endOfWeek.setDate(today.getDate() - daysBack);
    endOfWeek.setHours(23, 59, 59, 999);
    
    // Start of last week
    const startOfWeek = new Date(endOfWeek);
    startOfWeek.setDate(endOfWeek.getDate() - 6);
    startOfWeek.setHours(0, 0, 0, 0);

    dateFrom = formatDate(startOfWeek);
    dateTo = formatDate(endOfWeek);
  }

  return getInvoices({ dateFrom, dateTo, salesperson: 'ALL' });
}

/**
 * Format date to YYYY-MM-DD
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

module.exports = {
  getInvoices,
  getSalespeople,
  getScheduledInvoices
};
