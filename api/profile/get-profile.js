const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');

const prisma = require('../../lib/prisma');

// GET /api/profile
router.get('/', authenticateToken, async (req, res) => {
  let user_id = req.user?.user_id;

  if (!user_id && req.query && req.query.user_id) {
    const parsed = Number(req.query.user_id);
    if (!Number.isNaN(parsed)) user_id = parsed;
  }

  if (!user_id) {
    return res.status(400).json({ error: 'User ID not found in token' });
  }

  try {
    const user = await prisma.users.findUnique({
      where: { user_id: user_id },
      select: {
        user_id: true,
        name: true,
        email: true,
        grade_level: true,
        board: true,
        subjects: true,
        preferred_language: true,
        study_goal: true,
        avatar_choice: true,
        avatar_url: true,
        num_chats: true,
        num_lessons: true,
        created_at: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Fetch user's enrolled global subjects
    const enrollments = await prisma.user_subject_enrollment.findMany({
      where: { user_id: user_id },
      orderBy: { id: 'asc' },
      include: {
        subject: {
          select: {
            id: true,
            name: true,
            code: true,
            category: true,
            board: true,
            grade: true,
            chapters: {
              select: {
                id: true,
                topics: {
                  select: {
                    id: true,
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
          }
        }
      }
    });

    // Also fetch global curriculum status records
    const globalStatuses = await prisma.global_curriculum_status.findMany({
      where: {
        board: user.board || undefined,
        grade: user.grade_level || undefined
      }
    });

    const user_subjects = enrollments.map(enr => {
      const sub = enr.subject;
      const chapters = sub.chapters || [];
      const total_chapters = chapters.length;

      let completed_chapters = 0;
      let totalTopicPercentSum = 0;
      let totalTopicCount = 0;

      for (const ch of chapters) {
        const topics = ch.topics || [];
        const chTopicCount = topics.length;
        let chCompletedTopics = 0;

        for (const top of topics) {
          totalTopicCount++;
          const prog = top.user_progress?.[0];
          if (prog?.is_completed) {
            chCompletedTopics++;
          }
          totalTopicPercentSum += Number(prog?.completion_percent || 0);
        }

        if (chTopicCount > 0 && chCompletedTopics >= chTopicCount) {
          completed_chapters++;
        }
      }

      const completion_percent = totalTopicCount > 0
        ? Math.round(totalTopicPercentSum / totalTopicCount)
        : 0;

      const statusRecord = globalStatuses.find(gs => gs.subject_name.toLowerCase() === sub.name.toLowerCase());

      return {
        id: enr.id,
        subject_id: sub.id,
        total_chapters,
        completed_chapters,
        completion_percent,
        created_at: enr.enrolled_at,
        subject: {
          id: sub.id,
          name: sub.name,
          code: sub.code,
          category: sub.category
        },
        generation_status: statusRecord ? {
          status: statusRecord.status,
          chapters_generated: statusRecord.chapters_generated,
          topics_generated: statusRecord.topics_generated,
          goals_generated: statusRecord.goals_generated,
          error_message: statusRecord.error_message
        } : {
          status: 'completed',
          chapters_generated: true,
          topics_generated: true,
          goals_generated: true
        }
      };
    });

    return res.json({
      ...user,
      user_subjects
    });
  } catch (err) {
    console.error('Error fetching user profile:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;


