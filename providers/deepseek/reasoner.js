/**
 * DeepSeek Reasoner Engine
 * Specialized reasoning wrapper with Always-On Thinking and robust JSON extraction.
 */

const { invokeModel } = require('./client');

/**
 * Robust JSON extraction helper supporting reasoning tags (<think>...</think>)
 * and Markdown code fences.
 */
function extractJson(text) {
  if (!text) return null;

  // 1. Strip reasoning/thinking blocks if embedded
  let cleaned = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();

  // Strip Markdown JSON fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  if (!cleaned) return null;

  try {
    // 2. Direct parse attempt
    return JSON.parse(cleaned);
  } catch (_) {
    // 3. Depth-based JSON object extraction
    const openBrace = cleaned.search(/\{/);
    if (openBrace !== -1) {
      let depth = 0, inString = false, escaped = false, closeBrace = -1;
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
          if (depth === 0) { closeBrace = i; break; }
        }
      }

      if (closeBrace !== -1) {
        const candidate = cleaned.substring(openBrace, closeBrace + 1);
        try {
          // Remove trailing commas before closing braces
          const sanitized = candidate.replace(/,\s*([}\]])/g, '$1');
          return JSON.parse(sanitized);
        } catch (_) {}
      }
    }

    // 4. Fallback to array if wrapped in [...]
    if (cleaned.startsWith('[')) {
      try {
        return JSON.parse(cleaned);
      } catch (_) {}
    }

    return null;
  }
}

/**
 * Execute DeepSeek with Always-On Thinking and return structured output
 *
 * @param {string} systemPrompt
 * @param {Array} userMessages
 * @param {Object} options
 * @returns {Promise<{ content: string, reasoning: string, parsed: Object|null, usage: Object, durationMs: number }>}
 */
async function invokeReasoner(systemPrompt, userMessages = [], options = {}) {
  const result = await invokeModel(systemPrompt, userMessages, {
    ...options,
    thinking: 'enabled',
    returnFull: true,
  });

  const parsed = options.jsonFormat !== false ? extractJson(result.content) : null;

  return {
    content: result.content,
    reasoning: result.reasoning,
    parsed,
    usage: result.usage,
    durationMs: result.durationMs,
  };
}

module.exports = {
  invokeReasoner,
  extractJson,
};
