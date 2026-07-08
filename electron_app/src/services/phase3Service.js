const AirtableService = require('./airtableService');
const path = require('path');
const { readSheetRows } = require('./phase2SheetsService');
const { getInventoryConfig } = require('../config/configStore');
const { buildPowerlinkMapping, getLinkKeyVariants } = require('./phase3PowerlinkMappingService');
const Phase3ShipstationService = require('./phase3ShipstationService');
const { exportShipstationDebugWorkbook } = require('./phase3ShipstationDebugExportService');
const {
  buildSkuToDims,
  buildIpnToDims,
  buildShipstationFieldsForBlankTargets,
  isExcludedIpn,
  normalizeSku
} = require('./phase3PlanningService');

const PARTSHUNTER_STORE_ID = 333796;

function normalizeText(value) {
  return String(value || '').trim();
}

function splitRNumberValues(value = '') {
  return String(value || '')
    .split(/[\n,;|]+/)
    .map(item => normalizeSku(item))
    .filter(Boolean);
}

function shouldReplaceDims(existing, incoming) {
  if (!existing) return true;
  const existingMs = Number(existing?.createDateMs);
  const incomingMs = Number(incoming?.createDateMs);
  if (Number.isFinite(incomingMs) && Number.isFinite(existingMs)) return incomingMs > existingMs;
  if (Number.isFinite(incomingMs) && !Number.isFinite(existingMs)) return true;
  return false;
}

function buildMasterRNumberLookup(masterRecords = [], rNumberFieldName = 'RNumber') {
  const lookup = new Map();
  const duplicates = [];

  for (const record of masterRecords || []) {
    const fields = record?.fields || {};
    const ipn = normalizeText(fields.IPN);
    for (const rNumber of splitRNumberValues(fields[rNumberFieldName])) {
      if (!rNumber) continue;
      for (const key of getLinkKeyVariants(rNumber)) {
        if (lookup.has(key)) {
          const existing = lookup.get(key);
          if (existing?.recordId !== record.id) {
            duplicates.push(`Duplicate RNumber '${key}' on IPNs ${existing?.ipn || 'unknown'} and ${ipn || 'unknown'}.`);
          }
          continue;
        }
        lookup.set(key, {
          recordId: record.id,
          ipn,
          record
        });
      }
    }
  }

  return { lookup, duplicates };
}

function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return defaultValue;
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function buildPhase3Config(options = {}) {
  const phase2Config = getInventoryConfig('phase2Config') || {};
  const phase3Config = getInventoryConfig('phase3Config') || {};
  const merged = {
    ...phase2Config,
    ...phase3Config,
    ...options
  };

  const configuredStoreId = Number(
    merged.shipstationStoreId || process.env.SHIPSTATION_STORE_ID || PARTSHUNTER_STORE_ID
  );

  return {
    sheetId:
      merged.sheetId ||
      process.env.GOOGLE_SHEET_ID ||
      getInventoryConfig('spreadsheetId') ||
      '',
    tabName:
      merged.tabName ||
      process.env.GOOGLE_TAB_NAME ||
      getInventoryConfig('worksheetName') ||
      '',
    airtableToken: merged.airtableToken || process.env.AIRTABLE_TOKEN || '',
    airtableBaseId: merged.airtableBaseId || process.env.AIRTABLE_BASE_ID || '',
    airtableMasterTable:
      merged.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table',
    shipstationApiKey:
      merged.shipstationApiKey || process.env.SHIPSTATION_V1_API_KEY || '',
    shipstationApiSecret:
      merged.shipstationApiSecret || process.env.SHIPSTATION_V1_API_SECRET || '',
    shipstationStoreId: Number.isFinite(configuredStoreId)
      ? configuredStoreId
      : PARTSHUNTER_STORE_ID,
    phase3LookbackDays: toPositiveInt(
      merged.phase3LookbackDays || process.env.PHASE3_LOOKBACK_DAYS,
      90
    ),
    phase3PageSize: toPositiveInt(
      merged.phase3PageSize || process.env.PHASE3_PAGE_SIZE,
      50
    ),
    phase3MaxPages: toPositiveInt(
      merged.phase3MaxPages || process.env.PHASE3_MAX_PAGES,
      300
    ),
    phase3DryRun: parseBoolean(
      typeof merged.phase3DryRun !== 'undefined'
        ? merged.phase3DryRun
        : process.env.PHASE3_DRY_RUN,
      false
    ),
    phase3UsePowerlinkFallback: parseBoolean(
      typeof merged.phase3UsePowerlinkFallback !== 'undefined'
        ? merged.phase3UsePowerlinkFallback
        : process.env.PHASE3_USE_POWERLINK_FALLBACK,
      false
    ),
    authContext: 'inventory'
  };
}

