/**
 * Activity Tracker Service
 *
 * Manages user presence (heartbeat), activity sessions, daily stats,
 * and streak tracking. All functions are self-contained and can be
 * imported individually.
 */

const prisma = require('../../lib/prisma');
const crypto = require('crypto');

// ─── Session Management ────────────────────────────────────────────────────

/**
 * Start a new activity session when user opens the app.
 *
 * @param {number} userId
 * @param {string} [deviceType] - "web", "mobile", "tablet"
 * @param {string} [appVersion]
 * @returns {Promise<{ session_token: string, session_id: number }>}
 */
async function startSession(userId, deviceType = 'web', appVersion = null) {
  const sessionToken = crypto.randomUUID();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const session = await prisma.user_activity_sessions.create({
    data: {
      user_id: userId,
      session_token: sessionToken,
      device_type: deviceType,
      app_version: appVersion,
      started_at: new Date(),
      last_heartbeat: new Date(),
      is_active: true
    }
  });

  // Increment daily sessions count
  await prisma.user_daily_stats.upsert({
    where: { user_id_date: { user_id: userId, date: today } },
    create: {
      user_id: userId,
      date: today,
      sessions_count: 1
    },
    update: {
      sessions_count: { increment: 1 },
      updated_at: new Date()
    }
  });

  // Update streak
  await updateStreak(userId);

  console.log(`[activity-tracker] Session started for user ${userId}: ${sessionToken}`);
  return { session_token: sessionToken, session_id: session.id };
}

/**
 * Process a heartbeat ping from the client (called every ~30s).
 * Updates last_heartbeat and accumulates wall time.
 *
 * @param {number} userId
 * @param {string} sessionToken
 * @returns {Promise<boolean>} true if session was found and updated
 */
async function heartbeat(userId, sessionToken) {
  if (!sessionToken) return false;

  const session = await prisma.user_activity_sessions.findFirst({
    where: {
      user_id: userId,
      session_token: sessionToken,
      is_active: true
    }
  });

  if (!session) return false;

  const now = new Date();
  const lastBeat = new Date(session.last_heartbeat);
  const elapsedSec = Math.round((now.getTime() - lastBeat.getTime()) / 1000);

  // Only count if elapsed is reasonable (< 120s, to skip stale gaps)
  const wallTimeIncrement = elapsedSec > 0 && elapsedSec < 120 ? elapsedSec : 0;

  await prisma.user_activity_sessions.update({
    where: { id: session.id },
    data: {
      last_heartbeat: now,
      duration_seconds: { increment: wallTimeIncrement }
    }
  });

  // Accumulate daily wall time
  if (wallTimeIncrement > 0) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await prisma.user_daily_stats.upsert({
      where: { user_id_date: { user_id: userId, date: today } },
      create: {
        user_id: userId,
        date: today,
        total_wall_time_seconds: wallTimeIncrement
      },
      update: {
        total_wall_time_seconds: { increment: wallTimeIncrement },
        updated_at: new Date()
      }
    });
  }

  return true;
}

/**
 * End an activity session when user closes the app or goes idle.
 *
 * @param {number} userId
 * @param {string} sessionToken
 * @returns {Promise<boolean>}
 */
async function endSession(userId, sessionToken) {
  if (!sessionToken) return false;

  const session = await prisma.user_activity_sessions.findFirst({
    where: {
      user_id: userId,
      session_token: sessionToken,
      is_active: true
    }
  });

  if (!session) return false;

  const now = new Date();
  const totalDuration = Math.round((now.getTime() - new Date(session.started_at).getTime()) / 1000);

  await prisma.user_activity_sessions.update({
    where: { id: session.id },
    data: {
      ended_at: now,
      is_active: false,
      duration_seconds: totalDuration
    }
  });

  console.log(`[activity-tracker] Session ended for user ${userId}: ${sessionToken} (${totalDuration}s)`);
  return true;
}

// ─── Streak Management ─────────────────────────────────────────────────────

/**
 * Update the user's streak based on activity today.
 * - Same day → no-op
 * - Yesterday → increment
 * - Older → reset to 1
 *
 * @param {number} userId
 */
async function updateStreak(userId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  const existing = await prisma.user_streaks.findUnique({
    where: { user_id: userId }
  });

  if (!existing) {
    // First ever activity
    await prisma.user_streaks.create({
      data: {
        user_id: userId,
        current_streak: 1,
        longest_streak: 1,
        last_active_date: today,
        streak_start_date: today
      }
    });
    return;
  }

  const lastDateStr = existing.last_active_date
    ? new Date(existing.last_active_date).toISOString().split('T')[0]
    : null;

  if (lastDateStr === todayStr) {
    // Already active today, no-op
    return;
  }

  let newStreak;
  let newStartDate;

  if (lastDateStr === yesterdayStr) {
    // Consecutive day — increment
    newStreak = existing.current_streak + 1;
    newStartDate = existing.streak_start_date;
  } else {
    // Streak broken — reset
    newStreak = 1;
    newStartDate = today;
  }

  const newLongest = Math.max(existing.longest_streak, newStreak);

  await prisma.user_streaks.update({
    where: { user_id: userId },
    data: {
      current_streak: newStreak,
      longest_streak: newLongest,
      last_active_date: today,
      streak_start_date: newStartDate,
      updated_at: new Date()
    }
  });
}

