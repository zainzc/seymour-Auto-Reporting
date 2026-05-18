const axios = require('axios');
const { retryWithBackoff } = require('../utils/retry');

function normalizeText(value) {
  return String(value || '').trim();
}

function clampConfidence(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function extractJsonObject(text) {
  const direct = tryParseJson(text);
  if (direct) return direct;
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  return tryParseJson(match[0]);
}

function isPromptCacheUnsupported(error) {
  const status = Number(error?.response?.status || 0);
  if (status !== 400) return false;
  const body =
    String(error?.response?.data?.error?.message || '') ||
    String(error?.response?.data?.message || '') ||
    String(error?.message || '');
  const text = body.toLowerCase();
  return text.includes('prompt_cache_key') || text.includes('unknown parameter');
}

function parseIpnSet(value) {
  const text = String(value || '');
  if (!text.trim()) return new Set();
  return new Set(
    text
      .split(/[\n,;|]+/)
      .map(item => normalizeText(item).toUpperCase())
      .filter(Boolean)
  );
}

function normalizeTextArray(values = [], maxItems = 500) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const value of values) {
    const text = normalizeText(value);
    if (!text) continue;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

class Phase4AiEvaluatorService {
  static sharedFieldResolutionCache = new Map();

  constructor(config = {}) {
    this.apiKey = normalizeText(config.apiKey);
    this.model = normalizeText(config.model || 'gpt-5.4-nano');
    this.baseUrl = normalizeText(config.baseUrl || 'https://api.openai.com/v1');
    this.timeoutMs = Number(config.timeoutMs || 45000);
    this.webSearchTimeoutMs = Math.max(
      Number(config.webSearchTimeoutMs || process.env.PHASE4_WEB_SEARCH_TIMEOUT_MS || 90000),
      this.timeoutMs
    );
    this.maxAttempts = Number(config.maxAttempts || 4);
    this.baseDelayMs = Number(config.baseDelayMs || 700);
    this.promptCacheKey = normalizeText(config.promptCacheKey || '');
    this.promptCacheEnabled = config.promptCacheEnabled !== false;
    this.lowConfidenceThreshold = clampConfidence(
      Number.isFinite(Number(config.lowConfidenceThreshold))
        ? Number(config.lowConfidenceThreshold)
        : Number(process.env.PHASE4_LOW_CONFIDENCE_THRESHOLD || 0.75)
    );
    this.webSearchEnabled =
      config.webSearchEnabled !== false &&
      String(process.env.PHASE4_WEB_SEARCH_ENABLED || 'true').trim().toLowerCase() !== 'false';
    this.webSearchModel = normalizeText(
      config.webSearchModel || process.env.PHASE4_WEB_SEARCH_MODEL || this.model || 'gpt-5.4-nano'
    );
    this.webSearchAllowedDomains = Array.isArray(config.webSearchAllowedDomains) && config.webSearchAllowedDomains.length > 0
      ? config.webSearchAllowedDomains.map(value => normalizeText(value)).filter(Boolean)
      : ['ebay.com', 'www.ebay.com', 'go-parts.com', 'www.go-parts.com'];
    this.debugPromptIpn = normalizeText(
      config.debugPromptIpn || process.env.PHASE4B_DEBUG_PROMPT_IPN || process.env.PHASE4_DEBUG_PROMPT_IPN || ''
    ).toUpperCase();
    this.debugPromptIpnSet = parseIpnSet(this.debugPromptIpn);
    this.loggedDebugPromptKeys = new Set();

    if (!this.apiKey) {
      throw new Error('Missing OpenAI API key for Phase 4B-lite.');
    }

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      }
    });
  }

  shouldDebugIpn(ipn = '') {
    const value = normalizeText(ipn).toUpperCase();
    if (!value) return false;
    return this.debugPromptIpnSet.size > 0 && this.debugPromptIpnSet.has(value);
  }

  buildFieldPromptInput(payload = {}) {
    return {
      recordKey: normalizeText(payload.recordKey),
      ipn: normalizeText(payload.ipn),
      prefix: normalizeText(payload.prefix),
      tableName: normalizeText(payload.tableName),
      fieldName: normalizeText(payload.fieldName),
      ruleType: normalizeText(payload.ruleType).toUpperCase(),
      masterPartsData: payload.masterPartsData || {},
      allowedValues: Array.isArray(payload.allowedValues) ? payload.allowedValues : [],
      listingTitle: normalizeText(payload.listingTitle),
      listingDescription: normalizeText(payload.listingDescription),
      listingConditionsAndOptions: normalizeText(payload.listingConditionsAndOptions),
      listingItemSpecifics: normalizeText(payload.listingItemSpecifics),
      listingItemSpecificsAllCValuesRelevantToItem: normalizeText(
        payload.listingItemSpecificsAllCValuesRelevantToItem
      )
    };
  }

  buildFieldCacheKey(promptInput = {}) {
    return JSON.stringify({
      ipn: normalizeText(promptInput.ipn).toUpperCase(),
      prefix: normalizeText(promptInput.prefix),
      tableName: normalizeText(promptInput.tableName),
      fieldName: normalizeText(promptInput.fieldName),
      ruleType: normalizeText(promptInput.ruleType).toUpperCase(),
      masterPartsData: promptInput.masterPartsData || {},
      allowedValues: Array.isArray(promptInput.allowedValues) ? promptInput.allowedValues : [],
      listingTitle: normalizeText(promptInput.listingTitle),
      listingDescription: normalizeText(promptInput.listingDescription),
      listingConditionsAndOptions: normalizeText(promptInput.listingConditionsAndOptions),
      listingItemSpecifics: normalizeText(promptInput.listingItemSpecifics),
      listingItemSpecificsAllCValuesRelevantToItem: normalizeText(
        promptInput.listingItemSpecificsAllCValuesRelevantToItem
      )
    });
  }

  getCachedFieldResult(promptInput = {}) {
    const key = this.buildFieldCacheKey(promptInput);
    return Phase4AiEvaluatorService.sharedFieldResolutionCache.get(key) || null;
  }

  setCachedFieldResult(promptInput = {}, result = null) {
    if (!result) return;
    const key = this.buildFieldCacheKey(promptInput);
    Phase4AiEvaluatorService.sharedFieldResolutionCache.set(key, {
      value: normalizeText(result.value),
      confidence: clampConfidence(result.confidence),
      reason: normalizeText(result.reason),
      webSearchUsed: Boolean(result.webSearchUsed),
      webSources: Array.isArray(result.webSources) ? result.webSources : []
    });
  }

  buildFieldResolutionSystemPrompt() {
    return [
      'Return only valid JSON.',
      'You are resolving exactly one eBay item-specific field for an automotive part.',
      'Use only the evidence provided in masterPartsData, listingTitle, listingDescription, listingConditionsAndOptions, listingItemSpecifics, listingItemSpecificsAllCValuesRelevantToItem, fieldInstructions, allowedValues, and webEvidence.',
      'Never guess.',
      'Do not infer a technical value from category, table name, IPN prefix, or part type alone unless the evidence explicitly supports it.',
      'If evidence is missing, weak, ambiguous, or conflicting, return an empty string and low confidence.',
      'If allowedValues is non-empty, the value must exactly match one of those allowedValues.',
      'Keep reason short and evidence-based.',
      'Output JSON in exactly this shape: {"value":"string_or_empty","confidence":0,"reason":"short_reason"}'
    ].join(' ');
  }

  buildFieldResolutionUserPayload(promptInput, task = 'phase4_field_resolution') {
    return {
      task,
      expectedOutput: {
        value: 'string_or_empty',
        confidence: 'number_0_to_1',
        reason: 'short_reason'
      },
      input: promptInput
    };
  }

  parseChatCompletionJson(response) {
    const content = String(response?.data?.choices?.[0]?.message?.content || '').trim();
    return extractJsonObject(content) || {};
  }

  extractResponsesText(data = {}) {
    const direct = normalizeText(data?.output_text);
    if (direct) return direct;
    const chunks = [];
    const output = Array.isArray(data?.output) ? data.output : [];
    for (const item of output) {
      if (item?.type !== 'message') continue;
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const part of content) {
        const text = normalizeText(part?.text || part?.output_text || '');
        if (text) chunks.push(text);
      }
    }
    return chunks.join('\n').trim();
  }

  extractWebSources(data = {}) {
    const urls = new Set();
    const addSources = sources => {
      if (!Array.isArray(sources)) return;
      for (const src of sources) {
        const url = normalizeText(src?.url || src?.link || '');
        if (url) urls.add(url);
      }
    };
    addSources(data?.web_search_call?.action?.sources);
    const output = Array.isArray(data?.output) ? data.output : [];
    for (const item of output) {
      addSources(item?.action?.sources);
    }
    return Array.from(urls);
  }

  async evaluateFieldsWithSharedWebSearch(payloads = []) {
    const items = Array.isArray(payloads) ? payloads : [];
    if (items.length === 0) {
      return {
        resultsByField: new Map(),
        webSources: []
      };
    }

    const first = items[0] || {};
    const ipn = normalizeText(first.ipn);
    const sharedContext = {
      ipn,
      prefix: normalizeText(first.prefix),
      tableName: normalizeText(first.tableName),
      masterPartsData: first.masterPartsData || {},
      listingTitle: normalizeText(first.listingTitle),
      listingDescription: normalizeText(first.listingDescription),
      listingConditionsAndOptions: normalizeText(first.listingConditionsAndOptions),
      listingItemSpecifics: normalizeText(first.listingItemSpecifics),
      listingItemSpecificsAllCValuesRelevantToItem: normalizeText(
        first.listingItemSpecificsAllCValuesRelevantToItem
      )
    };
    const fields = items.map(item => ({
      fieldName: normalizeText(item.fieldName),
      ruleType: normalizeText(item.ruleType).toUpperCase(),
      allowedValues: Array.isArray(item.allowedValues) ? item.allowedValues : []
    }));

    const requestBody = {
      model: this.webSearchModel,
      reasoning: { effort: 'low' },
      tool_choice: 'auto',
      include: ['web_search_call.action.sources'],
      tools: [
        {
          type: 'web_search',
          filters: {
            allowed_domains: this.webSearchAllowedDomains
          }
        }
      ],
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: [
                'Return only valid JSON.',
                'Resolve multiple item-specific fields for one automotive part using allowed web_search domains only.',
                `Allowed domains: ${this.webSearchAllowedDomains.join(', ')}.`,
                'Do not guess.',
                'For each requested field, if evidence is weak/missing/conflicting, return empty value and low confidence.',
                'If allowedValues for a field is non-empty, value must exactly match one allowed value.',
                'Output exact JSON shape: {"results":[{"fieldName":"string","value":"string_or_empty","confidence":0,"reason":"short_reason"}]}'
              ].join(' ')
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({
                task: 'phase4_field_resolution_web_search_batch',
                context: sharedContext,
                fields
              })
            }
          ]
        }
      ]
    };

    const response = await retryWithBackoff(
      async () =>
        this.client.post('/responses', requestBody, {
          timeout: this.webSearchTimeoutMs
        }),
      {
        maxAttempts: this.maxAttempts,
        baseDelayMs: this.baseDelayMs
      }
    );

    const text = this.extractResponsesText(response?.data || {});
    const parsed = extractJsonObject(text) || {};
    const list = Array.isArray(parsed?.results) ? parsed.results : [];
    const sources = this.extractWebSources(response?.data || {});
    const resultsByField = new Map();
    for (const row of list) {
      const fieldName = normalizeText(row?.fieldName);
      if (!fieldName) continue;
      const result = {
        value: normalizeText(row?.value),
        confidence: clampConfidence(row?.confidence),
        reason: normalizeText(row?.reason),
        webSearchUsed: true,
        webSources: sources
      };
      resultsByField.set(fieldName, result);
    }
    for (const item of items) {
      const fieldName = normalizeText(item?.fieldName);
      if (!fieldName) continue;
      const result = resultsByField.get(fieldName);
      if (!result) continue;
      this.setCachedFieldResult(this.buildFieldPromptInput(item), result);
    }
    return {
      resultsByField,
      webSources: sources
    };
  }

  async evaluateFieldsWithSharedWebSearchBatch(payloads = [], options = {}) {
    const items = Array.isArray(payloads) ? payloads : [];
    const ipnBatchSize = Math.max(
      1,
      Math.min(300, Number(options?.ipnBatchSize || process.env.PHASE4_AI_IPN_BATCH_SIZE || 250) || 250)
    );
    const maxItemsPerCall = Math.max(
      1,
      Math.min(800, Number(options?.maxItemsPerCall || process.env.PHASE4_WEB_MAX_ITEMS_PER_CALL || 400) || 400)
    );
    const resultsByRequestId = new Map();

    const unresolved = [];
    for (let i = 0; i < items.length; i += 1) {
      const raw = items[i] || {};
      const requestId = normalizeText(raw.requestId || `${i + 1}`);
      const promptInput = this.buildFieldPromptInput(raw);
      const cached = this.getCachedFieldResult(promptInput);
      const canUseCachedForWebSearch =
        Boolean(cached) &&
        (Boolean(cached?.webSearchUsed) ||
          (Boolean(cached?.value) && Number(cached?.confidence || 0) >= this.lowConfidenceThreshold));
      if (canUseCachedForWebSearch) {
        resultsByRequestId.set(requestId, { ...cached });
      } else {
        unresolved.push({ requestId, promptInput });
      }
    }
    if (unresolved.length === 0) {
      return { resultsByRequestId, failedCount: 0 };
    }

    const byPrefix = new Map();
    for (const item of unresolved) {
      const prefix = normalizeText(item?.promptInput?.prefix).toUpperCase() || '__NO_PREFIX__';
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
      byPrefix.get(prefix).push(item);
    }

    const requestBatches = [];
    for (const prefixItems of byPrefix.values()) {
      const byIpn = new Map();
      for (const item of prefixItems) {
        const ipn = normalizeText(item?.promptInput?.ipn).toUpperCase() || '__NO_IPN__';
        if (!byIpn.has(ipn)) byIpn.set(ipn, []);
        byIpn.get(ipn).push(item);
      }
      const ipnGroups = Array.from(byIpn.values());
      let cursor = [];
      let cursorIpns = 0;
      for (const group of ipnGroups) {
        const nextIpns = cursorIpns + 1;
        const nextItems = cursor.length + group.length;
        if (cursor.length > 0 && (nextIpns > ipnBatchSize || nextItems > maxItemsPerCall)) {
          requestBatches.push(cursor);
          cursor = [];
          cursorIpns = 0;
        }
        cursor.push(...group);
        cursorIpns += 1;
      }
      if (cursor.length > 0) requestBatches.push(cursor);
    }

    let failedCount = 0;
    for (let b = 0; b < requestBatches.length; b += 1) {
      const batch = requestBatches[b];
      const debugBatchItems = batch.filter(item => this.shouldDebugIpn(item?.promptInput?.ipn));
      const requestBody = {
        model: this.webSearchModel,
        reasoning: { effort: 'low' },
        tool_choice: 'auto',
        include: ['web_search_call.action.sources'],
        tools: [
          {
            type: 'web_search',
            filters: {
              allowed_domains: this.webSearchAllowedDomains
            }
          }
        ],
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: [
                  'Return only valid JSON.',
                  'Resolve multiple item-specific fields for multiple automotive IPNs.',
                  `Allowed domains: ${this.webSearchAllowedDomains.join(', ')}.`,
                  'Do not guess.',
                  'Each result must be evidence-based for that exact item.',
                  'If evidence is weak/missing/conflicting, return empty value and low confidence.',
                  'If allowedValues is non-empty, value must exactly match one allowed value.',
                  'Output exact JSON shape: {"results":[{"requestId":"string","value":"string_or_empty","confidence":0,"reason":"short_reason"}]}'
                ].join(' ')
              }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify({
                  task: 'phase4_field_resolution_web_search_batch_multi_ipn',
                  items: batch.map(item => ({
                    requestId: item.requestId,
                    input: item.promptInput
                  }))
                })
              }
            ]
          }
        ]
      };
      if (debugBatchItems.length > 0) {
        const debugIpns = Array.from(
          new Set(debugBatchItems.map(item => normalizeText(item?.promptInput?.ipn).toUpperCase()).filter(Boolean))
        );
        console.log(
          '[Phase4AiEvaluatorService][DEBUG_PROMPT] Web-search batch requestBody:',
          JSON.stringify(
            {
              debugIpns,
              batchSize: batch.length,
              requestBody
            },
            null,
            2
          )
        );
      }

      let response;
      let batchFailed = false;
      try {
        response = await retryWithBackoff(
          async () =>
            this.client.post('/responses', requestBody, {
              timeout: this.webSearchTimeoutMs
            }),
          {
            maxAttempts: this.maxAttempts,
            baseDelayMs: this.baseDelayMs
          }
        );
      } catch (error) {
        batchFailed = true;
      }
      if (debugBatchItems.length > 0) {
        const debugIpns = Array.from(
          new Set(debugBatchItems.map(item => normalizeText(item?.promptInput?.ipn).toUpperCase()).filter(Boolean))
        );
        console.log(
          '[Phase4AiEvaluatorService][DEBUG_PROMPT] Web-search batch raw response:',
          JSON.stringify(
            {
              debugIpns,
              batchSize: batch.length,
              response: response?.data || {}
            },
            null,
            2
          )
        );
      }

      if (batchFailed || !response) {
        failedCount += batch.length;
        for (const item of batch) {
          resultsByRequestId.set(item.requestId, {
            value: '',
            confidence: 0,
            reason: 'web-search batch failed',
            webSearchUsed: false,
            webSources: []
          });
        }
        continue;
      }

      const text = this.extractResponsesText(response?.data || {});
      const parsed = extractJsonObject(text) || {};
      const rows = Array.isArray(parsed?.results) ? parsed.results : [];
      const sources = this.extractWebSources(response?.data || {});
      const parsedById = new Map();
      for (const row of rows) {
        const requestId = normalizeText(row?.requestId);
        if (!requestId) continue;
        parsedById.set(requestId, {
          value: normalizeText(row?.value),
          confidence: clampConfidence(row?.confidence),
          reason: normalizeText(row?.reason),
          webSearchUsed: true,
          webSources: sources
        });
      }
      for (const item of batch) {
        const result = parsedById.get(item.requestId) || {
          value: '',
          confidence: 0,
          reason: 'no web-search result returned',
          webSearchUsed: true,
          webSources: sources
        };
        resultsByRequestId.set(item.requestId, result);
        this.setCachedFieldResult(item.promptInput, result);
      }

      if (typeof options?.onBatchComplete === 'function') {
        options.onBatchComplete({
          index: b + 1,
          total: requestBatches.length,
          size: batch.length
        });
      }
    }

    return { resultsByRequestId, failedCount };
  }

  async evaluateFieldChat(promptInput = {}) {
    const requestBody = {
      model: this.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: this.buildFieldResolutionSystemPrompt()
        },
        {
          role: 'user',
          content: JSON.stringify(this.buildFieldResolutionUserPayload(promptInput, 'phase4_field_resolution'))
        }
      ]
    };

    const shouldUsePromptCache = this.promptCacheEnabled && this.promptCacheKey;
    if (shouldUsePromptCache) {
      requestBody.prompt_cache_key = this.promptCacheKey;
    }

    let response;
    try {
      response = await retryWithBackoff(
        async () => this.client.post('/chat/completions', requestBody),
        {
          maxAttempts: this.maxAttempts,
          baseDelayMs: this.baseDelayMs
        }
      );
    } catch (error) {
      if (!shouldUsePromptCache || !isPromptCacheUnsupported(error)) {
        throw error;
      }
      this.promptCacheEnabled = false;
      delete requestBody.prompt_cache_key;
      response = await retryWithBackoff(
        async () => this.client.post('/chat/completions', requestBody),
        {
          maxAttempts: this.maxAttempts,
          baseDelayMs: this.baseDelayMs
        }
      );
    }

    const parsed = this.parseChatCompletionJson(response);
    return {
      value: normalizeText(parsed.value),
      confidence: clampConfidence(parsed.confidence),
      reason: normalizeText(parsed.reason),
      webSearchUsed: false,
      webSources: []
    };
  }

  async evaluateFieldChatBatch(payloads = [], options = {}) {
    const items = Array.isArray(payloads) ? payloads : [];
    const ipnBatchSize = Math.max(
      1,
      Math.min(300, Number(options?.ipnBatchSize || process.env.PHASE4_AI_IPN_BATCH_SIZE || 250) || 250)
    );
    const maxItemsPerCall = Math.max(
      1,
      Math.min(1200, Number(options?.maxItemsPerCall || process.env.PHASE4_AI_MAX_ITEMS_PER_CALL || 600) || 600)
    );

    const resultsByRequestId = new Map();
    const unresolved = [];
    for (let i = 0; i < items.length; i += 1) {
      const raw = items[i] || {};
      const requestId = normalizeText(raw.requestId || `${i + 1}`);
      const promptInput = this.buildFieldPromptInput(raw);
      const cached = this.getCachedFieldResult(promptInput);
      if (cached) {
        resultsByRequestId.set(requestId, { ...cached });
      } else {
        unresolved.push({ requestId, promptInput });
      }
    }
    if (unresolved.length === 0) {
      return { resultsByRequestId, failedCount: 0 };
    }

    const byPrefix = new Map();
    for (const item of unresolved) {
      const prefix = normalizeText(item?.promptInput?.prefix).toUpperCase() || '__NO_PREFIX__';
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
      byPrefix.get(prefix).push(item);
    }

    const requestBatches = [];
    for (const prefixItems of byPrefix.values()) {
      const byIpn = new Map();
      for (const item of prefixItems) {
        const ipn = normalizeText(item?.promptInput?.ipn).toUpperCase() || '__NO_IPN__';
        if (!byIpn.has(ipn)) byIpn.set(ipn, []);
        byIpn.get(ipn).push(item);
      }
      const ipnGroups = Array.from(byIpn.values());
      let cursor = [];
      let cursorIpns = 0;
      for (const group of ipnGroups) {
        const nextIpns = cursorIpns + 1;
        const nextItems = cursor.length + group.length;
        if (cursor.length > 0 && (nextIpns > ipnBatchSize || nextItems > maxItemsPerCall)) {
          requestBatches.push(cursor);
          cursor = [];
          cursorIpns = 0;
        }
        cursor.push(...group);
        cursorIpns += 1;
      }
      if (cursor.length > 0) requestBatches.push(cursor);
    }

    let failedCount = 0;
    for (let b = 0; b < requestBatches.length; b += 1) {
      const batch = requestBatches[b];
      const requestBody = {
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'Return only valid JSON.',
              'Resolve multiple item-specific fields for multiple IPNs.',
              'Never guess.',
              'Use only each item input evidence (masterPartsData, listingTitle, listingDescription, listingConditionsAndOptions, listingItemSpecifics, listingItemSpecificsAllCValuesRelevantToItem, allowedValues).',
              'If evidence is weak or missing, return empty value and low confidence.',
              'If allowedValues is non-empty, value must exactly match one allowed value.',
              'Output exact JSON shape: {"results":[{"requestId":"string","value":"string_or_empty","confidence":0,"reason":"short_reason"}]}'
            ].join(' ')
          },
          {
            role: 'user',
            content: JSON.stringify({
              task: 'phase4_field_resolution_first_pass_batch',
              items: batch.map(item => ({
                requestId: item.requestId,
                input: item.promptInput
              }))
            })
          }
        ]
      };
      const shouldUsePromptCache = this.promptCacheEnabled && this.promptCacheKey;
      if (shouldUsePromptCache) {
        requestBody.prompt_cache_key = `${this.promptCacheKey}_batch`;
      }
      const debugBatchItems = batch.filter(item => this.shouldDebugIpn(item?.promptInput?.ipn));
      if (debugBatchItems.length > 0) {
        const debugIpns = Array.from(
          new Set(debugBatchItems.map(item => normalizeText(item?.promptInput?.ipn).toUpperCase()).filter(Boolean))
        );
        console.log(
          '[Phase4AiEvaluatorService][DEBUG_PROMPT] First-pass batch requestBody:',
          JSON.stringify(
            {
              debugIpns,
              batchSize: batch.length,
              requestBody
            },
            null,
            2
          )
        );
      }

      let response;
      let batchFailed = false;
      try {
        response = await retryWithBackoff(
          async () => this.client.post('/chat/completions', requestBody),
          {
            maxAttempts: this.maxAttempts,
            baseDelayMs: this.baseDelayMs
          }
        );
      } catch (error) {
        if (shouldUsePromptCache && isPromptCacheUnsupported(error)) {
          this.promptCacheEnabled = false;
          delete requestBody.prompt_cache_key;
          try {
            response = await retryWithBackoff(
              async () => this.client.post('/chat/completions', requestBody),
              {
                maxAttempts: this.maxAttempts,
                baseDelayMs: this.baseDelayMs
              }
            );
          } catch (retryError) {
            batchFailed = true;
          }
        } else {
          batchFailed = true;
        }
      }
      if (debugBatchItems.length > 0) {
        const debugIpns = Array.from(
          new Set(debugBatchItems.map(item => normalizeText(item?.promptInput?.ipn).toUpperCase()).filter(Boolean))
        );
        console.log(
          '[Phase4AiEvaluatorService][DEBUG_PROMPT] First-pass batch raw response:',
          JSON.stringify(
            {
              debugIpns,
              batchSize: batch.length,
              response: response?.data || {}
            },
            null,
            2
          )
        );
      }

      if (batchFailed || !response) {
        failedCount += batch.length;
        for (const item of batch) {
          resultsByRequestId.set(item.requestId, {
            value: '',
            confidence: 0,
            reason: 'batch first-pass failed',
            webSearchUsed: false,
            webSources: []
          });
        }
        continue;
      }

      const parsed = this.parseChatCompletionJson(response);
      const rows = Array.isArray(parsed?.results) ? parsed.results : [];
      const parsedById = new Map();
      for (const row of rows) {
        const requestId = normalizeText(row?.requestId);
        if (!requestId) continue;
        parsedById.set(requestId, {
          value: normalizeText(row?.value),
          confidence: clampConfidence(row?.confidence),
          reason: normalizeText(row?.reason),
          webSearchUsed: false,
          webSources: []
        });
      }

      for (const item of batch) {
        const result = parsedById.get(item.requestId) || {
          value: '',
          confidence: 0,
          reason: 'no result returned',
          webSearchUsed: false,
          webSources: []
        };
        resultsByRequestId.set(item.requestId, result);
        this.setCachedFieldResult(item.promptInput, result);
      }

      if (typeof options?.onBatchComplete === 'function') {
        options.onBatchComplete({
          index: b + 1,
          total: requestBatches.length,
          size: batch.length
        });
      }
    }

    return { resultsByRequestId, failedCount };
  }

  async evaluateFieldWithWebSearch(promptInput = {}) {
    const webPromptInput = {
      ...promptInput,
      webEvidence:
        'Use web_search results only from allowed domains. Prefer direct listing/spec text over generic category pages.'
    };
    const requestBody = {
      model: this.webSearchModel,
      reasoning: { effort: 'low' },
      tool_choice: 'auto',
      include: ['web_search_call.action.sources'],
      tools: [
        {
          type: 'web_search',
          filters: {
            allowed_domains: this.webSearchAllowedDomains
          }
        }
      ],
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text:
                this.buildFieldResolutionSystemPrompt() +
                ` Only use web search sources from these domains: ${this.webSearchAllowedDomains.join(', ')}.`
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify(this.buildFieldResolutionUserPayload(webPromptInput, 'phase4_field_resolution_web_search'))
            }
          ]
        }
      ]
    };

    const response = await retryWithBackoff(
      async () =>
        this.client.post('/responses', requestBody, {
          timeout: this.webSearchTimeoutMs
        }),
      {
        maxAttempts: this.maxAttempts,
        baseDelayMs: this.baseDelayMs
      }
    );
    const text = this.extractResponsesText(response?.data || {});
    const parsed = extractJsonObject(text) || {};
    return {
      value: normalizeText(parsed.value),
      confidence: clampConfidence(parsed.confidence),
      reason: normalizeText(parsed.reason),
      webSearchUsed: true,
      webSources: this.extractWebSources(response?.data || {})
    };
  }

  async evaluateField(payload = {}) {
    const promptInput = this.buildFieldPromptInput(payload);
    const cached = this.getCachedFieldResult(promptInput);
    if (cached) return { ...cached };

    const currentIpn = normalizeText(promptInput.ipn).toUpperCase();
    const currentField = normalizeText(promptInput.fieldName);
    const debugKey = `${currentIpn}::${currentField}`.toUpperCase();
    const shouldDebug = this.shouldDebugIpn(currentIpn);
    if (shouldDebug && !this.loggedDebugPromptKeys.has(debugKey)) {
      console.log(
        '[Phase4AiEvaluatorService][DEBUG_PROMPT] Input payload for IPN:',
        currentIpn,
        JSON.stringify(promptInput, null, 2)
      );
    }

    const firstPass = await this.evaluateFieldChat(promptInput);

    if (shouldDebug && !this.loggedDebugPromptKeys.has(debugKey)) {
      console.log(
        '[Phase4AiEvaluatorService][DEBUG_PROMPT] First-pass result for IPN:',
        currentIpn,
        JSON.stringify(firstPass, null, 2)
      );
    }

    const skipWebSearch = payload?.skipWebSearch === true;
    const firstPassHigh =
      Boolean(firstPass?.value) && Number(firstPass?.confidence || 0) >= this.lowConfidenceThreshold;
    if (firstPassHigh || !this.webSearchEnabled || skipWebSearch) {
      if (shouldDebug && !this.loggedDebugPromptKeys.has(debugKey)) {
        this.loggedDebugPromptKeys.add(debugKey);
      }
      this.setCachedFieldResult(promptInput, firstPass);
      return firstPass;
    }

    if (shouldDebug && !this.loggedDebugPromptKeys.has(debugKey)) {
      console.log(
        '[Phase4AiEvaluatorService][DEBUG_PROMPT] Triggering web_search second pass for IPN:',
        currentIpn
      );
    }
    let secondPass;
    try {
      secondPass = await this.evaluateFieldWithWebSearch(promptInput);
    } catch (error) {
      if (shouldDebug && !this.loggedDebugPromptKeys.has(debugKey)) {
        const errorBody = error?.response?.data ? JSON.stringify(error.response.data) : '';
        console.log(
          '[Phase4AiEvaluatorService][DEBUG_PROMPT] web_search second pass failed for IPN:',
          currentIpn,
          error?.message || error,
          errorBody
        );
        this.loggedDebugPromptKeys.add(debugKey);
      }
      this.setCachedFieldResult(promptInput, firstPass);
      return firstPass;
    }
    if (shouldDebug && !this.loggedDebugPromptKeys.has(debugKey)) {
      console.log(
        '[Phase4AiEvaluatorService][DEBUG_PROMPT] Web-search result for IPN:',
        currentIpn,
        JSON.stringify(secondPass, null, 2)
      );
      this.loggedDebugPromptKeys.add(debugKey);
    }
    const secondPassHigh =
      Boolean(secondPass?.value) && Number(secondPass?.confidence || 0) >= this.lowConfidenceThreshold;
    if (secondPassHigh) {
      this.setCachedFieldResult(promptInput, secondPass);
      return secondPass;
    }

    const fallback = secondPass.confidence >= firstPass.confidence ? secondPass : firstPass;
    const finalResult = {
      ...fallback,
      webSearchUsed: true,
      webSources: secondPass.webSources || []
    };
    this.setCachedFieldResult(promptInput, finalResult);
    return finalResult;
  }

  async rewriteFitment(payload = {}) {
    const promptInput = {
      ipn: normalizeText(payload.ipn),
      productTitle: normalizeText(payload.productTitle),
      conditionsAndOptions: normalizeText(payload.conditionsAndOptions),
      rawFitmentText: normalizeText(payload.rawFitmentText)
    };

    const requestBody = {
      model: this.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Return only JSON. Rewrite compatibility text into concise buyer-friendly wording. Preserve meaning, avoid verbatim copying, avoid unsupported assumptions, and do not add marketing fluff.'
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'phase6_fitment_rewrite',
            expectedOutput: {
              fitment: 'rewritten_text_only'
            },
            input: promptInput
          })
        }
      ]
    };

    const shouldUsePromptCache = this.promptCacheEnabled && this.promptCacheKey;
    if (shouldUsePromptCache) {
      requestBody.prompt_cache_key = this.promptCacheKey;
    }

    let response;
    try {
      response = await retryWithBackoff(
        async () => this.client.post('/chat/completions', requestBody),
        {
          maxAttempts: this.maxAttempts,
          baseDelayMs: this.baseDelayMs
        }
      );
    } catch (error) {
      if (!shouldUsePromptCache || !isPromptCacheUnsupported(error)) {
        throw error;
      }
      this.promptCacheEnabled = false;
      delete requestBody.prompt_cache_key;
      response = await retryWithBackoff(
        async () => this.client.post('/chat/completions', requestBody),
        {
          maxAttempts: this.maxAttempts,
          baseDelayMs: this.baseDelayMs
        }
      );
    }

    const content = String(
      response?.data?.choices?.[0]?.message?.content || ''
    ).trim();
    const parsed = extractJsonObject(content) || {};
    const fitment = normalizeText(parsed.fitment || parsed.value || parsed.rewrittenFitment || '');

    return {
      fitment
    };
  }

  async generateTitleAndDescription(payload = {}) {
    const customTitlePrompt = normalizeText(
      payload.phase74TitleRulesPrompt || payload.customTitlePrompt || process.env.PHASE74_TITLE_RULES_PROMPT || ''
    );
    const promptInput = {
      ipn: normalizeText(payload.ipn),
      categoryContext: payload.categoryContext || {},
      conditionsAndOptions: normalizeText(payload.conditionsAndOptions),
      condition: normalizeText(payload.condition),
      conditionNote: normalizeText(payload.conditionNote),
      itemSpecifics: payload.itemSpecifics || {},
      partFitment: normalizeText(payload.partFitment),
      currentTitle: normalizeText(payload.currentTitle),
      currentLegacyTitle: normalizeText(payload.currentLegacyTitle),
      existingTitles: normalizeTextArray(payload.existingTitles),
      requiredTitleLength: { min: 65, max: 80 }
    };

    const defaultTitleRulesPrompt = [
      'eBay Title Rules Prompt',
      'Master Instructions - Follow Exactly',
      '1) Required title structure:',
      '[YEAR RANGE] [MAKE] [MODEL] [PART] [SIDE] [KEY DETAIL] OEM',
      '2) Title constraints:',
      '- Title length must be 65 to 80 characters.',
      '- Title must end with OEM.',
      '- OEM must appear once only, and only at the end.',
      '- Keep title clean, natural, and human-readable.',
      '- No keyword stuffing.',
      '3) Never change or remove:',
      '- Year must remain present after processing.',
      '- Make must not be changed.',
      '- Model must not be changed.',
      '4) Year handling:',
      '- Convert 2-digit ranges to 4-digit ranges (05-07 => 2005-2007, 13-19 => 2013-2019).',
      '- If year is missing, do not guess. Leave unchanged or flag for review in reasoningSummary.',
      '5) Title cleaning:',
      '- Remove SKU/stock numbers (especially suffix-like IDs).',
      '- Remove OEM Part text and Used Auto text.',
      '- Remove extra uses of Part.',
      '- Keep exactly one OEM at end.',
      '6) Side standardization (mandatory):',
      '- Driver side => Driver Left LH',
      '- Passenger side => Passenger Right RH',
      '7) SEO part name replacements (mandatory when applicable):',
      '- Accelerator Parts => Gas Pedal or Accelerator Pedal',
      '- Anti-Lock Brake Part => ABS Module or ABS Pump or Hydraulic Unit',
      '- Inside Mirror => Rear View Mirror',
      '- Throttle Valve Assembly => Throttle Body',
      '- Fuel Vapor Canister => EVAP Charcoal Canister',
      '- Audio Equipment Radio => Radio',
      '- Chassis ECM (590) => choose best single fit: ECM or ECU or PCM',
      '- Never stack duplicate synonyms.',
      '8) Extra optimization:',
      '- Optionally add Tested or OEM Tested when relevant.',
      '- Keep wording readable and non-spammy.',
      '9) No duplicate titles (hard rule):',
      '- Title must be unique against provided existingTitles.',
      '- If duplicate, apply controlled variation only:',
      '  * use approved part wording swap (for example ABS Pump <-> ABS Module)',
      '  * add/remove one small descriptor (for example w/ Motor, Assembly, Unit)',
      '  * slightly reposition one descriptor',
      '- Never alter year/make/model for uniqueness.',
      '10) Length control:',
      '- If too long, trim extra descriptors.',
      '- If too short, add relevant detail like Tested, Assembly, or Unit.',
      '11) Final checks before output:',
      '- Year present or flagged.',
      '- Make unchanged.',
      '- Model unchanged.',
      '- No SKU/junk text.',
      '- Side format standardized if side exists.',
      '- SEO replacements applied where relevant.',
      '- Ends with OEM once only.',
      '- 65-80 chars.',
      '- Clean/readable.',
      '- Unique against existingTitles.'
    ].join('\n');

    const requestBody = {
      model: this.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'Return only valid JSON.',
            'Generate an optimized eBay title and buyer-visible description from provided structured listing data.',
            'Do not invent facts or compatibility claims.',
            'Do not include HTML.',
            'Description must still be generated even when some optional item specifics are blank.'
          ].join(' ')
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'phase74_title_description_generation_v2',
            titleRulesPrompt: customTitlePrompt || defaultTitleRulesPrompt,
            requirements: [
              'Use Item Specifics - All C values and itemSpecifics as the primary title/description evidence.',
              'Use fitment only as supporting context when present.',
              'Keep description practical and buyer-readable.',
              'If a strict rule cannot be fully satisfied due to missing source data, explain briefly in reasoningSummary.'
            ],
            expectedOutput: {
              generatedTitle: 'string',
              generatedDescription: 'string',
              shortDescription: 'string_optional',
              reasoningSummary: 'string_short',
              validation: {
                titleLength: 'number',
                uniqueAgainstProvidedTitles: 'boolean',
                endsWithOemOnce: 'boolean'
              }
            },
            input: promptInput
          })
        }
      ]
    };

    const shouldUsePromptCache = this.promptCacheEnabled && this.promptCacheKey;
    if (shouldUsePromptCache) {
      requestBody.prompt_cache_key = this.promptCacheKey;
    }

    let response;
    try {
      response = await retryWithBackoff(
        async () => this.client.post('/chat/completions', requestBody),
        {
          maxAttempts: this.maxAttempts,
          baseDelayMs: this.baseDelayMs
        }
      );
    } catch (error) {
      if (!shouldUsePromptCache || !isPromptCacheUnsupported(error)) {
        throw error;
      }
      this.promptCacheEnabled = false;
      delete requestBody.prompt_cache_key;
      response = await retryWithBackoff(
        async () => this.client.post('/chat/completions', requestBody),
        {
          maxAttempts: this.maxAttempts,
          baseDelayMs: this.baseDelayMs
        }
      );
    }

    const content = String(
      response?.data?.choices?.[0]?.message?.content || ''
    ).trim();
    const parsed = extractJsonObject(content) || {};
    const generatedTitle = normalizeText(parsed.generatedTitle || parsed.title || parsed.optimizedTitle);
    const generatedDescription = normalizeText(
      parsed.generatedDescription || parsed.description || parsed.aiDescription
    );
    return {
      generatedTitle,
      generatedDescription,
      shortDescription: normalizeText(parsed.shortDescription),
      reasoningSummary: normalizeText(parsed.reasoningSummary)
    };
  }
}

module.exports = Phase4AiEvaluatorService;
