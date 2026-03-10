const { loadEnv } = require('../config/loadEnv');
const AirtableService = require('../services/airtableService');
const { chunkArray } = require('../utils/chunk');
const ElectronStore = require('electron-store').default;
const path = require('path');

loadEnv();

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeIpn(value) {
  return normalizeText(value).toUpperCase();
}

function parseArgs(argv = []) {
  return {
    dryRun: !argv.includes('--execute'),
    sampleLimit: Number(
      argv.find(arg => arg.startsWith('--sample-limit='))?.split('=')[1] || 50
    ),
    categoryLinkField:
      argv.find(arg => arg.startsWith('--category-link-field='))?.split('=')[1] ||
      process.env.AIRTABLE_CATEGORY_LINK_FIELD ||
      'Category Definitions Link',
    masterTable:
      argv.find(arg => arg.startsWith('--master-table='))?.split('=')[1] ||
      process.env.AIRTABLE_MASTER_TABLE ||
      'Master Parts Table'
  };
}

function loadPhase2ConfigFromStore() {
  try {
    const cwd = path.join(process.env.APPDATA || '', 'electron demo');
    const store = new ElectronStore({
      cwd,
      name: 'config',
      encryptionKey: 'client-secret-key'
    });
    return store.get('inventoryWebhook.phase2Config') || {};
  } catch (error) {
    return {};
  }
}

function hasLinkedCategory(fields = {}, linkFieldName = 'Category Definitions Link') {
  const candidates = [linkFieldName, 'Category Definitions Link', 'Category Definitions', 'Categories']
    .map(normalizeText)
    .filter(Boolean);
  for (const fieldName of candidates) {
    const value = fields?.[fieldName];
    if (Array.isArray(value) && value.length > 0) return true;
  }
  return false;
}

async function deleteRecordsByIds(airtableService, tableName, recordIds = []) {
  let deleted = 0;
  for (const batch of chunkArray(recordIds, 10)) {
    if (batch.length === 0) continue;
    await airtableService.request('DELETE', `/${encodeURIComponent(tableName)}`, {
      params: {
        records: batch
      }
    });
    deleted += batch.length;
  }
  return deleted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stored = loadPhase2ConfigFromStore();
  const token = normalizeText(process.env.AIRTABLE_TOKEN || stored.airtableToken);
  const baseId = normalizeText(process.env.AIRTABLE_BASE_ID || stored.airtableBaseId);
  if (!args.masterTable && stored.airtableMasterTable) {
    args.masterTable = String(stored.airtableMasterTable).trim();
  }
  if (!args.categoryLinkField && stored.categoryLinkFieldName) {
    args.categoryLinkField = String(stored.categoryLinkFieldName).trim();
  }

  if (!token || !baseId) {
    throw new Error('Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID.');
  }

  const airtableService = new AirtableService({
    token,
    baseId,
    masterTable: args.masterTable
  });

  const requestedFields = [
    'IPN',
    args.categoryLinkField,
    'Category Definitions Link',
    'Category Definitions',
    'Categories'
  ]
    .map(normalizeText)
    .filter(Boolean);
  const uniqueRequestedFields = [...new Set(requestedFields)];

  let rows = [];
  try {
    rows = await airtableService.fetchAllRecords(args.masterTable, uniqueRequestedFields);
  } catch (error) {
    const status = error?.response?.status;
    if (status !== 422) throw error;
    // Some bases use different link field names; fallback to full field scan.
    rows = await airtableService.fetchAllRecords(args.masterTable, []);
  }

  const byIpn = new Map();
  for (const record of rows) {
    const ipn = normalizeIpn(record?.fields?.IPN);
    if (!ipn) continue;
    if (!byIpn.has(ipn)) byIpn.set(ipn, []);
    byIpn.get(ipn).push(record);
  }

  const toDelete = [];
  const sample = [];
  let duplicateGroups = 0;
  let groupsWithLinked = 0;
  let groupsAllBlank = 0;
  let groupsAllLinked = 0;

  for (const [ipn, records] of byIpn.entries()) {
    if (records.length <= 1) continue;
    duplicateGroups += 1;

    const linked = records.filter(record =>
      hasLinkedCategory(record?.fields || {}, args.categoryLinkField)
    );
    const blank = records.filter(
      record => !hasLinkedCategory(record?.fields || {}, args.categoryLinkField)
    );

    if (linked.length === records.length && linked.length > 1) {
      groupsAllLinked += 1;
      // All rows are linked for this IPN; keep one, remove the rest.
      linked.slice(1).forEach(record => toDelete.push(record.id));
      if (sample.length < args.sampleLimit) {
        sample.push({
          ipn,
          total: records.length,
          linkedKept: 1,
          blankDeleted: 0,
          linkedDeleted: linked.length - 1
        });
      }
      continue;
    }

    if (linked.length > 0) {
      groupsWithLinked += 1;
      blank.forEach(record => toDelete.push(record.id));
      if (sample.length < args.sampleLimit) {
        sample.push({
          ipn,
          total: records.length,
          linkedKept: linked.length,
          blankDeleted: blank.length,
          linkedDeleted: 0
        });
      }
      continue;
    }

    if (blank.length > 1) {
      groupsAllBlank += 1;
      // Keep one blank row to avoid deleting all instances of an IPN.
      blank.slice(1).forEach(record => toDelete.push(record.id));
      if (sample.length < args.sampleLimit) {
        sample.push({
          ipn,
          total: records.length,
          linkedKept: 0,
          blankDeleted: blank.length - 1,
          linkedDeleted: 0
        });
      }
    }
  }

  const summary = {
    dryRun: args.dryRun,
    masterTable: args.masterTable,
    categoryLinkField: args.categoryLinkField,
    totalRowsScanned: rows.length,
    duplicateIpnGroups: duplicateGroups,
    groupsWithLinked,
    groupsAllBlank,
    groupsAllLinked,
    recordsMarkedForDelete: toDelete.length,
    sample
  };

  console.log('=== Duplicate Master IPN Cleanup Summary ===');
  console.log(JSON.stringify(summary, null, 2));

  if (args.dryRun) {
    console.log('Dry-run mode: no Airtable deletes performed.');
    return;
  }

  if (toDelete.length === 0) {
    console.log('No records to delete.');
    return;
  }

  const deleted = await deleteRecordsByIds(airtableService, args.masterTable, toDelete);
  console.log(`Deleted records: ${deleted}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Duplicate Master IPN cleanup failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
