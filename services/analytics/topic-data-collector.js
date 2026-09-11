/**
 * Topic Data Collector Service
 *
 * Hooks into the topic-chat V2 pipeline to populate:
 * - tutor_turn_logs (every turn's full pipeline data)
 * - topic_chat_errors (wrong answers linked to curriculum)
 * - topic_chat_sessions (per-session metadata)
 * - user_curriculum_summary (board+grade aggregation)
 * - user_daily_stats (questions/topics increments)
 *
 * All functions are fire-and-forget safe (catch errors internally
 * so they never break the chat flow).
 */

const prisma = require('../../lib/prisma');

// ─── Turn Logging ──────────────────────────────────────────────────────────

/**
 * Record the full orchestrator pipeline data for a single turn.
 *
 * @param {object} turnResult - The full result from processTutorTurn()
 * @param {object} context - { userId, topicId, chapterId, subjectId, goalId, chatId, userMessage }
 * @returns {Promise<number|null>} The created tutor_turn_logs.id, or null on failure
 */
async function recordTurnLog(turnResult, context) {
  try {
    const { evaluatorResult, nextState, stateInstruction, questionType,
            answeredPhase, gradedThisTurn, messages, masteryReport } = turnResult;
    const { userId, topicId, chapterId, subjectId, goalId, chatId, userMessage } = context;

    const goalIndex = nextState.goalIndex || 0;
    const perGoalStats = nextState.perGoal?.[goalIndex] || { correct: 0, total: 0, errors: [] };

    // Preview of AI response (first 500 chars of first bubble)
    const firstBubble = messages?.[0]?.message || '';
    const aiPreview = firstBubble.substring(0, 500);

    const log = await prisma.tutor_turn_logs.create({
      data: {
        user_id: userId,
        topic_id: topicId,
        chapter_id: chapterId || null,
        subject_id: subjectId || null,
        goal_id: goalId || null,
        chat_id: chatId || null,

        // Evaluator output
        intent: evaluatorResult.intent || 'ANSWER',
        is_correct: evaluatorResult.is_correct ?? null,
        score_percent: evaluatorResult.score_percent ?? null,
        error_type: evaluatorResult.error_type || null,
        diff_html: evaluatorResult.diff_html || null,
        complete_answer: evaluatorResult.complete_answer || null,
        suggested_action: evaluatorResult.suggested_action || null,
        evaluator_reasoning: evaluatorResult.reasoning || null,

        // State machine
        phase: nextState.phase,
        answered_in_phase: answeredPhase || null,
        state_instruction: stateInstruction || null,
        question_type: questionType || null,
        goal_index: goalIndex,
        goal_total: nextState.goalTotal || 0,

        // Per-goal stats
        goal_correct: perGoalStats.correct || 0,
        goal_total_questions: perGoalStats.total || 0,
        goal_errors: perGoalStats.errors || [],

        // Session pacing
        total_turns: nextState.totalTurns || 0,
        total_questions: nextState.totalQuestions || 0,
        consecutive_wrong: nextState.consecutiveWrong || 0,
        off_topic_streak: nextState.offTopicStreak || 0,
        stuck_streak: nextState.stuckStreak || 0,
        reteach_pending: nextState.reteachPending || false,
        reveal_pending: nextState.revealPending || false,

        // User message & AI response
        user_message: userMessage || null,
        ai_response_preview: aiPreview || null,
        ai_bubble_count: messages?.length || 0,

        // Mastery (only on WRAP/DONE)
        mastery_score_percent: masteryReport?.score_percent ?? null,
        performance_level: masteryReport?.performance_level || null,
        star_rating: masteryReport?.star_rating ?? null,
        end_reason: nextState.endedReason || null,

        // Graded flag
        was_graded: gradedThisTurn || false
      }
    });

    return log.id;
  } catch (err) {
    console.warn('[topic-data-collector] recordTurnLog failed:', err.message);
    return null;
  }
}

// ─── Error Detection ───────────────────────────────────────────────────────

/**
 * If the answer was wrong, record it in topic_chat_errors with full
 * curriculum hierarchy linking.
 *
 * @param {object} turnResult
 * @param {object} context - { userId, topicId, chapterId, subjectId, goalId, chatId, userMessage, lastQuestionText }
 * @param {number|null} turnLogId - The tutor_turn_logs.id for cross-referencing
 */
