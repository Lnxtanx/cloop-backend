/**
 * AI Provider Telemetry & Token Logger
 * Records token consumption, cache hits, thinking tokens, and latency across all provider invocations.
 */

let defaultPrisma = null;
try {
  defaultPrisma = require('../../lib/prisma');
} catch (_) {
  // Graceful fallback for isolated test suites
}

/**
 * Asynchronously log token usage for any provider operation.
 * Non-blocking: Errors are caught and logged without interrupting feature execution.
 *
 * @param {Object} params
 * @param {number|null} [params.userId=null] - User ID associated with the call
 * @param {string} params.featureArea - Feature area ('tutor-core', 'curriculum', 'academic-graph')
 * @param {string} [params.subFeature=null] - Sub-feature ('evaluator', 'dialogue-generator', etc.)
 * @param {string} [params.provider='deepseek'] - LLM Provider name
 * @param {string} [params.modelName='deepseek-v4-pro'] - Model name
 * @param {number} [params.promptTokens=0] - Input tokens
 * @param {number} [params.completionTokens=0] - Output tokens
 * @param {number} [params.totalTokens=0] - Total tokens
 * @param {number} [params.cachedPromptTokens=0] - Prompt cache hit tokens
 * @param {number} [params.reasoningTokens=0] - Thinking tokens
 * @param {number} [params.requestDurationMs=0] - Call duration in ms
 * @param {string} [params.status='success'] - 'success' or 'failed'
 * @param {Object} [params.metadata=null] - Additional metadata
 * @param {Object} [params.prismaClient=null] - Optional injected prisma client
 */
function recordTokenUsage(params = {}) {
  const prisma = params.prismaClient || defaultPrisma;
  if (!prisma) return;

  setImmediate(async () => {
    try {
      const userId = params.userId ? parseInt(params.userId, 10) : null;
      const promptTokens = Math.max(0, parseInt(params.promptTokens, 10) || 0);
      const completionTokens = Math.max(0, parseInt(params.completionTokens, 10) || 0);
      const totalTokens = (params.totalTokens && parseInt(params.totalTokens, 10) > 0)
        ? parseInt(params.totalTokens, 10)
        : (promptTokens + completionTokens);
      const cachedPromptTokens = Math.max(0, parseInt(params.cachedPromptTokens, 10) || 0);
      const reasoningTokens = Math.max(0, parseInt(params.reasoningTokens, 10) || 0);

      const featureArea = (params.featureArea || 'general').trim();
      const subFeature = params.subFeature ? params.subFeature.trim() : null;
      const provider = (params.provider || 'deepseek').trim();
      const modelName = (params.modelName || 'deepseek-v4-pro').trim();
      const status = (params.status || 'success').trim();

      // Compute cache hit ratio
      const cacheHitRatio = promptTokens > 0 ? Number((cachedPromptTokens / promptTokens).toFixed(4)) : 0;
      const enrichedMetadata = {
        ...(params.metadata || {}),
        cache_hit_ratio: cacheHitRatio,
        tokens_saved_by_cache: cachedPromptTokens,
      };

      // 1. Insert raw token log record
      if (prisma.ai_token_logs?.create) {
        await prisma.ai_token_logs.create({
          data: {
            user_id: userId,
            feature_area: featureArea,
            sub_feature: subFeature,
            provider,
            model_name: modelName,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens,
            cached_prompt_tokens: cachedPromptTokens,
            reasoning_tokens: reasoningTokens,
            request_duration_ms: params.requestDurationMs || 0,
            status,
            metadata: enrichedMetadata,
          },
        });
      }

      // 2. If user_id exists, update daily aggregates
      if (userId && prisma.ai_user_daily_token_usage?.upsert) {
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);

        const areas = Array.from(new Set([featureArea, 'all']));
        for (const area of areas) {
          await prisma.ai_user_daily_token_usage.upsert({
            where: {
              user_id_date_feature_area: {
                user_id: userId,
                date: today,
                feature_area: area,
              },
            },
            update: {
              total_prompt_tokens: { increment: promptTokens },
              total_completion_tokens: { increment: completionTokens },
              total_tokens: { increment: totalTokens },
              total_calls: { increment: 1 },
              updated_at: new Date(),
            },
            create: {
              user_id: userId,
              date: today,
              feature_area: area,
              total_prompt_tokens: BigInt(promptTokens),
              total_completion_tokens: BigInt(completionTokens),
              total_tokens: BigInt(totalTokens),
              total_calls: 1,
            },
          }).catch(err => {
            console.error(`[TokenLogger] Error updating daily usage (${area}):`, err.message);
          });
        }
      }

      const cacheSavingsNote = cachedPromptTokens > 0 ? ` (Cached: ${cachedPromptTokens} | ${(cacheHitRatio * 100).toFixed(1)}% hit)` : '';
      const reasoningNote = reasoningTokens > 0 ? ` (Thinking: ${reasoningTokens})` : '';
      console.log(`[TokenLogger] 📊 ${provider}/${modelName} | ${totalTokens} tokens (${promptTokens} in / ${completionTokens} out)${cacheSavingsNote}${reasoningNote} | Feature: ${featureArea}/${subFeature || '-'} | User: ${userId || 'Anon'}`);
    } catch (error) {
      console.error('[TokenLogger] ❌ Error recording token log:', error.message);
    }
  });
}

module.exports = {
  recordTokenUsage,
};
