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
    this.model = normalizeText(config.model || 'gpt-4o-mini');
    this.baseUrl = normalizeText(config.baseUrl || 'https://api.openai.com/v1');
    this.timeoutMs = Number(config.timeoutMs || 45000);
    this.maxAttempts = Number(config.maxAttempts || 4);
    this.baseDelayMs = Number(config.baseDelayMs || 700);
    this.promptCacheKey = normalizeText(config.promptCacheKey || '');
    this.promptCacheEnabled = config.promptCacheEnabled !== false;

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

    const requestBody = {
      model: this.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Return only JSON. Decide a value for one item-specific field using provided inventory context (Master Parts) and listing context (title/description/conditions). If uncertain, return low confidence.'
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'phase4b_lite_field_resolution',
            expectedOutput: {
              value: 'string_or_empty',
              confidence: 'number_0_to_1',
              reason: 'short_reason'
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
      // Graceful fallback for models/endpoints that don't accept prompt cache parameters.
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
    const parsed = tryParseJson(content) || {};
    const value = normalizeText(parsed.value);
    const confidence = clampConfidence(parsed.confidence);
    const reason = normalizeText(parsed.reason);

    return {
      value,
      confidence,
      reason
    };
  }
}

module.exports = Phase4AiEvaluatorService;
