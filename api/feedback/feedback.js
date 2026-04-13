const express = require('express');
const router = express.Router();
const prisma = require('../../lib/prisma');

// POST /api/feedback - Submit feedback
router.post('/', async (req, res) => {
  const { user_id, rating, feedback, category } = req.body;

  // Validate required fields
  if (!rating || !feedback) {
    return res.status(400).json({ error: 'Rating and feedback text are required' });
  }

  // Validate rating
  if (rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }

  try {
    // Create feedback record
    const newFeedback = await prisma.feedback.create({
      data: {
        user_id: user_id || null, // Allow null for anonymous feedback
        rating: parseInt(rating),
        feedback: feedback.trim(),
        category: category || 'general',
      },
    });

    console.log('✅ Feedback received:', {
      id: newFeedback.id,
      userId: user_id || 'anonymous',
      rating,
      category,
      feedbackLength: feedback.length,
    });

    return res.status(201).json({
      success: true,
      message: 'Feedback submitted successfully',
      data: newFeedback,
    });
  } catch (err) {
    console.error('❌ Feedback submission error:', err);
    return res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// GET /api/feedback - Get all feedback (admin only, for demo)
router.get('/', async (req, res) => {
  try {
    const feedbacks = await prisma.feedback.findMany({
      orderBy: { created_at: 'desc' },
      take: 100, // Limit to last 100
    });

    return res.json({ feedbacks });
  } catch (err) {
    console.error('❌ Fetch feedback error:', err);
    return res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

module.exports = router;
