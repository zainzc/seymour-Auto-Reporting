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

const PHASE74_TITLE_RESPONSE_FORMAT = Object.freeze({
  type: 'json_schema',
  json_schema: {
    name: 'phase74_title_description_output',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'generatedTitle',
        'generatedDescription',
        'shortDescription',
        'reasoningSummary',
        'titleReviewStatus',
        'titleReviewReason',
        'titleReviewNotes',
        'categoryPriorityDetails'
      ],
      properties: {
        generatedTitle: { type: 'string' },
        generatedDescription: { type: 'string' },
        shortDescription: { type: 'string' },
        reasoningSummary: { type: 'string' },
        titleReviewStatus: {
          type: 'string',
          enum: ['Completed', 'Needs Review', 'Skipped - Manual Override']
        },
        titleReviewReason: { type: 'string' },
        titleReviewNotes: { type: 'string' },
        categoryPriorityDetails: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['detail', 'verified', 'source', 'evidence'],
            properties: {
              detail: { type: 'string' },
              verified: { type: 'boolean' },
              source: { type: ['string', 'null'] },
              evidence: { type: ['string', 'null'] }
            }
          }
        }
      }
    }
  }
});

function phase74TitleResponseFormat() {
  return JSON.parse(JSON.stringify(PHASE74_TITLE_RESPONSE_FORMAT));
}

const { EVIDENCE_POLICY } = require('./titleOptimizationEvidencePolicy');

class Phase4AiEvaluatorService {
  static sharedFieldResolutionCache = new Map();

