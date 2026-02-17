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
        CONVERT(varchar(23), i.DateCreated, 121) AS DateCreated,
        e.EmployeeName AS [Created By],
        i.InvoiceNumber AS [Invoice#],
        i.CustomerNumber,
        i.OrderSource,

        'R0' + CAST(inv.InventoryID AS VARCHAR(50)) AS RNumber,
        inv.StockTicketNumber AS [Stock#],
        inv.InventoryNumber,
        li.UnitPrice AS Price,
        inv.WarrantyInfo AS Warranty,

        i.TotalDiscountAmount AS Discount,

        ISNULL(i.TotalFreightAmount, 0) + 
        ISNULL(li.TotalFreightAmount, 0)
        AS Shipping,

        ISNULL(i.TotalCityTaxAmount, 0) +
        ISNULL(i.TotalCountyTaxAmount, 0) +
        ISNULL(i.TotalStateProvTaxAmount, 0) +
        ISNULL(i.TotalOtherTax, 0) +
        ISNULL(i.TotalGSTTaxAmount, 0) AS Tax,

        /* Line-level total (invoice values repeated per line) */
        li.UnitPrice +
        ISNULL(i.TotalFreightAmount, 0) +
        ISNULL(li.TotalFreightAmount, 0) +
        ISNULL(i.TotalFreightTaxAmount, 0) +
        ISNULL(i.TotalCityTaxAmount, 0) +
        ISNULL(i.TotalCountyTaxAmount, 0) +
        ISNULL(i.TotalStateProvTaxAmount, 0) +
        ISNULL(i.TotalOtherTax, 0) +
        ISNULL(i.TotalGSTTaxAmount, 0) -
        ISNULL(i.TotalDiscountAmount, 0) AS Total,

        inv.LocationCode,

        i.BillToBusinessName AS CustomerName,
        i.BillToAddress1,
        i.BillToAddress2,
        i.BillToCity,
        i.BillToStateOrProvince,
        i.BillToPostalCode AS BillToZipCode,

        NULLIF(LTRIM(RTRIM(i.CustomerPO)), '') AS PONumber,
        i.EbayOrderNumber AS [EbayOrder#],
        i.InvoiceNotes,
        i.PaymentComment AS PaymentNotes,
        i.CreditCardApprovalCode AS CreditCardAuthNumber,
        /* Updated Payment Type Logic */
        CASE 
        -- 1. Check specific payment amount columns first
          WHEN ISNULL(i.TotalPaymentCheck, 0) <> 0 THEN 'Check'
          WHEN ISNULL(i.TotalPaymentCash, 0) <> 0 THEN 'Cash'
          WHEN ISNULL(i.TotalPaymentCharge, 0) <> 0 THEN 'Charge'
        
        -- 2. Fallback to Credit Card table if amounts are null/zero
          WHEN i.CreditCardType IS NOT NULL THEN cc.CreditCardDescription 
        
        -- 3. Final fallback to Other Payment Type
          ELSE opt.OtherPaymentTypeDescription 
        END AS PaymentType,

        /* Condition: Only populate if Stock# starts with 'P' */
        CASE WHEN inv.StockTicketNumber LIKE 'P%' THEN po.VendorName ELSE NULL END AS VendorName,
        CASE WHEN inv.StockTicketNumber LIKE 'P%' THEN po.PONumber ELSE NULL END AS [PurchaseOrder#],
        CASE WHEN inv.StockTicketNumber LIKE 'P%' THEN poli1.UnitPrice ELSE NULL END AS VendorUnitPrice,
        CASE WHEN inv.StockTicketNumber LIKE 'P%' THEN poli1.ReceivedQty ELSE NULL END AS [Qty/Received],

        /* Line-level markup logic applied only for 'P' stocks */
        CASE
           WHEN inv.StockTicketNumber LIKE 'P%' AND poli1.UnitPrice > 0
           THEN ROUND(((inv.RetailPrice - poli1.UnitPrice) / poli1.UnitPrice) * 100, 2)
           ELSE 0
        END AS MarkUp

    FROM dbo.INVOICE i
    JOIN dbo.INVOICE_LINEITEM li
        ON li.InvoiceID = i.InvoiceID

    JOIN dbo.INVENTORY inv
        ON inv.InventoryID = li.InventoryID

    LEFT JOIN dbo.OTHER_PAYMENT_TYPE opt
        ON opt.OtherPaymentType = i.OtherPaymentType

    LEFT JOIN dbo.CREDIT_CARD cc 
        ON cc.CreditCardType = i.CreditCardType

    LEFT JOIN dbo.EMPLOYEE e
        ON e.EmployeeID = i.CreatedBy

    OUTER APPLY (
     SELECT TOP 1
        poli.PurchaseOrderID,
        poli.UnitPrice,
        poli.ReceivedQty,
        poli.DateReceived,
        poli.LastEditDate,
        poli.LineItemID
     FROM dbo.PURCHASE_ORDER_LINEITEM poli
     WHERE poli.InventoryNumber = inv.InventoryNumber
     ORDER BY
        CASE WHEN poli.DateReceived IS NULL THEN 1 ELSE 0 END,  -- prefer received rows
        poli.DateReceived DESC,
        poli.LastEditDate DESC,
        poli.LineItemID DESC
    ) poli1

    LEFT JOIN dbo.PURCHASE_ORDER po
        ON po.PurchaseOrderID = poli1.PurchaseOrderID
    
    WHERE i.DateCreated >= @dateFrom 
      AND i.DateCreated < DATEADD(day, 1, @dateTo)
  `;

  // Add salesperson filter if not ALL
  if (salesperson && salesperson !== 'ALL') {
    query += ` AND e.EmployeeName = @salesperson`;
  }

  query += ` ORDER BY i.InvoiceNumber`;

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
    SELECT DISTINCT e.EmployeeName
    FROM dbo.INVOICE i
    LEFT JOIN dbo.EMPLOYEE e
        ON e.EmployeeID = i.CreatedBy
    WHERE e.EmployeeName IS NOT NULL
    ORDER BY e.EmployeeName
  `;

  const result = await pool.request().query(query);
  return result.recordset.map(row => row.EmployeeName);
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
