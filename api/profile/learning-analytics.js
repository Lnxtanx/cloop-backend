const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const { getTopicAnalytics, getLearningTurnsByTopic, getLearningTurnsByGoal } = require('../../services/learning_turns_tracker');

const prisma = require('../../lib/prisma');

/**
 * GET /api/profile/learning-analytics/topic/:topicId
 * Get comprehensive learning analytics for a specific topic
 * Uses learning_turns table for detailed performance insights
 */
router.get('/topic/:topicId', authenticateToken, async (req, res) => {
  const user_id = req.user?.user_id;
  const { topicId } = req.params;

  if (!user_id) {
    return res.status(401).json({ error: 'Authentication required - please login' });
  }

  if (!topicId || isNaN(parseInt(topicId))) {
    return res.status(400).json({ error: 'Valid topic ID is required' });
  }

  try {
    // Verify topic exists
    const topic = await prisma.global_topics.findUnique({
      where: {
        id: parseInt(topicId)
      },
      include: {
        chapter: {
          select: {
            title: true,
            subject: {
              select: {
                name: true
              }
            }
          }
        },
        user_progress: {
          where: { user_id: user_id },
          select: {
            is_completed: true,
            completion_percent: true
          }
        }
      }
    });

    if (!topic) {
      return res.status(404).json({ error: 'Topic not found' });
    }

    // Get comprehensive analytics from learning_turns
    const analytics = await getTopicAnalytics(user_id, parseInt(topicId));

    const prog = topic.user_progress?.[0] || {};

    return res.status(200).json({
      topic: {
        id: topic.id,
        title: topic.title,
        subject: topic.chapter?.subject?.name || null,
        chapter: topic.chapter?.title || null,
        is_completed: prog.is_completed || false,
        completion_percent: parseFloat(prog.completion_percent?.toString() || '0')
      },
      analytics: analytics
    });
  } catch (err) {
    console.error('Error fetching learning analytics:', err);
    return res.status(500).json({ error: 'Server error while fetching analytics' });
  }
});

/**
 * GET /api/profile/learning-analytics/goal/:goalId
 * Get detailed analytics for a specific learning goal
 */
router.get('/goal/:goalId', authenticateToken, async (req, res) => {
  const user_id = req.user?.user_id;
  const { goalId } = req.params;

  if (!user_id) {
    return res.status(401).json({ error: 'Authentication required - please login' });
  }

  if (!goalId || isNaN(parseInt(goalId))) {
    return res.status(400).json({ error: 'Valid goal ID is required' });
  }

  try {
    // Get all learning turns for this goal
    const turns = await getLearningTurnsByGoal(user_id, parseInt(goalId));

    // Get goal details
    const goal = await prisma.global_topic_goals.findUnique({
      where: { id: parseInt(goalId) },
      include: {
        topic: {
          select: {
            title: true,
            subject_id: true
          }
        }
      }
    });

    if (!goal) {
      return res.status(404).json({ error: 'Goal not found' });
    }

    // Calculate goal-specific metrics
    const totalQuestions = turns.length;
    const correctAnswers = turns.filter(t => t.is_correct).length;
    const incorrectAnswers = totalQuestions - correctAnswers;
    const averageScore = totalQuestions > 0
      ? Math.round(turns.reduce((sum, t) => sum + (t.score_percent || 0), 0) / totalQuestions)
      : 0;

    // Error analysis
    const errorTypes = {};
    turns.forEach(turn => {
      if (turn.error_type) {
        errorTypes[turn.error_type] = (errorTypes[turn.error_type] || 0) + 1;
      }
    });

    // Engagement metrics
    const totalExplainRequests = turns.reduce((sum, t) => sum + (t.explain_loop_count || 0), 0);
    const averageExplainsPerQuestion = totalQuestions > 0
      ? (totalExplainRequests / totalQuestions).toFixed(2)
      : 0;

    // Detailed turn-by-turn data
    const turnDetails = turns.map(turn => ({
      id: turn.id,
      question: turn.question_text,
      user_answer: turn.user_answer_raw,
      corrected_answer: turn.corrected_answer,
      is_correct: turn.is_correct,
      score_percent: turn.score_percent,
      error_type: turn.error_type,
      explain_count: turn.explain_loop_count,
      mastery_score: turn.mastery_score,
      goal_progress_after: turn.goal_progress_after,
      created_at: turn.created_at
    }));

    return res.status(200).json({
      goal: {
        id: goal.id,
        title: goal.title,
        description: goal.description,
        topic_title: goal.topic?.title
      },
      metrics: {
        total_questions: totalQuestions,
        correct_answers: correctAnswers,
        incorrect_answers: incorrectAnswers,
        average_score: averageScore,
        error_types: errorTypes,
        total_explain_requests: totalExplainRequests,
        average_explains_per_question: averageExplainsPerQuestion
      },
      turns: turnDetails
    });
  } catch (err) {
    console.error('Error fetching goal analytics:', err);
    return res.status(500).json({ error: 'Server error while fetching goal analytics' });
  }
});

