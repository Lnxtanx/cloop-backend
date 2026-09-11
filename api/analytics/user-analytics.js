/**
 * User Analytics API Routes
 *
 * Endpoints for user presence (heartbeat), activity sessions,
 * dashboard stats, active user counts, and curriculum completion.
 *
 * Mount: app.use('/api/analytics', require('./api/analytics/user-analytics'))
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const {
  startSession,
  heartbeat,
  endSession,
  getActiveUserCount,
  getActiveUsers,
  getUserStats
} = require('../../services/analytics/activity-tracker');

const prisma = require('../../lib/prisma');

// ─── Heartbeat & Presence ──────────────────────────────────────────────────

/**
 * POST /api/analytics/session/start
 * Called when user opens the app / page mounts.
 * Body: { device_type?: string, app_version?: string }
 */
router.post('/session/start', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { device_type, app_version } = req.body;
    const result = await startSession(userId, device_type || 'web', app_version || null);

    return res.status(201).json(result);
  } catch (err) {
    console.error('[analytics] session/start error:', err.message);
    return res.status(500).json({ error: 'Failed to start session' });
  }
});

/**
 * POST /api/analytics/heartbeat
 * Called every ~30 seconds from the client.
 * Body: { session_token: string }
 */
router.post('/heartbeat', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { session_token } = req.body;
    if (!session_token) {
      return res.status(400).json({ error: 'session_token is required' });
    }

    const updated = await heartbeat(userId, session_token);

    if (!updated) {
      return res.status(404).json({ error: 'Session not found or already ended' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[analytics] heartbeat error:', err.message);
    return res.status(500).json({ error: 'Failed to process heartbeat' });
  }
});

/**
 * POST /api/analytics/session/end
 * Called when user closes the app / page unloads.
 * Body: { session_token: string }
 *
 * Note: Client should use navigator.sendBeacon() for this endpoint
 * to ensure it fires even on tab close.
 */
router.post('/session/end', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { session_token } = req.body;
    if (!session_token) {
      return res.status(400).json({ error: 'session_token is required' });
    }

    const ended = await endSession(userId, session_token);

    if (!ended) {
      return res.status(404).json({ error: 'Session not found or already ended' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[analytics] session/end error:', err.message);
    return res.status(500).json({ error: 'Failed to end session' });
  }
});

// ─── Dashboard / Internal Analytics ────────────────────────────────────────

/**
 * GET /api/analytics/active-users
 * Returns count and details of currently active users.
 */
router.get('/active-users', authenticateToken, async (req, res) => {
  try {
    const [count, users] = await Promise.all([
      getActiveUserCount(),
      getActiveUsers()
    ]);

    return res.status(200).json({
      active_count: count,
      users: users.map(s => ({
        user_id: s.user_id,
        name: s.user?.name || null,
        device_type: s.device_type,
        online_since: s.started_at,
        last_heartbeat: s.last_heartbeat,
        duration_seconds: s.duration_seconds
      }))
    });
  } catch (err) {
    console.error('[analytics] active-users error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch active users' });
  }
});

/**
 * GET /api/analytics/user-stats
 * Returns dashboard stats for the authenticated user:
 * streak, today's activity, weekly summary, online status.
 */
router.get('/user-stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const stats = await getUserStats(userId);
    return res.status(200).json(stats);
  } catch (err) {
    console.error('[analytics] user-stats error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch user stats' });
  }
});

/**
 * GET /api/analytics/completion/:board/:grade
 * Returns board+grade-wise completion overview.
 * Shows how many topics/chapters completed per subject for this board+grade.
 *
 * Optional query param: ?user_id=X (for admin/teacher views)
 */
router.get('/completion/:board/:grade', authenticateToken, async (req, res) => {
  try {
    const userId = req.query.user_id ? parseInt(req.query.user_id) : req.user?.user_id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { board, grade } = req.params;

    if (!board || !grade) {
      return res.status(400).json({ error: 'Board and grade are required' });
    }

    // Get curriculum summaries for this board+grade
    const summaries = await prisma.user_curriculum_summary.findMany({
      where: {
        user_id: userId,
        board: decodeURIComponent(board),
        grade: decodeURIComponent(grade)
      },
      orderBy: { subject_name: 'asc' }
    });

    // If no pre-computed summaries exist, compute on-the-fly
    if (summaries.length === 0) {
      // Find all subjects for this board+grade
      const subjects = await prisma.global_subjects.findMany({
        where: {
          board: decodeURIComponent(board),
          grade: decodeURIComponent(grade)
        },
        include: {
          chapters: {
            include: {
              topics: {
                select: { id: true }
              }
            }
          }
        }
      });

      const liveData = [];

      for (const subject of subjects) {
        const allTopicIds = subject.chapters.flatMap(c => c.topics.map(t => t.id));
        const totalTopics = allTopicIds.length;
        const totalChapters = subject.chapters.length;

        const completedTopics = totalTopics > 0
          ? await prisma.user_topic_progress.count({
              where: {
                user_id: userId,
                topic_id: { in: allTopicIds },
                is_completed: true
              }
            })
          : 0;

        const completionPercent = totalTopics > 0
          ? Math.round((completedTopics / totalTopics) * 10000) / 100
          : 0;

        liveData.push({
          subject_id: subject.id,
          subject_name: subject.name,
          board: subject.board,
          grade: subject.grade,
          total_chapters: totalChapters,
          completed_chapters: 0, // Would need chapter progress lookup
          total_topics: totalTopics,
          completed_topics: completedTopics,
          completion_percent: completionPercent
        });
      }

      return res.status(200).json({
        board: decodeURIComponent(board),
        grade: decodeURIComponent(grade),
        user_id: userId,
        source: 'live',
        subjects: liveData
      });
    }

    return res.status(200).json({
      board: decodeURIComponent(board),
      grade: decodeURIComponent(grade),
      user_id: userId,
      source: 'cached',
      subjects: summaries.map(s => ({
        subject_id: s.subject_id,
        subject_name: s.subject_name,
        total_chapters: s.total_chapters,
        completed_chapters: s.completed_chapters,
        total_topics: s.total_topics,
        completed_topics: s.completed_topics,
        completion_percent: parseFloat(s.completion_percent?.toString() || '0'),
        avg_score_percent: parseFloat(s.avg_score_percent?.toString() || '0'),
        total_time_spent_seconds: s.total_time_spent_seconds,
        last_activity_at: s.last_activity_at
      }))
    });
  } catch (err) {
    console.error('[analytics] completion error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch completion data' });
  }
});

module.exports = router;
