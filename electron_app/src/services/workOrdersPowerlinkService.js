const { getDB } = require('./db');

const { formatDateInTimeZone } = require('../utils/timezone');

const WORK_ORDERS_EST_TIME_ZONE = 'Etc/GMT+5';

const WORK_ORDERS_QUERY = `
DECLARE @LastSynced DATETIME = GETDATE();

WITH ImageDedup AS (
    SELECT DISTINCT
        InventoryID,
        CAST(CONCAT(ISNULL(FilePath, ''), ISNULL(FileName, '')) AS varchar(max)) AS ImagePath
    FROM dbo.IMAGE
    WHERE DateDeleted IS NULL
      AND ImageType = 'I'
      AND FileName IS NOT NULL
),

LineImageAgg AS (
    SELECT
        InventoryID,
        STRING_AGG(CAST(ImagePath AS varchar(max)), ' | ') AS PartPictures
    FROM ImageDedup
    GROUP BY InventoryID
),

WorkOrderLineDedup AS (
    SELECT DISTINCT
        wol.WorkOrderID,
        wol.LineItemID,
        wol.LineItemStatus,
        wol.InventoryNumber,
        wol.LocalInventoryID,
        wol.LineItemDescription,
        wol.LineItemNotes,
        wol.LineItemSourceDetails,
        wol.Quantity,
        wol.UnitPrice,
        wol.LineItemTotal,
        wol.ShipVIA AS LineShipVIA,
        wol.TrackingNumber,
        wol.EBayItemId,
        inv.StockTicketNumber,
        inv.LocationCode,
        CONCAT(
            CAST(inv.SourceVehicleStoreNumber AS varchar(10)),
            ISNULL(inv.CategoryCode, '')
        ) AS SourceCode
    FROM dbo.WORKORDER_LINEITEM wol
    LEFT JOIN dbo.INVENTORY inv
        ON inv.InventoryID = wol.LocalInventoryID
    WHERE wol.LineItemStatus = 'O'
),

QuoteLineDedup AS (
    SELECT DISTINCT
        ql.QuoteID,
        ql.LineItemID,
        ql.LineItemStatus,
        ql.InventoryNumber,
        ql.LocalInventoryID,
        ql.LineItemNotes,
        inv.StockTicketNumber,
        inv.LocationCode,
        CONCAT(
            CAST(inv.SourceVehicleStoreNumber AS varchar(10)),
            ISNULL(inv.CategoryCode, '')
        ) AS SourceCode
    FROM dbo.QUOTE_LINEITEM ql
    LEFT JOIN dbo.INVENTORY inv
        ON inv.InventoryID = ql.LocalInventoryID
    WHERE ql.LineItemStatus = 'O'
)

SELECT
    NULL AS [Date/Time Last Synced],
    CONVERT(varchar(23), wo.DateCreated, 121) AS [Created],
    wo.WorkOrderNumber AS [W/O or Quote Number],
    wold.LineItemID AS [Line Item ID],

    CASE
        WHEN wo.WorkOrderStatus = 'O' THEN 'Open'
        WHEN wo.WorkOrderStatus = 'C' THEN 'Closed'
        ELSE wo.WorkOrderStatus
    END AS [Status],
    wold.LineItemStatus AS [Line Item Status],

    COALESCE(woemp.EmployeeName, CAST(wo.CreatedBy AS varchar(50))) AS [Created By],

    COALESCE(NULLIF(wold.LineShipVIA, ''), wo.ShipVIA) AS [Ship Via],
    wold.TrackingNumber AS [Tracking Number],

    wo.Amount AS [Amount (Total)],
    wold.Quantity AS [Line Quantity],
    wold.UnitPrice AS [Line Unit Price],
    wold.LineItemTotal AS [Line Total],

    wo.CustomerPO AS [Customer PO],
    wo.CustomerNumber AS [Customer Number],
    CONVERT(varchar(23), wo.DeliveryDate, 121) AS [Delivery Date],

    COALESCE(NULLIF(wo.BillToBusinessName, ''), wo.BillToContactName) AS [Billing Customer Name],
    COALESCE(NULLIF(wo.ShipToBusinessName, ''), wo.ShipToContactName) AS [Shipping Customer Name],

    CONCAT_WS(', ',
        NULLIF(wo.ShipToAddress1, ''),
        NULLIF(wo.ShipToAddress2, ''),
        NULLIF(wo.ShipToCity, ''),
        NULLIF(wo.ShipToStateOrProvince, ''),
        NULLIF(wo.ShipToPostalCode, ''),
        NULLIF(wo.ShipToCountry, '')
    ) AS [Shipping Customer Address],

    wo.ShipToCity AS [Shipping City],
    wo.ShipToStateOrProvince AS [Shipping State],
    wo.ShipToContactPhone AS [Shipping Customer Phone Number],
    wo.EbayOrderNumber AS [eBay Order Number],
    wold.EBayItemId AS [eBay Item ID],

    wold.InventoryNumber AS [Detail (IPN)],
    wold.LineItemDescription AS [Line Item Description],

    CASE
        WHEN wold.LocalInventoryID IS NOT NULL THEN CONCAT('R0', wold.LocalInventoryID)
        ELSE ''
    END AS [R#],

    wold.StockTicketNumber AS [Stock #],
    wold.SourceCode AS [S/C],
    wold.LocationCode AS [Location],

    wold.LineItemSourceDetails AS [Source Details],

    CONCAT_WS(' | ',
        NULLIF(wo.WorkOrderNotes, ''),
        NULLIF(wold.LineItemNotes, '')
    ) AS [Notes],

    img.PartPictures AS [Part Pictures],
    'Work Order' AS [Record Type]

FROM dbo.WORKORDER wo
INNER JOIN WorkOrderLineDedup wold
    ON wold.WorkOrderID = wo.WorkOrderID
LEFT JOIN LineImageAgg img
    ON img.InventoryID = wold.LocalInventoryID
LEFT JOIN dbo.EMPLOYEE woemp
    ON woemp.EmployeeID = wo.CreatedBy
WHERE wo.IsLastRevision = 1
  AND wo.WorkOrderStatus = 'O'

UNION ALL

SELECT
    NULL AS [Date/Time Last Synced],
    CONVERT(varchar(23), q.DateCreated, 121) AS [Created],
    q.QuoteNumber AS [W/O or Quote Number],
    qld.LineItemID AS [Line Item ID],

    CASE
        WHEN q.QuoteStatus = 'O' THEN 'Open'
        WHEN q.QuoteStatus = 'C' THEN 'Closed'
        ELSE q.QuoteStatus
    END AS [Status],
    qld.LineItemStatus AS [Line Item Status],

    COALESCE(qemp.EmployeeName, CAST(q.CreatedBy AS varchar(50))) AS [Created By],

    q.ShipVIA AS [Ship Via],
    NULL AS [Tracking Number],

    q.QuoteAmount AS [Amount (Total)],
    NULL AS [Line Quantity],
    NULL AS [Line Unit Price],
    NULL AS [Line Total],

    q.CustomerPO AS [Customer PO],
    q.CustomerNumber AS [Customer Number],
    NULL AS [Delivery Date],

    COALESCE(NULLIF(q.BillToBusinessName, ''), q.BillToContactName) AS [Billing Customer Name],
    COALESCE(NULLIF(q.ShipToBusinessName, ''), q.ShipToContactName) AS [Shipping Customer Name],

    CONCAT_WS(', ',
        NULLIF(q.ShipToAddress1, ''),
        NULLIF(q.ShipToAddress2, ''),
        NULLIF(q.ShipToCity, ''),
        NULLIF(q.ShipToStateOrProvince, ''),
        NULLIF(q.ShipToPostalCode, ''),
        NULLIF(q.ShipToCountry, '')
    ) AS [Shipping Customer Address],

    NULL AS [Shipping City],
    NULL AS [Shipping State],
    q.ShipToContactPhone AS [Shipping Customer Phone Number],
    NULL AS [eBay Order Number],
    NULL AS [eBay Item ID],

    qld.InventoryNumber AS [Detail (IPN)],
    NULL AS [Line Item Description],

    CASE
        WHEN qld.LocalInventoryID IS NOT NULL THEN CONCAT('R0', qld.LocalInventoryID)
        ELSE ''
    END AS [R#],

    qld.StockTicketNumber AS [Stock #],
    qld.SourceCode AS [S/C],
    qld.LocationCode AS [Location],

    NULL AS [Source Details],

    CONCAT_WS(' | ',
        NULLIF(q.QuoteNotes, ''),
        NULLIF(qld.LineItemNotes, '')
    ) AS [Notes],

    img.PartPictures AS [Part Pictures],
    'Quote' AS [Record Type]

FROM dbo.QUOTE q
INNER JOIN QuoteLineDedup qld
    ON qld.QuoteID = q.QuoteID
LEFT JOIN LineImageAgg img
    ON img.InventoryID = qld.LocalInventoryID
LEFT JOIN dbo.EMPLOYEE qemp
    ON qemp.EmployeeID = q.CreatedBy
WHERE q.IsLastRevision = 1
  AND q.QuoteStatus = 'O'
  AND q.ShipVIA = 'Check Part';
`;

function normalizeValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatDateInTimeZone(value, WORK_ORDERS_EST_TIME_ZONE);
  return String(value);
}

async function fetchWorkOrderRows() {
  const pool = getDB();
  const result = await pool.request().query(WORK_ORDERS_QUERY);
  const rows = Array.isArray(result?.recordset) ? result.recordset : [];
  return rows.map(row => {
    const normalized = {};
    Object.keys(row || {}).forEach(key => {
      normalized[key] = normalizeValue(row[key]);
    });
    return normalized;
  });
}

module.exports = {
  WORK_ORDERS_QUERY,
  fetchWorkOrderRows
};
