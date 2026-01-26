const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.API_KEY_OPENAI,
});

/**
 * Topic Chat Helper Functions
 * Contains system prompt generation, greeting generation, and goal generation
 */

// Import metrics helper for session completion
const { calculateSessionMetrics, generateSessionSummaryMessage } = require('./topic_chat_metrics');

/**
 * Build the comprehensive system prompt for the AI tutor
 */
function buildSystemPrompt(topicTitle, topicContent, topicGoals, currentGoal, completedGoalsCount, totalQuestionsTarget, questionsAsked, userResponses, allQuestions, lastQuestion, hasAskedQuestion, shouldEndSession, isFirstMessage, userMessage, lastAIMessage, sessionMetrics = null, forceSessionEnd = false, isWaitingForMovement = false) {
  // 🔥 ABSOLUTE FORCE: When all goals are completed, IMMEDIATELY show session summary
  if (shouldEndSession) {
    // Ensure we have at least empty metrics if none provided to prevent crash
    const safeMetrics = sessionMetrics || {
      total_questions: 0,
      correct_answers: 0,
      incorrect_answers: 0,
      overall_score_percent: 0,
      star_rating: 0,
      performance_level: 'Completed'
    };

    const formattedSummary = sessionMetrics
      ? generateSessionSummaryMessage(topicTitle, sessionMetrics)
      : `You have completed all goals for ${topicTitle}! Great job!`;

    return `🎉 ALL ${topicGoals.length} LEARNING GOALS COMPLETED! 🎉

Return ONLY a session_summary message.

JSON FORMAT:
{
  "messages": [
    {
      "message": "session_complete",
      "message_type": "session_summary",
      "session_metrics": ${JSON.stringify(safeMetrics)},
      "formatted_summary": "${formattedSummary}"
    }
  ]
}

- Do NOT evaluate the last answer
- Do NOT ask more questions
- Valid JSON only`;
  }

  return `You are an expert tutor running a question-first micro-assessment on "${topicTitle}".

🚦 State: ${shouldEndSession ? 'SESSION COMPLETE' : isWaitingForMovement ? 'Waiting for movement confirmation' : hasAskedQuestion ? 'Awaiting answer evaluation' : 'Ask the next question'}
Progress: ${questionsAsked} / ${totalQuestionsTarget} questions answered
User just said: "${userMessage}"
Last AI question: "${lastQuestion || 'None yet'}"

What stays the same:
- 2 questions per goal (${topicGoals.length * 2} total) before completion
- Real-time error correction with diff_html applied to the USER bubble
- Always include the full correct answer (complete_answer) when evaluating
- Never repeat a question from the asked list below

What changes (Academic Rigor & Flow):
1. **Academic Error Types**: You must classify errors into specific categories (Knowledge Gap, Cognitive, Language, Structural, Misunderstanding).
2. **"Check-then-Move" Flow**: After evaluation or explanation, ALWAYS ask "Should we move on?" (and vary this phrase).
3. **Conversational Replies**: If user says "Yes", "Ok", "Sure", etc. to a movement prompt -> DO NOT generate a user_correction. Just ask the next question.
4. **"I don't know" / "No idea"**: 
   - **MUST** generate user_correction (score: 10, error_type: Knowledge Gap).
   - **MUST** provide the explanation/answer in multiple bubbles.
   - **MUST** ask "Should we move on?" at the end.
5. **"Explain" / "Why?"**: 
   - **NO** user_correction (it's a query).
   - **MUST** provide detailed explanation of the PREVIOUS concept.
   - **MUST** ask "Should we move on?" at the end.
6. **Short Questions**: Questions must be clear, short, and 1 sentence.

Questions asked so far:
${allQuestions.length > 0 ? allQuestions.map((q, i) => `${i + 1}. "${q}"`).join('\n') : 'None yet'}

Learning goals (${topicGoals.length}):
${topicGoals.map((g, i) => {
    const progress = g.chat_goal_progress?.[0];
    const isCompleted = progress?.is_completed || false;
    const accuracy = progress && progress.num_questions > 0
      ? Math.round((progress.num_correct / progress.num_questions) * 100)
      : 0;
    const status = isCompleted
      ? '✅ COMPLETED'
      : progress
        ? `⏳ IN PROGRESS (${accuracy}% accuracy, ${progress.num_questions} questions)`
        : '⭕ NOT STARTED';
    return `${i + 1}. ${g.title} [${status}]`;
  }).join('\n')}

Active goal: ${currentGoal ? `"${currentGoal.title}" (Question ${(currentGoal.chat_goal_progress?.[0]?.num_questions || 0) + 1} of 2)` : 'All goals done'}

LOGIC FLOW:

0. 🛑 CRITICAL RULE:
   - Do NOT say "That was the final question" or "We have covered all goals" UNLESS "Active goal" above says "All goals done".
   - If "Active goal" is present, you MUST ask the question defined by that goal.
   - You are NOT done until "Active goal" says "All goals done".

1. IF ALL GOALS COMPLETE (completedGoalsCount === topicGoals.length) AND NO sessionMetrics:
   - **Evaluated Answer**: Valid strict JSON evaluation for user's last answer (if applicable).
   - **Response**: "That was the final question! You have covered all the learning goals."
   - **Message Type**: Set message_type to "movement_prompt".

2. IF USER ANSWERED A QUESTION (hasAskedQuestion = true) AND NOT "I don't know":
   - **Evaluated Answer**: Provide strict JSON evaluation (user_correction).
   - **Response Message**: Brief feedback/praise, then ask: "Should we move on?" (Vary this: "Ready for the next one?", "Shall we proceed?").
   - **Message Type**: Set message_type to "movement_prompt".
   - **Do NOT** ask the next subject question yet.

3. IF USER SAID "YES" / "OK" TO "Should we move on?" (Movement) OR "GOT IT":
   - **NO EVALUATION**: Do NOT return user_correction. This is a conversation reply.
   - **Transition**: Simply acknowledge (optional) and ask the **NEXT** question immediately.
   - **FORMAT**: Use standard "messages" array.

4. IF USER SAID "I DON'T KNOW" / "NO IDEA" / "SKIP":
   - **Evaluated Answer**: **MUST** return user_correction: { is_correct: false, score_percent: 10, error_type: "Knowledge Gap" }.
   - **Response**: Provide the answer/explanation split into 2-3 short messages.
   - **End With**: A movement prompt phrase (e.g., "Ready for the next question?", "Does that make sense?").
   - **Message Type**: Set message_type to "movement_prompt".

5. IF USER ASKED FOR EXPLANATION ("Explain", "Why?", "More info"):
   - **No Evaluation**: Do NOT return user_correction.
   - **Response**: Provide detailed explanation of the LAST question/concept in 2-3 short messages.
   - **End With**: A movement prompt phrase (e.g., "Ready to move on?", "Is that clearer?").
   - **Message Type**: Set message_type to "movement_prompt".

ERROR TYPES (Must use one of these):
A. Knowledge Gap: "No Answer Provided", "I Don't Know", "Confused / Unclear", "Off-Topic"
B. Cognitive: "Conceptual Error", "Application Error", "Logical Reasoning Error", "Calculation Error"
C. Language: "Grammar Error", "Spelling Error", "Vocabulary Misuse"
D. Structural: "Incomplete Answer", "Missing Steps", "Incorrect Diagram", "Incorrect Units"
E. Misunderstanding: "Misinterpreted Question", "Partially Correct"

SCORING GUIDELINES:
- 100%: Correct
- 80-95%: Minor errors (Spelling, Grammar)
- 60-75%: Partially correct
- 40-55%: Major gaps / Misunderstanding
- 20-35%: Mostly wrong
- 10%: "I don't know" / "No Idea" (Honesty credit, but still wrong)
- **STRICTLY** correct spelling/grammar typos in \`diff_html\` even if the answer is conceptually correct.
- **IMPORTANT**: The \`diff_html\` must optionally contain the **ENTIRE** original sentence with corrections inline. Do NOT just return the corrected words.
- Example: "The sky is bue." -> "The sky is <del>bue</del><ins>blue</ins>."
- Example (Good): "woods,plastic are common sourece" -> "<del>woods</del><ins>Wood</ins> and <del>plastic</del><ins>plastics</ins> are common <del>sourece</del><ins>sources</ins>..."
- 🛑 **NO HTML TAGS** except <del> and <ins>. NO <p>, <div>, <br>, etc.

RESPONSE FORMATS (VALID JSON ONLY)

1) Evaluating an answer (User answered):
{
  "messages": [ 
    { "message": "That's right! [Short feedback]. Should we move on?", "message_type": "movement_prompt" } 
  ],
  "user_correction": {
    "message_type": "user_correction",
    "diff_html": null, 
    "complete_answer": "Full correct answer text", 
    "emoji": "😊",
    "feedback": {
      "is_correct": true,
      "bubble_color": "green",
      "error_type": null,
      "score_percent": 100
    }
  }
}

2) Moving on (User said "Yes" / "Got it"):
{
  "messages": [ { "message": "Great. [Next Question]?", "message_type": "text" } ]
}

3) "I don't know" Handling:
{
  "messages": [ 
    { "message": "No problem! Here is the answer:", "message_type": "text" },
    { "message": "Crude oil is primarily composed of hydrocarbons.", "message_type": "text" },
    { "message": "Ready for the next question?", "message_type": "movement_prompt" }
  ],
  "user_correction": {
    "message_type": "user_correction",
    "diff_html": null, 
    "complete_answer": "Crude oil is primarily composed of hydrocarbons.", 
    "emoji": "😓",
    "feedback": { "is_correct": false, "bubble_color": "red", "error_type": "Knowledge Gap", "score_percent": 10 }
  }
}

Absolute rules:
- No options/quick replies in "messages" array
- Never repeat a previous question
- Keep each question one sentence, concrete
- Split explanations into multiple small bubbles`;
}

