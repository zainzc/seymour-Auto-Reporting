const AirtableService = require('./airtableService');
const ClickUpService = require('./clickupService');
const { getInventoryConfig, saveInventoryConfig } = require('../config/configStore');

const COMMENT_CACHE_KEY = 'phase2WritebackCommentCache';

function isExcludedIpn(ipn) {
  const normalized = String(ipn || '').trim().toUpperCase();
  return normalized.startsWith('900') || normalized.startsWith('950') || normalized.startsWith('999');
}

function parseIpnPrefix(ipn) {
  const firstToken = String(ipn || '').trim().split('-')[0];
  const parsed = parseInt(firstToken, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildSummary() {
  return {
    tasksProcessed: 0,
    tasksCompleted: 0,
    tasksErrored: 0,
    airtableUpdates: 0,
    skippedExcluded: 0,
    skippedAlreadyResolved: 0,
    writebacksCompleted: 0,
    writebacksFailed: 0
  };
}

class Phase2WritebackService {
  constructor(config = {}) {
    this.config = {
      clickupResolvedCategoryFieldName:
        config.clickupResolvedCategoryFieldName || 'Category Identifier Selection',
      clickupStatusDetermined: config.clickupStatusDetermined || 'Category Determined',
      clickupStatusCompleted: config.clickupStatusCompleted || 'Completed',
      clickupStatusNeedsReview: config.clickupStatusNeedsReview || 'Needs Review',
      categoryLinkFieldName: config.categoryLinkFieldName || 'Category Definitions Link',
      ...config
    };

    this.commentCache = getInventoryConfig(COMMENT_CACHE_KEY) || {};
    this.commentCacheDirty = false;

    this.clickupService = new ClickUpService({
      token: this.config.clickupToken,
      listId: this.config.clickupListId
    });

    this.airtableService = new AirtableService({
      token: this.config.airtableToken,
      baseId: this.config.airtableBaseId,
      masterTable: this.config.airtableMasterTable || 'Master Parts Table',
      categoryTable: this.config.airtableCategoryTable || 'Category Definitions'
    });
    this.masterFieldNames = new Set();
    this.categoryLinkFieldName = this.config.categoryLinkFieldName;
  }

  ensureRequiredConfig() {
    const required = [
      ['clickupToken', 'ClickUp token'],
      ['clickupListId', 'ClickUp list ID'],
      ['airtableToken', 'Airtable token'],
      ['airtableBaseId', 'Airtable base ID']
    ];

    for (const [key, label] of required) {
      if (!String(this.config[key] || '').trim()) {
        throw new Error(`Write-back config missing: ${label}.`);
      }
    }
  }

  makeCommentCacheKey(taskId, reasonCode) {
    return `${String(taskId || '').trim()}::${String(reasonCode || '').trim()}`;
  }

  async addCommentOnce(taskId, reasonCode, message) {
    const key = this.makeCommentCacheKey(taskId, reasonCode);
    if (this.commentCache[key]) {
      return false;
    }

    await this.clickupService.addTaskComment(taskId, message);
    this.commentCache[key] = {
      at: new Date().toISOString(),
      reasonCode
    };
    this.commentCacheDirty = true;
    return true;
  }

  hasCategories(fields = {}) {
    const candidates = [
      this.categoryLinkFieldName,
      this.config.categoryLinkFieldName,
      'Category Definitions Link',
      'Category Definitions',
      'Categories'
    ]
      .map(value => String(value || '').trim())
      .filter(Boolean);
    for (const fieldName of candidates) {
      const value = fields[fieldName];
      if (Array.isArray(value) && value.length > 0) return true;
    }
    return false;
  }

  static normalizeText(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  parseResolvedSelection(rawValue, fallbackPrefix) {
    const raw = String(rawValue || '').trim();
    if (!raw) {
      return {
        raw,
        prefix: Number.isFinite(fallbackPrefix) ? fallbackPrefix : null,
        categoryName: '',
        conditionText: ''
      };
    }

    // Supported styles:
    // 1) Front Lamp
    // 2) Front Lamp(Fog)
    // 3) 116 - Front Lamp(Fog) / 116 – Front Lamp (Fog)
    let text = raw;
    let parsedPrefix = Number.isFinite(fallbackPrefix) ? fallbackPrefix : null;

    const prefixMatch = text.match(/^(\d{2,4})\s*[-–]\s*(.+)$/);
    if (prefixMatch) {
      const maybePrefix = parseInt(prefixMatch[1], 10);
      if (Number.isFinite(maybePrefix)) {
        parsedPrefix = maybePrefix;
      }
      text = String(prefixMatch[2] || '').trim();
    }

    let categoryName = text;
    let conditionText = '';
    const parenMatch = text.match(/^(.+?)\s*\((.+)\)\s*$/);
    if (parenMatch) {
      categoryName = String(parenMatch[1] || '').trim();
      conditionText = String(parenMatch[2] || '').trim();
    }

    return {
      raw,
      prefix: parsedPrefix,
      categoryName,
      conditionText
    };
  }

  filterMatchesByCondition(matches, conditionText) {
    const wanted = Phase2WritebackService.normalizeText(conditionText);
    if (!wanted) return matches;

    const narrowed = matches.filter(record => {
      const value = Phase2WritebackService.normalizeText(record?.fields?.['Conditions & Options']);
      if (!value) return false;
      return value.includes(wanted) || wanted.includes(value);
    });

    return narrowed.length > 0 ? narrowed : matches;
  }

  async moveTaskToCompleted(taskId) {
    const list = await this.clickupService.getList();
    const statuses = Array.isArray(list?.statuses) ? list.statuses : [];

    const closedStatuses = statuses
      .map(status => ({
        name: String(status?.status || '').trim(),
        type: String(status?.type || '').trim().toLowerCase()
      }))
      .filter(item => item.name)
      .filter(item => {
        if (item.type === 'closed') return true;
        const label = item.name.toLowerCase();
        return label.includes('complete') || label.includes('closed') || label.includes('done');
      });

    if (closedStatuses.length === 0) {
      throw new Error('No closed status found in the ClickUp list.');
    }

    await this.clickupService.updateTaskStatus(taskId, closedStatuses[0].name);
  }

  async moveTaskToNeedsReview(taskId) {
    const list = await this.clickupService.getList();
    const statuses = Array.isArray(list?.statuses) ? list.statuses : [];
    const candidates = statuses
      .map(status => String(status?.status || '').trim())
      .filter(Boolean)
      .filter(name => {
        const lower = name.toLowerCase();
        return lower.includes('review') || lower.includes('blocked');
      });

    const preferred = String(this.config.clickupStatusNeedsReview || '').trim();
    const byName = statuses
      .map(status => String(status?.status || '').trim())
      .find(name => name.toLowerCase() === preferred.toLowerCase());
    const target = byName || candidates[0] || '';
    if (!target) return;
    await this.clickupService.updateTaskStatus(taskId, target);
  }

  buildTrackingFields({ selectedIdentifier, status, taskId }) {
    const fields = {};
    if (this.masterFieldNames.has('Category Resolution Status') && status) {
      fields['Category Resolution Status'] = status;
    }
    if (this.masterFieldNames.has('Resolved Category Identifier') && selectedIdentifier) {
      fields['Resolved Category Identifier'] = selectedIdentifier;
    }
    if (this.masterFieldNames.has('ClickUp Task ID') && taskId) {
      fields['ClickUp Task ID'] = taskId;
    }
    return fields;
  }

  async processTask(task, resolvedField, summary) {
    summary.tasksProcessed += 1;
    const taskId = String(task?.id || '').trim();
    const ipn =
      ClickUpService.extractIpnFromTask(task) || ClickUpService.extractCustomFieldText(task, 'IPN');

    if (!ipn) {
      summary.tasksErrored += 1;
      await this.addCommentOnce(
        taskId,
        'missing_ipn',
        'Write-back blocked: missing IPN in task title/description.'
      );
      return;
    }

    if (isExcludedIpn(ipn)) {
      summary.skippedExcluded += 1;
      await this.addCommentOnce(
        taskId,
        'excluded_ipn',
        `Write-back skipped: excluded IPN (${ipn}) with prefix 900/950/999.`
      );
      await this.moveTaskToCompleted(taskId);
      summary.tasksCompleted += 1;
      return;
    }

    let selectedIdentifier =
      ClickUpService.getTaskCustomFieldDisplayValue(task, resolvedField) ||
      ClickUpService.extractCustomFieldText(task, this.config.clickupResolvedCategoryFieldName);
    if (!selectedIdentifier) {
      try {
        const detailedTask = await this.clickupService.getTask(taskId);
        selectedIdentifier =
          ClickUpService.getTaskCustomFieldDisplayValue(detailedTask, resolvedField) ||
          ClickUpService.extractCustomFieldText(
            detailedTask,
            this.config.clickupResolvedCategoryFieldName
          );
      } catch (detailError) {
        // keep original path; missing detail fetch should not crash whole run
      }
    }
    if (!selectedIdentifier) {
      summary.tasksErrored += 1;
      summary.writebacksFailed += 1;
      await this.addCommentOnce(
        taskId,
        'missing_resolved_category',
        `Write-back blocked: select '${this.config.clickupResolvedCategoryFieldName}' before completion.`
      );
      return;
    }

    const masterRecord = await this.airtableService.fetchMasterPartByIpn(ipn);
    if (!masterRecord) {
      summary.tasksErrored += 1;
      await this.addCommentOnce(
        taskId,
        `missing_master_${ipn}`,
        `Write-back blocked: Master Parts record not found for IPN ${ipn}.`
      );
      return;
    }

    if (this.hasCategories(masterRecord.fields || {})) {
      summary.skippedAlreadyResolved += 1;
      await this.addCommentOnce(
        taskId,
        `already_resolved_${ipn}`,
        `Master Parts already has category for IPN ${ipn}; no overwrite performed.`
      );
      await this.moveTaskToCompleted(taskId);
      summary.tasksCompleted += 1;
      return;
    }

    const ipnPrefix = parseIpnPrefix(ipn);
    if (!Number.isFinite(ipnPrefix)) {
      summary.tasksErrored += 1;
      await this.addCommentOnce(
        taskId,
        `invalid_prefix_${ipn}`,
        `Write-back blocked: could not parse numeric IPN prefix for ${ipn}.`
      );
      return;
    }

    const selected = String(selectedIdentifier || '').trim();
    const matches = await this.airtableService.fetchCategoryRecordsByPrefixAndIdentifier(
      ipnPrefix,
      selected
    );

    if (matches.length !== 1) {
      summary.tasksErrored += 1;
      summary.writebacksFailed += 1;
      const reason =
        matches.length === 0
          ? `no category definition row for prefix ${ipnPrefix} and identifier '${selected}'`
          : `multiple category definition rows for prefix ${ipnPrefix} and identifier '${selected}'`;
      await this.addCommentOnce(
        taskId,
        `category_mapping_${ipn}_${selected.toLowerCase()}`,
        `Write-back blocked: ${reason}.`
      );
      await this.moveTaskToNeedsReview(taskId);
      return;
    }

    const categoryRecord = matches[0];
    const resolvedEbayCategoryId = String(
      categoryRecord?.fields?.['eBay Category ID'] || ''
    ).trim();
    await this.airtableService.setMasterPartCategory(masterRecord.id, categoryRecord.id, {
      linkFieldName: this.categoryLinkFieldName
    });
    const trackingFields = this.buildTrackingFields({
      selectedIdentifier: selected,
      status: 'Resolved',
      taskId
    });
    if (Object.keys(trackingFields).length > 0) {
      try {
        await this.airtableService.updateMasterPartFields(masterRecord.id, trackingFields);
      } catch (trackingError) {
        // Tracking fields are optional. Do not fail write-back if unavailable/mismatched.
      }
    }
    summary.airtableUpdates += 1;
    summary.writebacksCompleted += 1;

    await this.addCommentOnce(
      taskId,
      `writeback_success_${ipn}_${categoryRecord.id}`,
      `Category write-back succeeded. MasterRecord=${masterRecord.id}, CategoryRecord=${categoryRecord.id}, Identifier='${selected}', eBayCategoryID='${resolvedEbayCategoryId || 'n/a'}'.`
    );
    await this.moveTaskToCompleted(taskId);
    summary.tasksCompleted += 1;
  }

  async runOnce() {
    this.ensureRequiredConfig();
    const summary = buildSummary();
    this.masterFieldNames = await this.airtableService.getMasterFieldNames();
    this.categoryLinkFieldName = await this.airtableService.ensureMasterCategoryLinkField(
      this.config.categoryLinkFieldName
    );

    const tasks = await this.clickupService.fetchTasksByStatuses(
      [this.config.clickupStatusDetermined],
      {
        includeClosed: true,
        subtasks: false
      }
    );
    if (tasks.length === 0) {
      return summary;
    }

    const fieldNameCandidates = [
      this.config.clickupResolvedCategoryFieldName,
      'Category Identifier Selection',
      'Resolved Category'
    ]
      .map(name => String(name || '').trim())
      .filter(Boolean);
    const uniqueCandidateNames = [...new Set(fieldNameCandidates)];

    let resolvedField = null;
    for (const fieldName of uniqueCandidateNames) {
      resolvedField = await this.clickupService.getCustomFieldByName(fieldName);
      if (resolvedField) {
        this.config.clickupResolvedCategoryFieldName = fieldName;
        break;
      }
    }

    if (!resolvedField) {
      const normalizedCandidates = uniqueCandidateNames.map(name => name.toLowerCase());
      for (const task of tasks) {
        const customFields = Array.isArray(task?.custom_fields) ? task.custom_fields : [];
        const match = customFields.find(field =>
          normalizedCandidates.includes(String(field?.name || '').trim().toLowerCase())
        );
        if (match) {
          resolvedField = {
            id: match.id,
            name: match.name,
            type: match.type,
            type_config: match.type_config || {}
          };
          this.config.clickupResolvedCategoryFieldName = String(match.name || '').trim();
          break;
        }
      }
    }

    if (!resolvedField) {
      throw new Error(
        `ClickUp custom field not found. Tried: ${uniqueCandidateNames.join(', ')}. Verify list ID and field name.`
      );
    }

    for (const task of tasks) {
      try {
        await this.processTask(task, resolvedField, summary);
      } catch (error) {
        summary.tasksErrored += 1;
        const taskId = String(task?.id || '').trim();
        if (taskId) {
          const code = `processing_error_${taskId}`;
          const message = `Write-back failed: ${error.message}`;
          try {
            await this.addCommentOnce(taskId, code, message);
          } catch (commentError) {
            // no-op: avoid failing the whole run due to comment errors
          }
        }
      }
    }

    if (this.commentCacheDirty) {
      saveInventoryConfig(COMMENT_CACHE_KEY, this.commentCache);
      this.commentCacheDirty = false;
    }

    return summary;
  }
}

module.exports = {
  Phase2WritebackService,
  isExcludedIpn,
  parseIpnPrefix
};
