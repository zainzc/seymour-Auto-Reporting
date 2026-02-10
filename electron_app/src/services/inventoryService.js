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
        InterchangeNumber AS RNumber,
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
        InventorierID,
        DismantlerID,
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
    FROM INVENTORY
  `;

  const result = await pool.request().query(query);
  return result.recordset;
}

module.exports = {
  getAllInventory
};
