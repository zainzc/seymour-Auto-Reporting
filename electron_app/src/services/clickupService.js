const axios = require('axios');
const { retryWithBackoff, sleep } = require('../utils/retry');

class ClickUpService {
  constructor(config) {
    this.token = config.token;
    this.listId = config.listId || null;
    this.minIntervalMs = 220;
    this.lastRequestAt = 0;

    if (!this.token) {
      throw new Error('ClickUp configuration is missing CLICKUP_TOKEN.');
    }

    this.client = axios.create({
      baseURL: 'https://api.clickup.com/api/v2',
      timeout: 30000,
      headers: {
        Authorization: this.token,
        'Content-Type': 'application/json'
      }
    });
  }

  async throttle() {
    const elapsed = Date.now() - this.lastRequestAt;
    const waitMs = this.minIntervalMs - elapsed;
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    this.lastRequestAt = Date.now();
  }

  async request(method, path, options = {}) {
    return retryWithBackoff(
      async () => {
        await this.throttle();
        const response = await this.client.request({
          method,
          url: path,
          data: options.data,
          params: options.params
        });
        return response.data;
      },
      {
        maxAttempts: 5,
        baseDelayMs: 600,
        onRetry: ({ attempt, delayMs, error }) => {
          const status = error?.response?.status;
          console.warn(`ClickUp retry attempt ${attempt} after ${delayMs}ms (status: ${status || 'n/a'})`);
        }
      }
    );
  }

  async createTask(task) {
    if (!this.listId) {
      throw new Error('ClickUp list ID is missing.');
    }

    const isMulti = String(task?.type || '').toLowerCase() === 'multi';
    const body = {
      name: isMulti ? `Category Selection - ${task.ipn}` : `Category Exception - ${task.ipn}`,
      description: [
        `IPN: ${task.ipn}`,
        `IPN Prefix: ${Number.isFinite(task.ipnPrefix) ? task.ipnPrefix : 'N/A'}`,
        `MasterRecordID: ${task.masterRecordId || ''}`,
        `CategoryCode: ${task.categoryCode || ''}`,
        `ConditionsAndOptions: ${task.conditionsAndOptions || ''}`,
        `PartType: ${task.partType || ''}`,
        `ModelYear: ${task.modelYear || ''}`,
        `ModelName: ${task.modelName || ''}`,
        `LocationCode: ${task.locationCode || ''}`,
        `StockTicketNumber: ${task.stockTicketNumber || ''}`,
        `ReferenceNumber: ${task.referenceNumber || ''}`,
        `Reason: ${task.reason}`,
        isMulti && Array.isArray(task.validOptions) && task.validOptions.length > 0
          ? `Valid Category Identifiers: ${task.validOptions.join(' | ')}`
          : ''
      ]
        .filter(Boolean)
        .join('\n')
    };

    if (Array.isArray(task.customFields) && task.customFields.length > 0) {
      body.custom_fields = task.customFields;
    }

    const preferredStatus = String(task.preferredStatus || '').trim() || 'Open / To-Do - Select Category';

    try {
      return await this.request('POST', `/list/${this.listId}/task`, {
        data: {
          ...body,
          status: preferredStatus
        }
      });
    } catch (error) {
      // Fallback: some lists reject unknown status names; let ClickUp assign list default status.
      const statusCode = error?.response?.status;
      if (statusCode === 400) {
        try {
          return await this.request('POST', `/list/${this.listId}/task`, { data: body });
        } catch (fallbackError) {
          const clickupErrorText =
            fallbackError?.response?.data?.err ||
            fallbackError?.response?.data?.error ||
            fallbackError?.message;
          throw new Error(`ClickUp create task failed: ${clickupErrorText}`);
        }
      }

      const clickupErrorText =
        error?.response?.data?.err ||
        error?.response?.data?.error ||
        error?.message;
      throw new Error(`ClickUp create task failed: ${clickupErrorText}`);
    }
  }

