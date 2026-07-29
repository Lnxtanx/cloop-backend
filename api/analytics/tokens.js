const express = require('express');
const router = express.Router();
const prisma = require('../../lib/prisma');
const { getTokenUsageSummary, logTokenUsage } = require('../../services/token-tracker');
const { authenticateToken } = require('../../middleware/auth');

/**
 * GET /api/analytics/tokens/summary
 * Fetch system-wide or user-filtered token summary (input, output, total, features, models)
 */
router.get('/summary', async (req, res) => {
    try {
        const { userId, featureArea, fromDate, toDate } = req.query;
        const summary = await getTokenUsageSummary({ userId, featureArea, fromDate, toDate });

        return res.status(200).json({
            success: true,
            data: summary
        });
    } catch (err) {
        console.error('[AnalyticsAPI] Error fetching token summary:', err);
        return res.status(500).json({ error: 'Failed to fetch token summary analytics' });
    }
});

/**
 * GET /api/analytics/tokens/user/:userId
 * Fetch comprehensive per-user token consumption report
 */
router.get('/user/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId, 10);
        if (isNaN(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        const summary = await getTokenUsageSummary({ userId });

        // Daily breakdown from ai_user_daily_token_usage
        const dailyHistory = await prisma.ai_user_daily_token_usage.findMany({
            where: { user_id: userId },
            orderBy: { date: 'desc' },
            take: 30
        });

        // Convert BigInts to Numbers for JSON serialization
        const formattedHistory = dailyHistory.map(item => ({
            ...item,
            total_prompt_tokens: Number(item.total_prompt_tokens),
            total_completion_tokens: Number(item.total_completion_tokens),
            total_tokens: Number(item.total_tokens),
        }));

        return res.status(200).json({
            success: true,
            userId,
            summary: summary.totals,
            by_feature: summary.by_feature,
            by_model: summary.by_model,
            daily_history: formattedHistory
        });
    } catch (err) {
        console.error(`[AnalyticsAPI] Error fetching user ${req.params.userId} token analytics:`, err);
        return res.status(500).json({ error: 'Failed to fetch user token report' });
    }
});

/**
 * GET /api/analytics/tokens/timeseries
 * Fetch time-series token consumption data grouped by date and feature
 */
router.get('/timeseries', async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const limitDays = Math.min(90, Math.max(1, parseInt(days, 10) || 30));

        const startDate = new Date();
        startDate.setUTCDate(startDate.getUTCDate() - limitDays);
        startDate.setUTCHours(0, 0, 0, 0);

        const dailyStats = await prisma.ai_user_daily_token_usage.findMany({
            where: {
                date: { gte: startDate }
            },
            orderBy: { date: 'asc' }
        });

        const formattedStats = dailyStats.map(item => ({
            id: item.id,
            user_id: item.user_id,
            date: item.date,
            feature_area: item.feature_area,
            total_prompt_tokens: Number(item.total_prompt_tokens),
            total_completion_tokens: Number(item.total_completion_tokens),
            total_tokens: Number(item.total_tokens),
            total_calls: item.total_calls
        }));

        return res.status(200).json({
            success: true,
            timeseries: formattedStats
        });
    } catch (err) {
        console.error('[AnalyticsAPI] Error fetching timeseries token analytics:', err);
        return res.status(500).json({ error: 'Failed to fetch timeseries analytics' });
    }
});

/**
 * GET /api/analytics/tokens/logs
 * Fetch paginated detailed raw token logs for auditing
 */
router.get('/logs', async (req, res) => {
    try {
        const { page = 1, limit = 50, featureArea, userId } = req.query;
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
        const skip = (pageNum - 1) * limitNum;

        const where = {};
        if (featureArea && featureArea !== 'all') where.feature_area = featureArea;
        if (userId) where.user_id = parseInt(userId, 10);

        const [logs, total] = await Promise.all([
            prisma.ai_token_logs.findMany({
                where,
                orderBy: { created_at: 'desc' },
                skip,
                take: limitNum
            }),
            prisma.ai_token_logs.count({ where })
        ]);

        const formattedLogs = logs.map(log => ({
            ...log,
            id: log.id.toString()
        }));

        return res.status(200).json({
            success: true,
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum)
            },
            logs: formattedLogs
        });
    } catch (err) {
        console.error('[AnalyticsAPI] Error fetching token logs:', err);
        return res.status(500).json({ error: 'Failed to fetch token logs' });
    }
});

/**
 * POST /api/analytics/tokens/log
 * Internal/External endpoint to log token usage directly
 */
router.post('/log', async (req, res) => {
    try {
        const {
            userId,
            featureArea,
            subFeature,
            provider,
            modelName,
            promptTokens,
            completionTokens,
            totalTokens,
            cachedPromptTokens,
            reasoningTokens,
            requestDurationMs,
            status,
            metadata
        } = req.body;

        if (!featureArea) {
            return res.status(400).json({ error: 'featureArea is required' });
        }

        logTokenUsage({
            userId,
            featureArea,
            subFeature,
            provider,
            modelName,
            promptTokens,
            completionTokens,
            totalTokens,
            cachedPromptTokens,
            reasoningTokens,
            requestDurationMs,
            status,
            metadata
        });

        return res.status(200).json({ success: true, message: 'Token usage queued for logging' });
    } catch (err) {
        console.error('[AnalyticsAPI] Error processing manual token log:', err);
        return res.status(500).json({ error: 'Failed to log token usage' });
    }
});

module.exports = router;
