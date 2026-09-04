const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');

const prisma = require('../../lib/prisma');

// GET /api/profile/chat-history
// Fetch user's topic chat history grouped by topics
router.get('/', authenticateToken, async (req, res) => {
  let user_id = req.user?.user_id;

  if (!user_id) {
    return res.status(401).json({ error: 'Authentication required - please login' });
  }

  try {
    // Get distinct topics that user has chatted about via chat_goal_progress -> global_topic_goals -> topic
    const progressEntries = await prisma.chat_goal_progress.findMany({
      where: { user_id: user_id },
      include: {
        global_topic_goals: {
          include: {
            topic: {
              include: {
                goals: { select: { id: true } },
                chapter: {
                  include: {
                    subject: { select: { name: true } }
                  }
                },
                user_progress: {
                  where: { user_id: user_id },
                  select: {
                    is_completed: true,
                    completion_percent: true
                  }
                }
              }
            }
          }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    // De-duplicate by topic_id while preserving latest activity
    const seen = new Set();
    const formattedHistory = [];
    for (const entry of progressEntries) {
      const topic = entry.global_topic_goals?.topic;
      if (!topic) continue;
      if (seen.has(topic.id)) continue;
      seen.add(topic.id);

      const prog = topic.user_progress?.[0] || {};
      let isCompleted = Boolean(prog.is_completed);
      let completionPercent = Number(prog.completion_percent || 0);

      // Reconcile / auto-heal if all goals were completed in chat_goal_progress
      if (!isCompleted && topic.goals?.length > 0) {
        const completedGoals = await prisma.chat_goal_progress.findMany({
          where: {
            user_id: user_id,
            goal_id: { in: topic.goals.map(g => g.id) },
            is_completed: true
          },
          distinct: ['goal_id']
        });
        if (completedGoals.length >= topic.goals.length) {
          isCompleted = true;
          completionPercent = 100;
          prisma.user_topic_progress.upsert({
            where: { user_id_topic_id: { user_id, topic_id: topic.id } },
            update: { is_completed: true, completion_percent: 100, last_accessed_at: new Date() },
            create: { user_id, topic_id: topic.id, is_completed: true, completion_percent: 100, last_accessed_at: new Date() }
          }).catch(() => {});
        } else if (completedGoals.length > 0 && completionPercent === 0) {
          completionPercent = Math.round((completedGoals.length / topic.goals.length) * 100);
        }
      }

      formattedHistory.push({
        topic_id: topic.id,
        title: topic.title,
        subject: topic.chapter?.subject?.name || null,
        chapter: topic.chapter?.title || null,
        last_activity: entry.created_at,
        is_completed: isCompleted,
        completion_percent: completionPercent,
        chat_count: 0 // Placeholder, or calculate if feasible
      });
    }

    return res.status(200).json({
      chatHistory: formattedHistory
    });
  } catch (err) {
    console.error('Error fetching chat history:', err);
    return res.status(500).json({ error: 'Server error while fetching chat history' });
  }
});

module.exports = router;

