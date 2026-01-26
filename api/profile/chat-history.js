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
    // Get distinct topics that user has chatted about via chat_goal_progress -> topic_goals -> topics
    const progressEntries = await prisma.chat_goal_progress.findMany({
      where: { user_id: user_id },
      include: {
        topic_goals: {
          include: {
            topics: {
              include: {
                subjects: { select: { name: true } },
                chapters: { select: { title: true } }
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
      const topic = entry.topic_goals?.topics;
      if (!topic) continue;
      if (seen.has(topic.id)) continue;
      seen.add(topic.id);
      formattedHistory.push({
        topic_id: topic.id,
        title: topic.title,
        subject: topic.subjects?.name || null,
        chapter: topic.chapters?.title || null,
        last_activity: entry.created_at,
        is_completed: topic.is_completed || false,
        completion_percent: topic.completion_percent || 0,
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

