const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const prisma = require('../../lib/prisma');

/**
 * GET /api/profile/teacher-analytics/student-overview
 * Aggregates all learning turns for a comprehensive overview of the student's progress and weak spots
 */
router.get('/student-overview', authenticateToken, async (req, res) => {
  const user_id = req.user?.user_id;
  if (!user_id) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const turns = await prisma.learning_turns.findMany({
      where: { user_id },
      orderBy: { created_at: 'desc' }
    });

    const totalQuestions = turns.length;
    const correctAnswers = turns.filter(t => t.is_correct).length;
    const incorrectAnswers = totalQuestions - correctAnswers;
    const accuracy = totalQuestions > 0 ? Math.round((correctAnswers / totalQuestions) * 100) : 0;

    // Engagement Metrics
    const explainCount = turns.reduce((acc, t) => acc + (t.explain_loop_count || 0), 0);
    const retryCount = turns.reduce((acc, t) => acc + (t.num_retries || 0), 0);
    const helpRequests = turns.filter(t => t.help_requested && t.help_requested !== 'no').length;

    // Dynamic error frequency breakdown
    const errorCounts = {};
    turns.forEach(t => {
      if (!t.is_correct && t.error_type) {
        errorCounts[t.error_type] = (errorCounts[t.error_type] || 0) + 1;
      }
    });

    // Per subject scores & mastery
    const subjectGroups = {};
    turns.forEach(t => {
      if (t.subject_id) {
        if (!subjectGroups[t.subject_id]) {
          subjectGroups[t.subject_id] = {
            subject_id: t.subject_id,
            subject_name: t.subject_name || 'Unknown Subject',
            scores: [],
            correct: 0,
            total: 0
          };
        }
        subjectGroups[t.subject_id].scores.push(t.score_percent || 0);
        subjectGroups[t.subject_id].total++;
        if (t.is_correct) subjectGroups[t.subject_id].correct++;
      }
    });

    const subjectsList = Object.values(subjectGroups).map(s => {
      const avgScore = s.scores.length > 0 ? Math.round(s.scores.reduce((a, b) => a + b, 0) / s.scores.length) : 0;
      let status = 'Not Started';
      if (avgScore >= 80) status = 'Mastered';
      else if (avgScore >= 60) status = 'Proficient';
      else if (avgScore > 0) status = 'Developing';
      else status = 'Needs Attention';

      return {
        subject_id: s.subject_id,
        subject_name: s.subject_name,
        average_score: avgScore,
        accuracy: s.total > 0 ? Math.round((s.correct / s.total) * 100) : 0,
        total_questions: s.total,
        status
      };
    });

    // Weakest topics (bottom 5)
    const topicGroups = {};
    turns.forEach(t => {
      if (t.topic_id) {
        if (!topicGroups[t.topic_id]) {
          topicGroups[t.topic_id] = {
            topic_id: t.topic_id,
            topic_title: t.topic_title || 'Unknown Topic',
            subject_name: t.subject_name || '',
            scores: []
          };
        }
        topicGroups[t.topic_id].scores.push(t.score_percent || 0);
      }
    });

    const weakTopics = Object.values(topicGroups)
      .map(t => {
        const avgScore = t.scores.length > 0 ? Math.round(t.scores.reduce((a, b) => a + b, 0) / t.scores.length) : 0;
        return {
          topic_id: t.topic_id,
          topic_title: t.topic_title,
          subject_name: t.subject_name,
          average_score: avgScore
        };
      })
      .filter(t => t.average_score < 70)
      .sort((a, b) => a.average_score - b.average_score)
      .slice(0, 5);

    // AI generated dynamic recommendations based on errors
    const recommendations = [];
    const errorTypesSorted = Object.entries(errorCounts).sort((a, b) => b[1] - a[1]);
    if (errorTypesSorted.length > 0) {
      const topError = errorTypesSorted[0][0];
      if (topError.toLowerCase().includes('conceptual')) {
        recommendations.push(`Core conceptual gaps identified. Recommend revisiting topic summaries and chat notes before attempting advanced practice quizzes.`);
      } else if (topError.toLowerCase().includes('knowledge')) {
        recommendations.push(`Knowledge gaps detected in several areas. Recommend focusing on non-started chapters to build foundation.`);
      } else if (topError.toLowerCase().includes('calculation') || topError.toLowerCase().includes('spelling') || topError.toLowerCase().includes('grammar')) {
        recommendations.push(`High rate of silly mistakes (${topError}). Suggest taking extra time to double-check responses before submitting.`);
      }
    }
    if (weakTopics.length > 0) {
      recommendations.push(`Prioritize practice on weakest topic: "${weakTopics[0].topic_title}" in ${weakTopics[0].subject_name || 'Subject'}.`);
    }
    if (recommendations.length === 0) {
      recommendations.push(`Keep practicing! Regular quiz sessions will help build robust mastery scores.`);
    }

    return res.status(200).json({
      overview: {
        total_questions: totalQuestions,
        correct_answers: correctAnswers,
        incorrect_answers: incorrectAnswers,
        accuracy,
        explain_count,
        retry_count,
        help_requests: helpRequests
      },
      error_distribution: errorCounts,
      subjects: subjectsList,
      weak_topics: weakTopics,
      recommendations
    });

  } catch (error) {
    console.error('[TeacherAnalytics] Student overview error:', error);
    return res.status(500).json({ error: 'Server error while fetching overview' });
  }
});

/**
 * GET /api/profile/teacher-analytics/error-profile
 * Fetches all incorrect learning turns with rich metadata and full feedback_json logs
 */
