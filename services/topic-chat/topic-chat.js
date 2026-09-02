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
    messages.push({ role: 'user', content: userMessage });

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

    // Grounded evaluation: if question was asked and no user_correction, grade it
    if (analysis.hasAskedQuestion && !parsed.user_correction && userMessage && userMessage.trim() !== '' && phase !== 'WRAP') {
      try {
        console.log('[topic_chat] No user_correction — using grounded answer grader (temp 0)');
        const graded = await gradeAnswer({
          answer: userMessage,
          question: lastQuestion,
          topicTitle,
          topicContent
        });

        if (graded) {
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
          parsed = normalizeUserCorrectionOptions(parsed);
          console.log('[topic_chat] Obtained grounded user_correction');
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
