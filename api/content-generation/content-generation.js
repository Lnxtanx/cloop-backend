const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const { generateMissingGlobalGoals } = require('../../services/global-curriculum-pipeline');
const { generateTopicGoals } = require('../../services/ai/curriculum');
const prisma = require('../../lib/prisma');

/**
 * POST /api/content-generation/generate-missing-goals
 * Manually trigger goal generation for global topics without goals
 */
router.post('/generate-missing-goals', authenticateToken, async (req, res) => {
  try {
    console.log('\n=== Manual global goal generation triggered ===');
    
    const result = await generateMissingGlobalGoals();
    
    return res.status(200).json({
      success: true,
      message: `Generated goals for ${result.generated} global topics`,
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
 * Generate goals for a specific global topic
 */
router.post('/generate-goals/:topicId', authenticateToken, async (req, res) => {
  const { topicId } = req.params;

  if (!topicId || isNaN(parseInt(topicId))) {
    return res.status(400).json({ error: 'Valid topic ID is required' });
  }

  try {
    const topic = await prisma.global_topics.findUnique({
      where: {
        id: parseInt(topicId)
      }
    });

    if (!topic) {
      return res.status(404).json({ error: 'Topic not found' });
    }

    // Check if goals already exist
    const existingGoals = await prisma.global_topic_goals.findMany({
      where: { topic_id: parseInt(topicId) },
      orderBy: { order: 'asc' }
    });

    if (existingGoals.length > 0) {
      return res.status(200).json({
        success: true,
        message: 'Goals already exist for this topic',
        goals: existingGoals
      });
    }

    // Generate goals via AI
    console.log(`\nGenerating goals for global topic ${topicId}: ${topic.title}`);
    const goalsData = await generateTopicGoals(topic.title, topic.content);
    const goalsList = goalsData.goals || [];

    const createdGoals = [];
    for (let i = 0; i < goalsList.length; i++) {
      const g = goalsList[i];
      const created = await prisma.global_topic_goals.create({
        data: {
          topic_id: topic.id,
          title: `Goal ${i + 1}: ${g.title}`,
          description: g.description,
          order: i + 1
        }
      });
      createdGoals.push(created);
    }

    return res.status(201).json({
      success: true,
      message: `Generated ${createdGoals.length} goals`,
      goals: createdGoals
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
 * Get global background processor status
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const { getProcessorStatus } = require('../../services/background-processor');
    const status = getProcessorStatus();
    
    // Get pending tasks count
    const pendingCount = await prisma.global_curriculum_status.count({
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

/**
 * POST /api/content-generation/retry/:subjectId
 * Reset failed status to pending and manually trigger background processor
 */
router.post('/retry/:subjectId', authenticateToken, async (req, res) => {
  const { subjectId } = req.params;

  if (!subjectId || isNaN(parseInt(subjectId))) {
    return res.status(400).json({ error: 'Valid subject ID is required' });
  }

  try {
    const parsedSubjectId = parseInt(subjectId);

    // Find the global subject
    const subject = await prisma.global_subjects.findUnique({
      where: { id: parsedSubjectId }
    });

    if (subject) {
      await prisma.global_curriculum_status.upsert({
        where: {
          board_grade_subject_name: {
            board: subject.board,
            grade: subject.grade,
            subject_name: subject.name
          }
        },
        update: {
          status: 'pending',
          error_message: null,
          updated_at: new Date()
        },
        create: {
          board: subject.board,
          grade: subject.grade,
          subject_name: subject.name,
          status: 'pending'
        }
      });
    }

    // Manually trigger the background processor
    const { triggerManualProcessing } = require('../../services/background-processor');
    triggerManualProcessing().catch(err => console.error('Error in manual processing trigger:', err));

    return res.status(200).json({
      success: true,
      message: 'Curriculum generation retried successfully'
    });
  } catch (error) {
    console.error('Error retrying generation:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;


