const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');

const prisma = require('../../lib/prisma');

// POST /api/profile/add-subject
router.post('/add-subject', authenticateToken, async (req, res) => {
  const { subject_id } = req.body;
  const user_id = req.user?.user_id;

  if (!user_id) {
    return res.status(401).json({ error: 'User ID not found in token' });
  }

  if (!subject_id) {
    return res.status(400).json({ error: 'Subject ID is required' });
  }

  try {
    // Check if user already has this subject
    const existingUserSubject = await prisma.user_subjects.findUnique({
      where: {
        user_id_subject_id: {
          user_id: user_id,
          subject_id: subject_id
        }
      }
    });

    if (existingUserSubject) {
      return res.status(400).json({ error: 'Subject already added to your profile' });
    }

    // Verify subject exists
    const subject = await prisma.subjects.findUnique({
      where: { id: subject_id }
    });

    if (!subject) {
      return res.status(404).json({ error: 'Subject not found' });
    }

    // Count existing chapters for this subject and user
    const totalChapters = await prisma.chapters.count({
      where: {
        subject_id: subject_id,
        user_id: user_id
      }
    });

    // Add subject to user_subjects table
    const userSubject = await prisma.user_subjects.create({
      data: {
        user_id: user_id,
        subject_id: subject_id,
        total_chapters: totalChapters,
        completed_chapters: 0,
        completion_percent: 0
      },
      include: {
        subjects: {
          select: {
            id: true,
            name: true,
            code: true,
            category: true
          }
        }
      }
    });

    return res.json({
      success: true,
      userSubject: {
        id: userSubject.id,
        subject_id: userSubject.subject_id,
        total_chapters: userSubject.total_chapters,
        completed_chapters: userSubject.completed_chapters,
        completion_percent: userSubject.completion_percent,
        created_at: userSubject.created_at,
        subject: userSubject.subjects
      }
    });

  } catch (err) {
    console.error('Error adding subject:', err);
    return res.status(500).json({ error: 'Server error while adding subject' });
  }
});

// DELETE /api/profile/remove-subject
router.delete('/remove-subject', authenticateToken, async (req, res) => {
  const { subject_id } = req.body;
  const user_id = req.user?.user_id;

  if (!user_id) {
    return res.status(401).json({ error: 'User ID not found in token' });
  }

  if (!subject_id) {
    return res.status(400).json({ error: 'Subject ID is required' });
  }

  try {
    // Check if user has this subject
    const existingUserSubject = await prisma.user_subjects.findUnique({
      where: {
        user_id_subject_id: {
          user_id: user_id,
          subject_id: subject_id
        }
      }
    });

    if (!existingUserSubject) {
      return res.status(404).json({ error: 'Subject not found in your profile' });
    }

    // Remove subject from user_subjects table
    await prisma.user_subjects.delete({
      where: {
        user_id_subject_id: {
          user_id: user_id,
          subject_id: subject_id
        }
      }
    });

    return res.json({ success: true, message: 'Subject removed successfully' });

  } catch (err) {
    console.error('Error removing subject:', err);
    return res.status(500).json({ error: 'Server error while removing subject' });
  }
});

module.exports = router;

