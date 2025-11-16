const prisma = require('../lib/prisma');

/**
 * Learning Turns Tracker Service
 * Populates the learning_turns table with comprehensive analytics data
 * 
 * This service captures every question-answer interaction with full details:
 * - Error types and patterns
 * - Performance scores and correctness
 * - User engagement (help requests, explanations, retries)
 * - Progress tracking (before/after mastery scores)
 * - Timing and difficulty metrics
 */

/**
 * Create a learning turn record for a question-answer interaction
 * 
 * @param {Object} params - Learning turn parameters
 * @param {number} params.user_id - User ID
 * @param {number} params.chat_id - Admin chat message ID
 * @param {number} params.goal_id - Topic goal ID
 * @param {number} params.topic_id - Topic ID
 * @param {number} params.subject_id - Subject ID
 * @param {string} params.user_name - User's name (optional)
 * @param {string} params.question_text - The question asked by AI
 * @param {string} params.user_answer_raw - User's original answer
 * @param {string} params.corrected_answer - AI's corrected version
 * @param {string} params.diff_html - Visual correction markup
 * @param {string} params.feedback_text - Explanation/feedback text
 * @param {Object} params.feedback_json - Structured feedback object
 * @param {string} params.error_type - Main error type (Conceptual, Spelling, Grammar, No Answer Provided)
 * @param {string} params.error_subtype - Specific error subtype (optional)
 * @param {boolean} params.is_correct - Whether answer was correct
 * @param {number} params.score_percent - Score percentage (0-100)
 * @param {number} params.response_time_sec - Time taken to answer (optional)
 * @param {string} params.help_requested - Type of help requested (optional)
 * @param {number} params.explain_loop_count - Number of "Explain" clicks
 * @param {number} params.num_retries - Number of retry attempts
 * @param {number} params.goal_progress_before - Progress % before this question
 * @param {number} params.goal_progress_after - Progress % after this question
 * @param {number} params.mastery_score - Overall mastery score
 * @param {string} params.difficulty_level - Question difficulty
 * @param {string} params.topic_title - Topic title for context
 * @param {string} params.subject_name - Subject name for context
 * @param {string} params.question_type - Type of question
 * @returns {Object} Created learning turn record
 */
async function createLearningTurn(params) {
  try {
    console.log('\n========== CREATING LEARNING TURN ==========');
    console.log('📚 Topic:', params.topic_title || 'Unknown');
    console.log('🎯 Goal ID:', params.goal_id);
    console.log('❓ Question:', params.question_text ? params.question_text.substring(0, 80) + '...' : 'N/A');
    console.log('💬 User Answer:', params.user_answer_raw ? params.user_answer_raw.substring(0, 80) + '...' : 'N/A');
    console.log('✅ Is Correct:', params.is_correct);
    console.log('📊 Score:', params.score_percent + '%');
    console.log('🔍 Error Type:', params.error_type || 'None');

    const learningTurn = await prisma.learning_turns.create({
      data: {
        // Required IDs
        user_id: params.user_id,
        chat_id: params.chat_id,
        goal_id: params.goal_id || null,
        topic_id: params.topic_id || null,
        subject_id: params.subject_id || null,
        
        // User info
        user_name: params.user_name || null,
        sender: 'user', // Always user for learning turns
        
        // Question-Answer content
        question_text: params.question_text || null,
        user_answer_raw: params.user_answer_raw || null,
        corrected_answer: params.corrected_answer || null,
        diff_html: params.diff_html || null,
        
        // Feedback
        feedback_text: params.feedback_text || null,
        feedback_json: params.feedback_json || null,
        
        // Error analysis
        error_type: params.error_type || null,
        error_subtype: params.error_subtype || null,
        
        // Performance metrics
        is_correct: params.is_correct || false,
        score_percent: params.score_percent || 0,
        
        // Timing
        response_time_sec: params.response_time_sec || 0,
        
        // Engagement metrics
        help_requested: params.help_requested || null,
        explain_loop_count: params.explain_loop_count || 0,
        num_retries: params.num_retries || 0,
        
        // Progress tracking
        goal_progress_before: params.goal_progress_before || 0,
        goal_progress_after: params.goal_progress_after || 0,
        mastery_score: params.mastery_score || 0,
        
        // Question metadata
        difficulty_level: params.difficulty_level || 'medium',
        topic_title: params.topic_title || null,
        subject_name: params.subject_name || null,
        question_type: params.question_type || 'open_ended',
        
        // Timestamps
        created_at: new Date(),
        updated_at: new Date()
      }
    });

    console.log('✅ Learning turn created with ID:', learningTurn.id);
    console.log('============================================\n');

    return learningTurn;
  } catch (error) {
    console.error('❌ Error creating learning turn:', error);
    throw error;
  }
}