async function recordErrorIfWrong(turnResult, context, turnLogId = null) {
  try {
    const { evaluatorResult, nextState, answeredPhase } = turnResult;

    // Only record actual wrong answers
    if (evaluatorResult.intent !== 'ANSWER' || evaluatorResult.is_correct !== false) {
      return;
    }

    const { userId, topicId, chapterId, subjectId, goalId, chatId, userMessage, lastQuestionText } = context;

    if (!chapterId || !subjectId) {
      console.warn('[topic-data-collector] Skipping error record: missing chapterId or subjectId');
      return;
    }

    // Determine severity based on score
    let severity = 'medium';
    if (evaluatorResult.score_percent !== null) {
      if (evaluatorResult.score_percent <= 20) severity = 'high';
      else if (evaluatorResult.score_percent >= 50) severity = 'low';
    }

    await prisma.topic_chat_errors.create({
      data: {
        user_id: userId,
        topic_id: topicId,
        chapter_id: chapterId,
        subject_id: subjectId,
        goal_id: goalId || null,
        chat_id: chatId || null,
        turn_log_id: turnLogId,

        error_type: evaluatorResult.error_type || 'Conceptual',
        error_subtype: evaluatorResult.error_subtype || null,
        severity,

        question_text: lastQuestionText || null,
        user_answer: userMessage || '',
        correct_answer: evaluatorResult.complete_answer || null,
        diff_html: evaluatorResult.diff_html || null,
        score_percent: evaluatorResult.score_percent ?? 0,

        phase: answeredPhase || null,
        attempt_number: (nextState.consecutiveWrong || 0) + 1,
        was_retaught: nextState.reteachPending || false,
        mastery_before: null,
        mastery_after: null
      }
    });

    console.log(`[topic-data-collector] Error recorded: ${evaluatorResult.error_type} for user ${userId} in topic ${topicId}`);
  } catch (err) {
    console.warn('[topic-data-collector] recordErrorIfWrong failed:', err.message);
  }
}

// ─── Chat Session Tracking ─────────────────────────────────────────────────

/**
 * Create a topic_chat_sessions row when a topic chat starts.
 *
 * @param {number} userId
 * @param {number} topicId
 * @param {object} topic - The global_topics record with chapter relation
 * @param {number} goalsTotal - Number of goals for this topic
 * @returns {Promise<number|null>} The session id
 */
async function startChatSession(userId, topicId, topic, goalsTotal = 0) {
  try {
    const session = await prisma.topic_chat_sessions.create({
      data: {
        user_id: userId,
        topic_id: topicId,
        subject_id: topic.chapter?.subject_id || topic.subject_id || null,
        chapter_id: topic.chapter_id || topic.chapter?.id || null,
        goals_total: goalsTotal,
        started_at: new Date()
      }
    });

    console.log(`[topic-data-collector] Chat session started: ${session.id} for user ${userId}, topic ${topicId}`);
    return session.id;
  } catch (err) {
    console.warn('[topic-data-collector] startChatSession failed:', err.message);
    return null;
  }
}

/**
 * Update topic_chat_sessions with final metrics when session wraps.
 *
 * @param {number} userId
 * @param {number} topicId
 * @param {object} turnResult - The final turn result with masteryReport
 */
async function endChatSession(userId, topicId, turnResult) {
  try {
    const { nextState, masteryReport } = turnResult;

    // Find the most recent open session for this user+topic
    const session = await prisma.topic_chat_sessions.findFirst({
      where: {
        user_id: userId,
        topic_id: topicId,
        ended_at: null
      },
      orderBy: { started_at: 'desc' }
    });

    if (!session) {
      console.warn(`[topic-data-collector] No open chat session found for user ${userId}, topic ${topicId}`);
      return;
    }

    const now = new Date();
    const durationSec = Math.round((now.getTime() - new Date(session.started_at).getTime()) / 1000);

    await prisma.topic_chat_sessions.update({
      where: { id: session.id },
      data: {
        ended_at: now,
        duration_seconds: durationSec,
        total_turns: nextState.totalTurns || 0,
        total_questions: masteryReport?.total_questions || nextState.totalQuestions || 0,
        correct_answers: masteryReport?.correct_answers || 0,
        incorrect_answers: masteryReport?.incorrect_answers || 0,
        score_percent: masteryReport?.score_percent || 0,
        goals_completed: masteryReport?.goals_covered || nextState.goalIndex || 0,
        goals_total: nextState.goalTotal || session.goals_total,
        end_reason: nextState.endedReason || 'complete',
        performance_level: masteryReport?.performance_level || null,
        star_rating: masteryReport?.star_rating || 0,
        final_state_json: nextState
      }
    });

    // Also update daily study time
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await prisma.user_daily_stats.upsert({
      where: { user_id_date: { user_id: userId, date: today } },
      create: {
        user_id: userId,
        date: today,
        total_study_time_seconds: durationSec,
        topics_completed: 1
      },
      update: {
        total_study_time_seconds: { increment: durationSec },
        topics_completed: { increment: 1 },
        updated_at: new Date()
      }
    });

    console.log(`[topic-data-collector] Chat session ended: ${session.id} (${durationSec}s, ${masteryReport?.score_percent || 0}%)`);
  } catch (err) {
    console.warn('[topic-data-collector] endChatSession failed:', err.message);
  }
}