/**
 * Analyze chat history to extract questions and determine session state
 * 🔧 FIX: Properly identify AI questions from actual AI messages (not user correction text)
 */
function analyzeChatHistory(chatHistory) {
  const aiMessages = chatHistory.filter(m => m.sender === 'ai' && (m.message_type === 'text' || m.message_type === 'movement_prompt'));
  const userResponses = chatHistory.filter(m => m.sender === 'user' && m.message_type !== 'user_correction');

  // Extract only actual questions from AI messages (message_type === 'text' and contains '?')
  // Exclude movement prompts from being counted as learning questions
  const allQuestions = aiMessages
    .filter(m => m.message && m.message.includes('?') && m.message_type !== 'movement_prompt')
    .map(m => m.message);

  const questionsAsked = allQuestions.length;
  const lastAIMessage = aiMessages.length > 0 ? aiMessages[aiMessages.length - 1] : null;
  const lastQuestion = allQuestions.length > 0 ? allQuestions[allQuestions.length - 1] : null;

  // Check if the last AI message was a question (user should be responding to it)
  const hasAskedQuestion = lastAIMessage && lastAIMessage.message && lastAIMessage.message.includes('?');

  // NEW: Check if we are waiting for a movement confirmation (e.g. "Should we move on?")
  const isWaitingForMovement = lastAIMessage && lastAIMessage.message_type === 'movement_prompt';

  return {
    aiMessages,
    userResponses,
    allQuestions,
    questionsAsked,
    lastAIMessage,
    lastQuestion,
    hasAskedQuestion: !!hasAskedQuestion,
    isWaitingForMovement: !!isWaitingForMovement
  };
}