/**
 * Update an existing learning turn (e.g., when user clicks "Explain" multiple times)
 * 
 * @param {number} learningTurnId - Learning turn ID to update
 * @param {Object} updates - Fields to update
 * @returns {Object} Updated learning turn record
 */
async function updateLearningTurn(learningTurnId, updates) {
  try {
    console.log('\n========== UPDATING LEARNING TURN ==========');
    console.log('🔄 Learning Turn ID:', learningTurnId);
    console.log('📝 Updates:', Object.keys(updates).join(', '));

    const updatedTurn = await prisma.learning_turns.update({
      where: { id: learningTurnId },
      data: {
        ...updates,
        updated_at: new Date()
      }
    });

    console.log('✅ Learning turn updated');
    console.log('============================================\n');

    return updatedTurn;
  } catch (error) {
    console.error('❌ Error updating learning turn:', error);
    throw error;
  }
}

/**
 * Increment explain loop count when user clicks "Explain" or "Explain more"
 * 
 * @param {number} learningTurnId - Learning turn ID
 * @returns {Object} Updated learning turn
 */
async function incrementExplainCount(learningTurnId) {
  try {
    const updatedTurn = await prisma.learning_turns.update({
      where: { id: learningTurnId },
      data: {
        explain_loop_count: { increment: 1 },
        updated_at: new Date()
      }
    });

    console.log(`🔄 Explain count incremented for learning turn ${learningTurnId}: ${updatedTurn.explain_loop_count}`);
    return updatedTurn;
  } catch (error) {
    console.error('❌ Error incrementing explain count:', error);
    throw error;
  }
}

/**
 * Get all learning turns for a topic (for analytics and metrics)
 * 
 * @param {number} userId - User ID
 * @param {number} topicId - Topic ID
 * @returns {Array} Array of learning turn records
 */
async function getLearningTurnsByTopic(userId, topicId) {
  try {
    const turns = await prisma.learning_turns.findMany({
      where: {
        user_id: userId,
        topic_id: topicId
      },
      orderBy: {
        created_at: 'asc'
      },
      include: {
        topic_goals: {
          select: {
            title: true,
            description: true
          }
        }
      }
    });

    return turns;
  } catch (error) {
    console.error('❌ Error fetching learning turns:', error);
    throw error;
  }
}

/**
 * Get learning turns for a specific goal
 * 
 * @param {number} userId - User ID
 * @param {number} goalId - Goal ID
 * @returns {Array} Array of learning turn records
 */
async function getLearningTurnsByGoal(userId, goalId) {
  try {
    const turns = await prisma.learning_turns.findMany({
      where: {
        user_id: userId,
        goal_id: goalId
      },
      orderBy: {
        created_at: 'asc'
      }
    });

    return turns;
  } catch (error) {
    console.error('❌ Error fetching learning turns by goal:', error);
    throw error;
  }
}

/**
 * Calculate mastery score based on recent performance
 * Uses weighted average of recent answers with decay for older attempts
 * 
 * @param {number} userId - User ID
 * @param {number} goalId - Goal ID
 * @returns {number} Mastery score (0-100)
 */
