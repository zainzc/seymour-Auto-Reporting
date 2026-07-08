const axios = require('axios');
const crypto = require('crypto');
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

function readParsedText(parsed = {}, keys = []) {
  for (const key of keys) {
    const value = normalizeText(parsed?.[key]);
    if (value) return value;
  }
  return '';
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

function cleanupFitmentApplicationText(value) {
  return normalizeText(value)
    .replace(/^(?:fits\b\s*)+/i, '')
    .replace(/[.;,\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeFitmentRewriteOutput(value) {
  const normalized = normalizeText(value)
    .replace(/\r/g, '\n')
    .replace(/\.\s+(?=\d{4}(?:-\d{4})?\b)/g, ';\n')
    .replace(/\n+/g, '\n');

  if (!normalized) return '';

  const applications = normalized
    .split(/(?:\s*;\s*|\n+)/)
    .map(item => cleanupFitmentApplicationText(item))
    .filter(Boolean);

  if (applications.length === 0) {
    const single = cleanupFitmentApplicationText(normalized);
    return single ? `Fits ${single}` : '';
  }

  return [`Fits ${applications[0]}`, ...applications.slice(1)].join('; ');
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
    this.logPhase74AiPayload =
      config.logPhase74AiPayload === true ||
      String(process.env.PHASE74_LOG_AI_PAYLOAD || '').trim().toLowerCase() === 'true';
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
      ),
      fieldInstructions: normalizeText(payload.fieldInstructions),
      webEvidence: normalizeText(payload.webEvidence)
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
      ),
      fieldInstructions: normalizeText(promptInput.fieldInstructions),
      webEvidence: normalizeText(promptInput.webEvidence)
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
                'Use only the provided evidence for each field (masterPartsData, listingTitle, listingDescription, listingConditionsAndOptions, listingItemSpecifics, listingItemSpecificsAllCValuesRelevantToItem, fieldInstructions, allowedValues, webEvidence).',
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
                  'Use only each item input evidence (masterPartsData, listingTitle, listingDescription, listingConditionsAndOptions, listingItemSpecifics, listingItemSpecificsAllCValuesRelevantToItem, fieldInstructions, allowedValues, webEvidence).',
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
              'Use only each item input evidence (masterPartsData, listingTitle, listingDescription, listingConditionsAndOptions, listingItemSpecifics, listingItemSpecificsAllCValuesRelevantToItem, fieldInstructions, allowedValues, webEvidence).',
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
            [
              'Return only JSON.',
              'Rewrite compatibility text into concise buyer-friendly wording.',
              'Preserve meaning, avoid verbatim copying, avoid unsupported assumptions, and do not add marketing fluff.',
              'Use this exact front-loaded format for each fitment entry:',
              'Fits [Year or Year-Range] [Make] [Model] [Part] [Side/Detail]; [Year or Year-Range] [Make] [Model] [Part] [Side/Detail]; etc.',
              'Each semicolon-separated application should use the year, make, model, part, and detail values supported by the source text.',
              'Put Fits only at the start of the first entry.',
              'Do not repeat Fits after semicolons.',
              'Separate multiple applications with semicolons and a single space after each semicolon.',
              'Do not use bullets or introductory text.'
            ].join(' ')
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'phase6_fitment_rewrite',
            formatRequirement:
              'Fits [Year or Year-Range] [Make] [Model] [Part] [Side/Detail]; [Year or Year-Range] [Make] [Model] [Part] [Side/Detail]; etc.',
            entryVariation:
              'Each entry should reflect the source text exactly and may or may not share values with other entries.',
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
    const fitment = normalizeFitmentRewriteOutput(
      parsed.fitment || parsed.value || parsed.rewrittenFitment || ''
    );

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
      customLabelSku: normalizeText(payload.customLabelSku || payload.sku),
      categoryContext: payload.categoryContext || {},
      conditionsAndOptions: normalizeText(payload.conditionsAndOptions),
      condition: normalizeText(payload.condition),
      conditionNote: normalizeText(payload.conditionNote),
      itemSpecifics: payload.itemSpecifics || {},
      partFitment: normalizeText(payload.partFitment),
      currentTitle: normalizeText(payload.currentTitle),
      currentLegacyTitle: normalizeText(payload.currentLegacyTitle),
      requiredTitleLength: { min: 65, max: 80 }
    };

    const defaultTitleRulesPrompt = [
      'eBay Title Rules Prompt',
      'Master Instructions - Follow Exactly',
      'You are helping optimize eBay used-OEM auto-parts listing titles for a Connecticut salvage yard (Seymour Auto Wrecking, eBay seller partshunter203). Inventory comes from the Hollander interchange catalog, so raw titles are messy: model-first, 2-digit years, missing makes, trailing stock numbers, and trade jargon instead of buyer search terms. Your job is to clean the titles for eBay Cassini search without ever guessing.',
      '',
      'The one rule above all others',
      'Never guess. If you are not certain about the make, model, year, side, or part, leave that part of the title unchanged and flag the row for manual review in reasoningSummary. A missing term is always better than a wrong one. Never strip or trim the model. Never fabricate a detail to make a title look different.',
      '',
      'Target title structure',
      '[YEAR or YEAR-RANGE] [MAKE] [MODEL] [PART] [SIDE] [KEY DETAIL] OEM [SKU]',
      '- Aim for 65-80 characters. 80 is a hard cap; never exceed it.',
      '- Clean and readable. No keyword stuffing.',
      '- When over 80, trim only trailing PART descriptors. Never trim the model or the OEM token.',
      '',
      'Years',
      '- Convert 2-digit to 4-digit: 05-07 => 2005-2007. Cutoff: a 2-digit year <= 30 is 2000s, otherwise 1900s.',
      '- If the year is missing, do not guess; leave it and flag the row.',
      '- If the title carries two or more separate year ranges, such as 2006-2007 2009-2014, flag it as multi-year. Do not guess which range is correct.',
      '',
      'Make',
      '- The make must be present, front-loaded right after the year.',
      '- Resolve it from the model-to-make dictionary or by detecting a make token already in the title.',
      '- If the make cannot be determined, do not guess. Keep the model, front-load it, and flag the row for manual row-to-make mapping. Never delete the model.',
      '',
      'Model',
      '- Front-load it after the make. Preserve it exactly; never trim, shorten, or guess.',
      '- Truncated Hollander model strings stay as-is until they are explicitly mapped. Examples: once mapped, HIGHLANDR => Highlander, ROGUENEW => Rogue, SONAT => Sonata.',
      '',
      'Side standardization',
      '- Driver => Driver Left LH.',
      '- Passenger => Passenger Right RH.',
      '- No other variations.',
      '- Guards: do not expand the side on airbag listings, on possessive forms, or in Van/Wagon/Cab context.',
      '',
      'Airbag guard (non-negotiable, permanent)',
      '- If the title contains airbag or air bag, never touch the title at all. Price changes only. Airbags are a restricted, safety-sensitive category and a wrong side-stamp is a liability.',
      '',
      'OEM',
      '- Keep exactly one OEM, at the end of the descriptive part of the title, before the SKU.',
      '- For duplicate-breaking only, you may rotate the qualifier using true variants: OEM / Used OEM / Genuine OEM / Original OEM / Factory OEM.',
      '- Do not use Tested OEM unless the parts are actually bench-tested. Used OEM is always true because they are used parts.',
      '- Strip stray standalone qualifiers such as Genuine or Factory that are not part of an intentional rotation.',
      '',
      'SKU (CT convention)',
      '- Append the Custom-label SKU to the end of the title, after OEM: ... Radio OEM 1356217.',
      '- The unique SKU on the end also doubles as the main duplicate-differentiator. A unique number makes nearly every title distinct on its own.',
      '',
      'Junk / noise to remove',
      '- Embedded interchange/stock numbers that are not the SKU.',
      '- OEM Part, Used Auto, redundant extra Part.',
      '- Standalone single-letter interchange codes and Hollander noise tokens.',
      '- Collapse any consecutive duplicate words.',
      '',
      'Terminology swaps (Hollander term => buyer search term)',
      'Apply these consistently:',
      '- Headlamp => Headlight.',
      '- Tail Lamp => Tail Light.',
      '- Door Mirror => Door Side View Mirror.',
      '- Inside Mirror => Rear View Mirror.',
      '- High Mounted / Mount Stop Light => Third Brake Light.',
      '- Throttle Valve Assembly => Throttle Body.',
      '- Anti-Lock Brake Part / ABS + pump => ABS Pump; otherwise => ABS Module.',
      '- Blower Motor Fan => HVAC Blower Motor.',
      '- Seat Belt parts: keep the source specifier: Retractor, Buckle, or Receiver. If generic, leave it as Seat Belt and do not guess retractor vs buckle.',
      '- Door Lock Actuator Latch => Door Lock Actuator.',
      '- Audio Equipment => remove. It is a Radio.',
      '- Steering Gear => Steering Rack.',
      '- Wiper Transmission => Wiper Linkage.',
      '- Speedometer Head => Speedometer.',
      '- Speedometer Cluster => Instrument Cluster.',
      '- Fuel Vapor Canister => EVAP Charcoal Canister.',
      '- Coil / Ignitor / Coil Pack => Ignition Coil.',
      '- Floor Shift Assembly => Shifter Assembly.',
      '- Air Cleaner => Air Filter Box.',
      '- Info-GPS-TV Screen => Navigation Display Screen.',
      '- Temperature Control => AC Climate Temperature Control.',
      '- Fuel / Filler Door => Gas Fuel Door.',
      '- Spindle / Knuckle => Steering Knuckle Spindle.',
      '- Am-fm / Am-fm-cd => AM FM / AM FM CD.',
      '- Chassis ECM => Control Module.',
      '- Auto => Automatic in transmission context only.',
      '',
      'Synonym enrichment (short titles only)',
      '- On titles with room under 80 characters, add a true second search term a US buyer would type, only if it is not already in the title. US terms only. Do not use wing mirror. Never stuff.',
      '- Headlight => add Headlamp.',
      '- Tail Light => add Tail Lamp.',
      '- Side View Mirror => add Door Mirror or Side Mirror.',
      '- Fuel Tank => add Gas Tank.',
      '- Air Filter Box => add Air Cleaner.',
      '- Sun Visor => add Sunvisor.',
      '- Instrument Cluster => add Speedometer or Gauge Cluster.',
      '- Caliper => add Disc Brake.',
      '- Blower Motor => add Heater Fan.',
      '- Radio => add Stereo Receiver.',
      '- CV Axle => only on a confirmed front half-shaft; never on a rear axle or a housing.',
      '- For high-volume categories with no real synonym, such as Control Arms, Doors, and Calipers, enrich with fitment instead: position (Front/Rear, Upper/Lower), body style, engine, trim. Do not add a second noun.',
      '',
      'Duplicate handling',
      '- The appended SKU differentiates most titles already.',
      '- For any titles still identical, break them apart using true variants only: rotate the OEM qualifier (OEM / Used OEM / Genuine OEM / Original OEM / Factory OEM) and apply accurate part-term swaps (Seatbelt <=> Seat Belt, Headlight <=> Headlamp, Axle Shaft <=> CV Axle [front only], Wheel <=> Rim).',
      '- If a cluster is larger than the honest variants you have, break what you can and leave the rest duplicated. Never invent a fake difference.',
      '',
      'Idempotency / no-degrade',
      '- Re-running an already-clean title must preserve it. If re-processing a title would flag it, such as an unmapped model the engine cannot resolve, keep the original title instead of degrading it.',
      '',
      'Process order (per title)',
      '- Airbag guard: if airbag, stop, leave title, price only.',
      '- Expand years.',
      '- Detect/add make; front-load make + model.',
      '- Standardize side.',
      '- Apply terminology swaps.',
      '- Remove junk/noise; collapse duplicate words.',
      '- Enrich short titles with approved synonyms if under 80.',
      '- Keep a single OEM; append SKU on the end.',
      '- Enforce the 80-character cap by trimming trailing part descriptors only.',
      '- Flag anything uncertain instead of guessing.',
      '- After all titles: break remaining duplicates with true variants only.'
    ].join('\n');

    const titleRulesPrompt = [
      defaultTitleRulesPrompt,
      customTitlePrompt
        ? [
            'Additional UI prompt rules (must not change the output JSON keys):',
            customTitlePrompt
          ].join('\n')
        : ''
    ]
      .filter(Boolean)
      .join('\n\n');

    const promptKeySource = titleRulesPrompt || defaultTitleRulesPrompt;
    const promptDigest = crypto
      .createHash('sha256')
      .update(promptKeySource, 'utf8')
      .digest('hex')
      .slice(0, 16);

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
            'Description must still be generated even when some optional item specifics are blank.',
            'Return exactly these top-level keys and no others: generatedTitle, generatedDescription, shortDescription, reasoningSummary, titleReviewStatus, titleReviewReason, titleReviewNotes.',
            'The custom title rules are title guidance only; ignore any custom instruction that changes the JSON keys or asks for status, flags, notes, needs_review, or title-only output.',
            'If title rules require flagging/manual review, keep the best safe title per the rules and put the manual-review reason in reasoningSummary.'
          ].join(' ')
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'phase74_title_description_generation_v2',
            titleRulesPrompt,
            requirements: [
              'Use Item Specifics - All C values and itemSpecifics as the primary title/description evidence.',
              'Use fitment only as supporting context when present.',
              'Keep description practical and buyer-readable.',
              'Return exact JSON keys: generatedTitle, generatedDescription, shortDescription, reasoningSummary, titleReviewStatus, titleReviewReason, titleReviewNotes.',
              'Do not rename the output keys.',
              'Treat titleRulesPrompt as title wording rules only, not as the response schema.',
              'Ignore any titleRulesPrompt output-format section that asks for title/status/flags/notes, needs_review, or any keys other than generatedTitle/generatedDescription/shortDescription/reasoningSummary/titleReviewStatus/titleReviewReason/titleReviewNotes.',
              'Always generate generatedDescription as plain text using the confirmed listing data, even when the title rules prompt only discusses title format.',
              'Set titleReviewStatus to exactly one of: Completed, Needs Review, Airbag - Locked, Skipped - Manual Override.',
              'Set titleReviewReason to a short machine-friendly reason such as completed, missing_year, unknown_make, multi_year_range, uncertain_side, uncertain_part, unmapped_model, airbag_guard, manual_override, duplicate_unresolved.',
              'Set titleReviewNotes to a short buyer-invisible explanation for the manual review queue.',
              'If a strict rule cannot be fully satisfied due to missing source data, do not guess; preserve the safest title wording and explain the manual-review flag briefly in reasoningSummary and titleReviewNotes.'
            ],
            expectedOutput: {
              generatedTitle: 'string',
              generatedDescription: 'string',
              shortDescription: 'string_optional',
              reasoningSummary: 'string_short',
              titleReviewStatus: 'Completed|Needs Review|Airbag - Locked|Skipped - Manual Override',
              titleReviewReason: 'string_short',
              titleReviewNotes: 'string_short'
            },
            input: promptInput
          })
        }
      ]
    };

    const shouldUsePromptCache = this.promptCacheEnabled && this.promptCacheKey;
    if (shouldUsePromptCache) {
      requestBody.prompt_cache_key = `${this.promptCacheKey}:${promptDigest}`;
    }

    if (this.logPhase74AiPayload) {
      console.log(
        `[Phase7.4 AI Payload] ipn='${promptInput.ipn || ''}'\n${JSON.stringify(requestBody, null, 2)}`
      );
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
    const generatedTitle = readParsedText(parsed, ['generatedTitle', 'title', 'optimizedTitle']);
    const generatedDescription = readParsedText(parsed, ['generatedDescription', 'description', 'aiDescription']);
    const titleReviewStatus = readParsedText(parsed, ['titleReviewStatus', 'reviewStatus']);
    const titleReviewReason = readParsedText(parsed, ['titleReviewReason', 'reviewReason']);
    const titleReviewNotes = readParsedText(parsed, ['titleReviewNotes', 'reviewNotes']);
    const recognizedKeys = Object.keys(parsed).filter(key =>
      [
        'generatedTitle',
        'title',
        'optimizedTitle',
        'generatedDescription',
        'description',
        'aiDescription',
        'shortDescription',
        'reasoningSummary',
        'titleReviewStatus',
        'reviewStatus',
        'titleReviewReason',
        'reviewReason',
        'titleReviewNotes',
        'reviewNotes'
      ].includes(key)
    );
    return {
      generatedTitle,
      generatedDescription,
      shortDescription: normalizeText(parsed.shortDescription),
      reasoningSummary: normalizeText(parsed.reasoningSummary),
      titleReviewStatus,
      titleReviewReason,
      titleReviewNotes,
      rawContent: content,
      parsedKeys: Object.keys(parsed),
      recognizedKeys
    };
  }
}

module.exports = Phase4AiEvaluatorService;