/**
 * GET /api/profile/learning-analytics/subject/:subjectId
 * Get aggregated learning analytics across all topics in a subject
 */
router.get('/subject/:subjectId', authenticateToken, async (req, res) => {
  const user_id = req.user?.user_id;
  const { subjectId } = req.params;

  if (!user_id) {
    return res.status(401).json({ error: 'Authentication required - please login' });
  }

  if (!subjectId || isNaN(parseInt(subjectId))) {
    return res.status(400).json({ error: 'Valid subject ID is required' });
  }

  try {
    // Get all learning turns for this subject
    const turns = await prisma.learning_turns.findMany({
      where: {
        user_id: user_id,
        subject_id: parseInt(subjectId)
      },
      orderBy: {
        created_at: 'asc'
      },
      include: {
        global_topic_goals: {
          select: {
            title: true,
            topic_id: true
          }
        }
      }
    });

    // Get subject details
    let subject = await prisma.global_subjects.findUnique({
      where: { id: parseInt(subjectId) },
      select: {
        id: true,
        name: true,
        code: true
      }
    });

    if (!subject) {
      subject = await prisma.subjects.findUnique({
        where: { id: parseInt(subjectId) },
        select: {
          id: true,
          name: true,
          code: true
        }
      });
    }

    if (!subject) {
      return res.status(404).json({ error: 'Subject not found' });
    }

    // Calculate subject-wide metrics
    const totalQuestions = turns.length;
    const correctAnswers = turns.filter(t => t.is_correct).length;
    const incorrectAnswers = totalQuestions - correctAnswers;
    const averageScore = totalQuestions > 0
      ? Math.round(turns.reduce((sum, t) => sum + (t.score_percent || 0), 0) / totalQuestions)
      : 0;

    // Error analysis
    const errorTypes = {};
    const errorSubtypes = {};
    turns.forEach(turn => {
      if (turn.error_type) {
        errorTypes[turn.error_type] = (errorTypes[turn.error_type] || 0) + 1;
      }
      if (turn.error_subtype) {
        errorSubtypes[turn.error_subtype] = (errorSubtypes[turn.error_subtype] || 0) + 1;
      }
    });

    // Topic-level breakdown
    const byTopic = {};
    turns.forEach(turn => {
      if (turn.topic_id) {
        if (!byTopic[turn.topic_id]) {
          byTopic[turn.topic_id] = {
            topic_id: turn.topic_id,
            topic_title: turn.topic_title || 'Unknown',
            total: 0,
            correct: 0,
            incorrect: 0,
            scores: []
          };
        }

        byTopic[turn.topic_id].total++;
        if (turn.is_correct) byTopic[turn.topic_id].correct++;
        else byTopic[turn.topic_id].incorrect++;
        byTopic[turn.topic_id].scores.push(turn.score_percent || 0);
      }
    });

    // Calculate average scores per topic
    Object.keys(byTopic).forEach(topicId => {
      const topic = byTopic[topicId];
      topic.average_score = topic.scores.length > 0
        ? Math.round(topic.scores.reduce((a, b) => a + b, 0) / topic.scores.length)
        : 0;
      delete topic.scores;
    });

    // Engagement metrics
    const totalExplainRequests = turns.reduce((sum, t) => sum + (t.explain_loop_count || 0), 0);
    const totalHelpRequests = turns.filter(t => t.help_requested).length;
    const totalRetries = turns.reduce((sum, t) => sum + (t.num_retries || 0), 0);

    // Performance trend (last 20 questions)
    const recentTurns = turns.slice(-20).map(turn => ({
      timestamp: turn.created_at,
      score_percent: turn.score_percent || 0,
      mastery_score: turn.mastery_score || 0,
      topic_title: turn.topic_title
    }));

    // --- NEW: Time Analytics (Daily, Weekly, Monthly) ---
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const studySessions = await prisma.study_sessions.findMany({
      where: {
        user_id: user_id,
        subject_id: parseInt(subjectId),
        start_time: { gte: monthStart } // Fetch last 30 days
      },
      select: {
        start_time: true,
        duration_seconds: true
      }
    });

    let dailyTime = 0;
    let weeklyTime = 0;
    let monthlyTime = 0;

    studySessions.forEach(session => {
      const duration = session.duration_seconds || 0;
      const startTime = new Date(session.start_time);

      monthlyTime += duration;
      if (startTime >= weekStart) weeklyTime += duration;
      if (startTime >= todayStart) dailyTime += duration;
    });

    // --- NEW: Concepts Mastery & Recommendations ---
    // Fetch ALL topics for this subject to include "Not Started"
    const allTopics = await prisma.global_topics.findMany({
      where: {
        subject_id: parseInt(subjectId)
      },
      select: {
        id: true,
        title: true,
        user_progress: {
          where: { user_id: user_id },
          select: {
            is_completed: true,
            completion_percent: true,
            time_spent_seconds: true
          }
        }
      }
    });

    let masteredCount = 0;
    let learningCount = 0;
    let notStartedCount = 0;
    const recommendedFocus = [];

    allTopics.forEach(topic => {
      const prog = topic.user_progress?.[0] || {};
      const topicPerf = byTopic[topic.id];
      const avgScore = topicPerf ? topicPerf.average_score : 0;
      const isCompleted = prog.is_completed || false;
      const timeSpent = prog.time_spent_seconds || 0;
      const hasActivity = topicPerf || (timeSpent > 60);

      if (!hasActivity) {
        notStartedCount++;
      } else if (avgScore >= 80 || isCompleted) {
        masteredCount++;
      } else {
        learningCount++;

        // Add to recommended focus if score is low or not completed
        if (avgScore < 75) {
          const potentialGain = Math.max(5, Math.round((100 - avgScore) / 5) * 5); // Heuristic: gain is gap rounded to 5
          recommendedFocus.push({
            topic_id: topic.id,
            title: topic.title,
            current_score: avgScore || 50,
            potential_gain: potentialGain,
            marks_value: 5 // Placeholder for marks weight
          });
        }
      }
    });

    // Sort recommended focus by potential gain (desc)
    recommendedFocus.sort((a, b) => b.potential_gain - a.potential_gain);

    // Calculate mastery level status
    let masteryLevel = 'Needs Attention';
    if (averageScore >= 80) masteryLevel = 'Mastered';
    else if (averageScore >= 60) masteryLevel = 'Proficient';
    else if (averageScore > 0) masteryLevel = 'Developing';

    // Calculate per-topic weak points (score < 60)
    const weakTopicsList = Object.values(byTopic)
      .filter(t => t.average_score < 60)
      .map(t => {
        const topicTurns = turns.filter(turn => turn.topic_id === t.topic_id && !turn.is_correct);
        const topicErrors = {};
        topicTurns.forEach(turn => {
          if (turn.error_type) {
            topicErrors[turn.error_type] = (topicErrors[turn.error_type] || 0) + 1;
          }
        });
        return {
          topic_id: t.topic_id,
          topic_title: t.topic_title,
          average_score: t.average_score,
          total_questions: t.total,
          error_distribution: topicErrors
        };
      });

    // Detailed error cards for this subject (limit to last 50, latest first)
    const errorTurns = turns
      .filter(t => !t.is_correct)
      .slice(-50)
      .reverse()
      .map(t => ({
        id: t.id,
        question_text: t.question_text,
        user_answer_raw: t.user_answer_raw,
        corrected_answer: t.corrected_answer,
        diff_html: t.diff_html,
        error_type: t.error_type,
        feedback_json: t.feedback_json,
        score_percent: t.score_percent,
        topic_title: t.topic_title,
        created_at: t.created_at
      }));

    return res.status(200).json({
      subject: subject,
      summary: {
        total_questions: totalQuestions,
        correct_answers: correctAnswers,
        incorrect_answers: incorrectAnswers,
        average_score: averageScore,
        total_explain_requests: totalExplainRequests,
        total_help_requests: totalHelpRequests,
        total_retries: totalRetries
      },
      time_analytics: {
        daily_seconds: dailyTime,
        weekly_seconds: weeklyTime,
        monthly_seconds: monthlyTime
      },
      concepts_mastery: {
        mastered: masteredCount,
        learning: learningCount,
        not_started: notStartedCount
      },
      recommended_focus: recommendedFocus,
      error_analysis: {
        error_types: errorTypes,
        error_subtypes: errorSubtypes
      },
      by_topic: Object.values(byTopic),
      performance_trend: recentTurns,
      mastery_level: masteryLevel,
      weak_topics: weakTopicsList,
      error_cards: errorTurns
    });
  } catch (err) {
    console.error('Error fetching subject analytics:', err);
    return res.status(500).json({ error: 'Server error while fetching subject analytics' });
  }
});

