const { invokeModel, extractJson } = require('./bedrock-client');
const { gradeAnswer } = require('./answer-grader');
const {
  buildSystemPrompt,
  analyzeChatHistory,
  normalizeUserCorrectionOptions,
  generateTopicGreeting,
  generateTopicGoals,
  calculateSessionMetrics,
  generateSessionSummaryMessage
} = require('./topic-chat-helpers');

/**
 * Enhanced Topic Chat Service with Micro-Assessment and Real-Time Error Correction
 * Uses AWS Bedrock for interactive questioning with immediate feedback
 */

/**
 * Generate AI response for topic-specific chat (Question-Based Tutor)
 * Focuses on asking questions and providing instant feedback with error correction
 * Session-based: 2 questions per goal with performance tracking
 */
async function generateTopicChatResponse(userMessage, topicTitle, topicContent, chatHistory = [], currentGoal = null, topicGoals = [], userId = null, topicId = null) {
  let lastQuestion = "";
  try {
    const {
      aiMessages,
      userResponses,
      allQuestions,
      questionsAsked,
      lastAIMessage,
      lastQuestion: extractedLastQuestion,
      hasAskedQuestion
    } = analyzeChatHistory(chatHistory);

    lastQuestion = extractedLastQuestion;
    const isFirstMessage = chatHistory.length === 0;

    // Count completed goals
    const completedGoalsCount = topicGoals.filter(g => {
      const progress = g.chat_goal_progress?.[0];
      return progress?.is_completed || false;
    }).length;
    const allGoalsCompleted = completedGoalsCount === topicGoals.length;

    // Session management
    const totalQuestionsTarget = topicGoals.length * 2;
    const shouldEndSession = allGoalsCompleted;

    let sessionMetrics = null;
    if (shouldEndSession && userId && topicId) {
      console.log('\n🎯 All goals completed - calculating session metrics...');
      sessionMetrics = await calculateSessionMetrics(userId, topicId, topicGoals);
    }

    if (shouldEndSession) {
      console.log('NOT FOUND');
    }

    // Build comprehensive system prompt
    const systemPrompt = buildSystemPrompt(
      topicTitle,
      topicContent,
      topicGoals,
      currentGoal,
      completedGoalsCount,
      totalQuestionsTarget,
      questionsAsked,
      userResponses,
      allQuestions,
      lastQuestion,
      hasAskedQuestion,
      shouldEndSession,
      isFirstMessage,
      userMessage,
      lastAIMessage,
      sessionMetrics
    );

    const messages = [];

    // Add recent chat history (last 6 messages for context)
    const recentHistory = chatHistory.slice(-6);
    for (const msg of recentHistory) {
      messages.push({
        role: msg.sender === 'user' ? 'user' : 'assistant',
        content: msg.message || ''
      });
    }

    // Add current user message
    messages.push({
      role: 'user',
      content: userMessage
    });

    // ===== LOG COMPLETE AI INPUT =====
    console.log('\n========== AI INPUT DETAILS (BEDROCK) ==========');
    console.log('📊 Session State:');
    console.log('  - Questions Asked:', questionsAsked, '/', totalQuestionsTarget);
    console.log('  - Completed Goals:', completedGoalsCount, '/', topicGoals.length);
    console.log('  - Should End Session:', shouldEndSession);
    console.log('\n📝 Current User Message:', userMessage);
    console.log('================================================\n');

    let parsed = {};
    let attempts = 0;
    const maxAttempts = 3; // Increased to 3 for higher reliability
    let lastError = null;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        console.log(`[topic_chat] 🚀 Attempt ${attempts}/${maxAttempts} - Calling Bedrock API...`);
        
        const responseText = await invokeModel(systemPrompt, messages, {
          temperature: 0.7,
          maxTokens: 2048,
          userId,
          featureArea: 'topic_chat',
          subFeature: 'tutor_turn',
          metadata: { topicId, topicTitle }
        });

        if (!responseText) {
          throw new Error('Empty response from Bedrock API');
        }

        console.log(`[topic_chat] 📤 Raw Output (first 500 chars): ${responseText.substring(0, 500)}`);

        // Try to parse JSON
        parsed = extractJson(responseText);
        
        if (!parsed) {
          throw new Error('Failed to extract valid JSON from Bedrock response');
        }

        console.log(`[topic_chat] ✅ Successfully parsed JSON on attempt ${attempts}`);
        break;

      } catch (err) {
        lastError = err;
        console.warn(`[topic_chat] ❌ Attempt ${attempts} failed: ${err.message}`);
        
        if (attempts < maxAttempts) {
          console.log(`[topic_chat] 🔄 Retrying...`);
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          console.error(`[topic_chat] 💥 All ${maxAttempts} attempts failed.`);
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
        session_metrics: parsed.session_metrics,
        diff_html: parsed.diff_html
      }];
    }

    // Normalize user_correction options
    parsed = normalizeUserCorrectionOptions(parsed);

    // Grounded evaluation: If a question was asked and user_correction is missing, call gradeAnswer at temp 0
    if (hasAskedQuestion && !parsed.user_correction && userMessage && userMessage.trim() !== '' && !shouldEndSession) {
      try {
        console.log('[topic_chat] ⚠️ No user_correction found — using grounded answer grader (temp 0)');
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
          console.log('[topic_chat] ✅ Obtained grounded user_correction');
        }
      } catch (retryErr) {
        console.error('[topic_chat] Grounded grader fallback failed:', retryErr.message);
      }
    }

    console.log(`✓ Topic chat response generated | Topic: ${topicTitle}`);

    return parsed;
  } catch (error) {
    console.error('Error generating topic chat response:', error);
    // Do NOT blame the student. Re-ask the SAME question so the turn continues naturally
    const q = lastQuestion || "Let's keep going — here's the question again.";
    return {
      messages: [
        { message: "I encountered an issue processing that. Could you resend your message as text?", message_type: "text" },
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