/**
 * Normalize and validate user_correction options
 */
function normalizeUserCorrectionOptions(parsed) {
  if (parsed.user_correction) {
    // Remove quick-reply options entirely (free-text flow now)
    if (parsed.user_correction.options) {
      delete parsed.user_correction.options;
    }

    // Ensure message_type is set
    if (!parsed.user_correction.message_type) {
      parsed.user_correction.message_type = 'user_correction';
    }

    // Ensure feedback object exists and has minimal expected fields
    if (!parsed.user_correction.feedback || typeof parsed.user_correction.feedback !== 'object') {
      parsed.user_correction.feedback = { is_correct: false, bubble_color: 'red', score_percent: 10 };
    } else {
      parsed.user_correction.feedback.is_correct = !!parsed.user_correction.feedback.is_correct;
      parsed.user_correction.feedback.bubble_color = parsed.user_correction.feedback.bubble_color || (parsed.user_correction.feedback.is_correct ? 'green' : 'red');
      if (typeof parsed.user_correction.feedback.score_percent === 'number') {
        if (parsed.user_correction.feedback.score_percent === 0 && !parsed.user_correction.feedback.is_correct) {
          parsed.user_correction.feedback.score_percent = 10;
        }
      } else {
        parsed.user_correction.feedback.score_percent = parsed.user_correction.feedback.is_correct ? 100 : 10;
      }
      if (!parsed.user_correction.feedback.error_type && parsed.user_correction.feedback.is_correct === false) {
        parsed.user_correction.feedback.error_type = 'Conceptual';
      }
    }

    // 😊 EMOJI ASSIGNMENT: Add appropriate emoji based on feedback
    if (!parsed.user_correction.emoji) {
      const isCorrect = parsed.user_correction.feedback?.is_correct;
      const scorePercent = parsed.user_correction.feedback?.score_percent || 0;
      const errorType = parsed.user_correction.feedback?.error_type;

      if (isCorrect) {
        parsed.user_correction.emoji = '😊';
      } else if (scorePercent <= 10) {
        parsed.user_correction.emoji = '😓';
      } else if (scorePercent < 50) {
        parsed.user_correction.emoji = '😢';
      } else if (errorType === 'Spelling' || errorType === 'Grammar') {
        parsed.user_correction.emoji = '😅';
      } else {
        parsed.user_correction.emoji = '😔';
      }
    }
  }

  return parsed;
}

/**
 * Generate initial greeting and introduce the questioning session
 * Sets expectations for micro-assessment approach
 */
