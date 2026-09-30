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
    /* Pre-calculate total freight credit per invoice */
    SELECT 
        InvoiceID, 
        SUM(UnitPrice) AS TotalFreightCredit
    FROM dbo.INVOICE_LINEITEM
    WHERE LineItemType = 'CRED'
      AND (
            LineItemDescription LIKE '%Freight%'
            OR LineItemDescription LIKE 'CR: FREIGHT%'
          )
    GROUP BY InvoiceID
),

LineFreight AS (
    /* 
       Calculate total freight stored on valid product lines.

       This is ONLY used when the invoice/header freight is 0.
       SERV and CRED rows are excluded so they do not affect
       the product freight calculation.
    */
    SELECT
        InvoiceID,
        SUM(ISNULL(TotalFreightAmount, 0)) AS TotalLineFreight
    FROM dbo.INVOICE_LINEITEM
    WHERE LineItemType NOT IN ('SERV', 'CRED')
      AND InventoryID IS NOT NULL
    GROUP BY InvoiceID
)

SELECT
    CONVERT(varchar(23), i.DateCreated, 121) AS DateCreated,
    e.EmployeeName AS [Created By],
    i.InvoiceNumber AS [Invoice#],
    i.CustomerNumber,
    i.OrderSource,

    /* Ghost Logic */
    CASE 
        WHEN li.LineItemID IS NULL THEN NULL
        ELSE 'R0' + CAST(inv.InventoryID AS VARCHAR(50))
    END AS RNumber,

    CASE 
        WHEN li.LineItemID IS NULL THEN NULL
        ELSE inv.StockTicketNumber
    END AS [Stock#],

    CASE 
        WHEN li.LineItemID IS NULL THEN NULL
        ELSE inv.InventoryNumber
    END AS InventoryNumber,

    li.UnitPrice AS Price,

    /* Warranty sold on this invoice line */
    ISNULL(vli.WarrantyPrice, 0) AS Warranty,


    /* ============================================================
       DELIVERY FEE
       Show once on the first valid invoice row.
       ============================================================ */
    CASE
        WHEN ROW_NUMBER() OVER (
            PARTITION BY i.InvoiceID
            ORDER BY li.LineItemID
        ) = 1
        THEN ISNULL(i.TotalServicesAmount, 0)
        ELSE 0
    END AS [Delivery Fee],


    i.TotalDiscountAmount AS Discount,


    /* ============================================================
       SHIPPING

       Rule:
       1. If header freight exists -> use header freight.
       2. Otherwise -> use summed product-line freight.
       3. Apply freight credit.
       4. Show shipping only on first invoice row.

       IMPORTANT:
       Header freight and line freight are NOT added together.
       ============================================================ */
    CASE
        WHEN ROW_NUMBER() OVER (
            PARTITION BY i.InvoiceID
            ORDER BY li.LineItemID
        ) = 1
        THEN
            (
                CASE
                    WHEN ISNULL(i.TotalFreightAmount, 0) <> 0
                        THEN ISNULL(i.TotalFreightAmount, 0)
                    ELSE ISNULL(lf.TotalLineFreight, 0)
                END
            )
            + ISNULL(fc.TotalFreightCredit, 0)

        ELSE 0
    END AS Shipping,


    /* ============================================================
       TAX
       Show once on the first valid invoice row.
       ============================================================ */
    CASE
        WHEN ROW_NUMBER() OVER (
            PARTITION BY i.InvoiceID
            ORDER BY li.LineItemID
        ) = 1
        THEN (
            ISNULL(i.TotalCityTaxAmount, 0)
            + ISNULL(i.TotalCountyTaxAmount, 0)
            + ISNULL(i.TotalStateProvTaxAmount, 0)
            + ISNULL(i.TotalOtherTax, 0)
            + ISNULL(i.TotalGSTTaxAmount, 0)
        )
        ELSE 0
    END AS Tax,


    /* ============================================================
       TOTAL CALCULATION
       ============================================================ */
    CASE

        /* --------------------------------------------------------
           SCENARIO 1:
           Single line item or ghost invoice.

           Trust InvoiceAmount because it already represents the
           final invoice amount and avoids double-counting freight,
           warranty, etc.
           -------------------------------------------------------- */
        WHEN (
            SELECT COUNT(*)
            FROM dbo.INVOICE_LINEITEM
            WHERE InvoiceID = i.InvoiceID
              AND LineItemType <> 'CRED'
        ) <= 1

        THEN
            CASE
                WHEN ROW_NUMBER() OVER (
                    PARTITION BY i.InvoiceID
                    ORDER BY li.LineItemID
                ) = 1
                THEN i.InvoiceAmount
                ELSE 0
            END


        /* --------------------------------------------------------
           SCENARIO 2:
           Multiple line items.

           Each row receives its own UnitPrice.

           Invoice-level charges are added to the first row only.
           -------------------------------------------------------- */
        ELSE (
            ISNULL(li.UnitPrice, 0)

            +

            CASE
                WHEN ROW_NUMBER() OVER (
                    PARTITION BY i.InvoiceID
                    ORDER BY li.LineItemID
                ) = 1

                THEN (

                    /* Freight:
                       Header freight takes priority.
                       Otherwise use summed line freight.
                    */
                    CASE
                        WHEN ISNULL(i.TotalFreightAmount, 0) <> 0
                            THEN ISNULL(i.TotalFreightAmount, 0)
                        ELSE ISNULL(lf.TotalLineFreight, 0)
                    END

                    /* Freight Credit */
                    + ISNULL(fc.TotalFreightCredit, 0)

                    /* Freight Tax */
                    + ISNULL(i.TotalFreightTaxAmount, 0)

                    /* Taxes */
                    + ISNULL(i.TotalCityTaxAmount, 0)
                    + ISNULL(i.TotalCountyTaxAmount, 0)
                    + ISNULL(i.TotalStateProvTaxAmount, 0)
                    + ISNULL(i.TotalOtherTax, 0)
                    + ISNULL(i.TotalGSTTaxAmount, 0)

                    /* Delivery / Services */
                    + ISNULL(i.TotalServicesAmount, 0)

                    /* Discount */
                    - ISNULL(i.TotalDiscountAmount, 0)
                )

                ELSE 0
            END
        )
    END AS Total,


    /* ============================================================
       CUSTOMER / INVENTORY INFORMATION
       ============================================================ */

    inv.LocationCode,

    i.BillToBusinessName AS CustomerName,
    i.BillToAddress1,
    i.BillToAddress2,
    i.BillToCity,
    i.BillToStateOrProvince,
    i.BillToPostalCode AS BillToZipCode,

    NULLIF(
        LTRIM(RTRIM(i.CustomerPO)),
        ''
    ) AS PONumber,

    i.EbayOrderNumber AS [EbayOrder#],
    i.InvoiceNotes,
    i.PaymentComment AS PaymentNotes,
    i.CreditCardApprovalCode AS CreditCardAuthNumber,


    /* ============================================================
       PAYMENT TYPE
       ============================================================ */
    CASE
        WHEN ISNULL(i.TotalPaymentCheck, 0) <> 0
            THEN 'Check'

        WHEN ISNULL(i.TotalPaymentCash, 0) <> 0
            THEN 'Cash'

        WHEN ISNULL(i.TotalPaymentCharge, 0) <> 0
            THEN 'Charge'

        WHEN i.CreditCardType IS NOT NULL
            THEN cc.CreditCardDescription

        ELSE opt.OtherPaymentTypeDescription
    END AS PaymentType,


    /* ============================================================
       VENDOR / PURCHASE ORDER
       Only populated when Stock# starts with P
       ============================================================ */

    CASE
        WHEN inv.StockTicketNumber LIKE 'P%'
            THEN po.VendorName
        ELSE NULL
    END AS VendorName,

    CASE
        WHEN inv.StockTicketNumber LIKE 'P%'
            THEN po.PONumber
        ELSE NULL
    END AS [PurchaseOrder#],

    CASE
        WHEN inv.StockTicketNumber LIKE 'P%'
            THEN poli1.UnitPrice
        ELSE NULL
    END AS VendorUnitPrice,

    CASE
        WHEN inv.StockTicketNumber LIKE 'P%'
            THEN poli1.ReceivedQty
        ELSE NULL
    END AS [Qty/Received],


    /* ============================================================
       MARKUP
       ============================================================ */
    CASE
        WHEN inv.StockTicketNumber LIKE 'P%'
             AND poli1.UnitPrice > 0
        THEN ROUND(
            (
                (inv.RetailPrice - poli1.UnitPrice)
                / poli1.UnitPrice
            ) * 100,
            2
        )
        ELSE 0
    END AS MarkUp


FROM dbo.INVOICE i


/* ================================================================
   MAIN INVOICE LINE ITEMS
   ================================================================ */
LEFT JOIN dbo.INVOICE_LINEITEM li
    ON li.InvoiceID = i.InvoiceID

    AND li.LineItemType NOT IN ('SERV')

    AND li.InventoryID IS NOT NULL

    /* Do not create separate output rows for freight credits */
    AND NOT (
        li.LineItemType = 'CRED'
        AND (
            li.LineItemDescription LIKE '%Freight%'
            OR li.LineItemDescription LIKE 'CR: FREIGHT%'
        )
    )


/* ================================================================
   WARRANTY INFORMATION
   ================================================================ */
LEFT JOIN dbo.vu_invoice_lineitem vli
    ON vli.LineItemID = li.LineItemID


/* ================================================================
   INVENTORY
   ================================================================ */
LEFT JOIN dbo.INVENTORY inv
    ON inv.InventoryID = li.InventoryID


/* ================================================================
   PAYMENT LOOKUPS
   ================================================================ */
LEFT JOIN dbo.OTHER_PAYMENT_TYPE opt
    ON opt.OtherPaymentType = i.OtherPaymentType

LEFT JOIN dbo.CREDIT_CARD cc
    ON cc.CreditCardType = i.CreditCardType


/* ================================================================
   EMPLOYEE
   ================================================================ */
LEFT JOIN dbo.EMPLOYEE e
    ON e.EmployeeID = i.CreatedBy


/* ================================================================
   FREIGHT CREDIT
   ================================================================ */
LEFT JOIN FreightCredits fc
    ON fc.InvoiceID = i.InvoiceID


/* ================================================================
   LINE FREIGHT FALLBACK
   ================================================================ */
LEFT JOIN LineFreight lf
    ON lf.InvoiceID = i.InvoiceID


/* ================================================================
   PURCHASE ORDER LOOKUP
   ================================================================ */
OUTER APPLY (
    SELECT TOP 1
        poli.PurchaseOrderID,
        poli.UnitPrice,
        poli.ReceivedQty

    FROM dbo.PURCHASE_ORDER_LINEITEM poli

    WHERE poli.InventoryNumber = inv.InventoryNumber

    ORDER BY
        CASE
            WHEN poli.DateReceived IS NULL THEN 1
            ELSE 0
        END,
        poli.DateReceived DESC
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