  async updateTask(taskId, updates = {}) {
    const id = String(taskId || '').trim();
    if (!id) throw new Error('ClickUp task ID is required.');
    const payload = {};
    if (updates.name) payload.name = String(updates.name);
    if (updates.description) payload.description = String(updates.description);
    if (updates.status) payload.status = String(updates.status);
    if (Array.isArray(updates.custom_fields)) payload.custom_fields = updates.custom_fields;
    if (Object.keys(payload).length === 0) return null;
    return this.request('PUT', `/task/${id}`, { data: payload });
  }

  static buildCategoryTaskPayload(task = {}) {
    const isMulti = String(task?.type || '').toLowerCase() === 'multi';
    return {
      name: isMulti ? `Category Selection - ${task.ipn}` : `Category Exception - ${task.ipn}`,
      description: [
        `IPN: ${task.ipn}`,
        `IPN Prefix: ${Number.isFinite(task.ipnPrefix) ? task.ipnPrefix : 'N/A'}`,
        `MasterRecordID: ${task.masterRecordId || ''}`,
        `CategoryCode: ${task.categoryCode || ''}`,
        `ConditionsAndOptions: ${task.conditionsAndOptions || ''}`,
        `PartType: ${task.partType || ''}`,
        `ModelYear: ${task.modelYear || ''}`,
        `ModelName: ${task.modelName || ''}`,
        `LocationCode: ${task.locationCode || ''}`,
        `StockTicketNumber: ${task.stockTicketNumber || ''}`,
        `ReferenceNumber: ${task.referenceNumber || ''}`,
        `Reason: ${task.reason}`,
        isMulti && Array.isArray(task.validOptions) && task.validOptions.length > 0
          ? `Valid Category Identifiers: ${task.validOptions.join(' | ')}`
          : ''
      ].join('\n')
    };
  }

  static normalizeIpn(value) {
    return String(value || '').trim().toUpperCase();
  }

  static extractIpnFromTask(task = {}) {
    const title = String(task.name || '').trim();
    const titleMatch = title.match(
      /^(?:Resolve\s+Category|Category\s+Selection|Category\s+Exception)\s*-\s*(.+)$/i
    );
    if (titleMatch && titleMatch[1]) {
      return ClickUpService.normalizeIpn(titleMatch[1]);
    }

    const description = String(task.description || '');
    const descMatch = description.match(/(?:^|\n)\s*IPN:\s*([^\n\r]+)/i);
    if (descMatch && descMatch[1]) {
      return ClickUpService.normalizeIpn(descMatch[1]);
    }

    return '';
  }

  static extractTaskType(task = {}) {
    const title = String(task?.name || '').toLowerCase();
    if (title.includes('category selection')) return 'multi';
    if (title.includes('category exception')) return 'exception';
    if (title.includes('resolve category')) return 'multi';

    const description = String(task?.description || '').toLowerCase();
    if (description.includes('reason: multiple_category_definitions')) return 'multi';
    if (description.includes('reason: no_match')) return 'exception';
    return 'unknown';
  }

  static buildTaskIdentityKey(ipn, type = '') {
    const ipnKey = ClickUpService.normalizeIpn(ipn);
    const typeKey = String(type || '').trim().toLowerCase() || 'unknown';
    return `${ipnKey}::${typeKey}`;
  }

  static extractCustomFieldText(task = {}, fieldName = '') {
    const normalizedName = String(fieldName || '').trim().toLowerCase();
    if (!normalizedName) return '';
    const fields = Array.isArray(task.custom_fields) ? task.custom_fields : [];
    const target = fields.find(field => String(field?.name || '').trim().toLowerCase() === normalizedName);
    if (!target) return '';

    const rawValue = target?.value;
    if (rawValue === null || rawValue === undefined) return '';

    if (target?.type === 'drop_down') {
      const options = target?.type_config?.options || [];
      const option =
        options.find(item => String(item?.id || '') === String(rawValue)) ||
        options.find(item => String(item?.orderindex || '') === String(rawValue));
      return String(option?.name || '').trim();
    }

    return String(rawValue).trim();
  }

