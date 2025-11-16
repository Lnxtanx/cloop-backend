const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const CurriculumAutoTrigger = require('../../services/curriculum-auto-trigger');
const { saveExpoPushToken } = require('../../services/notifications');

const prisma = require('../../lib/prisma');

// PUT /api/profile/update
router.put('/update', authenticateToken, async (req, res) => {
  const { 
    grade_level, 
    board, 
    subjects, 
    preferred_language, 
    study_goal,
    avatar_choice,
    avatar_url 
  } = req.body;

  // Get user_id from authenticated token
  const user_id = req.user?.user_id;

  if (!user_id) {
    return res.status(401).json({ error: 'User ID not found in token' });
  }

  try {
    const updatedUser = await prisma.users.update({
      where: {
        user_id: user_id
      },
      data: {
        grade_level,
        board,
        subjects,
        preferred_language,
        study_goal,
        avatar_choice,
        avatar_url
      },
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
        avatar_url: true
      }
    });

    // Auto-trigger curriculum generation if profile is complete
    CurriculumAutoTrigger.handleProfileUpdate(user_id, {
      grade_level,
      board,
      subjects,
      preferred_language,
      study_goal
    }).catch(error => {
      console.error('Auto-trigger curriculum generation failed:', error);
    });

    return res.json({ success: true, user: updatedUser });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/profile/push-token
router.post('/push-token', authenticateToken, async (req, res) => {
  const { expoPushToken } = req.body;
  const user_id = req.user?.user_id;

  if (!user_id) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!expoPushToken) {
    return res.status(400).json({ error: 'Expo push token is required' });
  }

  try {
    await saveExpoPushToken(user_id, expoPushToken);
    
    return res.json({ 
      success: true, 
      message: 'Push token saved successfully' 
    });
  } catch (error) {
    console.error('Error saving push token:', error);
    return res.status(500).json({ error: 'Failed to save push token' });
  }
});

module.exports = router;

