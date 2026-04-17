const { invokeModel, extractJson } = require('./bedrock-client');
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
  try {
    const {
      aiMessages,
      userResponses,
      allQuestions,
      questionsAsked,
      lastAIMessage,
      lastQuestion,
      hasAskedQuestion
    } = analyzeChatHistory(chatHistory);

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
      console.log('🔔 SESSION END DETECTED');
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
    const maxAttempts = 3;
    let lastError = null;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        console.log(`[topic_chat] 🚀 Attempt ${attempts}/${maxAttempts} - Calling Bedrock API...`);
        
        const responseText = await invokeModel(systemPrompt, messages, {
            temperature: 0.7,
            maxTokens: 4096
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
          await new Promise(resolve => setTimeout(resolve, 1000));
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

    // Evaluate "I don't know" or retry user_correction if missing
    if (hasAskedQuestion && !parsed.user_correction && userMessage && userMessage.trim() !== '' && !shouldEndSession) {
      try {
        console.log('[topic_chat] ⚠️ No user_correction found but question was asked — retrying evaluation');
        const retryPrompt = `User answer: "${userMessage}"\nLast question asked: "${lastQuestion}"\n\nTask: Evaluate this answer and return a "user_correction" object only.\n\nRules:\n1. If correct: set feedback.is_correct=true, score_percent=100.\n2. If incorrect: set feedback.is_correct=false, score_percent=based on accuracy, provide diff_html and complete_answer.\n3. If "I don't know": set feedback.is_correct=false, feedback.score_percent=10, feedback.error_type="Knowledge Gap", and provide complete_answer for "${lastQuestion}".`;
        
        const retryText = await invokeModel('You are a JSON-only assistant. Respond with a single JSON object. Do NOT include any extra text.', [{ role: 'user', content: retryPrompt }], { temperature: 0.3 });
        const retryParsed = extractJson(retryText);
        
        if (retryParsed && retryParsed.user_correction) {
          parsed.user_correction = retryParsed.user_correction;
          parsed = normalizeUserCorrectionOptions(parsed);
          console.log('[topic_chat] ✅ Obtained user_correction from retry');
        }
      } catch (retryErr) {
        console.error('[topic_chat] Retry for user_correction failed:', retryErr.message);
      }
    }

    console.log(`✓ Topic chat response generated | Topic: ${topicTitle}`);

    return parsed;
  } catch (error) {
    console.error('Error generating topic chat response:', error);
    return {
      messages: [
        { message: "I'm here to help you learn!", message_type: "text" },
        { message: "Could you rephrase that?", message_type: "text" }
      ]
    };
  }
}

module.exports = {
  generateTopicChatResponse,
  generateTopicGreeting,
  generateTopicGoals,
};