router.get('/error-profile', authenticateToken, async (req, res) => {
  const user_id = req.user?.user_id;
  if (!user_id) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  const subjectId = req.query.subject_id ? parseInt(req.query.subject_id) : undefined;
  const errorType = req.query.error_type || undefined;

  try {
    const whereClause = {
      user_id,
      is_correct: false,
    };

    if (subjectId) whereClause.subject_id = subjectId;
    if (errorType) whereClause.error_type = errorType;

    const [total, errors] = await Promise.all([
      prisma.learning_turns.count({ where: whereClause }),
      prisma.learning_turns.findMany({
        where: whereClause,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          question_text: true,
          user_answer_raw: true,
          corrected_answer: true,
          diff_html: true,
          error_type: true,
          feedback_json: true,
          score_percent: true,
          topic_title: true,
          subject_name: true,
          created_at: true
        }
      })
    ]);

    return res.status(200).json({
      errors,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('[TeacherAnalytics] Error profile error:', error);
    return res.status(500).json({ error: 'Server error while fetching error profile' });
  }
});

/**
 * GET /api/profile/teacher-analytics/report-card
 * Detailed visual report card payload
 */
router.get('/report-card', authenticateToken, async (req, res) => {
  const user_id = req.user?.user_id;
  if (!user_id) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const turns = await prisma.learning_turns.findMany({
      where: { user_id },
      orderBy: { created_at: 'asc' }
    });

    // Time Spent tracking via study_sessions
    const studySessions = await prisma.study_sessions.findMany({
      where: { user_id },
      select: {
        subject_id: true,
        duration_seconds: true
      }
    });

    const subjectTime = {};
    studySessions.forEach(s => {
      if (s.subject_id && s.duration_seconds) {
        subjectTime[s.subject_id] = (subjectTime[s.subject_id] || 0) + s.duration_seconds;
      }
    });

    // Aggregating subjects
    const subjectsAgg = {};
    turns.forEach(t => {
      if (t.subject_id) {
        if (!subjectsAgg[t.subject_id]) {
          subjectsAgg[t.subject_id] = {
            subject_id: t.subject_id,
            subject_name: t.subject_name || 'Unknown',
            questions: 0,
            correct: 0,
            scores: [],
            topics: {}
          };
        }
        const sAgg = subjectsAgg[t.subject_id];
        sAgg.questions++;
        if (t.is_correct) sAgg.correct++;
        sAgg.scores.push(t.score_percent || 0);

        if (t.topic_id) {
          if (!sAgg.topics[t.topic_id]) {
            sAgg.topics[t.topic_id] = {
              topic_title: t.topic_title,
              scores: [],
              correct: 0,
              total: 0
            };
          }
          sAgg.topics[t.topic_id].scores.push(t.score_percent || 0);
          sAgg.topics[t.topic_id].total++;
          if (t.is_correct) sAgg.topics[t.topic_id].correct++;
        }
      }
    });

    const reportCardList = Object.values(subjectsAgg).map(sub => {
      const avgScore = sub.scores.length > 0 ? Math.round(sub.scores.reduce((a,b)=>a+b,0) / sub.scores.length) : 0;
      
      let status = 'Not Started';
      if (avgScore >= 80) status = 'Mastered';
      else if (avgScore >= 60) status = 'Proficient';
      else if (avgScore > 0) status = 'Developing';
      else status = 'Needs Attention';

      // Find strongest and weakest topics
      const topicsList = Object.values(sub.topics).map(tp => {
        const avg = tp.scores.length > 0 ? Math.round(tp.scores.reduce((a,b)=>a+b,0) / tp.scores.length) : 0;
        return { title: tp.topic_title, score: avg };
      });

      const strongest = topicsList.length > 0 ? topicsList.reduce((max, tp) => tp.score > max.score ? tp : max, topicsList[0]).title : 'N/A';
      const weakest = topicsList.length > 0 ? topicsList.reduce((min, tp) => tp.score < min.score ? tp : min, topicsList[0]).title : 'N/A';

      return {
        subject_id: sub.subject_id,
        subject_name: sub.subject_name,
        accuracy: sub.questions > 0 ? Math.round((sub.correct / sub.questions) * 100) : 0,
        total_questions: sub.questions,
        correct_questions: sub.correct,
        average_score: avgScore,
        mastery_level: status,
        time_spent_seconds: subjectTime[sub.subject_id] || 0,
        strongest_topic: strongest,
        weakest_topic: weakest
      };
    });

    // Overall grade calculator
    const totalAvg = reportCardList.length > 0 
      ? Math.round(reportCardList.reduce((acc, s) => acc + s.average_score, 0) / reportCardList.length)
      : 0;

    let overallGrade = 'D';
    if (totalAvg >= 90) overallGrade = 'A+';
    else if (totalAvg >= 80) overallGrade = 'A';
    else if (totalAvg >= 70) overallGrade = 'B+';
    else if (totalAvg >= 60) overallGrade = 'B';
    else if (totalAvg >= 50) overallGrade = 'C';

    // Improvement Trend: Compare older turns vs newer turns
    let trend = 'Stable';
    if (turns.length >= 6) {
      const half = Math.floor(turns.length / 2);
      const firstHalf = turns.slice(0, half);
      const secondHalf = turns.slice(half);

      const firstAvg = firstHalf.reduce((sum, t) => sum + (t.score_percent || 0), 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((sum, t) => sum + (t.score_percent || 0), 0) / secondHalf.length;

      if (secondAvg - firstAvg > 5) trend = 'Improving';
      else if (firstAvg - secondAvg > 5) trend = 'Declining';
    }

    return res.status(200).json({
      gpa: overallGrade,
      average_score: totalAvg,
      trend,
      subjects: reportCardList
    });

  } catch (error) {
    console.error('[TeacherAnalytics] Report card error:', error);
    return res.status(500).json({ error: 'Server error while fetching report card' });
  }
});

module.exports = router;
