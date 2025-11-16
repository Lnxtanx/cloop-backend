const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const { generateMissingGoals, generateGoalsForTopic } = require('../../services/content-pipeline');
const prisma = require('../../lib/prisma');

// All content generation is now handled automatically by the backend pipeline
// Content is generated on backend startup when pending records are found

/**
 * POST /api/content-generation/generate-missing-goals
 * Manually trigger goal generation for topics without goals
 */
router.post('/generate-missing-goals', authenticateToken, async (req, res) => {
  try {
    console.log('\n=== Manual goal generation triggered ===');
    
    const result = await generateMissingGoals();
    
    return res.status(200).json({
      success: true,
      message: `Generated goals for ${result.generated} topics`,
      ...result
    });
  } catch (error) {
    console.error('Error in manual goal generation:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/content-generation/generate-goals/:topicId
 * Generate goals for a specific topic
 */
router.post('/generate-goals/:topicId', authenticateToken, async (req, res) => {
  const { topicId } = req.params;
  const userId = req.user?.user_id;

  if (!topicId || isNaN(parseInt(topicId))) {
    return res.status(400).json({ error: 'Valid topic ID is required' });
  }

  try {
    // Verify user has access to this topic
    const topic = await prisma.topics.findFirst({
      where: {
        id: parseInt(topicId),
        user_id: userId
      }
    });

    if (!topic) {
      return res.status(403).json({ error: 'Topic not found or access denied' });
    }

    // Check if goals already exist
    const existingGoals = await prisma.topic_goals.findMany({
      where: { topic_id: parseInt(topicId) }
    });

    if (existingGoals.length > 0) {
      return res.status(200).json({
        success: true,
        message: 'Goals already exist for this topic',
        goals: existingGoals
      });
    }

    // Generate goals
    console.log(`\nGenerating goals for topic ${topicId}: ${topic.title}`);
    const goals = await generateGoalsForTopic(topic);

    if (goals.length === 0) {
      return res.status(500).json({
        success: false,
        error: 'Failed to generate goals'
      });
    }

    return res.status(201).json({
      success: true,
      message: `Generated ${goals.length} goals`,
      goals
    });
  } catch (error) {
    console.error('Error generating goals for topic:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/content-generation/status
 * Get background processor status
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const { getProcessorStatus } = require('../../services/background-processor');
    const status = getProcessorStatus();
    
    // Get pending tasks count
    const pendingCount = await prisma.content_generation_status.count({
      where: {
        OR: [
          { status: 'pending' },
          { status: 'in_progress' }
        ]
      }
    });

    return res.json({
      success: true,
      processor: status,
      pendingTasks: pendingCount
    });
  } catch (error) {
    console.error('Error getting processor status:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;

