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
    skippedAlreadyResolved: 0
  };
}

class Phase2WritebackService {
  constructor(config = {}) {
    this.config = {
      clickupResolvedCategoryFieldName:
        config.clickupResolvedCategoryFieldName || 'Resolved Category',
      clickupStatusDetermined: config.clickupStatusDetermined || 'Category Determined',
      clickupStatusCompleted: config.clickupStatusCompleted || 'Completed',
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
      categoryTable: this.config.airtableCategoryTable || 'Category Names'
    });
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
    const categories = fields.Categories;
    return Array.isArray(categories) && categories.length > 0;
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

    let resolvedCategory =
      ClickUpService.getTaskCustomFieldDisplayValue(task, resolvedField) ||
      ClickUpService.extractCustomFieldText(task, this.config.clickupResolvedCategoryFieldName);
    if (!resolvedCategory) {
      try {
        const detailedTask = await this.clickupService.getTask(taskId);
        resolvedCategory =
          ClickUpService.getTaskCustomFieldDisplayValue(detailedTask, resolvedField) ||
          ClickUpService.extractCustomFieldText(
            detailedTask,
            this.config.clickupResolvedCategoryFieldName
          );
      } catch (detailError) {
        // keep original path; missing detail fetch should not crash whole run
      }
    }
    if (!resolvedCategory) {
      summary.tasksErrored += 1;
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

    const parsedSelection = this.parseResolvedSelection(resolvedCategory, ipnPrefix);
    const effectivePrefix = Number.isFinite(parsedSelection.prefix)
      ? parsedSelection.prefix
      : ipnPrefix;
    const effectiveCategoryName = String(parsedSelection.categoryName || '').trim();
    let matches = await this.airtableService.fetchCategoryRecordsByPrefixAndName(
      effectivePrefix,
      effectiveCategoryName
    );
    if (matches.length > 1) {
      matches = this.filterMatchesByCondition(matches, parsedSelection.conditionText);
    }

    if (matches.length !== 1) {
      summary.tasksErrored += 1;
      const reason =
        matches.length === 0
          ? `no category row for prefix ${effectivePrefix} and name '${effectiveCategoryName || parsedSelection.raw}'`
          : `multiple category rows for prefix ${effectivePrefix} and name '${effectiveCategoryName || parsedSelection.raw}'`;
      await this.addCommentOnce(
        taskId,
        `category_mapping_${ipn}_${resolvedCategory.toLowerCase()}`,
        `Write-back blocked: ${reason}.`
      );
      return;
    }

    const categoryRecord = matches[0];
    await this.airtableService.setMasterPartCategory(masterRecord.id, categoryRecord.id);
    summary.airtableUpdates += 1;

    await this.addCommentOnce(
      taskId,
      `writeback_success_${ipn}_${categoryRecord.id}`,
      `Category write-back succeeded. MasterRecord=${masterRecord.id}, CategoryRecord=${categoryRecord.id}, Category='${resolvedCategory}'.`
    );
    await this.moveTaskToCompleted(taskId);
    summary.tasksCompleted += 1;
  }

  async runOnce() {
    this.ensureRequiredConfig();
    const summary = buildSummary();

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

    let resolvedField = await this.clickupService.getCustomFieldByName(
      this.config.clickupResolvedCategoryFieldName
    );
    if (!resolvedField) {
      const targetName = String(this.config.clickupResolvedCategoryFieldName || '')
        .trim()
        .toLowerCase();
      for (const task of tasks) {
        const customFields = Array.isArray(task?.custom_fields) ? task.custom_fields : [];
        const match = customFields.find(
          field => String(field?.name || '').trim().toLowerCase() === targetName
        );
        if (match) {
          resolvedField = {
            id: match.id,
            name: match.name,
            type: match.type,
            type_config: match.type_config || {}
          };
          break;
        }
      }
    }

    if (!resolvedField) {
      throw new Error(
        `ClickUp custom field '${this.config.clickupResolvedCategoryFieldName}' not found in configured list/tasks. Verify list ID and field name.`
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
