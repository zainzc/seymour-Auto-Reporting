const { getDB } = require('./db');

/**
 * Inventory Service
 * Handles fetching inventory data from Powerlink for webhook push
 */

/**
 * Get all inventory data from Powerlink
 * @returns {Promise<Array>} Inventory records
 */
async function getAllInventory() {
  const pool = getDB();
  
  const query = `
    SELECT
        InventoryID AS RNumber,
        InventoryNumber,
        ModelYear,
        ModelName,
        CategoryCode,
        StockTicketNumber,
        PartType,
        LocationCode,
        PrimaryARADamageCode,
        SecondaryARADamageCode,
        ConditionsAndOptions,
        PartNotes,
        NULL AS IsAlternate,  -- column not present, return NULL
        PartRating,
        InventoriedDate,
        DateAcquired,
        ConditionCode,
        QuantityAvailable,
        QuantityQuoted,
        QuantityOnHold,
        inv_emp.EmployeeName AS Inventorier, 
        dism_emp.EmployeeName AS Dismantler,
        Mileage,
        RetailPrice,
        WholesalePrice,
        CostPrice,
        ValuePrice,
        EbayPrice,
        EcomPrice,
        DamageReported,
        UnitsOfDamage,
        DateBPGGraded,
        EComDescription,
        PrivacyIndicator,
        BlockOnlineSale,
        ReferenceNumber
FROM dbo.INVENTORY i -- Added alias 'i' for clarity
LEFT JOIN dbo.EMPLOYEE inv_emp
   ON inv_emp.EmployeeID = i.InventorierID
LEFT JOIN dbo.EMPLOYEE dism_emp
  ON dism_emp.EmployeeID = i.DismantlerID
WHERE ISNULL(i.QuantityAvailable, 0) > 0
   AND (
        i.InventoryNumber IS NULL
        OR (
          CAST(i.InventoryNumber AS VARCHAR(50)) NOT LIKE '900%'
          AND CAST(i.InventoryNumber AS VARCHAR(50)) NOT LIKE '950%'
          AND CAST(i.InventoryNumber AS VARCHAR(50)) NOT LIKE '999%'
        )
      );
  `;

  const result = await pool.request().query(query);
  return result.recordset;
}

module.exports = {
  getAllInventory
};