function buildSummary() {
  return {
    shipmentsFetched: 0,
    shipstationPageSize: 0,
    shipstationMaxPages: 0,
    shipstationPagesAvailable: 0,
    skusExtracted: 0,
    skusWithCompleteDims: 0,
    skusMappedToIpn: 0,
    skusMappedByMasterRNumber: 0,
    skusMappedByPowerlink: 0,
    ipnsFoundInAirtable: 0,
    ipnsUpdated: 0,
    ipnsSkippedAlreadyFilled: 0,
    ipnsSkippedExcludedPrefix: 0,
    skusUnmatchedByMasterRNumber: 0,
    skusUnmappedInPowerlink: 0,
    powerlinkFallbackEnabled: false,
    updatedIpnLogs: [],
    errors: []
  };
}

function emitProgress(progressCallback, payload) {
  if (typeof progressCallback === 'function') {
    progressCallback(payload);
  }
}

async function runPhase3(options = {}, progressCallback = () => {}) {
  const config = buildPhase3Config(options);
  const summary = buildSummary();

  if (!config.sheetId || !config.tabName) {
    throw new Error('Phase 3 source sheet config is missing. Set spreadsheet ID and tab name first.');
  }
  if (!config.airtableToken || !config.airtableBaseId) {
    throw new Error('Phase 3 Airtable config missing. Set AIRTABLE_TOKEN and AIRTABLE_BASE_ID.');
  }
  if (!config.shipstationApiKey || !config.shipstationApiSecret) {
    throw new Error(
      'Phase 3 ShipStation v1 credentials are missing. Set SHIPSTATION_V1_API_KEY and SHIPSTATION_V1_API_SECRET.'
    );
  }
  if (Number(config.shipstationStoreId) !== PARTSHUNTER_STORE_ID) {
    throw new Error(
      `Phase 3 is restricted to ShipStation store ${PARTSHUNTER_STORE_ID} (Partshunter203).`
    );
  }

  console.log('Phase3 started', {
    sheetId: config.sheetId,
    tabName: config.tabName,
    storeId: config.shipstationStoreId,
    lookbackDays: config.phase3LookbackDays,
    dryRun: config.phase3DryRun,
    powerlinkFallbackEnabled: config.phase3UsePowerlinkFallback
  });
  summary.powerlinkFallbackEnabled = Boolean(config.phase3UsePowerlinkFallback);

  emitProgress(progressCallback, {
    stage: 'stage1_powerlink_mapping',
    percent: 10,
    counts: summary,
    message: 'Building Powerlink mapping (RNumber -> IPN)...'
  });

  const values = await readSheetRows(config.sheetId, config.tabName, config.authContext);
  const mapping = buildPowerlinkMapping(values);
  for (const warning of mapping.duplicateWarnings.slice(0, 30)) {
    summary.errors.push(`Mapping warning: ${warning}`);
  }
  if (mapping.duplicateWarnings.length > 30) {
    summary.errors.push(
      `Mapping warning: ...and ${mapping.duplicateWarnings.length - 30} additional duplicate RNumber warnings.`
    );
  }

  emitProgress(progressCallback, {
    stage: 'stage2_fetch_shipstation',
    percent: 25,
    counts: summary,
    message: `Fetching ShipStation shipments for store ${PARTSHUNTER_STORE_ID}...`
  });

  const shipstationService = new Phase3ShipstationService({
    apiKey: config.shipstationApiKey,
    apiSecret: config.shipstationApiSecret,
    storeId: config.shipstationStoreId,
    lookbackDays: config.phase3LookbackDays,
    pageSize: config.phase3PageSize,
    maxPages: config.phase3MaxPages
  });
  summary.shipstationPageSize = Number(config.phase3PageSize || 0) || 0;
  summary.shipstationMaxPages = Number(config.phase3MaxPages || 0) || 0;

  const shipstationResult = await shipstationService.fetchShipments(
    { lookbackDays: config.phase3LookbackDays, maxPages: config.phase3MaxPages },
    pageUpdate => {
      summary.shipstationPagesAvailable = Number(pageUpdate?.totalPages || summary.shipstationPagesAvailable || 0) || 0;
      emitProgress(progressCallback, {
        stage: 'stage2_fetch_shipstation',
        percent: 25,
        counts: summary,
        message:
          `ShipStation page ${pageUpdate.page}: +${pageUpdate.fetchedThisPage} shipments ` +
          `(${pageUpdate.shipmentsFetched} total, available pages ${pageUpdate.totalPages || 'unknown'}).`
      });
    }
  );

  summary.shipmentsFetched = shipstationResult.shipments.length;
  summary.shipstationPageSize = Number(shipstationResult.pageSize || config.phase3PageSize || 0) || 0;
  summary.shipstationMaxPages = Number(shipstationResult.maxPages || config.phase3MaxPages || 0) || 0;
  summary.shipstationPagesAvailable = Number(shipstationResult.totalPagesAvailable || summary.shipstationPagesAvailable || 0) || 0;

  const airtableService = new AirtableService({
    token: config.airtableToken,
    baseId: config.airtableBaseId,
    masterTable: config.airtableMasterTable
  });
  const rNumberFieldName = await airtableService.ensureMasterTextField('RNumber');

  emitProgress(progressCallback, {
    stage: 'stage3_translate_sku_to_ipn',
    percent: 50,
    counts: summary,
    message: 'Loading Master Parts RNumber index for direct ShipStation SKU matching...'
  });

  const masterRNumberRecords = await airtableService.fetchAllRecords(config.airtableMasterTable);
  const masterRNumberRecordById = new Map(
    masterRNumberRecords.map(record => [record.id, record])
  );
  const masterRNumberLookup = buildMasterRNumberLookup(masterRNumberRecords, rNumberFieldName);
  for (const warning of masterRNumberLookup.duplicates.slice(0, 30)) {
    summary.errors.push(`RNumber mapping warning: ${warning}`);
  }
  if (masterRNumberLookup.duplicates.length > 30) {
    summary.errors.push(
      `RNumber mapping warning: ...and ${masterRNumberLookup.duplicates.length - 30} additional duplicate RNumber warnings.`
    );
  }
  const directSkuToIpn = new Map(
    Array.from(masterRNumberLookup.lookup.entries()).map(([sku, value]) => [sku, normalizeText(value?.ipn)])
  );

  try {
    emitProgress(progressCallback, {
      stage: 'stage2_fetch_shipstation',
      percent: 55,
      counts: summary,
      message: 'Exporting ShipStation debug workbook with Master RNumber mapping...'
    });
    const debugExport = await exportShipstationDebugWorkbook({
      shipments: shipstationResult.shipments,
      rnumToIpn: config.phase3UsePowerlinkFallback ? mapping.rnumToIpn : new Map(),
      directSkuToIpn,
      outputPath: path.resolve(__dirname, '..', '..', 'dev-output', 'phase3-shipstation-debug.xlsx')
    });
    emitProgress(progressCallback, {
      stage: 'stage2_fetch_shipstation',
      percent: 58,
      counts: summary,
      message: `ShipStation debug workbook saved: ${debugExport.filePath} (${debugExport.rawRows} raw rows, ${debugExport.uniqueSkus} unique SKUs).`
    });
    console.log(
      `Phase3 debug export saved to ${debugExport.filePath} ` +
        `(${debugExport.rawRows} raw rows, ${debugExport.uniqueSkus} unique SKUs).`
    );
  } catch (error) {
    summary.errors.push(`ShipStation debug export failed: ${error.message}`);
  }

  const skuBuild = buildSkuToDims(shipstationResult.shipments);
  summary.skusExtracted = skuBuild.skusExtracted;
  summary.skusWithCompleteDims = skuBuild.skusWithCompleteDims;

  let unmappedLogCount = 0;
  let excludedLogCount = 0;
  const directRecordTargets = new Map();
  const fallbackSkuToDims = new Map();

  for (const [sku, dims] of skuBuild.skuToDims.entries()) {
    const direct = masterRNumberLookup.lookup.get(normalizeSku(sku));
    if (!direct?.recordId) {
      fallbackSkuToDims.set(sku, dims);
      continue;
    }

    summary.skusMappedToIpn += 1;
    summary.skusMappedByMasterRNumber += 1;
    if (isExcludedIpn(direct.ipn)) {
      summary.ipnsSkippedExcludedPrefix += 1;
      if (excludedLogCount < 50) {
        summary.errors.push(`Excluded IPN skipped (${direct.ipn}) from Master RNumber SKU ${sku}`);
      }
      excludedLogCount += 1;
      continue;
    }

    const existing = directRecordTargets.get(direct.recordId);
    if (!existing || shouldReplaceDims(existing.dims, dims)) {
      directRecordTargets.set(direct.recordId, {
        recordId: direct.recordId,
        ipn: direct.ipn,
        dims,
        matchMethod: 'master_rnumber'
      });
    }
  }

  summary.skusUnmatchedByMasterRNumber = fallbackSkuToDims.size;
  let ipnToDims = new Map();
  if (config.phase3UsePowerlinkFallback) {
    const mappedBeforePowerlink = summary.skusMappedToIpn;
    ipnToDims = buildIpnToDims(fallbackSkuToDims, mapping.rnumToIpn, summary, {
      onUnmappedSku: sku => {
        if (unmappedLogCount < 50) {
          summary.errors.push(`Unmapped SKU in Powerlink map: ${sku}`);
        }
        unmappedLogCount += 1;
      },
      onExcludedIpn: (ipn, sku) => {
        if (excludedLogCount < 50) {
          summary.errors.push(`Excluded IPN skipped (${ipn}) from SKU ${sku}`);
        }
        excludedLogCount += 1;
      }
    });
    summary.skusMappedByPowerlink = summary.skusMappedToIpn - mappedBeforePowerlink;
  } else if (fallbackSkuToDims.size > 0) {
    unmappedLogCount = fallbackSkuToDims.size;
    summary.errors.push(
      `Powerlink fallback disabled for test run. ${fallbackSkuToDims.size} SKU(s) did not match Master Parts RNumber.`
    );
  }

  if (config.phase3UsePowerlinkFallback && unmappedLogCount > 50) {
    summary.errors.push(`...and ${unmappedLogCount - 50} additional unmapped SKU entries.`);
  }
  if (excludedLogCount > 50) {
    summary.errors.push(`...and ${excludedLogCount - 50} additional excluded-prefix SKU entries.`);
  }

  emitProgress(progressCallback, {
    stage: 'stage4_update_airtable',
    percent: 70,
    counts: summary,
    message: config.phase3DryRun
      ? 'Planning Airtable updates (dry run)...'
      : 'Updating Airtable Master Parts (blank dims + corrected ShipStation lbs weight)...'
  });

  const totalTargets = directRecordTargets.size + ipnToDims.size;
  let processed = 0;
  const maxUpdatedLogs = 300;

  for (const target of directRecordTargets.values()) {
    processed += 1;
    try {
      summary.ipnsFoundInAirtable += 1;
      const sourceRecord = masterRNumberRecordById.get(target.recordId);
      const fieldsToSet = buildShipstationFieldsForBlankTargets(sourceRecord?.fields || {}, target.dims);
      if (Object.keys(fieldsToSet).length === 0) {
        summary.ipnsSkippedAlreadyFilled += 1;
      } else if (!config.phase3DryRun) {
        await airtableService.updateMasterShipstationFields(target.recordId, fieldsToSet);
        summary.ipnsUpdated += 1;
        if (summary.updatedIpnLogs.length < maxUpdatedLogs) {
          summary.updatedIpnLogs.push({
            ipn: target.ipn,
            mode: 'updated_by_master_rnumber',
            fields: fieldsToSet
          });
        }
      } else {
        summary.ipnsUpdated += 1;
        if (summary.updatedIpnLogs.length < maxUpdatedLogs) {
          summary.updatedIpnLogs.push({
            ipn: target.ipn,
            mode: 'dry_run_would_update_by_master_rnumber',
            fields: fieldsToSet
          });
        }
      }
    } catch (error) {
      const detail =
        typeof AirtableService.getAirtableErrorMessage === 'function'
          ? AirtableService.getAirtableErrorMessage(error)
          : error.message;
      summary.errors.push(`Phase3 direct RNumber update failed for IPN ${target.ipn}: ${detail}`);
    } finally {
      emitProgress(progressCallback, {
        stage: 'stage4_update_airtable',
        percent: 70 + Math.floor((processed / Math.max(totalTargets, 1)) * 28),
        counts: summary,
        message: `Processed ${processed}/${totalTargets} mapped ShipStation targets`
      });
    }
  }

  for (const [ipn, dims] of ipnToDims.entries()) {
    processed += 1;
    try {
      const record = await airtableService.findMasterPartByIPN(ipn);
      if (!record) {
        summary.errors.push(`Master part not found for IPN ${ipn}.`);
      } else {
        summary.ipnsFoundInAirtable += 1;
        const fieldsToSet = buildShipstationFieldsForBlankTargets(record.fields || {}, dims);
        if (Object.keys(fieldsToSet).length === 0) {
          summary.ipnsSkippedAlreadyFilled += 1;
        } else if (!config.phase3DryRun) {
          await airtableService.updateMasterShipstationFields(record.id, fieldsToSet);
          summary.ipnsUpdated += 1;
          if (summary.updatedIpnLogs.length < maxUpdatedLogs) {
            summary.updatedIpnLogs.push({
              ipn,
              mode: 'updated',
              fields: fieldsToSet
            });
          }
        } else {
          summary.ipnsUpdated += 1;
          if (summary.updatedIpnLogs.length < maxUpdatedLogs) {
            summary.updatedIpnLogs.push({
              ipn,
              mode: 'dry_run_would_update',
              fields: fieldsToSet
            });
          }
        }
      }
    } catch (error) {
      const detail =
        typeof AirtableService.getAirtableErrorMessage === 'function'
          ? AirtableService.getAirtableErrorMessage(error)
          : error.message;
      summary.errors.push(`Phase3 update failed for IPN ${ipn}: ${detail}`);
    } finally {
      emitProgress(progressCallback, {
        stage: 'stage4_update_airtable',
        percent: 70 + Math.floor((processed / Math.max(totalTargets, 1)) * 28),
        counts: summary,
        message: `Processed ${processed}/${totalTargets} mapped ShipStation targets`
      });
    }
  }

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: summary,
    message: config.phase3DryRun ? 'Phase 3 dry run completed.' : 'Phase 3 completed.'
  });

  console.log('Phase3 completed', summary);
  return summary;
}

module.exports = {
  runPhase3,
  buildPhase3Config,
  PARTSHUNTER_STORE_ID
};

