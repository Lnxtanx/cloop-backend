const prisma = require('../lib/prisma');

/**
 * Topic Chat Metrics Service
 * Handles session completion metrics, performance analysis, and mistake tracking
 * 
 * Features:
 * - Calculate overall performance metrics
 * - Track error types and patterns
 * - Identify weak topics for "Learn More" mode
 * - Generate session summary with detailed statistics
 */

/**
 * Calculate comprehensive session metrics for a completed topic
 * @param {number} userId - User ID
 * @param {number} topicId - Topic ID
 * @param {Array} topicGoals - Array of topic goals with progress
 * @returns {Object} Session metrics including questions, score, errors, and weak areas
 */
async function calculateSessionMetrics(userId, topicId, topicGoals) {
  try {
    console.log('\n========== CALCULATING SESSION METRICS ==========');
    console.log('👤 User ID:', userId);
    console.log('📚 Topic ID:', topicId);
    console.log('🎯 Total Goals:', topicGoals.length);
    
    // Get all goal IDs for this topic
    const goalIds = topicGoals.map(g => g.id);
    console.log('📋 Goal IDs:', goalIds);
    
    // PRIMARY SOURCE: chat_goal_progress (real-time counts)
    console.log('\n🔍 PRIMARY SOURCE: chat_goal_progress table...');
    const goalProgress = await prisma.chat_goal_progress.findMany({
      where: {
        user_id: userId,
        goal_id: { in: goalIds }
      },
      select: {
        goal_id: true,
        num_questions: true,
        num_correct: true,
        num_incorrect: true,
        is_completed: true
      }
    });

    console.log('📊 Goal Progress Records Found:', goalProgress.length);
    goalProgress.forEach((progress, index) => {
      console.log(`   ${index + 1}. Goal ${progress.goal_id}: ${progress.num_questions} questions, ${progress.num_correct} correct, ${progress.num_incorrect} incorrect`);
    });

    // SECONDARY SOURCE: learning_turns (detailed feedback with error types)
    console.log('\n🔍 SECONDARY SOURCE: learning_turns table...');
    
    // Get learning_turns for this topic's goals
    const learningTurns = await prisma.learning_turns.findMany({
      where: {
        user_id: userId,
        goal_id: { in: goalIds }
      },
      orderBy: {
        created_at: 'asc'
      },
      select: {
        id: true,
        goal_id: true,
        is_correct: true,
        error_type: true,
        error_subtype: true,
        score_percent: true,
        question_text: true,
        user_answer_raw: true
      }
    });

    console.log('📊 Learning Turns Found:', learningTurns.length);

    // Build evaluations from learning_turns directly
    let evaluations = [];
    const errorTypesByGoal = {};

    // Parse learning turns to get detailed error information
    console.log('\n📋 PARSING LEARNING TURNS:');
    let parsedCount = 0;
    
    learningTurns.forEach((turn, index) => {
      if (!errorTypesByGoal[turn.goal_id]) {
        errorTypesByGoal[turn.goal_id] = [];
      }
      
      const errorType = turn.is_correct ? null : (turn.error_type || 'Unknown');
      const scorePercent = turn.score_percent !== null && turn.score_percent !== undefined 
        ? turn.score_percent 
        : (turn.is_correct ? 100 : 10);
      
      errorTypesByGoal[turn.goal_id].push({
        is_correct: turn.is_correct || false,
        error_type: errorType,
        error_subtype: turn.error_subtype || null,
        score_percent: scorePercent
      });
      
      parsedCount++;
      console.log(`   ${index + 1}. Goal ${turn.goal_id}: ${turn.is_correct ? '✅ CORRECT' : '❌ INCORRECT'} | Error: ${errorType || 'None'} | Score: ${scorePercent}%`);
    });
    
    console.log(`\n📊 Learning Turns Parsing Summary:`);
    console.log(`   ✅ Successfully parsed: ${parsedCount}`);
    console.log(`   📋 Total records: ${learningTurns.length}`);

    // Build evaluations using learning_turns data
    console.log('\n📊 BUILDING EVALUATIONS:');
    let dataSource = 'learning_turns';
    
    goalProgress.forEach(progress => {
      const goalId = progress.goal_id;
      const errorDetails = errorTypesByGoal[goalId] || [];
      
      console.log(`   Goal ${goalId}:`);
      console.log(`      - Total Questions: ${progress.num_questions}`);
      console.log(`      - Correct: ${progress.num_correct}`);
      console.log(`      - Incorrect: ${progress.num_incorrect}`);
      console.log(`      - Learning Turns: ${errorDetails.length}`);
      
      // Add evaluations from learning turns
      errorDetails.forEach(detail => {
        evaluations.push({
          is_correct: detail.is_correct,
          error_type: detail.error_type,
          error_subtype: detail.error_subtype,
          score_percent: detail.score_percent,
          goal_id: goalId
        });
      });
      
      console.log(`      - Evaluations Added: ${errorDetails.length}`);
    });

    console.log('\n📊 DATA SOURCE USED:', dataSource.toUpperCase());
    console.log('📊 Total Evaluations Built:', evaluations.length);

    if (evaluations.length > 0) {
      console.log('\n📋 EVALUATION BREAKDOWN:');
      evaluations.forEach((evaluation, index) => {
        console.log(`   ${index + 1}. ${evaluation.is_correct ? '✅ CORRECT' : '❌ INCORRECT'} | Score: ${evaluation.score_percent}% | Error: ${evaluation.error_type || 'None'}`);
      });
    }

    // Calculate overall metrics
    const totalQuestions = evaluations.length;
    const correctAnswers = evaluations.filter(e => e.is_correct).length;
    const incorrectAnswers = totalQuestions - correctAnswers;
    
    // Calculate average score from score_percent (not just correct/incorrect binary)
    const totalScore = evaluations.reduce((sum, e) => sum + (e.score_percent || 0), 0);
    const overallScorePercent = totalQuestions > 0 
      ? Math.round(totalScore / totalQuestions) 
      : 0;

    console.log('\n📊 CALCULATED METRICS:');
    console.log('   Total Questions:', totalQuestions);
    console.log('   Correct Answers:', correctAnswers);
    console.log('   Incorrect Answers:', incorrectAnswers);
    console.log('   📈 Total Score Points:', totalScore, '/', totalQuestions * 100);
    console.log('   📈 Average Score:', overallScorePercent + '%');
    console.log('   📊 Score Breakdown:', evaluations.map(e => `${e.score_percent}%`).join(', '));

    // Calculate average response time (not tracked in current system)
    const avgResponseTime = 0;

    // Count help requests (not tracked in current system)
    const totalHelpRequests = 0;
    const totalExplanations = 0;

    // Analyze error types and subtypes
    const errorTypeCounts = {};
    const errorSubtypeCounts = {};
    const incorrectEvals = evaluations.filter(e => !e.is_correct);
    
    incorrectEvals.forEach(evaluation => {
      if (evaluation.error_type) {
        errorTypeCounts[evaluation.error_type] = (errorTypeCounts[evaluation.error_type] || 0) + 1;
      }
      if (evaluation.error_subtype) {
        errorSubtypeCounts[evaluation.error_subtype] = (errorSubtypeCounts[evaluation.error_subtype] || 0) + 1;
      }
    });

    // Sort error types by frequency
    const topErrorTypes = Object.entries(errorTypeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count, percent: incorrectAnswers > 0 ? Math.round((count / incorrectAnswers) * 100) : 0 }));

    // Analyze goal-level performance
    console.log('\n🎯 GOAL-LEVEL PERFORMANCE:');
    const goalPerformance = [];
    for (const goal of topicGoals) {
      // Get progress from chat_goal_progress
      const progress = await prisma.chat_goal_progress.findFirst({
        where: {
          user_id: userId,
          goal_id: goal.id
        }
      });
      
      const questionsAsked = progress?.num_questions || 0;
      const correctCount = progress?.num_correct || 0;
      const incorrectCount = progress?.num_incorrect || 0;
      const goalScore = questionsAsked > 0 ? Math.round((correctCount / questionsAsked) * 100) : 0;
      
      console.log(`   Goal ${goal.id}: "${goal.title}"`);
      console.log(`      Questions: ${questionsAsked}, Correct: ${correctCount}, Incorrect: ${incorrectCount}, Score: ${goalScore}%`);
      
      goalPerformance.push({
        goal_id: goal.id,
        goal_title: goal.title,
        goal_description: goal.description,
        questions_asked: questionsAsked,
        correct_answers: correctCount,
        incorrect_answers: incorrectCount,
        score_percent: goalScore,
        is_weak: goalScore < 70, // Weak if below 70%
        mistakes: [] // Detailed mistakes not available in current system
      });
    }

    // Identify weak goals (score < 70%)
    const weakGoals = goalPerformance.filter(g => g.is_weak);

    console.log('\n⚠️  WEAK GOALS (< 70%):');
    if (weakGoals.length > 0) {
      weakGoals.forEach((goal, index) => {
        console.log(`   ${index + 1}. "${goal.goal_title}" - ${goal.score_percent}% (${goal.correct_answers}/${goal.questions_asked} correct)`);
      });
    } else {
      console.log('   ✅ No weak goals - all above 70%!');
    }

    // Determine star rating (1-5 stars)
    let starRating = 1;
    if (overallScorePercent >= 90) starRating = 5;
    else if (overallScorePercent >= 75) starRating = 4;
    else if (overallScorePercent >= 60) starRating = 3;
    else if (overallScorePercent >= 40) starRating = 2;

    // Determine performance level
    let performanceLevel = 'Needs Improvement';
    let performanceColor = '#EF4444'; // Red
    if (overallScorePercent >= 80) {
      performanceLevel = 'Excellent';
      performanceColor = '#10B981'; // Green
    } else if (overallScorePercent >= 60) {
      performanceLevel = 'Good';
      performanceColor = '#F59E0B'; // Yellow
    }

    console.log('\n⭐ PERFORMANCE RATING:');
    console.log('   Star Rating:', starRating + '/5 ' + '⭐'.repeat(starRating));
    console.log('   Performance Level:', performanceLevel);
    console.log('   Performance Color:', performanceColor);

    const metrics = {
      // Overall statistics
      total_questions: totalQuestions,
      correct_answers: correctAnswers,
      incorrect_answers: incorrectAnswers,
      overall_score_percent: overallScorePercent,
      star_rating: starRating,
      performance_level: performanceLevel,
      performance_color: performanceColor,
      
      // Time and engagement
      avg_response_time_sec: avgResponseTime,
      total_help_requests: totalHelpRequests,
      total_explanations: totalExplanations,
      
      // Error analysis
      top_error_types: topErrorTypes,
      error_type_counts: errorTypeCounts,
      error_subtype_counts: errorSubtypeCounts,
      
      // Goal-level performance
      goal_performance: goalPerformance,
      weak_goals: weakGoals,
      has_weak_areas: weakGoals.length > 0,
      
      // Raw data for learn more mode
      all_mistakes: [] // Not available in current implementation
    };

    console.log('\n✅ ===== FINAL METRICS SUMMARY =====');
    console.log('   📊 Total Questions:', totalQuestions);
    console.log('   ✅ Correct Answers:', correctAnswers);
    console.log('   ❌ Incorrect Answers:', incorrectAnswers);
    console.log('   📈 Overall Score:', overallScorePercent + '%');
    console.log('   ⭐ Star Rating:', starRating + '/5');
    console.log('   🏆 Performance Level:', performanceLevel);
    console.log('   🎯 Goals with < 70%:', weakGoals.length);
    console.log('   📋 Top Error Types:', topErrorTypes.map(e => `${e.type} (${e.count})`).join(', ') || 'None');
    if (Object.keys(errorSubtypeCounts).length > 0) {
      console.log('   📋 Error Subtypes:', Object.entries(errorSubtypeCounts).map(([type, count]) => `${type} (${count})`).join(', '));
    }
    console.log('   🔍 Data Source:', dataSource.toUpperCase());
    console.log('==================================================\n');

    return metrics;
  } catch (error) {
    console.error('Error calculating session metrics:', error);
    // Return default metrics on error
    return {
      total_questions: 0,
      correct_answers: 0,
      incorrect_answers: 0,
      overall_score_percent: 0,
      star_rating: 1,
      performance_level: 'Unknown',
      performance_color: '#6B7280',
      avg_response_time_sec: 0,
      total_help_requests: 0,
      total_explanations: 0,
      top_error_types: [],
      error_type_counts: {},
      error_subtype_counts: {},
      goal_performance: [],
      weak_goals: [],
      has_weak_areas: false,
      all_mistakes: []
    };
  }
}

