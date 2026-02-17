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

    const body = {
      name: `Resolve Category - ${task.ipn}`,
      description: [
        `IPN: ${task.ipn}`,
        `IPN Prefix: ${Number.isFinite(task.ipnPrefix) ? task.ipnPrefix : 'N/A'}`,
        `CategoryCode: ${task.categoryCode || ''}`,
        `ConditionsAndOptions: ${task.conditionsAndOptions || ''}`,
        `PartType: ${task.partType || ''}`,
        `ModelYear: ${task.modelYear || ''}`,
        `ModelName: ${task.modelName || ''}`,
        `LocationCode: ${task.locationCode || ''}`,
        `StockTicketNumber: ${task.stockTicketNumber || ''}`,
        `ReferenceNumber: ${task.referenceNumber || ''}`,
        `Reason: ${task.reason}`
      ].join('\n')
    };

    const preferredStatus = 'Open / To-Do - Select Category';

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