  static getTaskCustomFieldDisplayValue(task = {}, fieldMeta = null) {
    if (!fieldMeta) return '';
    const fields = Array.isArray(task.custom_fields) ? task.custom_fields : [];
    const target = fields.find(field => String(field?.id || '') === String(fieldMeta?.id || ''));
    if (!target) return '';

    let rawValue = target?.value;
    if (rawValue === null || rawValue === undefined) return '';
    if (Array.isArray(rawValue)) {
      rawValue = rawValue.length > 0 ? rawValue[0] : null;
      if (rawValue === null || rawValue === undefined) return '';
    }

    if (target?.type === 'drop_down') {
      const options = target?.type_config?.options || fieldMeta?.type_config?.options || [];
      const valueId =
        typeof rawValue === 'object'
          ? String(rawValue?.id || rawValue?.value || rawValue?.orderindex || '')
          : String(rawValue);
      const valueName =
        typeof rawValue === 'object' ? String(rawValue?.name || '').trim() : '';

      if (valueName) {
        return valueName;
      }

      const option =
        options.find(item => String(item?.id || '') === valueId) ||
        options.find(item => String(item?.orderindex || '') === valueId);
      return String(option?.name || '').trim();
    }

    if (typeof rawValue === 'object') {
      if (typeof rawValue?.name === 'string' && rawValue.name.trim()) {
        return rawValue.name.trim();
      }
      if (typeof rawValue?.value === 'string' && rawValue.value.trim()) {
        return rawValue.value.trim();
      }
    }

    return String(rawValue).trim();
  }

  async getList() {
    if (!this.listId) {
      throw new Error('ClickUp list ID is missing.');
    }
    return this.request('GET', `/list/${this.listId}`);
  }

  async validateAccess() {
    const data = await this.getList();
    return {
      success: true,
      listName: data?.name || 'Unknown List'
    };
  }

  async getTask(taskId) {
    if (!taskId) {
      throw new Error('ClickUp task ID is required.');
    }
    return this.request('GET', `/task/${taskId}`);
  }

  async updateTaskStatus(taskId, status) {
    if (!taskId) throw new Error('ClickUp task ID is required.');
    if (!status) throw new Error('ClickUp status is required.');
    return this.request('PUT', `/task/${taskId}`, { data: { status } });
  }

  async addTaskComment(taskId, commentText, notifyAll = false) {
    if (!taskId) throw new Error('ClickUp task ID is required.');
    const text = String(commentText || '').trim();
    if (!text) throw new Error('ClickUp comment text is required.');

    return this.request('POST', `/task/${taskId}/comment`, {
      data: {
        comment_text: text,
        notify_all: Boolean(notifyAll)
      }
    });
  }

  async getCustomFieldByName(fieldName) {
    const normalizedName = String(fieldName || '').trim().toLowerCase();
    if (!normalizedName) {
      throw new Error('Custom field name is required.');
    }

    const list = await this.getList();
    const fields = Array.isArray(list?.fields) ? list.fields : [];
    return (
      fields.find(field => String(field?.name || '').trim().toLowerCase() === normalizedName) || null
    );
  }

  async fetchTasks(options = {}) {
    if (!this.listId) {
      throw new Error('ClickUp list ID is missing.');
    }

    const params = {
      include_closed: options.includeClosed ? 'true' : 'false',
      subtasks: options.subtasks ? 'true' : 'false',
      page: Number.isFinite(options.page) ? options.page : 0
    };

    const statuses = Array.isArray(options.statuses)
      ? options.statuses.filter(Boolean).map(value => String(value).trim())
      : [];
    if (statuses.length > 0) {
      params['statuses[]'] = statuses;
    }

    if (Number.isFinite(options.limit) && options.limit > 0) {
      params.limit = Math.floor(options.limit);
    }

    const data = await this.request('GET', `/list/${this.listId}/task`, { params });
    return {
      tasks: Array.isArray(data?.tasks) ? data.tasks : [],
      lastPage: Boolean(data?.last_page)
    };
  }