async function calculateMasteryScore(userId, goalId) {
  try {
    const recentTurns = await prisma.learning_turns.findMany({
      where: {
        user_id: userId,
        goal_id: goalId
      },
      orderBy: {
        created_at: 'desc'
      },
      take: 10, // Last 10 attempts
      select: {
        score_percent: true,
        is_correct: true
      }
    });

    if (recentTurns.length === 0) return 0;

    // Weighted average: recent attempts count more
    let totalWeight = 0;
    let weightedSum = 0;

    recentTurns.forEach((turn, index) => {
      const weight = Math.pow(0.9, index); // Exponential decay
      const score = turn.score_percent || (turn.is_correct ? 100 : 0);
      weightedSum += score * weight;
      totalWeight += weight;
    });

    const masteryScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
    return masteryScore;
  } catch (error) {
    console.error('❌ Error calculating mastery score:', error);
    return 0;
  }
}

/**
 * Get analytics summary for a topic
 * Aggregates all learning turns data for reporting
 * 
 * @param {number} userId - User ID
 * @param {number} topicId - Topic ID
 * @returns {Object} Analytics summary
 */
async function getTopicAnalytics(userId, topicId) {
  try {
    const turns = await getLearningTurnsByTopic(userId, topicId);

    const analytics = {
      total_questions: turns.length,
      correct_answers: turns.filter(t => t.is_correct).length,
      incorrect_answers: turns.filter(t => !t.is_correct).length,
      average_score: turns.length > 0 
        ? Math.round(turns.reduce((sum, t) => sum + (t.score_percent || 0), 0) / turns.length)
        : 0,
      
      // Error analysis
      error_types: {},
      error_subtypes: {},
      
      // Engagement metrics
      total_explain_requests: turns.reduce((sum, t) => sum + (t.explain_loop_count || 0), 0),
      total_help_requests: turns.filter(t => t.help_requested).length,
      total_retries: turns.reduce((sum, t) => sum + (t.num_retries || 0), 0),
      
      // Timing
      average_response_time: turns.length > 0
        ? Math.round(turns.reduce((sum, t) => sum + (t.response_time_sec || 0), 0) / turns.length)
        : 0,
      
      // Progress
      mastery_trend: turns.map(t => ({
        timestamp: t.created_at,
        mastery_score: t.mastery_score || 0,
        score_percent: t.score_percent || 0
      })),
      
      // Goal-level breakdown
      by_goal: {}
    };

    // Count error types
    turns.forEach(turn => {
      if (turn.error_type) {
        analytics.error_types[turn.error_type] = (analytics.error_types[turn.error_type] || 0) + 1;
      }
      if (turn.error_subtype) {
        analytics.error_subtypes[turn.error_subtype] = (analytics.error_subtypes[turn.error_subtype] || 0) + 1;
      }
      
      // Group by goal
      if (turn.goal_id) {
        if (!analytics.by_goal[turn.goal_id]) {
          analytics.by_goal[turn.goal_id] = {
            goal_title: turn.topic_goals?.title || 'Unknown',
            total: 0,
            correct: 0,
            incorrect: 0,
            average_score: 0,
            scores: []
          };
        }
        
        analytics.by_goal[turn.goal_id].total++;
        if (turn.is_correct) analytics.by_goal[turn.goal_id].correct++;
        else analytics.by_goal[turn.goal_id].incorrect++;
        analytics.by_goal[turn.goal_id].scores.push(turn.score_percent || 0);
      }
    });

    // Calculate average scores per goal
    Object.keys(analytics.by_goal).forEach(goalId => {
      const goal = analytics.by_goal[goalId];
      goal.average_score = goal.scores.length > 0
        ? Math.round(goal.scores.reduce((a, b) => a + b, 0) / goal.scores.length)
        : 0;
      delete goal.scores; // Remove raw scores array
    });

    return analytics;
  } catch (error) {
    console.error('❌ Error getting topic analytics:', error);
    throw error;
  }
}

module.exports = {
  createLearningTurn,
  updateLearningTurn,
  incrementExplainCount,
  getLearningTurnsByTopic,
  getLearningTurnsByGoal,
  calculateMasteryScore,
  getTopicAnalytics
};