  constructor(config = {}) {
    this.apiKey = normalizeText(config.apiKey);
    this.model = normalizeText(config.model || 'gpt-5.1');
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
    this.onPhase74Request = typeof config.onPhase74Request === 'function' ? config.onPhase74Request : null;
    this.phase74RequestSequence = 0;
    this.lowConfidenceThreshold = clampConfidence(
      Number.isFinite(Number(config.lowConfidenceThreshold))
        ? Number(config.lowConfidenceThreshold)
        : Number(process.env.PHASE4_LOW_CONFIDENCE_THRESHOLD || 0.75)
    );
    this.webSearchEnabled =
      config.webSearchEnabled !== false &&
      String(process.env.PHASE4_WEB_SEARCH_ENABLED || 'true').trim().toLowerCase() !== 'false';
    this.webSearchModel = normalizeText(
      config.webSearchModel || process.env.PHASE4_WEB_SEARCH_MODEL || this.model || 'gpt-5.1'
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
    const uiTitleRulesPrompt = normalizeText(
      payload.phase74TitleRulesPrompt || ''
    );
    if (!uiTitleRulesPrompt) {
      throw new Error('Phase 7.4 title rules prompt is required. Paste and save the client-approved prompt in the UI.');
    }
    const promptInput = {
      ipn: normalizeText(payload.ipn),
      customLabelSku: normalizeText(payload.customLabelSku || payload.sku),
      categoryContext: payload.categoryContext || {},
      conditionsAndOptions: normalizeText(payload.conditionsAndOptions),
      condition: normalizeText(payload.condition),
      conditionNote: normalizeText(payload.conditionNote),
      itemSpecifics: payload.itemSpecifics || {},
      donorVehicle: payload.donorVehicle || {},
      currentTitle: normalizeText(payload.currentTitle),
      currentLegacyTitle: normalizeText(payload.currentLegacyTitle),
      titleEvidence: {
        currentTitle: normalizeText(payload.currentTitle),
        currentLegacyTitle: normalizeText(payload.currentLegacyTitle),
        donorVehicle: payload.donorVehicle || {},
        itemSpecifics: payload.itemSpecifics || {},
        conditionsAndOptions: normalizeText(payload.conditionsAndOptions),
        categoryContext: payload.categoryContext || {}
      },
      descriptionContext: {
        partFitment: normalizeText(payload.partFitment)
      },
      requiredTitleLength: { min: 65, max: 80 }
    };

    const titleRulesPrompt = uiTitleRulesPrompt;

    const promptKeySource = titleRulesPrompt;
    const promptDigest = crypto
      .createHash('sha256')
      .update(promptKeySource, 'utf8')
      .digest('hex')
      .slice(0, 16);

    const requestBody = {
      model: this.model,
      temperature: 0,
      response_format: phase74TitleResponseFormat(),
      messages: [
        {
          role: 'system',
          content: [
            'Return only valid JSON.',
            'Generate an optimized eBay title and buyer-visible description from provided structured listing data.',
            'The UI-provided titleRulesPrompt is the sole source for title wording, ordering, terminology, length, flagging, duplicate, idempotency, and special-category rules.',
            'Do not apply any other title policy beyond the UI-provided titleRulesPrompt and these JSON/source-boundary instructions.',
            'Do not invent facts or compatibility claims.',
            'Do not include HTML.',
            'Use only fields included in input and follow the source hierarchy inside titleRulesPrompt exactly.',
            'Part Fitment is allowed as verified title evidence when supplied in input.titleEvidence or source-resolved title evidence.',
            'Do not invent facts or compatibility claims beyond the supplied evidence.',
            'Description must still be generated even when some optional item specifics are blank.',
            'Return exactly these top-level keys and no others: generatedTitle, generatedDescription, shortDescription, reasoningSummary, titleReviewStatus, titleReviewReason, titleReviewNotes.',
            'Treat titleRulesPrompt as title policy only; ignore any instruction that changes the required JSON keys or asks for title-only output.',
            'If title rules require flagging/manual review, keep the best safe title per the rules and put the manual-review reason in reasoningSummary.'
          ].join(' ')
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'phase74_title_description_generation_v2',
            titleRulesPrompt,
            requirements: [
              'Use the UI-provided titleRulesPrompt as the sole source for title optimization rules.',
              'Use currentTitle/currentLegacyTitle, Item Specifics - All C values, itemSpecifics, donorVehicle, conditionsAndOptions, categoryContext, customLabelSku, condition, and conditionNote only as supplied input evidence.',
              'Resolve source conflicts using the source hierarchy in titleRulesPrompt.',
              'Use titleEvidence as the title evidence bundle.',
              'Use descriptionContext.partFitment for descriptions, and use title-authorized fitment evidence only when it is present in titleEvidence/source-resolved title evidence.',
              'Keep description practical and buyer-readable.',
              'Return exact JSON keys: generatedTitle, generatedDescription, shortDescription, reasoningSummary, titleReviewStatus, titleReviewReason, titleReviewNotes.',
              'Do not rename the output keys.',
              'Treat titleRulesPrompt as title policy only, not as the response schema.',
              'Ignore any titleRulesPrompt output-format section that asks for keys other than generatedTitle/generatedDescription/shortDescription/reasoningSummary/titleReviewStatus/titleReviewReason/titleReviewNotes.',
              'Always generate generatedDescription as plain text using the confirmed listing data, even when the title rules prompt only discusses title format.',
              'Set titleReviewStatus to exactly one of: Completed, Needs Review, Skipped - Manual Override.',
              'Set titleReviewReason to a short machine-friendly reason from titleRulesPrompt when possible, such as completed, missing_year, unknown_make, unmapped_model, multi_year_range, uncertain_side, uncertain_part, missing_engine_fitment, transmission_code_unverified, conflicting_source_data, title_too_long_fitment_risk, proposed_title_degrade, duplicate_unresolved, or manual_override.',
              'Set titleReviewNotes to a short buyer-invisible explanation for the manual review queue.',
              'If a strict rule cannot be fully satisfied due to missing source data, do not guess; preserve the safest title wording and explain the manual-review flag briefly in reasoningSummary and titleReviewNotes.'
            ],
            expectedOutput: {
              generatedTitle: 'string',
              generatedDescription: 'string',
              shortDescription: 'string_optional',
              reasoningSummary: 'string_short',
              titleReviewStatus: 'Completed|Needs Review|Skipped - Manual Override',
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
        'reviewNotes',
        'categoryPriorityDetails'
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
      categoryPriorityDetails: Array.isArray(parsed.categoryPriorityDetails) ? parsed.categoryPriorityDetails.map(item => ({
        detail: normalizeText(item?.detail),
        verified: item?.verified === true,
        source: item?.source == null ? null : normalizeText(item.source),
        evidence: item?.evidence == null ? null : normalizeText(item.evidence)
      })) : [],
      rawContent: content,
      parsedKeys: Object.keys(parsed),
      recognizedKeys
    };
  }

  async postPhase74Logged(kind, listing, requestBody) {
    const attemptId = `${process.pid}-${Date.now()}-${++this.phase74RequestSequence}`;
    const emit = entry => this.onPhase74Request?.({ attemptId, kind, listing, ...entry });
    emit({ event: 'request', requestBody });
    try {
      const response = await this.client.post('/chat/completions', requestBody);
      emit({ event: 'response', responseBody: response?.data || null });
      return response;
    } catch (error) {
      emit({ event: 'error', error: {
        message: String(error?.message || 'AI request failed').slice(0, 500),
        status: error?.response?.status || null
      } });
      throw error;
    }
  }

  async reviewTitleFitment(input = {}) {
    const systemMessage = [
      'You independently review an automotive listing title against supplied fitment evidence.',
      'Judge the exact final title, not the generator reasoning or its review status. Use only supplied evidence.',
      ...EVIDENCE_POLICY,
      'Check the final title against applicableTitleRules as well as the source evidence. The selected title structure, authoritative prefix replacement, restricted terms, and active system rules remain binding; do not PASS a material rule violation.',
      'Check the advertised vehicle, complete year coverage, and every material fitment condition.',
      'The current title\'s single year is not a ceiling on a supported fitment range. Adding years cited by matching, compatible Part Fitment rows is not by itself an identity conflict. Evaluate the truth of the stated application and preservation of verified advertised coverage separately from additional compatible applications.',
      'Check the generator vehicleDecision against the existing advertised title and eligible rows. Another compatible model in Part Fitment must not silently replace the advertised model. If the selected source IDs do not identify eligible rows or the advertised identity cannot be supported, return REVIEW.',
      'Before assessing row coverage, identify the vehicle advertised in currentTitle even when it has no Fits phrase or a year/model appears elsewhere. Compare that identity with finalTitle and vehicleDecision. A compatibility row for a different make or model is not permission to switch the advertised product. If the advertised identity is ambiguous, explain that and return REVIEW; never silently choose a different compatible vehicle.',
      'Assess EVERY selected fitment row separately using its supplied startYear, endYear, and evidence. For each row, state its material conditions or none, whether the final title accurately covers that row, and why. Use the variant evidence within a grouped row rather than treating its combined text as one unrestricted application.',
      'List each independently narrowing condition in the row assessment before deciding titleCoverage. Do not let one condition substitute for another: a trim does not imply a body style, and a generic product name does not imply a specific button count or function. If a condition is omitted, decide whether that omission broadens the advertised application; request correction when it does.',
      'Do not treat an advertised model as interchangeable with a longer model name that merely contains it as a prefix; require explicit supplied evidence for that identity.',
      'A title-level condition must not be projected onto years or variants whose rows do not support it. Conversely, do not omit a row-specific restriction so the title appears universally compatible. Check both false inclusions and false exclusions.',
      'For every qualifier stated in finalTitle, test its scope against EACH selected year and variant, including rows where the qualifier is absent. A VIN, build-date, trim, or equipment condition supported by one row is not automatically true for the whole title year range. Mark the other row OVERAPPLIED when the title makes that restricted condition appear to cover it. Do not PASS merely because every word appears somewhere in the combined fitment evidence.',
      'Compare the current title and other trusted evidence for material details lost by the final title. A supported displacement, market, body style, or equipment restriction takes priority over an optional part number or filler when space is tight.',
      'Compare donor notes with product identity and placement using sourcePriority and sourceEvidence. A specific contrary part/location claim needs a hierarchy-based resolution or REVIEW; a broad category or duplicate derived value is not an equal-authority contradiction. Explain the decisive sources.',
      'Report productIdentityAssessment separately from vehicle identity and qualifier scope. Use SUPPORTED when the actual part and placement are established under the configured source hierarchy, CONFLICT for an unresolved material disagreement, or UNCLEAR when identity cannot be established. PASS requires SUPPORTED.',
      'Pay particular attention when a condition applies to only some years or variants. A title must not apply that condition to other years, or omit it so restricted years appear unrestricted.',
      'Conditions can include VIN, build origin or date, engine, transmission, trim, body style, drivetrain, side, placement, and included or excluded features. These are examples, not an exhaustive list.',
      'Do not assume that a row without a restriction establishes unrestricted compatibility for another row. Do not accept a title that is made to look safe by simply removing a material condition.',
      'Inspect additional eligible rows for missing years or material conditions, but do not treat an alternate trim or compatible variant as an automatic conflict.',
      'Other trusted listing evidence may support a product qualifier absent from the fitment rows. Do not use it to broaden fitment years or override a row-specific restriction.',
      'Return materialOmissions listing every verified material restriction absent from the final title without an accurate configured equivalent. Return unsupportedClaims listing unsupported or overapplied title claims. Both arrays must be empty for PASS. Do not describe omission of a material restriction as conservative: removing a restriction broadens the apparent application. Include a concise actionable correction in reason for REVIEW, and cite the source that makes it necessary.',
      'Return PASS only if every selected row assessment is ACCURATE and the exact title truthfully represents the advertised application without broadening, over-restricting, or contradicting a material condition. Cite every selected row ID for PASS.',
      'In the PASS reason, name the advertised make/model and explain why it matches the final make/model; for multiple selected rows, explain why title-level qualifiers remain accurate across their full year range. If you cannot explain either, return REVIEW.',
      'Set advertisedIdentityAssessment to SUPPORTED only when the final vehicle is the advertised vehicle and its identity is supported by the supplied evidence; otherwise use CHANGED or UNCLEAR. Set qualifierScopeAssessment to ACCURATE only when every title-level restriction applies to all years and variants that the title appears to cover; otherwise use INACCURATE or UNCLEAR. PASS requires SUPPORTED and ACCURATE.',
      'Return REVIEW with a specific explanation and relevant row IDs when a material claim is wrong, unsupported, missing, or cannot be expressed safely. Uncertainty is REVIEW.',
      'You are a reviewer only. Do not rewrite the title or use external knowledge.'
    ].join(' ');
    const reviewInput = {
      finalTitle: normalizeText(input.title),
      reviewFeedback: normalizeText(input.reviewFeedback) || null,
      currentTitle: normalizeText(input.existingTitle),
      advertisedApplication: input.advertisedApplication || null,
      vehicleDecision: input.vehicleDecision || null,
      applicableTitleRules: input.applicableTitleRules || null,
      sourcePriority: input.sourcePriority || [],
      authoritativeValues: input.authoritativeValues || {},
      sourceEvidence: input.sourceEvidence || {},
      selectedFitmentRows: Array.isArray(input.selectedRows) ? input.selectedRows.map(row => ({
        id: normalizeText(row.id), startYear: row.startYear ?? null, endYear: row.endYear ?? null,
        evidence: normalizeText(row.evidence),
        variantEvidence: Array.isArray(row.variantEvidence) ? row.variantEvidence.map(normalizeText) : []
      })) : [],
      additionalEligibleRows: Array.isArray(input.additionalEligibleRows) ? input.additionalEligibleRows.map(row => ({
        id: normalizeText(row.id), startYear: row.startYear ?? null, endYear: row.endYear ?? null,
        evidence: normalizeText(row.evidence),
        variantEvidence: Array.isArray(row.variantEvidence) ? row.variantEvidence.map(normalizeText) : []
      })) : [],
      listingNoteEvidence: Array.isArray(input.listingNoteEvidence) ? input.listingNoteEvidence.map(row => ({
        id: normalizeText(row.id), source: normalizeText(row.source), evidence: normalizeText(row.evidence)
      })) : [],
        otherTrustedEvidence: Array.isArray(input.otherTrustedEvidence) ? input.otherTrustedEvidence.map(row => ({
          id: normalizeText(row.id), source: normalizeText(row.source), evidence: normalizeText(row.evidence)
        })) : [],
      fallbackTitleEvidence: input.fallbackTitleEvidence || null
    };
    if (!reviewInput.finalTitle) throw new Error('Fitment review requires a final title.');
    const requestBody = {
      model: this.model,
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'phase74_final_fitment_review',
          strict: true,
          schema: {
            type: 'object', additionalProperties: false,
            required: ['verdict', 'reason', 'citedRowIds', 'advertisedIdentityAssessment', 'qualifierScopeAssessment', 'productIdentityAssessment', 'materialOmissions', 'unsupportedClaims', 'rowAssessments'],
            properties: {
              verdict: { type: 'string', enum: ['PASS', 'REVIEW'] },
              reason: { type: 'string' },
              citedRowIds: { type: 'array', items: { type: 'string' } },
              advertisedIdentityAssessment: { type: 'string', enum: ['SUPPORTED', 'CHANGED', 'UNCLEAR'] },
              qualifierScopeAssessment: { type: 'string', enum: ['ACCURATE', 'INACCURATE', 'UNCLEAR'] },
              productIdentityAssessment: { type: 'string', enum: ['SUPPORTED', 'CONFLICT', 'UNCLEAR'] },
              materialOmissions: { type: 'array', items: { type: 'string' } },
              unsupportedClaims: { type: 'array', items: { type: 'string' } },
              rowAssessments: { type: 'array', items: { type: 'object', additionalProperties: false,
                required: ['rowId', 'conditions', 'titleCoverage', 'explanation'],
                properties: {
                  rowId: { type: 'string' },
                  conditions: { type: 'string' },
                  titleCoverage: { type: 'string', enum: ['ACCURATE', 'OMITTED', 'OVERAPPLIED', 'UNSUPPORTED', 'UNCLEAR'] },
                  explanation: { type: 'string' }
                } } }
            }
          }
        }
      },
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: JSON.stringify(reviewInput) }
      ]
    };
    if (this.logPhase74AiPayload) {
      console.log(`[Phase7.4 Fitment Review AI Payload]\n${JSON.stringify(requestBody, null, 2)}`);
    }
    const response = await retryWithBackoff(
      async () => this.postPhase74Logged('fitment-review', input.listing, requestBody),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs }
    );
    const content = String(response?.data?.choices?.[0]?.message?.content || '').trim();
    const parsed = extractJsonObject(content);
    if (!parsed || !['PASS', 'REVIEW'].includes(parsed.verdict) ||
        !normalizeText(parsed.reason) || !Array.isArray(parsed.citedRowIds) ||
        !Array.isArray(parsed.rowAssessments) ||
        !Array.isArray(parsed.materialOmissions) || !Array.isArray(parsed.unsupportedClaims) ||
        !['SUPPORTED', 'CHANGED', 'UNCLEAR'].includes(parsed.advertisedIdentityAssessment) ||
        !['ACCURATE', 'INACCURATE', 'UNCLEAR'].includes(parsed.qualifierScopeAssessment) ||
        !['SUPPORTED', 'CONFLICT', 'UNCLEAR'].includes(parsed.productIdentityAssessment)) {
      throw new Error('Fitment review returned an invalid response.');
    }
    return {
      verdict: parsed.verdict,
      reason: normalizeText(parsed.reason),
      citedRowIds: parsed.citedRowIds,
      advertisedIdentityAssessment: parsed.advertisedIdentityAssessment,
      qualifierScopeAssessment: parsed.qualifierScopeAssessment,
      productIdentityAssessment: parsed.productIdentityAssessment,
      materialOmissions: parsed.materialOmissions,
      unsupportedClaims: parsed.unsupportedClaims,
      rowAssessments: parsed.rowAssessments
    };
  }

  async generateTitleAndDescriptionFromRuntimePrompt(promptArtifact = {}, listing = null) {
    if (!promptArtifact || promptArtifact.kind === 'title-generation-bypass') {
      return {
        generatedTitle: '',
        generatedDescription: '',
        shortDescription: '',
        reasoningSummary: 'Config-driven runtime prompt bypassed title generation.',
        titleReviewStatus: 'Skipped - Manual Override',
        titleReviewReason: 'manual_override',
        titleReviewNotes: 'Manual override bypassed shadow title generation.',
        rawContent: '',
        parsedKeys: [],
        recognizedKeys: []
      };
    }
    const systemMessage = normalizeText(promptArtifact.systemMessage);
    if (!systemMessage) throw new Error('Runtime prompt artifact is missing systemMessage.');

    const promptKeySource = JSON.stringify({
      systemMessage,
      userPayload: promptArtifact.userPayload || {}
    });
    const promptDigest = crypto
      .createHash('sha256')
      .update(promptKeySource, 'utf8')
      .digest('hex')
      .slice(0, 16);

    const requestBody = {
      model: this.model,
      temperature: 0,
      response_format: phase74TitleResponseFormat(),
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: JSON.stringify(promptArtifact.userPayload || {}) }
      ]
    };
    const configuredDetails = [...new Set((promptArtifact.userPayload?.titlePolicy?.categoryRules || [])
      .flatMap(rule => rule.priorityDetails || []).map(item => normalizeText(item.detail)).filter(Boolean))];
    const runtimeSchema = requestBody.response_format.json_schema.schema;
    runtimeSchema.required.push('vehicleDecision');
    runtimeSchema.properties.vehicleDecision = {
      type: 'object', additionalProperties: false,
      required: ['resolved', 'make', 'model', 'yearRange', 'source', 'evidence', 'reason'],
      properties: { resolved: { type: 'boolean' },
        ...Object.fromEntries(['make', 'model', 'yearRange', 'source', 'evidence', 'reason'].map(key => [key, { type: ['string', 'null'] }])) }
    };
    runtimeSchema.required.push('sideDecision');
    runtimeSchema.properties.sideDecision = {
      type: 'object', additionalProperties: false,
      required: ['side', 'placement', 'source', 'evidence'],
      properties: Object.fromEntries(['side', 'placement', 'source', 'evidence'].map(key => [key, { type: ['string', 'null'] }]))
    };
    if (configuredDetails.length) {
      requestBody.response_format.json_schema.schema.properties.categoryPriorityDetails.items.properties.detail.enum = configuredDetails;
    }

    const shouldUsePromptCache = this.promptCacheEnabled && this.promptCacheKey;
    if (shouldUsePromptCache) {
      requestBody.prompt_cache_key = `${this.promptCacheKey}:runtime:${promptDigest}`;
    }

    if (this.logPhase74AiPayload) {
      console.log(
        `[Phase7.4 Runtime AI Payload] configVersion='${promptArtifact?.metadata?.configurationVersion || ''}' ` +
          `promptDigest='${promptDigest}'\n${JSON.stringify(requestBody, null, 2)}`
      );
    }
    const postRuntimeRequest = async () => this.postPhase74Logged('title-generation', listing, requestBody);

    let response;
    try {
      response = await retryWithBackoff(
        postRuntimeRequest,
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
        postRuntimeRequest,
        {
          maxAttempts: this.maxAttempts,
          baseDelayMs: this.baseDelayMs
        }
      );
    }

    const content = String(response?.data?.choices?.[0]?.message?.content || '').trim();
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
        'reviewNotes',
        'categoryPriorityDetails'
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
      categoryPriorityDetails: Array.isArray(parsed.categoryPriorityDetails) ? parsed.categoryPriorityDetails.map(item => ({
        detail: normalizeText(item?.detail),
        verified: item?.verified === true,
        source: item?.source == null ? null : normalizeText(item.source),
        evidence: item?.evidence == null ? null : normalizeText(item.evidence)
      })) : [],
      sideDecision: parsed.sideDecision && typeof parsed.sideDecision === 'object' ? parsed.sideDecision : null,
      vehicleDecision: parsed.vehicleDecision && typeof parsed.vehicleDecision === 'object' ? parsed.vehicleDecision : null,
      rawContent: content,
      parsedKeys: Object.keys(parsed),
      recognizedKeys
    };
  }
}

module.exports = Phase4AiEvaluatorService;
