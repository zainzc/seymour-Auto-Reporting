# Phase 3 Documentation
ShipStation v1 (store 333796 only) -> Airtable Master Parts ShipStation dimensions and weight.

## Scope
Phase 3 enriches existing Airtable Master Parts rows with ShipStation-derived shipping measurements using:

1. `ShipStation SKU (R Number)`
2. `Powerlink Current Inventory (RNumber -> InventoryNumber/IPN)`
3. `Airtable Master Parts (IPN)`

Only these Airtable fields are written:
- `Length (ShipStation)`
- `Width (ShipStation)`
- `Height (ShipStation)`
- `Weight (ShipStation)` (lbs, converted from oz)

Write policy:
- Fill blanks only.
- Never overwrite existing values.
- Manual Airtable edits are preserved.

## Hard Constraints Implemented
1. Store scope fixed to Partshunter203 (`storeId=333796`).
2. Excluded IPN prefixes (`900`, `950`, `999`) are skipped.
3. Weight conversion is `lbs = oz / 16` (rounded to 2 decimals).
4. No schema changes in Airtable.

## Services
- `electron_app/src/services/phase3Service.js`
- `electron_app/src/services/phase3ShipstationService.js`
- `electron_app/src/services/phase3PowerlinkMappingService.js`
- `electron_app/src/services/phase3PlanningService.js`

Supporting additions:
- `electron_app/src/services/airtableService.js`
  - `findMasterPartByIPN(ipn)`
  - `updateMasterShipstationFields(recordId, fieldsToSet)`

## IPC + UI Wiring
Main process handlers:
- `phase3:get-config`
- `phase3:run`
- progress event: `phase3:progress`

Renderer bridge:
- `window.phase3API.getConfig()`
- `window.phase3API.run(options)`
- `window.phase3API.onProgress(callback)`

Milestone 1 page updates:
- New config fields for ShipStation credentials and Phase 3 options.
- New `Run Phase 3` button.
- Phase 3 summary counters in status section.

## Config Keys
Supported env/config keys:
- `SHIPSTATION_V1_API_KEY`
- `SHIPSTATION_V1_API_SECRET`
- `SHIPSTATION_STORE_ID` (must remain 333796)
- `PHASE3_LOOKBACK_DAYS` (default 90)
- `PHASE3_DRY_RUN` (default false)

Values are persisted in existing inventory config flow via `phase2-save-config` payload.

## Summary Object
Phase 3 returns:
- `shipmentsFetched`
- `skusExtracted`
- `skusWithCompleteDims`
- `skusMappedToIpn`
- `ipnsFoundInAirtable`
- `ipnsUpdated`
- `ipnsSkippedAlreadyFilled`
- `ipnsSkippedExcludedPrefix`
- `skusUnmappedInPowerlink`
- `errors[]`

## Manual Acceptance Tests
1. Pick a ShipStation shipment item SKU from store `333796` that includes weight and all dimensions.
2. Confirm that SKU exists as `RNumber` in Powerlink source sheet and maps to an `InventoryNumber` (IPN).
3. Run Phase 3 from the Milestone 1 page.
4. Confirm Airtable Master Parts row (by IPN) now has:
   - `Length (ShipStation)`
   - `Width (ShipStation)`
   - `Height (ShipStation)`
   - `Weight (ShipStation)` in pounds (`oz/16`)
5. Re-run Phase 3 and confirm those values are not overwritten.
6. Manually edit those fields in Airtable and re-run Phase 3; confirm manual values are not overwritten.
