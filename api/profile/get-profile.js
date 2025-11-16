const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');

const prisma = require('../../lib/prisma');

// GET /api/profile
router.get('/', authenticateToken, async (req, res) => {
  // Get user_id from authenticated token
  let user_id = req.user?.user_id;

  // Allow a query fallback for development/testing: /api/profile?user_id=1
  if (!user_id && req.query && req.query.user_id) {
    // coerce to number when possible
    const parsed = Number(req.query.user_id);
    if (!Number.isNaN(parsed)) user_id = parsed;
  }

  // If still no user_id, return error
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
        subjects: true, // Keep for backward compatibility
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

    // Fetch user's subjects from user_subjects table
    const userSubjects = await prisma.user_subjects.findMany({
      where: { user_id: user_id },
      include: {
        subjects: {
          select: {
            id: true,
            name: true,
            code: true,
            category: true,
          }
        }
      }
    });

    // Update chapter counts from actual chapters table
    for (const userSubject of userSubjects) {
      const actualChapterCount = await prisma.chapters.count({
        where: {
          subject_id: userSubject.subject_id,
          user_id: user_id
        }
      });

      const completedChapterCount = await prisma.chapters.count({
        where: {
          subject_id: userSubject.subject_id,
          user_id: user_id,
          completion_percent: { gte: 100 }
        }
      });

      // Update the user_subjects record if counts differ
      if (actualChapterCount !== userSubject.total_chapters || 
          completedChapterCount !== userSubject.completed_chapters) {
        await prisma.user_subjects.update({
          where: {
            id: userSubject.id
          },
          data: {
            total_chapters: actualChapterCount,
            completed_chapters: completedChapterCount,
            completion_percent: actualChapterCount > 0 ? 
              Math.round((completedChapterCount / actualChapterCount) * 100) : 0
          }
        });

        // Update the local object
        userSubject.total_chapters = actualChapterCount;
        userSubject.completed_chapters = completedChapterCount;
        userSubject.completion_percent = actualChapterCount > 0 ? 
          Math.round((completedChapterCount / actualChapterCount) * 100) : 0;
      }
    }

    // Add the subjects data to the user object
    const userWithSubjects = {
      ...user,
      user_subjects: userSubjects.map(us => ({
        id: us.id,
        subject_id: us.subject_id,
        total_chapters: us.total_chapters,
        completed_chapters: us.completed_chapters,
        completion_percent: us.completion_percent,
        created_at: us.created_at,
        subject: us.subjects
      }))
    };

    return res.json(userWithSubjects);
  } catch (err) {
    console.error('Error fetching user profile:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

