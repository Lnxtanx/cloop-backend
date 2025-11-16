const { 
  buildSystemPrompt,
  analyzeChatHistory,
  normalizeUserCorrectionOptions,
  generateTopicGreeting,
  generateTopicGoals,
  openai,
  calculateSessionMetrics,
  generateSessionSummaryMessage
} = require('./topic_chat_helpers');

/**
 * Enhanced Topic Chat Service with Micro-Assessment and Real-Time Error Correction
 * Uses GPT-4 for interactive questioning with immediate feedback
 * 
 * 🔧 REFACTORED: Split into topic_chat.js (main logic) and topic_chat_helpers.js (helpers)
 * 🔧 FIXED: Chat history now properly tracks AI questions
 * 🔧 FIXED: Question counting and tracking works correctly
 * 🔧 FIXED: "I don't know" responses now answer the correct question
 */

/**
 * Generate AI response for topic-specific chat (Question-Based Tutor)
 * Focuses on asking questions and providing instant feedback with error correction
 * Session-based: 2 questions per goal with performance tracking
 */
async function generateTopicChatResponse(userMessage, topicTitle, topicContent, chatHistory = [], currentGoal = null, topicGoals = [], userId = null, topicId = null) {
  try {
    // 🔧 FIX: Properly analyze chat history to extract AI questions
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
    
    // Session management: ALL goals require 2 questions each
    const totalQuestionsTarget = topicGoals.length * 2;
    const shouldEndSession = allGoalsCompleted;
    
    // 🆕 CALCULATE SESSION METRICS when all goals are completed
    // Calculate BEFORE checking for user input, so we always have metrics ready
    let sessionMetrics = null;
    if (shouldEndSession && userId && topicId) {
      console.log('\n🎯 All goals completed - calculating session metrics...');
      sessionMetrics = await calculateSessionMetrics(userId, topicId, topicGoals);
    }
    
    // 🔥 SESSION END HANDLING:
    // - If metrics exist, we should show session summary
    // - UNLESS user explicitly says "end the chat" or similar
    const userWantsToEnd = userMessage && (
      /end.*(chat|session)/i.test(userMessage) || 
      /finish|quit|exit|stop/i.test(userMessage)
    );
    const forceSessionEnd = shouldEndSession && sessionMetrics && userWantsToEnd;
    
    if (shouldEndSession) {
      console.log('🔔 SESSION END DETECTED:');
      console.log('  - All Goals Completed:', allGoalsCompleted);
      console.log('  - User Wants to End:', userWantsToEnd);
      console.log('  - Has Session Metrics:', !!sessionMetrics);
      console.log('  - Force Session End:', forceSessionEnd);
    }
    
    // Build comprehensive system prompt using helper
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
      sessionMetrics,
      forceSessionEnd
    );

    const messages = [
      {
        role: 'system',
        content: systemPrompt
      }
    ];

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
    console.log('\n========== AI INPUT DETAILS ==========');
    console.log('📊 Session State:');
    console.log('  - Questions Asked:', questionsAsked, '/', totalQuestionsTarget);
    console.log('  - Completed Goals:', completedGoalsCount, '/', topicGoals.length);
    console.log('  - Has Asked Question:', hasAskedQuestion);
    console.log('  - Should End Session:', shouldEndSession);
    console.log('  - Last Question:', lastQuestion || 'None');
    console.log('\n📝 Current User Message:', userMessage);
    console.log('\n🎯 Current Active Goal:', currentGoal ? currentGoal.title : 'None');
    console.log('\n📚 Chat History (last 6 messages):');
    recentHistory.forEach((msg, i) => {
      console.log(`  ${i + 1}. [${msg.sender}] (${msg.message_type}): ${msg.message ? msg.message.substring(0, 80) : 'empty'}...`);
    });
    console.log('\n🔍 All Questions Asked So Far:', questionsAsked);
    if (allQuestions.length > 0) {
      console.log('📝 Question List:');
      allQuestions.forEach((q, i) => {
        console.log(`  ${i + 1}. "${q}"`);
      });
    }
    console.log('\n🤖 System Prompt Length:', systemPrompt.length, 'characters');
    console.log('\n💬 Total Messages Sent to AI:', messages.length);
    console.log('======================================\n');

    // Primary model call: use low temperature for deterministic JSON output when evaluating answers
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      temperature: 0.2,
      max_tokens: shouldEndSession && sessionMetrics ? 3000 : 800,
      response_format: { type: "json_object" }
    });

    // Log raw response for debugging
    const rawContent = response.choices[0].message.content;
    console.log('\n========== AI OUTPUT DETAILS ==========');
    console.log('📤 Raw Model Output (first 1000 chars):', rawContent && rawContent.substring(0, 1000));

    let parsed = {};
    try {
      const content = rawContent.trim();
      parsed = JSON.parse(content);
    } catch (parseErr) {
      console.error('[topic_chat] Failed to parse model JSON response:', parseErr.message);
      // Fallback: try to recover by attempting to extract a JSON substring
      const maybeJsonMatch = rawContent && rawContent.match(/\{[\s\S]*\}/);
      if (maybeJsonMatch) {
        try {
          parsed = JSON.parse(maybeJsonMatch[0]);
          console.log('[topic_chat] Recovered JSON from model output');
        } catch (e) {
          console.error('[topic_chat] Recovery parse failed:', e.message);
        }
      }
    }

    // Normalize user_correction options using helper
    parsed = normalizeUserCorrectionOptions(parsed);

    // If the model did not return a `user_correction` but we believe the user just answered
    // (hasAskedQuestion === true), retry with a focused, low-temperature JSON-only prompt
    // SKIP this retry if userMessage is empty (means "Got it" was clicked and we're asking next question)
    // SKIP this retry if all goals are complete (session should end with metrics)
    if (hasAskedQuestion && !parsed.user_correction && userMessage && userMessage.trim() !== '' && !shouldEndSession) {
      try {
        console.log('[topic_chat] ⚠️ No user_correction found but question was asked — retrying with strict JSON prompt');
        const correctionPrompt = [
          { role: 'system', content: 'You are a JSON-only assistant. Respond with a single JSON object. Do NOT include any extra text.' },
          { role: 'user', content: `User answer: "${userMessage}"\nLast question asked: "${lastQuestion}"\n\nTask: Evaluate this answer and return a "user_correction" object only. If the answer is correct, set feedback.is_correct=true. If incorrect, set feedback.is_correct=false and provide diff_html and complete_answer. If user said "I don't know", provide the answer to the SPECIFIC question: "${lastQuestion}".` }
        ];

        const retryResp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: correctionPrompt,
          temperature: 0.0,
          max_tokens: 400,
          response_format: { type: 'json_object' }
        });

        const retryRaw = retryResp.choices[0].message.content;
        console.log('[topic_chat] Retry raw output (trim):', retryRaw && retryRaw.substring(0, 1000));
        try {
          const retryParsed = JSON.parse(retryRaw.trim());
          // Merge user_correction if present
          if (retryParsed.user_correction) {
            parsed.user_correction = retryParsed.user_correction;
            parsed = normalizeUserCorrectionOptions(parsed);
            console.log('[topic_chat] ✅ Obtained user_correction from retry');
          }
        } catch (rpErr) {
          console.error('[topic_chat] Failed to parse retry JSON:', rpErr.message);
        }
      } catch (retryErr) {
        console.error('[topic_chat] Retry for user_correction failed:', retryErr.message);
      }
    }

    // Log the full AI response for debugging and content review
    console.log('\n📦 Parsed AI Response Structure:');
    console.log('  - Has messages array:', !!parsed.messages);
    console.log('  - Messages count:', parsed.messages ? parsed.messages.length : 0);
    console.log('  - Has user_correction:', !!parsed.user_correction);
    
    if (parsed.messages && parsed.messages.length > 0) {
      console.log('\n💬 AI Messages:');
      parsed.messages.forEach((msg, i) => {
        console.log(`  ${i + 1}. [${msg.message_type || 'undefined'}]: ${msg.message || 'undefined'}`);
        if (msg.options) {
          console.log(`     Options: [${msg.options.join(', ')}]`);
        }
      });
    }
    
    if (parsed.user_correction) {
      console.log('\n✏️ User Correction Details:');
      console.log('  - Is Correct:', parsed.user_correction.feedback?.is_correct);
      console.log('  - Bubble Color:', parsed.user_correction.feedback?.bubble_color);
      console.log('  - Score:', parsed.user_correction.feedback?.score_percent + '%');
      console.log('  - Error Type:', parsed.user_correction.feedback?.error_type || 'N/A');
      console.log('  - Diff HTML:', parsed.user_correction.diff_html ? parsed.user_correction.diff_html.substring(0, 150) + '...' : 'N/A');
      console.log('  - Complete Answer:', parsed.user_correction.complete_answer ? parsed.user_correction.complete_answer.substring(0, 150) + '...' : 'N/A');
      console.log('  - Options:', parsed.user_correction.options ? `[${parsed.user_correction.options.join(', ')}]` : 'N/A');
    }
    
    console.log('\n🔢 Token Usage:');
    console.log('  - Input tokens:', response.usage.prompt_tokens);
    console.log('  - Output tokens:', response.usage.completion_tokens);
    console.log('  - Total tokens:', response.usage.total_tokens);
    console.log('======================================\n');
    
    console.log(`✓ Topic chat response generated | Topic: ${topicTitle}`);
    
    return parsed;
  } catch (error) {
    console.error('Error generating topic chat response:', error);
    // Fallback to simple response
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

