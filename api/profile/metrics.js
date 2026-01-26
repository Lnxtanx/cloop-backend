const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');

const prisma = require('../../lib/prisma');

// GET /api/profile/metrics
// Fetch comprehensive user metrics including progress, weak/strong topics, etc.
router.get('/', authenticateToken, async (req, res) => {
  let user_id = req.user?.user_id;

  if (!user_id) {
    return res.status(401).json({ error: 'Authentication required - please login' });
  }

  try {
    // Get user's subjects with completion data
    const userSubjects = await prisma.user_subjects.findMany({
      where: { user_id: user_id },
      include: {
        subjects: {
          select: {
            id: true,
            name: true,
            code: true,
          }
        }
      }
    });

    // Get completed topics by subject
    const completedTopics = await prisma.topics.findMany({
      where: {
        user_id: user_id,
        is_completed: true
      },
      include: {
        subjects: {
          select: {
            name: true
          }
        },
        chapters: {
          select: {
            title: true
          }
        }
      }
    });

    // Get topic chat activity via chat_goal_progress (counts of chats per topic for this user)
    const progressEntries = await prisma.chat_goal_progress.findMany({
      where: { user_id: user_id },
      include: {
        topic_goals: { select: { topic_id: true } }
      }
    });

    // Aggregate counts per topic_id
    const topicCountsMap = {};
    for (const p of progressEntries) {
      const topicId = p.topic_goals?.topic_id;
      if (!topicId) continue;
      topicCountsMap[topicId] = (topicCountsMap[topicId] || 0) + 1;
    }

    const topicIds = Object.keys(topicCountsMap).map(x => parseInt(x));
    const topicDetails = topicIds.length > 0 ? await prisma.topics.findMany({
      where: { id: { in: topicIds } },
      include: {
        subjects: { select: { name: true } },
        chapters: { select: { title: true } }
      }
    }) : [];

    // Calculate metrics
    const totalSubjects = userSubjects.length;
    const completedSubjects = userSubjects.filter(us => us.completion_percent >= 100).length;
    const totalChapters = userSubjects.reduce((sum, us) => sum + (us.total_chapters || 0), 0);
    const completedChapters = userSubjects.reduce((sum, us) => sum + (us.completed_chapters || 0), 0);
    const totalCompletedTopics = completedTopics.length;

    // Determine strong and weak topics based on chat activity and completion
    const strongTopics = topicDetails
      .filter(topic => {
        const activityCount = topicCountsMap[topic.id] || 0;
        return topic.is_completed && activityCount >= 3;
      })
      .slice(0, 5);

    const weakTopics = topicDetails
      .filter(topic => {
        const activityCount = topicCountsMap[topic.id] || 0;
        return !topic.is_completed && activityCount >= 5;
      })
      .slice(0, 5);

    // Calculate subject-wise progress
    const subjectProgress = userSubjects.map(userSubject => ({
      subject: userSubject.subjects,
      total_chapters: userSubject.total_chapters || 0,
      completed_chapters: userSubject.completed_chapters || 0,
      completion_percent: parseFloat(userSubject.completion_percent?.toString() || '0'),
      topics_completed: completedTopics.filter(topic =>
        topic.subject_id === userSubject.subject_id
      ).length
    }));

    return res.status(200).json({
      overview: {
        total_subjects: totalSubjects,
        completed_subjects: completedSubjects,
        total_chapters: totalChapters,
        completed_chapters: completedChapters,
        total_topics_completed: totalCompletedTopics,
        overall_progress: totalChapters > 0 ? Math.round((completedChapters / totalChapters) * 100) : 0
      },
      subject_progress: subjectProgress,
      strong_topics: strongTopics.map(topic => ({
        id: topic.id,
        title: topic.title,
        subject: topic.subjects?.name || null,
        chapter: topic.chapters?.title || null,
        completion_percent: parseFloat(topic.completion_percent?.toString() || '0')
      })),
      weak_topics: weakTopics.map(topic => ({
        id: topic.id,
        title: topic.title,
        subject: topic.subjects?.name || null,
        chapter: topic.chapters?.title || null,
        chat_count: topicCountsMap[topic.id] || 0
      })),
      activity: {
        total_chat_sessions: Object.keys(topicCountsMap).length,
        most_active_topics: topicDetails
          .map(topic => ({
            id: topic.id,
            title: topic.title,
            subject: topic.subjects?.name || null,
            chat_count: topicCountsMap[topic.id] || 0
          }))
          .sort((a, b) => b.chat_count - a.chat_count)
          .slice(0, 5)
      }
    });
  } catch (err) {
    console.error('Error fetching user metrics:', err);
    return res.status(500).json({ error: 'Server error while fetching metrics' });
  }
});

module.exports = router;

