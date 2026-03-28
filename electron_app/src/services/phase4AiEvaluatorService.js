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

class Phase4AiEvaluatorService {
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

  buildFieldResolutionSystemPrompt() {
    return [
      'Return only valid JSON.',
      'You are resolving exactly one eBay item-specific field for an automotive part.',
      'Use only the evidence provided in masterPartsData, listingTitle, listingDescription, listingConditionsAndOptions, fieldInstructions, allowedValues, and webEvidence.',
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
      listingConditionsAndOptions: normalizeText(first.listingConditionsAndOptions)
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
    const resultsByField = new Map();
    for (const row of list) {
      const fieldName = normalizeText(row?.fieldName);
      if (!fieldName) continue;
      resultsByField.set(fieldName, {
        value: normalizeText(row?.value),
        confidence: clampConfidence(row?.confidence),
        reason: normalizeText(row?.reason),
        webSearchUsed: true,
        webSources: this.extractWebSources(response?.data || {})
      });
    }
    return {
      resultsByField,
      webSources: this.extractWebSources(response?.data || {})
    };
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
    const promptInput = {
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
      listingConditionsAndOptions: normalizeText(payload.listingConditionsAndOptions)
    };

    const currentIpn = normalizeText(promptInput.ipn).toUpperCase();
    const currentField = normalizeText(promptInput.fieldName);
    const debugKey = `${currentIpn}::${currentField}`.toUpperCase();
    const shouldDebug = this.debugPromptIpn && currentIpn === this.debugPromptIpn;
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
    if (secondPassHigh) return secondPass;

    const fallback = secondPass.confidence >= firstPass.confidence ? secondPass : firstPass;
    return {
      ...fallback,
      webSearchUsed: true,
      webSources: secondPass.webSources || []
    };
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
    const promptInput = {
      ipn: normalizeText(payload.ipn),
      categoryContext: payload.categoryContext || {},
      conditionsAndOptions: normalizeText(payload.conditionsAndOptions),
      condition: normalizeText(payload.condition),
      conditionNote: normalizeText(payload.conditionNote),
      itemSpecifics: payload.itemSpecifics || {},
      partFitment: normalizeText(payload.partFitment),
      currentTitle: normalizeText(payload.currentTitle)
    };

    const requestBody = {
      model: this.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Return only JSON. Generate an optimized eBay title and buyer-visible description from structured listing data. Do not invent facts. Do not include HTML. Keep output concise and practical.'
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'phase74_title_description_generation',
            requirements: [
              'Use provided listing item specifics and conditions/options.',
              'Use fitment only as supporting context when present.',
              'Do not include unsupported claims.',
              'Avoid noisy keyword stuffing.',
              'Description should remain readable even when some optional specifics are missing.'
            ],
            expectedOutput: {
              generatedTitle: 'string',
              generatedDescription: 'string',
              shortDescription: 'string_optional',
              reasoningSummary: 'string_short'
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
    return {
      generatedTitle: normalizeText(parsed.generatedTitle),
      generatedDescription: normalizeText(parsed.generatedDescription),
      shortDescription: normalizeText(parsed.shortDescription),
      reasoningSummary: normalizeText(parsed.reasoningSummary)
    };
  }
}

module.exports = Phase4AiEvaluatorService;
