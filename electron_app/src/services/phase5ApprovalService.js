const fs = require('fs');
const path = require('path');
const { detectRequiredFieldNames } = require('./phase5GovernanceService');

const DEFAULT_LISTINGS_TABLE = 'eBay Listings (API) (Mock)';

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function parseCsvHeaderLine(line = '') {
  const text = String(line || '');
  if (!text) return [];
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map(value => normalizeText(value.replace(/^\uFEFF/, ''))).filter(Boolean);
}

function readCsvHeadersIfPresent(csvPath = '') {
  const file = normalizeText(csvPath);
  if (!file) return [];
  try {
    if (!fs.existsSync(file)) return [];
    const fd = fs.openSync(file, 'r');
    try {
      const chunkSize = 64 * 1024;
      const buffer = Buffer.alloc(chunkSize);
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, 0);
      if (!bytesRead) return [];
      const text = buffer.toString('utf8', 0, bytesRead);
      const nlIndex = text.search(/\r?\n/);
      const firstLine = nlIndex >= 0 ? text.slice(0, nlIndex) : text;
      return parseCsvHeaderLine(firstLine || '');
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return [];
  }
}

function resolveSchemaCsvPath(explicitPath = '') {
  const direct = normalizeText(explicitPath);
  if (direct) return direct;
  const candidates = [
    path.resolve(process.cwd(), 'eBay Listings (API)-Grid view(Updated).csv'),
    path.resolve(process.cwd(), '..', 'eBay Listings (API)-Grid view(Updated).csv'),
    path.resolve(process.cwd(), 'Ebay Listing Example.csv'),
    path.resolve(process.cwd(), '..', 'Ebay Listing Example.csv')
  ];
  const maxImplicitBytes = 10 * 1024 * 1024;
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      if (Number(stat?.size || 0) > maxImplicitBytes) continue;
      return file;
    } catch (_) {}
  }
  return '';
}

function buildFieldLookup(fieldNames = []) {
  const map = new Map();
  for (const name of fieldNames) {
    const key = normalizeKey(name);
    if (!key || map.has(key)) continue;
    map.set(key, name);
  }
  return map;
}

function findFieldByAliases(fieldLookup, aliases = []) {
  for (const alias of aliases) {
    const key = normalizeKey(alias);
    if (fieldLookup.has(key)) return fieldLookup.get(key);
  }
  return '';
}

function rankApprovalField(name = '') {
  const key = normalizeKey(name);
  if (!key) return -1;
  let score = 0;
  if (key === 'approval status') score += 120;
  if (key === 'approved') score += 110;
  if (key.includes('approval')) score += 80;
  if (key.includes('approved')) score += 70;
  if (key.includes('publish')) score += 40;
  if (key.includes('status')) score += 15;
  if (key.includes('ready')) score += 10;
  return score;
}

function detectApprovalField(fieldNames = [], explicitFieldName = '') {
  const explicit = normalizeText(explicitFieldName);
  if (explicit) {
    const exact = fieldNames.find(name => normalizeKey(name) === normalizeKey(explicit));
    if (exact) return exact;
  }
  let best = '';
  let bestScore = -1;
  for (const fieldName of fieldNames) {
    const score = rankApprovalField(fieldName);
    if (score > bestScore) {
      bestScore = score;
      best = fieldName;
    }
  }
  return bestScore > 0 ? best : '';
}

function getApprovalLikeFieldHints(fieldNames = []) {
  return (Array.isArray(fieldNames) ? fieldNames : [])
    .filter(name => {
      const key = normalizeKey(name);
      return key.includes('approval') || key.includes('approved') || key.includes('publish') || key.includes('status');
    })
    .slice(0, 20);
}

function detectGroupField(fieldNames = [], explicitFieldName = '') {
  const explicit = normalizeText(explicitFieldName);
  if (explicit) {
    const exact = fieldNames.find(name => normalizeKey(name) === normalizeKey(explicit));
    if (exact) return exact;
  }
  for (const fieldName of fieldNames) {
    const key = normalizeKey(fieldName);
    if (!key) continue;
    if (key.includes('batch') || key.includes('group')) {
      return fieldName;
    }
  }
  return '';
}

function detectEligibilityField(fieldNames = [], explicitFieldName = '') {
  const explicit = normalizeText(explicitFieldName);
  if (explicit) {
    const exact = fieldNames.find(name => normalizeKey(name) === normalizeKey(explicit));
    if (exact) return exact;
  }
  const aliases = [
    'Publish Eligibility',
    'Auto Push Eligibility',
    'Auto Push Eligible',
    'Publish Eligible',
    'Eligibility Status',
    'Auto Push Status'
  ];
  const lookup = buildFieldLookup(fieldNames);
  const byAlias = findFieldByAliases(lookup, aliases);
  if (byAlias) return byAlias;

  for (const fieldName of fieldNames) {
    const key = normalizeKey(fieldName);
    if (!key) continue;
    if (
      (key.includes('eligib') && (key.includes('publish') || key.includes('push'))) ||
      (key.includes('auto') && key.includes('push') && key.includes('status'))
    ) {
      return fieldName;
    }
  }
  return '';
}