  async fetchTasksByStatuses(statuses = [], options = {}) {
    const results = [];
    const maxPages = Number.isFinite(options.maxPages) ? Math.max(1, options.maxPages) : 100;

    for (let page = 0; page < maxPages; page += 1) {
      const { tasks, lastPage } = await this.fetchTasks({
        ...options,
        statuses,
        page
      });

      results.push(...tasks);
      if (lastPage || tasks.length === 0) {
        break;
      }
    }

    return results;
  }

  async fetchOpenTaskIpnSet() {
    const tasks = await this.fetchTasksByStatuses([], {
      includeClosed: false,
      subtasks: false
    });

    const set = new Set();
    for (const task of tasks) {
      const ipn =
        ClickUpService.extractIpnFromTask(task) ||
        ClickUpService.extractCustomFieldText(task, 'IPN');
      if (ipn) {
        set.add(ipn);
      }
    }
    return set;
  }

  async fetchOpenTaskByIpnMap() {
    const tasks = await this.fetchTasksByStatuses([], {
      includeClosed: false,
      subtasks: false
    });

    const map = new Map();
    for (const task of tasks) {
      const ipn =
        ClickUpService.extractIpnFromTask(task) ||
        ClickUpService.extractCustomFieldText(task, 'IPN');
      if (!ipn || map.has(ipn)) continue;
      map.set(ipn, task);
    }
    return map;
  }

  async fetchOpenTaskByKeyMap() {
    const tasks = await this.fetchTasksByStatuses([], {
      includeClosed: false,
      subtasks: false
    });

    const map = new Map();
    for (const task of tasks) {
      const ipn =
        ClickUpService.extractIpnFromTask(task) ||
        ClickUpService.extractCustomFieldText(task, 'IPN');
      if (!ipn) continue;
      const type = ClickUpService.extractTaskType(task);
      const key = ClickUpService.buildTaskIdentityKey(ipn, type);
      if (map.has(key)) continue;
      map.set(key, task);
    }
    return map;
  }

  async fetchAllLists() {
    const teamsRes = await this.request('GET', '/team');
    const teams = teamsRes?.teams || [];
    const results = [];

    for (const team of teams) {
      const spacesRes = await this.request('GET', `/team/${team.id}/space`);
      const spaces = spacesRes?.spaces || [];

      for (const space of spaces) {
        const folderlessRes = await this.request('GET', `/space/${space.id}/list`);
        const folderless = folderlessRes?.lists || [];
        for (const list of folderless) {
          results.push({
            id: String(list.id),
            name: list.name || 'Unnamed List',
            teamName: team.name || '',
            spaceName: space.name || '',
            folderName: '',
            path: `${team.name || ''} / ${space.name || ''} / ${list.name || ''}`.trim()
          });
        }

        const foldersRes = await this.request('GET', `/space/${space.id}/folder`);
        const folders = foldersRes?.folders || [];
        for (const folder of folders) {
          const listsRes = await this.request('GET', `/folder/${folder.id}/list`);
          const lists = listsRes?.lists || [];
          for (const list of lists) {
            results.push({
              id: String(list.id),
              name: list.name || 'Unnamed List',
              teamName: team.name || '',
              spaceName: space.name || '',
              folderName: folder.name || '',
              path: `${team.name || ''} / ${space.name || ''} / ${folder.name || ''} / ${list.name || ''}`.trim()
            });
          }
        }
      }
    }

    const unique = new Map();
    for (const item of results) {
      unique.set(item.id, item);
    }
    return Array.from(unique.values()).sort((a, b) => a.path.localeCompare(b.path));
  }
}

module.exports = ClickUpService;
