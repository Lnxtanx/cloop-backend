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
    // Get user's enrolled subjects with completion data
    const enrollments = await prisma.user_subject_enrollment.findMany({
      where: { user_id: user_id },
      include: {
        subject: {
          include: {
            chapters: {
              include: {
                topics: {
                  include: {
                    user_progress: {
                      where: { user_id: user_id }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    // Get completed topics by user from user_topic_progress
    const completedTopicProgress = await prisma.user_topic_progress.findMany({
      where: {
        user_id: user_id,
        is_completed: true
      },
      include: {
        topic: {
          include: {
            chapter: {
              select: {
                title: true,
                subject: { select: { id: true, name: true } }
              }
            }
          }
        }
      }
    });

    // Get topic chat activity via chat_goal_progress (counts of chats per topic for this user)
    const progressEntries = await prisma.chat_goal_progress.findMany({
      where: { user_id: user_id },
      include: {
        global_topic_goals: { select: { topic_id: true } }
      }
    });

    // Aggregate counts per topic_id
    const topicCountsMap = {};
    for (const p of progressEntries) {
      const topicId = p.global_topic_goals?.topic_id;
      if (!topicId) continue;
      topicCountsMap[topicId] = (topicCountsMap[topicId] || 0) + 1;
    }

    const topicIds = Object.keys(topicCountsMap).map(x => parseInt(x));
    const topicDetails = topicIds.length > 0 ? await prisma.global_topics.findMany({
      where: { id: { in: topicIds } },
      include: {
        chapter: {
          select: {
            title: true,
            subject: { select: { name: true } }
          }
        },
        user_progress: {
          where: { user_id: user_id }
        }
      }
    }) : [];

    // Calculate subject-wise progress
    let totalChaptersCount = 0;
    let completedChaptersCount = 0;

    const subjectProgress = enrollments.map(enr => {
      const sub = enr.subject;
      const chapters = sub.chapters || [];
      totalChaptersCount += chapters.length;

      let subCompletedChapters = 0;
      let totalTopicPercent = 0;
      let totalTopicCount = 0;

      for (const ch of chapters) {
        const topics = ch.topics || [];
        totalTopicCount += topics.length;
        const completedChTopics = topics.filter(t => t.user_progress?.[0]?.is_completed).length;
        if (topics.length > 0 && completedChTopics >= topics.length) {
          subCompletedChapters++;
        }
        for (const t of topics) {
          totalTopicPercent += Number(t.user_progress?.[0]?.completion_percent || 0);
        }
      }

      completedChaptersCount += subCompletedChapters;
      const completion_percent = totalTopicCount > 0
        ? Math.round(totalTopicPercent / totalTopicCount)
        : 0;

      return {
        subject: {
          id: sub.id,
          name: sub.name,
          code: sub.code
        },
        total_chapters: chapters.length,
        completed_chapters: subCompletedChapters,
        completion_percent: completion_percent,
        topics_completed: completedTopicProgress.filter(p =>
          p.topic?.chapter?.subject?.id === sub.id
        ).length
      };
    });

    const totalSubjects = enrollments.length;
    const completedSubjects = subjectProgress.filter(sp => sp.completion_percent >= 100).length;
    const totalCompletedTopics = completedTopicProgress.length;

    // Determine strong and weak topics based on chat activity and completion
    const strongTopics = topicDetails
      .filter(topic => {
        const prog = topic.user_progress?.[0];
        const activityCount = topicCountsMap[topic.id] || 0;
        return prog?.is_completed && activityCount >= 3;
      })
      .slice(0, 5);

    const weakTopics = topicDetails
      .filter(topic => {
        const prog = topic.user_progress?.[0];
        const activityCount = topicCountsMap[topic.id] || 0;
        return (!prog || !prog.is_completed) && activityCount >= 5;
      })
      .slice(0, 5);

    return res.status(200).json({
      overview: {
        total_subjects: totalSubjects,
        completed_subjects: completedSubjects,
        total_chapters: totalChaptersCount,
        completed_chapters: completedChaptersCount,
        total_topics_completed: totalCompletedTopics,
        overall_progress: totalChaptersCount > 0 ? Math.round((completedChaptersCount / totalChaptersCount) * 100) : 0
      },
      subject_progress: subjectProgress,
      strong_topics: strongTopics.map(topic => {
        const prog = topic.user_progress?.[0] || {};
        return {
          id: topic.id,
          title: topic.title,
          subject: topic.chapter?.subject?.name || null,
          chapter: topic.chapter?.title || null,
          completion_percent: parseFloat(prog.completion_percent?.toString() || '0')
        };
      }),
      weak_topics: weakTopics.map(topic => ({
        id: topic.id,
        title: topic.title,
        subject: topic.chapter?.subject?.name || null,
        chapter: topic.chapter?.title || null,
        chat_count: topicCountsMap[topic.id] || 0
      })),
      activity: {
        total_chat_sessions: Object.keys(topicCountsMap).length,
        most_active_topics: topicDetails
          .map(topic => ({
            id: topic.id,
            title: topic.title,
            subject: topic.chapter?.subject?.name || null,
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

