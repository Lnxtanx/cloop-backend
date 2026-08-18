const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');

const prisma = require('../../lib/prisma');
const { enrollUserInSubject, ensureGlobalCurriculum } = require('../../services/global-curriculum-pipeline');

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
    const parsedSubjectId = parseInt(subject_id);

    // Check if user already enrolled
    const existingEnrollment = await prisma.user_subject_enrollment.findUnique({
      where: {
        user_id_subject_id: {
          user_id: user_id,
          subject_id: parsedSubjectId
        }
      }
    });

    if (existingEnrollment) {
      return res.status(400).json({ error: 'Subject already added to your profile' });
    }

    // Verify global subject exists
    let subject = await prisma.global_subjects.findUnique({
      where: { id: parsedSubjectId },
      include: {
        chapters: true
      }
    });

    // Fallback: check legacy subjects table
    if (!subject) {
      const legacySub = await prisma.subjects.findUnique({
        where: { id: parsedSubjectId }
      });

      if (legacySub) {
        const user = await prisma.users.findUnique({ where: { user_id: user_id } });
        if (user && user.board && user.grade_level) {
          const genResult = await ensureGlobalCurriculum(user.board, user.grade_level, legacySub.name, legacySub.code, legacySub.category);
          subject = genResult.globalSubject;
        }
      }
    }

    if (!subject) {
      return res.status(404).json({ error: 'Subject not found' });
    }

    // Enroll user in global subject
    const enrollment = await enrollUserInSubject(user_id, subject.id);

    return res.json({
      success: true,
      userSubject: {
        id: enrollment.id,
        subject_id: subject.id,
        total_chapters: subject.chapters?.length || 0,
        completed_chapters: 0,
        completion_percent: 0,
        created_at: enrollment.enrolled_at,
        subject: {
          id: subject.id,
          name: subject.name,
          code: subject.code,
          category: subject.category
        }
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
    const parsedSubjectId = parseInt(subject_id);

    // Remove enrollment
    await prisma.user_subject_enrollment.deleteMany({
      where: {
        user_id: user_id,
        subject_id: parsedSubjectId
      }
    });

    return res.json({ success: true, message: 'Subject removed successfully' });

  } catch (err) {
    console.error('Error removing subject:', err);
    return res.status(500).json({ error: 'Server error while removing subject' });
  }
});

module.exports = router;


