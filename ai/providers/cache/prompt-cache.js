/**
 * DeepSeek Prompt Cache Optimizer
 * Reorganizes prompt structures so static system instructions and topic boundaries
 * appear at the prefix (token 0), maximizing DeepSeek's server-side context cache hits (up to 98% discount).
 */

/**
 * Assemble a prompt structured specifically for DeepSeek prefix caching:
 * 1. [STATIC PREFIX] Permanent pedagogical rules and system instructions (Cached across all sessions)
 * 2. [SEMI-STATIC] Topic & Subject Knowledge Graph boundaries (Cached across turns within a topic)
 * 3. [OUTPUT SCHEMA] JSON response structure requirements (Cached across all turns)
 * 4. [DYNAMIC TAIL] Current turn directive, student answer, and conversation history (Evaluated dynamically)
 *
 * @param {Object} sections
 * @param {string} sections.systemIdentity - Core role definition
 * @param {string} sections.staticRules - Rules 1 to 8 (invariable guidelines)
 * @param {string} [sections.topicBoundaries] - AKG in-scope / out-of-scope boundaries
 * @param {string} sections.schema - JSON output schema
 * @param {string} sections.dynamicTurnData - Current student message, history, directive
 * @returns {string} Fully assembled, cache-optimized prompt
 */
function assembleCachedPrompt({
  systemIdentity = '',
  staticRules = '',
  topicBoundaries = '',
  schema = '',
  dynamicTurnData = '',
}) {
  const parts = [];

  // Block 1: Permanent Static Core (Identical across all turns and users)
  if (systemIdentity) parts.push(systemIdentity.trim());
  if (staticRules) parts.push(`STRICT PEDAGOGICAL RULES:\n${staticRules.trim()}`);
  if (schema) parts.push(`OUTPUT JSON SCHEMA:\n${schema.trim()}`);

  // Block 2: Semi-Static Topic Boundaries (Identical across all turns for this topic)
  if (topicBoundaries) parts.push(`CURRICULUM BOUNDARIES:\n${topicBoundaries.trim()}`);

  // Cache boundary delimiter
  parts.push('--- SESSION DATA (DYNAMIC) ---');

  // Block 3: Dynamic Turn Data (Changes every turn)
  if (dynamicTurnData) parts.push(dynamicTurnData.trim());

  return parts.join('\n\n');
}

/**
 * Calculate cache efficiency statistics from a completion usage object
 *
 * @param {Object} usage - { promptTokens, cachedPromptTokens }
 * @returns {{ hitRatio: number, cachedTokens: number, uncachedTokens: number, isCacheHit: boolean }}
 */
function computeCacheMetrics(usage = {}) {
  const totalPrompt = Math.max(0, parseInt(usage.promptTokens, 10) || 0);
  const cachedPrompt = Math.max(0, parseInt(usage.cachedPromptTokens, 10) || 0);
  const uncachedPrompt = Math.max(0, totalPrompt - cachedPrompt);
  const hitRatio = totalPrompt > 0 ? Number((cachedPrompt / totalPrompt).toFixed(4)) : 0;

  return {
    hitRatio,
    cachedTokens: cachedPrompt,
    uncachedTokens: uncachedPrompt,
    isCacheHit: cachedPrompt > 0,
  };
}

module.exports = {
  assembleCachedPrompt,
  computeCacheMetrics,
};
