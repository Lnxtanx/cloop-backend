const { invokeModel, extractJson } = require('../ai/deepseek-client');
const { gradeAnswer } = require('./answer-grader');
const {
  buildSystemPrompt,
  analyzeChatHistory,
  normalizeUserCorrectionOptions,
  generateTopicGreeting,
  generateTopicGoals,
  determinePhase,
  calculateSessionMetrics,
  generateSessionSummaryMessage
} = require('./topic-chat-helpers');

/**
 * Topic Chat Service v2 — Teaching Arc
 * FRAME → HOOK → REVEAL → EXPLORE → LOCK → WRAP
 */

async function generateTopicChatResponse({
  userMessage,
  topicTitle,
  topicContent,
  chatHistory = [],
  currentGoal = null,
  topicGoals = [],
  userId = null,
  topicId = null,
  user = null
}) {
  let lastQuestion = "";
  try {
    const analysis = analyzeChatHistory(chatHistory);
    lastQuestion = analysis.lastQuestion;

    // Count completed goals
    const completedGoalsCount = topicGoals.filter(g => {
      const progress = g.chat_goal_progress?.[0];
      return progress?.is_completed || false;
    }).length;
    const allGoalsCompleted = completedGoalsCount === topicGoals.length;

    // Determine current phase
    const { phase, goalIndex, goalTotal } = determinePhase(chatHistory, topicGoals, currentGoal, userMessage);

    // Calculate turns since last teaching beat
    let turnsSinceTeaching = analysis.turnsSinceTeaching || 0;

    // Get hook prediction from analysis
    const hookPrediction = analysis.hookPrediction || null;

    // Build completed concepts list
    const completedConcepts = topicGoals
      .filter(g => g.chat_goal_progress?.[0]?.is_completed)
      .map(g => g.title);

    // Build user info
    const board = user?.board || 'General';
    const classLevel = user?.grade_level || '8';

    // Build system prompt
    const systemPrompt = buildSystemPrompt({
      topicTitle,
      topicContent,
      topicGoals,
      currentGoal,
      questionsAsked: analysis.questionsAsked,
      allQuestions: analysis.allQuestions,
      lastQuestion,
      userMessage,
      phase,
      goalIndex,
      goalTotal,
      archetypesUsed: analysis.archetypesUsed,
      turnsSinceTeaching,
      hookPrediction,
      completedConcepts,
      board,
      classLevel,
      misconceptions: null
    });

    // Build messages for API
    const messages = [];
    const recentHistory = chatHistory.slice(-8);
    for (const msg of recentHistory) {
      messages.push({
        role: msg.sender === 'user' ? 'user' : 'assistant',
        content: msg.message || ''
      });
    }

    // WRAP sentinel: the route signals "all goals complete — generate the end-of-session
    // revision artefact". Pass the model an explicit directive (an empty string invites the
    // model to re-teach / ask another question). The model must emit revision_sheet + summary.
    const isWrapTurn = phase === 'WRAP' && (userMessage === '__SESSION_COMPLETE__' || userMessage === '');
    const userTurn = isWrapTurn
      ? 'SESSION COMPLETE. All learning goals are done. Emit the revision_sheet covering EVERY concept studied in this session, plus session_metrics with the overall score breakdown. Do NOT ask any further question — this is the final turn.'
      : userMessage;
    messages.push({ role: 'user', content: userTurn });

    // Log
    console.log('\n========== AI INPUT (v2 Teaching Arc) ==========');
    console.log(`  Phase: ${phase}`);
    console.log(`  Goal: ${goalIndex + 1}/${goalTotal} — ${currentGoal?.title || 'All done'}`);
    console.log(`  Questions: ${analysis.questionsAsked}`);
    console.log(`  Archetypes used: ${analysis.archetypesUsed.join(', ') || 'None'}`);
    console.log(`  Turns since teaching: ${turnsSinceTeaching}`);
    console.log(`  Hook prediction: ${hookPrediction || 'None'}`);
    console.log(`  User message: ${userMessage}`);
    console.log('================================================\n');

    // Call DeepSeek with retry
    let parsed = {};
    let attempts = 0;
    const maxAttempts = 3;
    let lastError = null;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        console.log(`[topic_chat] Attempt ${attempts}/${maxAttempts} — Phase: ${phase}`);

        const responseText = await invokeModel(systemPrompt, messages, {
          temperature: 0.7,
          maxTokens: 2048,
          userId,
          featureArea: 'topic_chat',
          subFeature: 'tutor_turn',
          metadata: { topicId, topicTitle, phase }
        });

        if (!responseText) {
          throw new Error('Empty response from DeepSeek API');
        }

        console.log(`[topic_chat] Raw (first 500): ${responseText.substring(0, 500)}`);

        parsed = extractJson(responseText);

        if (!parsed) {
          throw new Error('Failed to extract valid JSON from response');
        }

        // WRAP validation: the final turn MUST produce a revision_sheet. If the model
        // dropped the structured JSON (emitted rambling text) or forgot the block,
        // retry with an explicit instruction before giving up.
        if (phase === 'WRAP' && (!parsed.revision_sheet || typeof parsed.revision_sheet !== 'object')) {
          lastError = new Error('WRAP response missing revision_sheet');
          console.warn(`[topic_chat] WRAP response missing revision_sheet (attempt ${attempts}), retrying with directive`);
          if (attempts < maxAttempts) {
            // Reinforce the directive with the goal titles so the model knows what to cover.
            const goalTitles = topicGoals.map((g, i) => `${i + 1}. ${g.title || (g.chat_goal_progress?.[0] && g.title) || g.title}`).join('\n');
            messages.push({
              role: 'user',
              content: `You did not emit the revision_sheet. This session is COMPLETE. Return valid JSON with a "revision_sheet" block (concepts_covered, definitions[], key_points[], common_mistakes[], one_minute_recall[]) covering ALL goals studied:\n${goalTitles}\nNo questions.`
            });
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          throw lastError;
        }

        console.log(`[topic_chat] Parsed JSON on attempt ${attempts}`);
        break;

      } catch (err) {
        lastError = err;
        console.warn(`[topic_chat] Attempt ${attempts} failed: ${err.message}`);
        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          throw lastError;
        }
      }
    }

    // Normalize single message response
    if (parsed.message && !parsed.messages) {
      parsed.messages = [{
        message: parsed.message,
        message_type: parsed.message_type || 'text',
        options: parsed.options,
        emoji: parsed.emoji,
        diff_html: parsed.diff_html
      }];
    }

    // Normalize user_correction
    parsed = normalizeUserCorrectionOptions(parsed);

    // Grounded evaluation: if question was asked and there's no user_correction, grade it.
    // Also grade when a model user_correction exists but lacks diff_html (the source of the
    // strikethrough) so we still produce <del>/<ins> markup instead of a plain red bubble.
    const hasDiffMarkup = !!(parsed.user_correction?.diff_html && /<del>|<ins>/.test(parsed.user_correction.diff_html));
    if (analysis.hasAskedQuestion && !hasDiffMarkup && userMessage && userMessage.trim() !== '' && phase !== 'WRAP') {
      try {
        console.log('[topic_chat] Grading answer with grounded answer grader (temp 0)');
        const graded = await gradeAnswer({
          answer: userMessage,
          question: lastQuestion,
          topicTitle,
          topicContent
        });

        if (graded) {
          if (!parsed.user_correction) {
            // No model correction: build a full grounded correction
            parsed.user_correction = {
              message_type: 'user_correction',
              diff_html: graded.diff_html,
              complete_answer: graded.complete_answer,
              emoji: graded.is_correct ? '😊' : (graded.score_percent >= 50 ? '😅' : '😓'),
              feedback: {
                is_correct: graded.is_correct,
                bubble_color: graded.is_correct ? 'green' : 'red',
                error_type: graded.error_type,
                score_percent: graded.score_percent
              }
            };
            console.log('[topic_chat] Obtained grounded user_correction');
          } else {
            // Model gave a correction but no strikethrough markup: backfill diff_html only,
            // keep the model's complete_answer, feedback, and emoji.
            parsed.user_correction.diff_html = graded.diff_html || null;
            if (!parsed.user_correction.complete_answer) {
              parsed.user_correction.complete_answer = graded.complete_answer;
            }
            console.log('[topic_chat] Backfilled diff_html from grounded grader');
          }
          parsed = normalizeUserCorrectionOptions(parsed);
        }
      } catch (retryErr) {
        console.error('[topic_chat] Grounded grader failed:', retryErr.message);
      }
    }

    // Attach phase to evaluation for frontend
    if (parsed.evaluation) {
      parsed.evaluation.phase = phase;
    } else {
      parsed.evaluation = { phase };
    }

    console.log(`✓ Topic chat response | Phase: ${phase} | Topic: ${topicTitle}`);

    return parsed;
  } catch (error) {
    console.error('Error generating topic chat response:', error);
    const q = lastQuestion || "Let's keep going — here's the question again.";
    return {
      messages: [
        { message: "I faced an issue processing your message. Could you resend it?", message_type: "text" },
        { message: q, message_type: "text" }
      ]
    };
  }
}

module.exports = {
  generateTopicChatResponse,
  generateTopicGreeting,
  generateTopicGoals,
};