/**
 * GET /api/profile/learning-analytics/overview
 * Get high-level learning analytics overview across all subjects
 */
router.get('/overview', authenticateToken, async (req, res) => {
  const user_id = req.user?.user_id;

  if (!user_id) {
    return res.status(401).json({ error: 'Authentication required - please login' });
  }

  try {
    // Get all learning turns for this user
    const turns = await prisma.learning_turns.findMany({
      where: {
        user_id: user_id
      },
      orderBy: {
        created_at: 'asc'
      },
      select: {
        id: true,
        subject_id: true,
        subject_name: true,
        topic_id: true,
        topic_title: true,
        is_correct: true,
        score_percent: true,
        error_type: true,
        explain_loop_count: true,
        mastery_score: true,
        created_at: true
      }
    });

    // Overall metrics
    const totalQuestions = turns.length;
    const correctAnswers = turns.filter(t => t.is_correct).length;
    const incorrectAnswers = totalQuestions - correctAnswers;
    const overallAccuracy = totalQuestions > 0
      ? Math.round((correctAnswers / totalQuestions) * 100)
      : 0;
    const averageScore = totalQuestions > 0
      ? Math.round(turns.reduce((sum, t) => sum + (t.score_percent || 0), 0) / totalQuestions)
      : 0;

    // Subject breakdown
    const bySubject = {};
    turns.forEach(turn => {
      if (turn.subject_id) {
        if (!bySubject[turn.subject_id]) {
          bySubject[turn.subject_id] = {
            subject_id: turn.subject_id,
            subject_name: turn.subject_name || 'Unknown',
            total: 0,
            correct: 0,
            incorrect: 0,
            scores: []
          };
        }

        bySubject[turn.subject_id].total++;
        if (turn.is_correct) bySubject[turn.subject_id].correct++;
        else bySubject[turn.subject_id].incorrect++;
        bySubject[turn.subject_id].scores.push(turn.score_percent || 0);
      }
    });

    // Calculate accuracy per subject
    Object.keys(bySubject).forEach(subjectId => {
      const subject = bySubject[subjectId];
      subject.accuracy = subject.total > 0
        ? Math.round((subject.correct / subject.total) * 100)
        : 0;
      subject.average_score = subject.scores.length > 0
        ? Math.round(subject.scores.reduce((a, b) => a + b, 0) / subject.scores.length)
        : 0;
      delete subject.scores;
    });

    // Error types distribution
    const errorTypes = {};
    turns.forEach(turn => {
      if (turn.error_type) {
        errorTypes[turn.error_type] = (errorTypes[turn.error_type] || 0) + 1;
      }
    });

    // Engagement
    const totalExplainRequests = turns.reduce((sum, t) => sum + (t.explain_loop_count || 0), 0);

    // Recent activity (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentActivity = turns.filter(t => new Date(t.created_at) >= thirtyDaysAgo).length;

    // Performance trend (weekly averages for last 8 weeks)
    const weeklyScores = {};
    turns.forEach(turn => {
      const date = new Date(turn.created_at);
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      const weekKey = weekStart.toISOString().split('T')[0];

      if (!weeklyScores[weekKey]) {
        weeklyScores[weekKey] = { scores: [], count: 0 };
      }
      weeklyScores[weekKey].scores.push(turn.score_percent || 0);
      weeklyScores[weekKey].count++;
    });

    const weeklyTrend = Object.keys(weeklyScores)
      .sort()
      .slice(-8)
      .map(week => ({
        week: week,
        average_score: weeklyScores[week].scores.length > 0
          ? Math.round(weeklyScores[week].scores.reduce((a, b) => a + b, 0) / weeklyScores[week].scores.length)
          : 0,
        question_count: weeklyScores[week].count
      }));

    return res.status(200).json({
      overall: {
        total_questions: totalQuestions,
        correct_answers: correctAnswers,
        incorrect_answers: incorrectAnswers,
        overall_accuracy: overallAccuracy,
        average_score: averageScore,
        total_explain_requests: totalExplainRequests,
        recent_activity_30d: recentActivity
      },
      by_subject: Object.values(bySubject),
      error_distribution: errorTypes,
      weekly_trend: weeklyTrend
    });
  } catch (err) {
    console.error('Error fetching learning analytics overview:', err);
    return res.status(500).json({ error: 'Server error while fetching analytics overview' });
  }
});

module.exports = router;
