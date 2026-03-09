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
     WITH FreightCredits AS (
    /* Pre-calculate the total credit amount per invoice to roll it into the first row */
    SELECT 
        InvoiceID, 
        SUM(UnitPrice) AS TotalFreightCredit
    FROM dbo.INVOICE_LINEITEM
    WHERE LineItemType = 'CRED' 
      AND (LineItemDescription LIKE '%Freight%' OR LineItemDescription LIKE 'CR: FREIGHT%')
    GROUP BY InvoiceID
)
SELECT
    CONVERT(varchar(23), i.DateCreated, 121) AS DateCreated,
    e.EmployeeName AS [Created By],
    i.InvoiceNumber AS [Invoice#],
    i.CustomerNumber,
    i.OrderSource,

    /* Ghost Logic: If no line item exists, these return NULL/Blank */
    CASE WHEN li.LineItemID IS NULL THEN NULL ELSE 'R0' + CAST(inv.InventoryID AS VARCHAR(50)) END AS RNumber,
    CASE WHEN li.LineItemID IS NULL THEN NULL ELSE inv.StockTicketNumber END AS [Stock#],
    CASE WHEN li.LineItemID IS NULL THEN NULL ELSE inv.InventoryNumber END AS InventoryNumber,
    li.UnitPrice AS Price,
    inv.WarrantyInfo AS Warranty,

    /* Delivery Fee: Show on first valid row only */
    CASE 
        WHEN ROW_NUMBER() OVER(PARTITION BY i.InvoiceID ORDER BY li.LineItemID) = 1 
        THEN ISNULL(i.TotalServicesAmount, 0) 
        ELSE 0 
    END AS [Delivery Fee],

    i.TotalDiscountAmount AS Discount,
    /* SHIPPING: Combining Header Freight, Line Freight, and the new Freight Credits */
    CASE 
        WHEN ROW_NUMBER() OVER(PARTITION BY i.InvoiceID ORDER BY li.LineItemID) = 1 
        THEN ISNULL(i.TotalFreightAmount, 0) + 
             ISNULL(li.TotalFreightAmount, 0)+ ISNULL(fc.TotalFreightCredit, 0)
        ELSE 0 
    END AS Shipping,

    /* TAX: First row only */
    CASE 
        WHEN ROW_NUMBER() OVER(PARTITION BY i.InvoiceID ORDER BY li.LineItemID) = 1 
        THEN (ISNULL(i.TotalCityTaxAmount, 0) + ISNULL(i.TotalCountyTaxAmount, 0) + 
              ISNULL(i.TotalStateProvTaxAmount, 0) + ISNULL(i.TotalOtherTax, 0) + 
              ISNULL(i.TotalGSTTaxAmount, 0))
        ELSE 0 
    END AS Tax,

    /* TOTAL CALCULATION: Conditional Logic based on Line Item Count */
    CASE 
        /* SCENARIO 1: Single Line Item or Ghost (Count <= 1)
           Trust the Header InvoiceAmount to avoid double-counting shipping on eBay orders. */
        WHEN (SELECT COUNT(*) FROM dbo.INVOICE_LINEITEM WHERE InvoiceID = i.InvoiceID AND LineItemType <> 'CRED') <= 1
        THEN 
            CASE 
                WHEN ROW_NUMBER() OVER(PARTITION BY i.InvoiceID ORDER BY li.LineItemID) = 1 THEN i.InvoiceAmount 
                ELSE 0 
            END

        /* SCENARIO 2: Multiple Line Items
           Logic: Each row uses its own UnitPrice. 
           Row 1 also gets the 'Non-Taxable gap' and all associated fees.
        */
        ELSE (
            ISNULL(li.UnitPrice, 0) +
            CASE 
                WHEN ROW_NUMBER() OVER(PARTITION BY i.InvoiceID ORDER BY li.LineItemID) = 1 
                THEN (
                    ISNULL(i.TotalFreightAmount, 0) +
                    ISNULL(li.TotalFreightAmount, 0) +
                    ISNULL(fc.TotalFreightCredit, 0) +
                    ISNULL(i.TotalFreightTaxAmount, 0) +
                    ISNULL(i.TotalCityTaxAmount, 0) +
                    ISNULL(i.TotalCountyTaxAmount, 0) +
                    ISNULL(i.TotalStateProvTaxAmount, 0) +
                    ISNULL(i.TotalOtherTax, 0) +
                    ISNULL(i.TotalGSTTaxAmount, 0) +
                    ISNULL(i.TotalServicesAmount, 0) -
                    ISNULL(i.TotalDiscountAmount, 0)
                )
                ELSE 0 
            END
        )
    END AS Total,

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

    /* Payment Type Logic */
    CASE 
        WHEN ISNULL(i.TotalPaymentCheck, 0) <> 0 THEN 'Check'
        WHEN ISNULL(i.TotalPaymentCash, 0) <> 0 THEN 'Cash'
        WHEN ISNULL(i.TotalPaymentCharge, 0) <> 0 THEN 'Charge'
        WHEN i.CreditCardType IS NOT NULL THEN cc.CreditCardDescription 
        ELSE opt.OtherPaymentTypeDescription 
    END AS PaymentType,

    /* Vendor/PO Logic (Only populated if Stock# starts with 'P') */
    CASE WHEN inv.StockTicketNumber LIKE 'P%' THEN po.VendorName ELSE NULL END AS VendorName,
    CASE WHEN inv.StockTicketNumber LIKE 'P%' THEN po.PONumber ELSE NULL END AS [PurchaseOrder#],
    CASE WHEN inv.StockTicketNumber LIKE 'P%' THEN poli1.UnitPrice ELSE NULL END AS VendorUnitPrice,
    CASE WHEN inv.StockTicketNumber LIKE 'P%' THEN poli1.ReceivedQty ELSE NULL END AS [Qty/Received],

    /* Markup Logic for 'P' stocks */
    CASE
        WHEN inv.StockTicketNumber LIKE 'P%' AND poli1.UnitPrice > 0
        THEN ROUND(((inv.RetailPrice - poli1.UnitPrice) / poli1.UnitPrice) * 100, 2)
        ELSE 0
    END AS MarkUp

FROM dbo.INVOICE i
LEFT JOIN dbo.INVOICE_LINEITEM li
    ON li.InvoiceID = i.InvoiceID 
    AND li.LineItemType NOT IN ('SERV')
    /* EXCLUDE the freight credits from the main rows so they don't double-count */
    AND NOT (
        li.LineItemType = 'CRED' 
        AND (li.LineItemDescription LIKE '%Freight%' OR li.LineItemDescription LIKE 'CR: FREIGHT%'))
   
LEFT JOIN dbo.INVENTORY inv
    ON inv.InventoryID = li.InventoryID

LEFT JOIN dbo.OTHER_PAYMENT_TYPE opt ON opt.OtherPaymentType = i.OtherPaymentType
LEFT JOIN dbo.CREDIT_CARD cc ON cc.CreditCardType = i.CreditCardType
LEFT JOIN dbo.EMPLOYEE e ON e.EmployeeID = i.CreatedBy
LEFT JOIN FreightCredits fc ON fc.InvoiceID = i.InvoiceID /* Pull in the credits here */

OUTER APPLY (
    SELECT TOP 1 poli.PurchaseOrderID, poli.UnitPrice, poli.ReceivedQty
    FROM dbo.PURCHASE_ORDER_LINEITEM poli
    WHERE poli.InventoryNumber = inv.InventoryNumber
    ORDER BY CASE WHEN poli.DateReceived IS NULL THEN 1 ELSE 0 END, poli.DateReceived DESC
) poli1

LEFT JOIN dbo.PURCHASE_ORDER po ON po.PurchaseOrderID = poli1.PurchaseOrderID



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
