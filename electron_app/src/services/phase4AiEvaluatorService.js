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

class Phase4AiEvaluatorService {
  constructor(config = {}) {
    this.apiKey = normalizeText(config.apiKey);
    this.model = normalizeText(config.model || 'gpt-4o-mini');
    this.baseUrl = normalizeText(config.baseUrl || 'https://api.openai.com/v1');
    this.timeoutMs = Number(config.timeoutMs || 45000);
    this.maxAttempts = Number(config.maxAttempts || 4);
    this.baseDelayMs = Number(config.baseDelayMs || 700);

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
      ipn: normalizeText(payload.ipn),
      prefix: normalizeText(payload.prefix),
      tableName: normalizeText(payload.tableName),
      fieldName: normalizeText(payload.fieldName),
      ruleType: normalizeText(payload.ruleType).toUpperCase(),
      masterPartsData: payload.masterPartsData || {},
      allowedValues: Array.isArray(payload.allowedValues) ? payload.allowedValues : []
    };

    const response = await retryWithBackoff(
      async () =>
        this.client.post('/chat/completions', {
          model: this.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'Return only JSON. Decide a value for one item-specific field using only provided Master Parts context. If uncertain, return low confidence.'
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
        }),
      {
        maxAttempts: this.maxAttempts,
        baseDelayMs: this.baseDelayMs
      }
    );

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