// ─── Curriculum Summary ────────────────────────────────────────────────────

/**
 * Recalculate user_curriculum_summary for a specific subject.
 * Aggregates from user_topic_progress + user_chapter_progress.
 *
 * @param {number} userId
 * @param {number} subjectId
 */
async function updateCurriculumSummary(userId, subjectId) {
  try {
    if (!subjectId) return;

    const subject = await prisma.global_subjects.findUnique({
      where: { id: subjectId },
      select: { id: true, name: true, board: true, grade: true }
    });

    if (!subject) return;

    // Count total and completed chapters
    const chapters = await prisma.global_chapters.findMany({
      where: { subject_id: subjectId },
      select: { id: true }
    });

    const totalChapters = chapters.length;
    const chapterIds = chapters.map(c => c.id);

    const completedChapters = await prisma.user_chapter_progress.count({
      where: {
        user_id: userId,
        chapter_id: { in: chapterIds },
        completion_percent: { gte: 100 }
      }
    });

    // Count total and completed topics
    const totalTopics = await prisma.global_topics.count({
      where: { subject_id: subjectId }
    });

    const completedTopics = await prisma.user_topic_progress.count({
      where: {
        user_id: userId,
        is_completed: true,
        topic: { subject_id: subjectId }
      }
    });

    // Calculate time spent
    const timeResult = await prisma.user_topic_progress.aggregate({
      where: {
        user_id: userId,
        topic: { subject_id: subjectId }
      },
      _sum: { time_spent_seconds: true }
    });

    // Calculate average score from topic reports
    const scoreResult = await prisma.user_topic_reports.aggregate({
      where: {
        user_id: userId,
        topic: { subject_id: subjectId }
      },
      _avg: { score_percent: true }
    });

    const completionPercent = totalTopics > 0
      ? Math.round((completedTopics / totalTopics) * 10000) / 100
      : 0;

    await prisma.user_curriculum_summary.upsert({
      where: { user_id_subject_id: { user_id: userId, subject_id: subjectId } },
      create: {
        user_id: userId,
        board: subject.board,
        grade: subject.grade,
        subject_id: subjectId,
        subject_name: subject.name,
        total_chapters: totalChapters,
        completed_chapters: completedChapters,
        total_topics: totalTopics,
        completed_topics: completedTopics,
        completion_percent: completionPercent,
        avg_score_percent: scoreResult._avg?.score_percent || 0,
        total_time_spent_seconds: timeResult._sum?.time_spent_seconds || 0,
        last_activity_at: new Date()
      },
      update: {
        total_chapters: totalChapters,
        completed_chapters: completedChapters,
        total_topics: totalTopics,
        completed_topics: completedTopics,
        completion_percent: completionPercent,
        avg_score_percent: scoreResult._avg?.score_percent || 0,
        total_time_spent_seconds: timeResult._sum?.time_spent_seconds || 0,
        last_activity_at: new Date(),
        updated_at: new Date()
      }
    });
  } catch (err) {
    console.warn('[topic-data-collector] updateCurriculumSummary failed:', err.message);
  }
}

// ─── Daily Stats Helpers ───────────────────────────────────────────────────

/**
 * Increment daily study stats from a topic chat turn.
 * Called after every turn from the V2 pipeline.
 *
 * @param {number} userId
 * @param {object} turnResult
 * @param {number} topicId
 */
async function updateDailyStudyStats(userId, turnResult, topicId) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const isAnswer = turnResult.evaluatorResult?.intent === 'ANSWER';
    const isCorrect = turnResult.evaluatorResult?.is_correct === true;

    await prisma.user_daily_stats.upsert({
      where: { user_id_date: { user_id: userId, date: today } },
      create: {
        user_id: userId,
        date: today,
        messages_sent: 1,
        questions_answered: isAnswer ? 1 : 0,
        questions_correct: isAnswer && isCorrect ? 1 : 0,
        topics_studied: 1
      },
      update: {
        messages_sent: { increment: 1 },
        questions_answered: isAnswer ? { increment: 1 } : undefined,
        questions_correct: isAnswer && isCorrect ? { increment: 1 } : undefined,
        updated_at: new Date()
      }
    });
  } catch (err) {
    console.warn('[topic-data-collector] updateDailyStudyStats failed:', err.message);
  }
}

module.exports = {
  recordTurnLog,
  recordErrorIfWrong,
  startChatSession,
  endChatSession,
  updateCurriculumSummary,
  updateDailyStudyStats
};
