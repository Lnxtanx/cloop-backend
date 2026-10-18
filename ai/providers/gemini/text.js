/**
 * Gemini Text Provider (generateContent)
 *
 * Shared HTTP client for non-realtime Gemini models (Flash) used by
 * post-session voice analysis, error consolidation, and assessment engines.
 *
 * Responsibilities: request shaping, timeouts, JSON extraction, token telemetry.
 * NOT responsible for: prompts, fallbacks, or DB persistence (caller's concern).
 */

const { MODELS, ENDPOINTS, TIMEOUTS, generateContentUrl, getApiKey } = require('./constants');
const { recordTokenUsage } = require('../telemetry/token-logger');

/**
 * Extract a JSON object from a model response that may be wrapped in
 * markdown fences or surrounded by prose.
 */
function parseJsonLoose(text) {
  if (!text) return null;

  let cleaned = String(text).trim();

  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  const openBrace = cleaned.indexOf('{');
  if (openBrace !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = openBrace; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = cleaned.substring(openBrace, i + 1);
          try {
            return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
          } catch (_) {
            return null;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Invoke a Gemini generateContent model.
 *
 * @param {Object} options
 * @param {string} options.prompt - user content
 * @param {string} [options.systemInstruction] - optional system instruction
 * @param {string} [options.model] - defaults to MODELS.FLASH
 * @param {boolean} [options.json] - request application/json response
 * @param {number} [options.temperature]
 * @param {number} [options.maxOutputTokens]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.userId] - telemetry attribution
 * @param {string} [options.featureArea] - telemetry feature area
 * @param {string} [options.subFeature] - telemetry sub feature
 * @param {Object} [options.metadata] - telemetry metadata
 * @param {Function} [options.fetchImpl] - injectable fetch (tests)
 * @returns {Promise<{ text: string, usage: { promptTokens, completionTokens, totalTokens }, durationMs: number }>}
 */
async function generateText({
  prompt,
  systemInstruction,
  model = MODELS.FLASH,
  json = false,
  temperature = 0.3,
  maxOutputTokens = 4096,
  timeoutMs = TIMEOUTS.REST_MS,
  userId = null,
  featureArea = null,
  subFeature = null,
  metadata = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('[Gemini] GEMINI_API_KEY is missing in environment variables (.env)');
  }
  if (!prompt) {
    throw new Error('[Gemini] prompt is required');
  }

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      ...(json ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startTime = Date.now();

  try {
    const response = await fetchImpl(`${generateContentUrl(model)}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`[Gemini] HTTP ${response.status}: ${errorText.slice(0, 300)}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('[Gemini] Empty response payload (no candidate text)');
    }

    const durationMs = Date.now() - startTime;
    const rawUsage = data.usageMetadata || {};
    const usage = {
      promptTokens: rawUsage.promptTokenCount || 0,
      completionTokens: rawUsage.candidatesTokenCount || 0,
      totalTokens: rawUsage.totalTokenCount || 0,
    };

    if (featureArea) {
      recordTokenUsage({
        userId,
        featureArea,
        subFeature,
        provider: 'google',
        modelName: model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        requestDurationMs: durationMs,
        status: 'success',
        metadata,
      });
    }

    return { text, usage, durationMs };
  } catch (err) {
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;

    if (featureArea && err.name !== 'AbortError') {
      recordTokenUsage({
        userId,
        featureArea,
        subFeature,
        provider: 'google',
        modelName: model,
        status: 'failed',
        requestDurationMs: durationMs,
        metadata: { error: err.message, ...(metadata || {}) },
      });
    }

    if (err.name === 'AbortError') {
      throw new Error(`[Gemini] Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

/**
 * Convenience wrapper: generateText + strict JSON parsing.
 * @returns {Promise<{ parsed: object, text: string, usage: object, durationMs: number }>}
 */
async function generateJson(options = {}) {
  const result = await generateText({ ...options, json: true });
  const parsed = parseJsonLoose(result.text);
  if (!parsed) {
    throw new Error('[Gemini] Response was not valid JSON');
  }
  return { ...result, parsed };
}

module.exports = {
  generateText,
  generateJson,
  parseJsonLoose,
};
