const prisma = require('../lib/prisma');

/**
 * AI Token Tracker Service
 * Asynchronously records LLM token consumption across all backend services
 * and updates daily user aggregate stats.
 */

/**
 * Asynchronously log token usage for an AI operation.
 * Non-blocking: Errors are caught and logged without interrupting main feature flow.
 *
 * @param {Object} params
 * @param {number|null} [params.userId=null] - User ID associated with the call
 * @param {string} params.featureArea - Feature area ('curriculum_generation', 'topic_chat', 'normal_chat', 'practice_test', 'memory_context')
 * @param {string} [params.subFeature=null] - Sub-feature ('chapter_gen', 'concept_eval', etc.)
 * @param {string} [params.provider='deepseek'] - LLM Provider name
 * @param {string} [params.modelName='deepseek-chat'] - LLM Model name
 * @param {number} [params.promptTokens=0] - Input token count
 * @param {number} [params.completionTokens=0] - Output token count
 * @param {number} [params.totalTokens=0] - Total token count
 * @param {number} [params.cachedPromptTokens=0] - Cached prompt token count
 * @param {number} [params.reasoningTokens=0] - Reasoning output token count
 * @param {number} [params.requestDurationMs=0] - Latency in milliseconds
 * @param {string} [params.status='success'] - 'success' or 'failed'
 * @param {Object} [params.metadata=null] - Extra context (subject_id, topic_id, etc.)
 */
function logTokenUsage(params = {}) {
    setImmediate(async () => {
        try {
            const userId = params.userId ? parseInt(params.userId, 10) : null;
            const promptTokens = Math.max(0, parseInt(params.promptTokens, 10) || 0);
            const completionTokens = Math.max(0, parseInt(params.completionTokens, 10) || 0);
            const totalTokens = (params.totalTokens && parseInt(params.totalTokens, 10) > 0)
                ? parseInt(params.totalTokens, 10)
                : (promptTokens + completionTokens);

            const featureArea = (params.featureArea || 'general').trim();
            const subFeature = params.subFeature ? params.subFeature.trim() : null;
            const provider = (params.provider || 'deepseek').trim();
            const modelName = (params.modelName || 'deepseek-chat').trim();
            const status = (params.status || 'success').trim();

            // 1. Insert raw token log record
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
                    cached_prompt_tokens: params.cachedPromptTokens || 0,
                    reasoning_tokens: params.reasoningTokens || 0,
                    request_duration_ms: params.requestDurationMs || 0,
                    status,
                    metadata: params.metadata || null,
                }
            });

            // 2. If user_id exists, update daily aggregates (both specific feature & 'all')
            if (userId) {
                const today = new Date();
                today.setUTCHours(0, 0, 0, 0);

                const featureAreasToUpdate = Array.from(new Set([featureArea, 'all']));

                for (const area of featureAreasToUpdate) {
                    await prisma.ai_user_daily_token_usage.upsert({
                        where: {
                            user_id_date_feature_area: {
                                user_id: userId,
                                date: today,
                                feature_area: area
                            }
                        },
                        update: {
                            total_prompt_tokens: { increment: promptTokens },
                            total_completion_tokens: { increment: completionTokens },
                            total_tokens: { increment: totalTokens },
                            total_calls: { increment: 1 },
                            updated_at: new Date()
                        },
                        create: {
                            user_id: userId,
                            date: today,
                            feature_area: area,
                            total_prompt_tokens: BigInt(promptTokens),
                            total_completion_tokens: BigInt(completionTokens),
                            total_tokens: BigInt(totalTokens),
                            total_calls: 1
                        }
                    }).catch(err => {
                        console.error(`[TokenTracker] Error upserting daily usage for feature '${area}':`, err.message);
                    });
                }
            }

            console.log(`[TokenTracker] 📊 Logged ${totalTokens} tokens (${promptTokens} in / ${completionTokens} out) | Feature: ${featureArea} | User: ${userId || 'Anon'}`);
        } catch (error) {
            console.error('[TokenTracker] ❌ Error recording token log:', error.message);
        }
    });
}

/**
 * Get aggregated token usage analytics with optional filtering
 *
 * @param {Object} filters
 * @param {number} [filters.userId]
 * @param {string} [filters.featureArea]
 * @param {string} [filters.fromDate]
 * @param {string} [filters.toDate]
 */
async function getTokenUsageSummary(filters = {}) {
    const where = {};

    if (filters.userId) {
        where.user_id = parseInt(filters.userId, 10);
    }
    if (filters.featureArea && filters.featureArea !== 'all') {
        where.feature_area = filters.featureArea;
    }
    if (filters.fromDate || filters.toDate) {
        where.created_at = {};
        if (filters.fromDate) where.created_at.gte = new Date(filters.fromDate);
        if (filters.toDate) where.created_at.lte = new Date(filters.toDate);
    }

    // Total totals
    const aggregate = await prisma.ai_token_logs.aggregate({
        where,
        _sum: {
            prompt_tokens: true,
            completion_tokens: true,
            total_tokens: true,
            cached_prompt_tokens: true,
            reasoning_tokens: true
        },
        _count: {
            id: true
        }
    });

    // Group by feature_area
    const byFeatureRaw = await prisma.ai_token_logs.groupBy({
        by: ['feature_area'],
        where,
        _sum: {
            prompt_tokens: true,
            completion_tokens: true,
            total_tokens: true
        },
        _count: {
            id: true
        }
    });

    // Group by model_name
    const byModelRaw = await prisma.ai_token_logs.groupBy({
        by: ['model_name', 'provider'],
        where,
        _sum: {
            prompt_tokens: true,
            completion_tokens: true,
            total_tokens: true
        },
        _count: {
            id: true
        }
    });

    return {
        totals: {
            total_calls: aggregate._count.id || 0,
            prompt_tokens: aggregate._sum.prompt_tokens || 0,
            completion_tokens: aggregate._sum.completion_tokens || 0,
            total_tokens: aggregate._sum.total_tokens || 0,
            cached_prompt_tokens: aggregate._sum.cached_prompt_tokens || 0,
            reasoning_tokens: aggregate._sum.reasoning_tokens || 0,
        },
        by_feature: byFeatureRaw.map(f => ({
            feature_area: f.feature_area,
            calls: f._count.id,
            prompt_tokens: f._sum.prompt_tokens || 0,
            completion_tokens: f._sum.completion_tokens || 0,
            total_tokens: f._sum.total_tokens || 0
        })),
        by_model: byModelRaw.map(m => ({
            model_name: m.model_name,
            provider: m.provider,
            calls: m._count.id,
            prompt_tokens: m._sum.prompt_tokens || 0,
            completion_tokens: m._sum.completion_tokens || 0,
            total_tokens: m._sum.total_tokens || 0
        }))
    };
}

module.exports = {
    logTokenUsage,
    getTokenUsageSummary
};