/**
 * Generate session summary message with metrics
 * This creates the final AI message shown when all goals are completed
 */
function generateSessionSummaryMessage(topicTitle, metrics) {
  const { 
    total_questions, 
    correct_answers, 
    incorrect_answers,
    overall_score_percent,
    star_rating,
    performance_level,
    top_error_types,
    weak_goals,
    has_weak_areas
  } = metrics;

  // Build error summary
  let errorSummary = '';
  if (top_error_types.length > 0) {
    errorSummary = '\n\n📊 Common Mistakes:\n' + 
      top_error_types.slice(0, 3).map(e => `• ${e.type}: ${e.count} time${e.count > 1 ? 's' : ''} (${e.percent}%)`).join('\n');
  }

  // Build weak areas summary
  let weakAreasSummary = '';
  if (has_weak_areas) {
    weakAreasSummary = '\n\n💡 Areas to Improve:\n' + 
      weak_goals.map(g => `• ${g.goal_title} (${g.score_percent}%)`).join('\n');
  }

  const congratsMessage = overall_score_percent >= 80 
    ? `🎉 Outstanding work! You've mastered ${topicTitle}!`
    : overall_score_percent >= 60
    ? `👏 Great job! You've completed ${topicTitle}!`
    : `✅ Well done! You've finished ${topicTitle}!`;

  return `${congratsMessage}

📈 Your Performance: ${performance_level}
⭐ Rating: ${'⭐'.repeat(star_rating)} (${overall_score_percent}%)

📚 Session Summary:
• Total Questions: ${total_questions}
• Correct Answers: ${correct_answers} ✅
• Incorrect Answers: ${incorrect_answers} ❌${errorSummary}${weakAreasSummary}

${has_weak_areas ? '💪 Want to strengthen your weak areas? Click "Learn More" to practice!' : '🎓 You\'ve done an excellent job! Click "End Session" to finish.'}`;
}

module.exports = {
  calculateSessionMetrics,
  generateSessionSummaryMessage
};

