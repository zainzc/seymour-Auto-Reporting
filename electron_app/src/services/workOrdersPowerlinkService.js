const { getDB } = require('./db');

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

WorkOrderImageAgg AS (
    SELECT
        x.WorkOrderID,
        STRING_AGG(CAST(x.ImagePath AS varchar(max)), ' | ') AS PartPictures
    FROM (
        SELECT DISTINCT
            wol.WorkOrderID,
            img.ImagePath
        FROM dbo.WORKORDER_LINEITEM wol
        LEFT JOIN ImageDedup img
            ON img.InventoryID = wol.LocalInventoryID
        WHERE img.ImagePath IS NOT NULL
    ) x
    GROUP BY x.WorkOrderID
),

QuoteImageAgg AS (
    SELECT
        x.QuoteID,
        STRING_AGG(CAST(x.ImagePath AS varchar(max)), ' | ') AS PartPictures
    FROM (
        SELECT DISTINCT
            ql.QuoteID,
            img.ImagePath
        FROM dbo.QUOTE_LINEITEM ql
        LEFT JOIN ImageDedup img
            ON img.InventoryID = ql.LocalInventoryID
        WHERE img.ImagePath IS NOT NULL
    ) x
    GROUP BY x.QuoteID
),

WorkOrderLineDedup AS (
    SELECT DISTINCT
        wol.WorkOrderID,
        wol.LineItemID,
        wol.InventoryNumber,
        wol.LocalInventoryID,
        wol.LineItemNotes,
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
),

WorkOrderLineAgg AS (
    SELECT
        WorkOrderID,
        STRING_AGG(
            CAST(ISNULL(InventoryNumber, '') AS varchar(max)),
            ' | '
        ) AS DetailIPN,
        STRING_AGG(
            CAST(
                CASE
                    WHEN LocalInventoryID IS NOT NULL THEN CONCAT('R0', LocalInventoryID)
                    ELSE ''
                END AS varchar(max)
            ),
            ' | '
        ) AS RNumber,
        STRING_AGG(CAST(ISNULL(StockTicketNumber, '') AS varchar(max)), ' | ') AS StockNumber,
        STRING_AGG(CAST(ISNULL(SourceCode, '') AS varchar(max)), ' | ') AS SC,
        STRING_AGG(CAST(ISNULL(LocationCode, '') AS varchar(max)), ' | ') AS Location,
        STRING_AGG(CAST(ISNULL(LineItemNotes, '') AS varchar(max)), ' | ') AS LineNotes,
        STRING_AGG(CAST(ISNULL(EBayItemId, '') AS varchar(max)), ' | ') AS EBayItemIds
    FROM WorkOrderLineDedup
    GROUP BY WorkOrderID
),

QuoteLineDedup AS (
    SELECT DISTINCT
        ql.QuoteID,
        ql.LineItemID,
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
),

QuoteLineAgg AS (
    SELECT
        QuoteID,
        STRING_AGG(
            CAST(ISNULL(InventoryNumber, '') AS varchar(max)),
            ' | '
        ) AS DetailIPN,
        STRING_AGG(
            CAST(
                CASE
                    WHEN LocalInventoryID IS NOT NULL THEN CONCAT('R0', LocalInventoryID)
                    ELSE ''
                END AS varchar(max)
            ),
            ' | '
        ) AS RNumber,
        STRING_AGG(CAST(ISNULL(StockTicketNumber, '') AS varchar(max)), ' | ') AS StockNumber,
        STRING_AGG(CAST(ISNULL(SourceCode, '') AS varchar(max)), ' | ') AS SC,
        STRING_AGG(CAST(ISNULL(LocationCode, '') AS varchar(max)), ' | ') AS Location,
        STRING_AGG(CAST(ISNULL(LineItemNotes, '') AS varchar(max)), ' | ') AS LineNotes
    FROM QuoteLineDedup
    GROUP BY QuoteID
)

SELECT
    @LastSynced AS [Date/Time Last Synced],
    wo.DateCreated AS [Created],
    wo.WorkOrderNumber AS [W/O or Quote Number],
    'Open' AS [Status],
    COALESCE(woemp.EmployeeName, CAST(wo.CreatedBy AS varchar(50))) AS [Created By],
    wo.ShipVIA AS [Ship Via],
    wo.Amount AS [Amount (Total)],
    wo.CustomerPO AS [Customer PO],
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
    wo.ShipToContactPhone AS [Shipping Customer Phone Number],
    wo.EbayOrderNumber AS [eBay Order Number],
    wola.DetailIPN AS [Detail (IPN)],
    wola.RNumber AS [R#],
    wola.StockNumber AS [Stock #],
    wola.SC AS [S/C],
    wola.Location AS [Location],
    CONCAT_WS(' | ',
        NULLIF(wo.WorkOrderNotes, ''),
        NULLIF(wola.LineNotes, '')
    ) AS [Notes],
    woimg.PartPictures AS [Part Pictures],
    'Work Order' AS [Record Type]
FROM dbo.WORKORDER wo
LEFT JOIN WorkOrderLineAgg wola
    ON wola.WorkOrderID = wo.WorkOrderID
LEFT JOIN WorkOrderImageAgg woimg
    ON woimg.WorkOrderID = wo.WorkOrderID
LEFT JOIN dbo.EMPLOYEE woemp
    ON woemp.EmployeeID = wo.CreatedBy
WHERE wo.IsLastRevision = 1
  AND wo.WorkOrderStatus = 'O'

UNION ALL

SELECT
    @LastSynced AS [Date/Time Last Synced],
    q.DateCreated AS [Created],
    q.QuoteNumber AS [W/O or Quote Number],
    'Open' AS [Status],
    COALESCE(qemp.EmployeeName, CAST(q.CreatedBy AS varchar(50))) AS [Created By],
    q.ShipVIA AS [Ship Via],
    q.QuoteAmount AS [Amount (Total)],
    q.CustomerPO AS [Customer PO],
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
    q.ShipToContactPhone AS [Shipping Customer Phone Number],
    NULL AS [eBay Order Number],
    qla.DetailIPN AS [Detail (IPN)],
    qla.RNumber AS [R#],
    qla.StockNumber AS [Stock #],
    qla.SC AS [S/C],
    qla.Location AS [Location],
    CONCAT_WS(' | ',
        NULLIF(q.QuoteNotes, ''),
        NULLIF(qla.LineNotes, '')
    ) AS [Notes],
    qimg.PartPictures AS [Part Pictures],
    'Quote' AS [Record Type]
FROM dbo.QUOTE q
LEFT JOIN QuoteLineAgg qla
    ON qla.QuoteID = q.QuoteID
LEFT JOIN QuoteImageAgg qimg
    ON qimg.QuoteID = q.QuoteID
LEFT JOIN dbo.EMPLOYEE qemp
    ON qemp.EmployeeID = q.CreatedBy
WHERE q.IsLastRevision = 1
  AND q.QuoteStatus = 'O'
  AND q.ShipVIA = 'Check Part';
`;

function normalizeValue(value) {
  if (value === null || value === undefined) return '';
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