function isApprovedValue(value) {
  if (Array.isArray(value)) {
    return value.some(item => isApprovedValue(item));
  }
  if (value && typeof value === 'object') {
    const candidate = normalizeText(value.name || value.label || value.value || '');
    if (candidate) return isApprovedValue(candidate);
  }
  if (typeof value === 'boolean') return value === true;
  if (typeof value === 'number') return value === 1;
  const text = normalizeKey(value);
  if (!text) return false;
  if (['true', 'yes', 'y', 'approved', 'approve', 'ready', 'ready to publish', 'publish', 'published'].includes(text)) {
    return true;
  }
  if (text.includes('approved')) return true;
  if (text.includes('ready') && text.includes('publish')) return true;
  return false;
}

function normalizeComparableValue(value) {
  if (Array.isArray(value)) {
    return value.map(item => normalizeComparableValue(item)).filter(Boolean).join(',');
  }
  if (value && typeof value === 'object') {
    return normalizeText(value.name || value.label || value.value || '');
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return normalizeText(value);
}

function isEligibilityMatch(value, allowedValues = []) {
  const allowed = (Array.isArray(allowedValues) ? allowedValues : [])
    .map(v => normalizeKey(v))
    .filter(Boolean);
  if (allowed.length === 0) return false;

  if (Array.isArray(value)) {
    return value.some(item => isEligibilityMatch(item, allowedValues));
  }
  if (value && typeof value === 'object') {
    return isEligibilityMatch(normalizeComparableValue(value), allowedValues);
  }
  const key = normalizeKey(normalizeComparableValue(value));
  return key ? allowed.includes(key) : false;
}

function normalizeIpn(value) {
  return normalizeText(value).toUpperCase();
}

function buildPublishedIdentity(fields = {}, fieldHints = {}) {
  const ipnField = normalizeText(fieldHints.ipnField || '');
  const itemIdField = normalizeText(fieldHints.itemIdField || '');
  const recordKeyField = normalizeText(fieldHints.recordKeyField || '');
  const ipn = normalizeIpn(ipnField ? fields[ipnField] : '');
  const itemId = normalizeText(itemIdField ? fields[itemIdField] : '');
  const recordKey = normalizeText(recordKeyField ? fields[recordKeyField] : '');
  if (itemId) return `ITEM:${itemId}`;
  if (ipn) return `IPN:${ipn}`;
  if (recordKey) return `RK:${recordKey}`;
  return '';
}

class Phase5ApprovalService {
  constructor(config = {}) {
    this.listingsTableName = normalizeText(config.listingsTableName || DEFAULT_LISTINGS_TABLE);
    this.approvalFieldName = normalizeText(config.approvalFieldName || '');
    this.groupFieldName = normalizeText(config.groupFieldName || '');
    this.groupValue = normalizeText(config.groupValue || '');
    this.autoPushEligibilityFieldName = normalizeText(config.autoPushEligibilityFieldName || '');
    this.autoPushEligibilityValues = Array.isArray(config.autoPushEligibilityValues)
      ? config.autoPushEligibilityValues.map(v => normalizeText(v)).filter(Boolean)
      : String(config.autoPushEligibilityValues || '')
          .split(',')
          .map(v => normalizeText(v))
          .filter(Boolean);
    this.schemaCsvPath = resolveSchemaCsvPath(config.schemaCsvPath || '');
    this.batchTableName = normalizeText(config.batchTableName || process.env.PHASE5_BATCHES_TABLE || 'Listing Batches');
    this.batchStatusFieldName = normalizeText(config.batchStatusFieldName || process.env.PHASE5_BATCH_STATUS_FIELD || 'Batch Status');
    this.batchApprovedValue = normalizeText(config.batchApprovedValue || process.env.PHASE5_BATCH_APPROVED_VALUE || 'Approved') || 'Approved';
    this.requiredCategoryIdFieldName = normalizeText(
      config.requiredCategoryIdFieldName || process.env.PHASE5_REQUIRED_CATEGORY_ID_FIELD || ''
    );
    this.requiredTitleFieldName = normalizeText(config.requiredTitleFieldName || process.env.PHASE5_REQUIRED_TITLE_FIELD || '');
    this.requiredDescriptionFieldName = normalizeText(
      config.requiredDescriptionFieldName || process.env.PHASE5_REQUIRED_DESCRIPTION_FIELD || ''
    );
    this.requiredItemSpecificsFieldName = normalizeText(
      config.requiredItemSpecificsFieldName || process.env.PHASE5_REQUIRED_ITEM_SPECIFICS_FIELD || ''
    );
    this.blockedFieldName = normalizeText(config.blockedFieldName || process.env.PHASE5_BLOCKED_FIELD || '');
    this.exceptionFieldName = normalizeText(config.exceptionFieldName || process.env.PHASE5_EXCEPTION_FIELD || '');
    this.publishStatusFieldName = normalizeText(config.publishStatusFieldName || process.env.PHASE5_PUBLISH_STATUS_FIELD || '');
    this.payloadHashFieldName = normalizeText(config.payloadHashFieldName || process.env.PHASE5_PAYLOAD_HASH_FIELD || '');
    this.publishedAtFieldName = normalizeText(config.publishedAtFieldName || process.env.PHASE5_PUBLISHED_AT_FIELD || '');
    this.publishRunIdFieldName = normalizeText(config.publishRunIdFieldName || process.env.PHASE5_PUBLISH_RUN_ID_FIELD || '');
  }

  async resolveTableSchema(schemaService, options = {}) {
    const requireApprovalField = options?.requireApprovalField !== false;
    const requireEligibilityField = options?.requireEligibilityField === true;
    const tables = await schemaService.listTables();
    const table = (tables || []).find(
      row => normalizeKey(row?.name) === normalizeKey(this.listingsTableName)
    );
    if (!table?.id) {
      throw new Error(`Phase 5 listing table not found: '${this.listingsTableName}'.`);
    }
    const schemaFieldNames = (table.fields || []).map(field => normalizeText(field?.name)).filter(Boolean);
    const csvFieldNames = readCsvHeadersIfPresent(this.schemaCsvPath);
    const merged = Array.from(new Set([...schemaFieldNames, ...csvFieldNames]));
    const lookup = buildFieldLookup(merged);

    const ipnField = findFieldByAliases(lookup, [
      'c: partshunter203 ebay MOTORS interchange part number',
      'C: partshunter203 ebay MOTORS interchange part number',
      'IPN',
      'Inventory Number',
      'InventoryNumber',
      'IP'
    ]);
    const itemIdField = findFieldByAliases(lookup, [
      'Item ID',
      'ItemID',
      'eBay Item ID',
      'Ebay Item ID',
      'Listing ID',
      'ListingID'
    ]);
    const recordKeyField = findFieldByAliases(lookup, ['Record Key']);
    const approvalField = detectApprovalField(merged, this.approvalFieldName);
    const groupField = detectGroupField(merged, this.groupFieldName);
    const eligibilityField = detectEligibilityField(merged, this.autoPushEligibilityFieldName);
    const governanceFields = detectRequiredFieldNames(merged, {
      categoryIdFieldName: this.requiredCategoryIdFieldName,
      titleFieldName: this.requiredTitleFieldName,
      descriptionFieldName: this.requiredDescriptionFieldName,
      itemSpecificsFieldName: this.requiredItemSpecificsFieldName,
      itemIdFieldName: itemIdField,
      batchLinkFieldName: this.groupFieldName,
      blockedFieldName: this.blockedFieldName,
      exceptionFieldName: this.exceptionFieldName,
      publishStatusFieldName: this.publishStatusFieldName,
      payloadHashFieldName: this.payloadHashFieldName,
      publishedAtFieldName: this.publishedAtFieldName,
      publishRunIdFieldName: this.publishRunIdFieldName
    });
    if (this.groupValue && !groupField) {
      throw new Error(
        `Phase 5 group value was provided ('${this.groupValue}') but no group field could be resolved in '${this.listingsTableName}'. Set phase5GroupFieldName explicitly or clear group value.`
      );
    }

    if (requireApprovalField && !approvalField) {
      const hints = getApprovalLikeFieldHints(merged);
      const hintText = hints.length > 0 ? ` Candidate fields: ${hints.join(', ')}` : '';
      throw new Error(
        `Phase 5 approval field not found in '${this.listingsTableName}'. Add an explicit approval column (recommended: 'Approval Status' with value 'Approved') or set phase5ApprovalFieldName to an existing field.${hintText}`
      );
    }
    if (requireEligibilityField) {
      if (!eligibilityField) {
        throw new Error(
          `Phase 5 Option B requires an eligibility field in '${this.listingsTableName}'. Set phase5AutoPushEligibilityFieldName to an existing queue column.`
        );
      }
      if (!Array.isArray(this.autoPushEligibilityValues) || this.autoPushEligibilityValues.length === 0) {
        throw new Error(
          'Phase 5 Option B requires at least one eligibility value. Set phase5AutoPushEligibilityValues (comma-separated).'
        );
      }
    }

    return {
      tableId: normalizeText(table.id),
      tableName: normalizeText(table.name || this.listingsTableName),
      fieldNames: merged,
      approvalField,
      groupField: groupField || '',
      eligibilityField: eligibilityField || '',
      eligibilityValues: Array.isArray(this.autoPushEligibilityValues) ? this.autoPushEligibilityValues : [],
      ipnField: ipnField || '',
      itemIdField: itemIdField || '',
      recordKeyField: recordKeyField || '',
      schemaCsvPath: this.schemaCsvPath || '',
      batchTableName: this.batchTableName,
      batchStatusFieldName: this.batchStatusFieldName,
      batchApprovedValue: this.batchApprovedValue,
      categoryIdField: governanceFields.categoryIdField || '',
      titleField: governanceFields.titleField || '',
      descriptionField: governanceFields.descriptionField || '',
      itemSpecificsField: governanceFields.itemSpecificsField || '',
      batchLinkField: governanceFields.batchLinkField || '',
      blockedField: governanceFields.blockedField || '',
      exceptionField: governanceFields.exceptionField || '',
      publishStatusField: governanceFields.publishStatusField || '',
      payloadHashField: governanceFields.payloadHashField || '',
      publishedAtField: governanceFields.publishedAtField || '',
      publishRunIdField: governanceFields.publishRunIdField || ''
    };
  }

  async getQueueRecords(airtableService, tableNameOrId) {
    return airtableService.fetchAllRecords(tableNameOrId, []);
  }

  filterApprovedRecords(rows = [], schema = {}) {
    const approved = [];
    let skippedNotApproved = 0;
    const sampleSkips = [];
    const approvalField = normalizeText(schema.approvalField);
    const groupField = normalizeText(schema.groupField);
    const requestedGroup = normalizeText(this.groupValue);

    for (const row of Array.isArray(rows) ? rows : []) {
      const fields = row?.fields || {};
      if (requestedGroup && groupField) {
        const groupValue = normalizeText(fields[groupField]);
        if (groupValue !== requestedGroup) {
          skippedNotApproved += 1;
          continue;
        }
      }
      const approvedValue = fields[approvalField];
      if (!isApprovedValue(approvedValue)) {
        skippedNotApproved += 1;
        if (sampleSkips.length < 20) {
          sampleSkips.push(
            `skip=not_approved record='${normalizeText(row?.id)}' field='${approvalField}' value='${normalizeText(approvedValue)}'`
          );
        }
        continue;
      }
      approved.push(row);
    }

    return {
      approved,
      skippedNotApproved,
      sampleSkips
    };
  }

  filterQueueRecords(rows = [], schema = {}) {
    const queue = [];
    let skippedNotApproved = 0;
    const sampleSkips = [];
    const groupField = normalizeText(schema.groupField);
    const requestedGroup = normalizeText(this.groupValue);

    for (const row of Array.isArray(rows) ? rows : []) {
      const fields = row?.fields || {};
      if (requestedGroup && groupField) {
        const groupValue = normalizeText(fields[groupField]);
        if (groupValue !== requestedGroup) {
          skippedNotApproved += 1;
          continue;
        }
      }
      queue.push(row);
    }

    return {
      approved: queue,
      skippedNotApproved,
      sampleSkips
    };
  }

  filterAutoPushEligibleRecords(rows = [], schema = {}) {
    const eligible = [];
    let skippedNotApproved = 0;
    const sampleSkips = [];
    const groupField = normalizeText(schema.groupField);
    const requestedGroup = normalizeText(this.groupValue);
    const eligibilityField = normalizeText(schema.eligibilityField);
    const allowedValues = Array.isArray(schema.eligibilityValues) ? schema.eligibilityValues : [];

    for (const row of Array.isArray(rows) ? rows : []) {
      const fields = row?.fields || {};
      if (requestedGroup && groupField) {
        const groupValue = normalizeText(fields[groupField]);
        if (groupValue !== requestedGroup) {
          skippedNotApproved += 1;
          continue;
        }
      }

      if (!isEligibilityMatch(fields[eligibilityField], allowedValues)) {
        skippedNotApproved += 1;
        if (sampleSkips.length < 20) {
          sampleSkips.push(
            `skip=not_eligible record='${normalizeText(row?.id)}' field='${eligibilityField}' value='${normalizeComparableValue(
              fields[eligibilityField]
            )}' allowed='${allowedValues.join(',')}'`
          );
        }
        continue;
      }
      eligible.push(row);
    }

    return {
      approved: eligible,
      skippedNotApproved,
      sampleSkips
    };
  }

  buildRecordIdentity(record = {}, schema = {}) {
    return buildPublishedIdentity(record?.fields || {}, schema);
  }
}

module.exports = {
  Phase5ApprovalService,
  DEFAULT_LISTINGS_TABLE,
  normalizeText,
  buildPublishedIdentity
};