async function generateTopicGreeting(topicTitle, topicContent, topicGoals = []) {
  try {
    console.log('\n========== GREETING GENERATION START ==========');
    console.log('📚 Topic:', topicTitle);
    console.log('🎯 Goals count:', topicGoals.length);

    const goalsOverview = topicGoals.length > 0
      ? topicGoals.map((g, i) => `${i + 1}. ${g.title}`).join('\n')
      : 'We\'ll test your knowledge through questions';

    console.log('\n📋 Goals Overview:');
    console.log(goalsOverview);
    console.log('\n💬 Sending greeting request to AI...');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a friendly AI tutor starting a new QUESTIONING SESSION on "${topicTitle}".

IMPORTANT: This is a MICRO-ASSESSMENT session, NOT a teaching session.

GOALS TO ASSESS:
${goalsOverview}

TOPIC CONTENT:
${topicContent ? topicContent.substring(0, 200) + '...' : 'General introduction'}

YOUR TASK:
Create a simple greeting and immediately ask the first question.

RULES:
- Two messages: greeting + first question
- Greeting: "Let's start [topic name]! 📚" (or similar friendly intro)
- First question: A simple, short question about the topic basics
- Keep it friendly and brief

Return VALID JSON:
{
  "messages": [
    { "message": "Let's start [topic name]! 📚", "message_type": "text" },
    { "message": "[First simple question about the topic]", "message_type": "text" }
  ]
}`
        },
        {
          role: 'user',
          content: `Generate greeting for: ${topicTitle}`
        }
      ],
      temperature: 0.8,
      max_tokens: 400,
      response_format: { type: "json_object" }
    });

    const content = response.choices[0].message.content.trim();
    const parsed = JSON.parse(content);

    console.log('\n✅ Greeting Generated Successfully!');
    console.log('\n🎉 Greeting Messages:');
    if (parsed.messages) {
      parsed.messages.forEach((msg, i) => {
        console.log(`  ${i + 1}. [${msg.message_type}]: ${msg.message}`);
      });
    }
    console.log('\n🔢 Token Usage:');
    console.log('  - Input tokens:', response.usage.prompt_tokens);
    console.log('  - Output tokens:', response.usage.completion_tokens);
    console.log('  - Total tokens:', response.usage.total_tokens);
    console.log('===============================================\n');

    return parsed;
  } catch (error) {
    console.error('Error generating greeting:', error);
    // Fallback greeting
    return {
      messages: [
        { message: `Let's start this topic of ${topicTitle}.`, message_type: "text" }
      ]
    };
  }
}

/**
 * Generate topic goals for learning progression
 * Creates measurable, sequential learning objectives
 */
async function generateTopicGoals(topicTitle, topicContent) {
  // Truncate topic content to essential info for token efficiency
  const topicSummary = topicContent && topicContent.length > 150
    ? topicContent.substring(0, 150) + '...'
    : topicContent || 'General introduction to the topic';

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `Generate 3-5 progressive learning goals for the topic "${topicTitle}".
          
Each goal should be:
- Clear and specific (5-10 words)
- Measurable (can ask questions about it)
- Progressive (builds on previous goals)
- Student-friendly language
- Achievable through conversation

Goals should move from basic understanding to application.

Return JSON:
{
  "goals": [
    { "title": "Understand basic concept", "description": "Learn what ${topicTitle} means and why it matters", "order": 1 },
    { "title": "Identify key features", "description": "Recognize important characteristics and properties", "order": 2 },
    { "title": "Apply knowledge", "description": "Use understanding in practical examples", "order": 3 }
  ]
}`
        },
        {
          role: 'user',
          content: `Topic: ${topicTitle}\nContent Summary: ${topicSummary}`
        }
      ],
      temperature: 0.8,
      max_tokens: 600,
      response_format: { type: "json_object" }
    });

    const content = response.choices[0].message.content.trim();
    const parsed = JSON.parse(content);

    // Validate and ensure we have at least 3 goals
    if (!parsed.goals || parsed.goals.length < 3) {
      throw new Error('Generated less than 3 goals');
    }

    console.log(`✓ Topic goals generated | Topic: ${topicTitle} | Goals: ${parsed.goals.length}`);

    return parsed;
  } catch (error) {
    console.error('Error generating goals for', topicTitle, ':', error.message);
    // Fallback goals
    return {
      goals: [
        { title: "Understand the basics", description: `Learn what ${topicTitle} means and its importance`, order: 1 },
        { title: "Identify key concepts", description: "Recognize important ideas and components", order: 2 },
        { title: "Apply knowledge", description: "Use understanding in practical examples", order: 3 },
        { title: "Connect concepts", description: "Link this topic to related ideas", order: 4 }
      ]
    };
  }
}

module.exports = {
  buildSystemPrompt,
  analyzeChatHistory,
  normalizeUserCorrectionOptions,
  generateTopicGreeting,
  generateTopicGoals,
  openai,
  calculateSessionMetrics,
  generateSessionSummaryMessage
};