// ─── Active Users ──────────────────────────────────────────────────────────

/**
 * Count currently active users (heartbeat within last 60 seconds).
 *
 * @returns {Promise<number>}
 */
async function getActiveUserCount() {
  const cutoff = new Date(Date.now() - 60 * 1000);

  const count = await prisma.user_activity_sessions.count({
    where: {
      is_active: true,
      last_heartbeat: { gte: cutoff }
    }
  });

  return count;
}

/**
 * Get list of currently active user IDs with their session info.
 *
 * @returns {Promise<Array>}
 */
async function getActiveUsers() {
  const cutoff = new Date(Date.now() - 60 * 1000);

  const sessions = await prisma.user_activity_sessions.findMany({
    where: {
      is_active: true,
      last_heartbeat: { gte: cutoff }
    },
    select: {
      user_id: true,
      started_at: true,
      last_heartbeat: true,
      duration_seconds: true,
      device_type: true,
      user: {
        select: { name: true, email: true }
      }
    },
    orderBy: { last_heartbeat: 'desc' }
  });

  return sessions;
}

// ─── Stale Session Cleanup (Background Job) ────────────────────────────────

/**
 * Mark sessions as inactive if their last heartbeat is older than 2 minutes.
 * Should be called periodically (e.g. every 2 minutes from background-processor).
 */
async function cleanupStaleSessions() {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000);

  const result = await prisma.user_activity_sessions.updateMany({
    where: {
      is_active: true,
      last_heartbeat: { lt: cutoff }
    },
    data: {
      is_active: false,
      ended_at: new Date()
    }
  });

  if (result.count > 0) {
    console.log(`[activity-tracker] Cleaned up ${result.count} stale sessions`);
  }
}

// ─── User Stats Helpers ────────────────────────────────────────────────────

/**
 * Get dashboard stats for a user (streak, today's stats, weekly summary).
 *
 * @param {number} userId
 * @returns {Promise<object>}
 */
async function getUserStats(userId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const [streak, todayStats, weeklyStats, activeSessions] = await Promise.all([
    prisma.user_streaks.findUnique({ where: { user_id: userId } }),

    prisma.user_daily_stats.findUnique({
      where: { user_id_date: { user_id: userId, date: today } }
    }),

    prisma.user_daily_stats.findMany({
      where: { user_id: userId, date: { gte: weekAgo } },
      orderBy: { date: 'asc' }
    }),

    prisma.user_activity_sessions.count({
      where: { user_id: userId, is_active: true }
    })
  ]);

  // Aggregate weekly totals
  const weeklyTotals = weeklyStats.reduce((acc, day) => ({
    wall_time: acc.wall_time + day.total_wall_time_seconds,
    study_time: acc.study_time + day.total_study_time_seconds,
    questions: acc.questions + day.questions_answered,
    correct: acc.correct + day.questions_correct,
    topics_studied: acc.topics_studied + day.topics_studied,
    topics_completed: acc.topics_completed + day.topics_completed,
    messages: acc.messages + day.messages_sent,
    days_active: acc.days_active + 1
  }), { wall_time: 0, study_time: 0, questions: 0, correct: 0, topics_studied: 0, topics_completed: 0, messages: 0, days_active: 0 });

  return {
    streak: {
      current: streak?.current_streak || 0,
      longest: streak?.longest_streak || 0,
      last_active_date: streak?.last_active_date || null
    },
    today: {
      wall_time_seconds: todayStats?.total_wall_time_seconds || 0,
      study_time_seconds: todayStats?.total_study_time_seconds || 0,
      topics_studied: todayStats?.topics_studied || 0,
      topics_completed: todayStats?.topics_completed || 0,
      questions_answered: todayStats?.questions_answered || 0,
      questions_correct: todayStats?.questions_correct || 0,
      sessions_count: todayStats?.sessions_count || 0,
      messages_sent: todayStats?.messages_sent || 0
    },
    weekly: weeklyTotals,
    daily_breakdown: weeklyStats.map(d => ({
      date: d.date,
      wall_time: d.total_wall_time_seconds,
      study_time: d.total_study_time_seconds,
      questions: d.questions_answered,
      correct: d.questions_correct
    })),
    is_currently_online: activeSessions > 0
  };
}

module.exports = {
  startSession,
  heartbeat,
  endSession,
  updateStreak,
  getActiveUserCount,
  getActiveUsers,
  cleanupStaleSessions,
  getUserStats
};
