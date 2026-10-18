/**
 * DeepSeek Core Provider Client
 * Robust, low-latency HTTP client for DeepSeek with Always-On Thinking and Context Caching support.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env'), override: true });

const { MODELS, ENDPOINTS, THINKING_CONFIG, TIMEOUTS } = require('./constants');
const { recordTokenUsage } = require('../telemetry/token-logger');

/**
 * Invoke DeepSeek Chat/Reasoner Completion
 *
 * @param {string|Array} systemPrompt - System prompt string or full messages array
 * @param {Array|Object} messages - Array of { role, content } or options if systemPrompt is array
 * @param {Object} options - Invocation options:
 *   - model: Model ID ('deepseek-v4-pro', 'deepseek-flash') (default: deepseek-v4-pro)
 *   - thinking: 'enabled' | 'disabled' (default: 'enabled')
 *   - reasoningEffort: 'low' | 'high' | 'max' (default: 'high')
 *   - temperature: number (default: 0.7)
 *   - maxTokens: number (default: 4096)
 *   - jsonFormat: boolean (if true, enforces valid JSON output)
 *   - userId: number (for telemetry user attribution)
 *   - featureArea: string (e.g. 'tutor-core', 'academic-graph')
 *   - subFeature: string (e.g. 'evaluator', 'dialogue-generator')
 *   - metadata: object
 *   - returnFull: boolean (if true, returns { content, reasoning, usage, durationMs })
 * @returns {Promise<string|Object>}
 */
async function invokeModel(systemPrompt, messages = [], options = {}) {
  // Normalize invocation signatures
  if (Array.isArray(systemPrompt)) {
    options = messages || {};
    messages = systemPrompt;
    systemPrompt = options.systemPrompt || options.systemInstruction || '';
  }

  const apiKey = (process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || '').trim();
  if (!apiKey) {
    throw new Error('[DeepSeek] DEEPSEEK_API_KEY is missing in environment variables (.env)');
  }

  let requestedModel = options.modelId || options.model || MODELS.DEFAULT;
  if (MODELS.LEGACY_MAP && MODELS.LEGACY_MAP[requestedModel]) {
    requestedModel = MODELS.LEGACY_MAP[requestedModel];
  }
  const model = requestedModel;
  const isThinkingEnabled = options.thinking !== 'disabled';
  const reasoningEffort = options.reasoningEffort || THINKING_CONFIG.DEFAULT_EFFORT;

  // Format messages
  const formattedMessages = [];
  if (typeof systemPrompt === 'string' && systemPrompt.trim()) {
    formattedMessages.push({ role: 'system', content: systemPrompt.trim() });
  }

  for (const msg of messages) {
    let textContent = '';
    if (typeof msg.content === 'string') {
      textContent = msg.content.trim();
    } else if (Array.isArray(msg.content) && msg.content[0] && typeof msg.content[0].text === 'string') {
      textContent = msg.content[0].text.trim();
    } else if (msg.content && typeof msg.content === 'object' && typeof msg.content.text === 'string') {
      textContent = msg.content.text.trim();
    }

    if (!textContent) textContent = '...';

    formattedMessages.push({
      role: msg.role === 'ai' ? 'assistant' : msg.role,
      content: textContent,
    });
  }

  const payload = {
    model,
    messages: formattedMessages,
    temperature: options.temperature !== undefined ? options.temperature : 0.6,
    max_tokens: options.maxTokens || 4096,
  };

  // Thinking Mode Configuration
  if (isThinkingEnabled) {
    payload.reasoning_effort = reasoningEffort;
    payload.extra_body = {
      thinking: { type: 'enabled' },
    };
  }

  // JSON mode handling
  if (options.jsonFormat === true) {
    // If thinking is disabled or model supports native json_object:
    if (!isThinkingEnabled) {
      payload.response_format = { type: 'json_object' };
    }
    // DeepSeek guideline: ensure the word 'json' is in the system prompt
    const hasJsonWord = formattedMessages.some(m => /json/i.test(m.content));
    if (!hasJsonWord) {
      if (formattedMessages.length > 0 && formattedMessages[0].role === 'system') {
        formattedMessages[0].content += '\nRespond in strictly valid JSON format matching schema.';
      } else {
        formattedMessages.unshift({ role: 'system', content: 'Respond in strictly valid JSON format matching schema.' });
      }
    }
  }

  const timeoutMs = options.timeoutMs || TIMEOUTS.DEFAULT_CHAT_MS;
  const maxAttempts = options.maxAttempts || 2;
  const startTime = Date.now();
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new Error(`[DeepSeek] Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const response = await fetch(ENDPOINTS.CHAT_COMPLETIONS, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`DeepSeek HTTP ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const durationMs = Date.now() - startTime;

      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error('[DeepSeek] Empty or invalid response payload from API');
      }

      const messageObj = data.choices[0].message;
      const content = messageObj.content || '';
      const reasoning = messageObj.reasoning_content || '';

      // Usage details
      const rawUsage = data.usage || {};
      const promptTokens = rawUsage.prompt_tokens || 0;
      const completionTokens = rawUsage.completion_tokens || 0;
      const totalTokens = rawUsage.total_tokens || (promptTokens + completionTokens);
      const cachedPromptTokens = rawUsage.prompt_cache_hit_tokens || rawUsage.prompt_tokens_details?.cached_tokens || 0;
      const cacheMissTokens = rawUsage.prompt_cache_miss_tokens || Math.max(0, promptTokens - cachedPromptTokens);
      const reasoningTokens = rawUsage.completion_tokens_details?.reasoning_tokens || 0;

      const usageDetails = {
        promptTokens,
        completionTokens,
        totalTokens,
        cachedPromptTokens,
        cacheMissTokens,
        reasoningTokens,
        durationMs,
      };

      // Telemetry logging
      if (options.featureArea) {
        recordTokenUsage({
          userId: options.userId || null,
          featureArea: options.featureArea,
          subFeature: options.subFeature || null,
          provider: 'deepseek',
          modelName: model,
          promptTokens,
          completionTokens,
          totalTokens,
          cachedPromptTokens,
          reasoningTokens,
          requestDurationMs: durationMs,
          status: 'success',
          metadata: {
            thinking: isThinkingEnabled,
            reasoning_effort: reasoningEffort,
            ...(options.metadata || {}),
          },
        });
      }

      if (options.returnFull || options.returnUsage) {
        return {
          content,
          reasoning,
          usage: usageDetails,
          durationMs,
        };
      }

      return content;
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      console.warn(`[DeepSeek] ⚠️ Attempt ${attempt}/${maxAttempts} failed:`, err.message);

      if (options.featureArea && attempt === maxAttempts) {
        recordTokenUsage({
          userId: options.userId || null,
          featureArea: options.featureArea,
          subFeature: options.subFeature || null,
          provider: 'deepseek',
          modelName: model,
          status: 'failed',
          requestDurationMs: Date.now() - startTime,
          metadata: { error: err.message, ...(options.metadata || {}) },
        });
      }

      if (attempt < maxAttempts) {
        await new Promise(res => setTimeout(res, 1000));
      }
    }
  }

  throw lastError;
}

module.exports = {
  invokeModel,
};
