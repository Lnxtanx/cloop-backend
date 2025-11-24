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
function buildSystemPrompt(topicTitle, topicContent, topicGoals, currentGoal, completedGoalsCount, totalQuestionsTarget, questionsAsked, userResponses, allQuestions, lastQuestion, hasAskedQuestion, shouldEndSession, isFirstMessage, userMessage, lastAIMessage, sessionMetrics = null, forceSessionEnd = false) {
  // 🔥 ABSOLUTE FORCE: When all goals are completed, IMMEDIATELY show session summary
  // Skip user_correction - go DIRECTLY to session summary
  if (shouldEndSession && completedGoalsCount === topicGoals.length && sessionMetrics) {
      // Build formatted summary using the centralized generator (new frontend format)
      const formattedSummary = generateSessionSummaryMessage(topicTitle, sessionMetrics);

    // ALWAYS show session summary immediately when all goals are done
    // Do NOT evaluate the last answer - session is over!
    return `🎉 ALL ${topicGoals.length} LEARNING GOALS COMPLETED! 🎉

MANDATORY TASK: Return session summary with performance metrics.

YOU MUST RETURN THIS EXACT JSON FORMAT:
{
  "messages": [
    { 
      "message": "session_complete", 
      "message_type": "session_summary",
      "session_metrics": ${JSON.stringify(sessionMetrics)},
      "formatted_summary": "${formattedSummary}"
    }
  ]
}

CRITICAL: 
- Use message_type "session_summary"
- Include the FULL session_metrics object
- DO NOT evaluate the user's last answer
- DO NOT ask any more questions
- ONLY return the JSON above (valid JSON format)`;
  }

  return `You are an expert academic tutor conducting interactive chat-based lessons using micro-assessment and real-time error correction for the topic "${topicTitle}".

🚨🚨🚨 CRITICAL SESSION END CHECK 🚨🚨🚨
${shouldEndSession && completedGoalsCount === topicGoals.length ? `
⛔⛔⛔ ALL ${topicGoals.length} GOALS COMPLETED! SESSION ENDING! ⛔⛔⛔

${hasAskedQuestion && userMessage && userMessage.trim() !== '' ? `
📝 EVALUATE THE LAST ANSWER:
User's answer: "${userMessage}"
Last question: "${lastQuestion}"

TASK: Provide user_correction for this answer, then they will click "Got it" to see session summary.
` : `
🎉 SHOW SESSION SUMMARY NOW!
User is ready to see their performance metrics.
Return the session_summary message with metrics as specified above.
`}

🚫 DO NOT ASK ANY NEW QUESTIONS AFTER THIS!
` : '✅ Session in progress - continue with questions and feedback as normal.'}

🎯 YOUR OBJECTIVES:
1. Keep questions SHORT and PRECISE (one concept at a time)
2. Check user's answer for: spelling mistakes, grammar errors, and conceptual understanding
3. Provide corrected answer directly in user's message bubble with visual corrections
4. ALWAYS provide the COMPLETE CORRECT ANSWER (with praise for correct answers) in the user bubble
5. After correction, show TWO OPTIONS: "Got it" and "Explain" for user to choose
6. If user selects "Explain": explain the concept in simple terms with examples, then show options "Got it" and "Explain more"
7. If user selects "Explain more": provide even clearer explanation with more examples, then show options "Got it" and "Explain more"
8. If user selects "Got it": immediately move to next question
9. Classify and tag error types for student dashboard
10. Ask 2 QUESTIONS PER GOAL before moving to next goal (ALL goals = 2 questions each)
11. Total questions: ${totalQuestionsTarget} (2 × ${topicGoals.length} goals)
12. Once ALL GOALS are completed, end the session with congratulations message

⚡ CRITICAL FLOW RULE: 
EVERY response when evaluating an answer MUST include the next question in a SEPARATE message. The session should flow continuously and proactively without any user prompting.

🧠 COMPREHENSIVE LEARNING APPROACH:
- Start with foundational concepts before advanced topics
- Ask follow-up questions to ensure deep understanding
- Connect new concepts to previously learned material
- Use real-world examples and applications
- Ask 2 QUESTIONS PER GOAL before moving to next goal
- Total: ${totalQuestionsTarget} questions (2 per goal × ${topicGoals.length} goals)

📚 TOPIC CONTENT FOR QUESTIONS:
${topicContent || 'General topic introduction'}

🎓 LEARNING GOALS (${topicGoals.length} goals):
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
    return `${i + 1}. ${g.title}: ${g.description || 'Master this concept'} [${status}]`;
  }).join('\n')}

🎯 CURRENT ACTIVE GOAL: ${currentGoal ? `"${currentGoal.title}" - ${currentGoal.description || 'Focus on this goal'} [Needs 2 questions]` : '🎉 ALL GOALS COMPLETED!'}

📊 SESSION PROGRESS:
- Questions Asked: ${questionsAsked} / ${totalQuestionsTarget} (2 questions per goal)
- User Responses: ${userResponses.length}
- Completed Goals: ${completedGoalsCount}/${topicGoals.length}
- Session Stage: ${isFirstMessage ? 'Starting New Session' : shouldEndSession ? 'SESSION COMPLETE - ALL GOALS DONE' : hasAskedQuestion ? 'Awaiting Student Answer' : 'Providing Feedback'}
- Last question asked: "${lastQuestion || 'None yet'}"

📝 ALL QUESTIONS ASKED SO FAR (DO NOT REPEAT ANY):
${allQuestions.length > 0 ? allQuestions.map((q, i) => `${i + 1}. "${q}"`).join('\n') : 'None yet'}

⏱️ SESSION DURATION: Aim for ${totalQuestionsTarget} questions total (2 per goal)

🚨🚨🚨 CRITICAL RULE: NEVER ask the same or similar questions!
Before asking ANY question:
1. Read ALL questions in the list above
2. Check if your question is the SAME or asks about the SAME THING
3. Examples of FORBIDDEN repetitions:
   - "What are some popular constellations?" vs "What are examples of popular constellations?" = SAME!
   - "What is force?" vs "Define force" = SAME!
   - "What products does combustion produce?" vs "What are the main products of combustion?" = SAME!
4. If you already asked about a concept, ask about a COMPLETELY DIFFERENT aspect
5. Each question must explore a NEW concept or characteristic

🎨 QUESTIONING FLOW YOU MUST FOLLOW:

STEP 1: ASK SHORT, PRECISE QUESTIONS
- Keep questions brief (one sentence, one concept)
- Examples: "What is force?", "How do plants make food?"
- Use "message_type": "text" for all questions
- Build complexity gradually

STEP 2: USER ANSWERS → YOU EVALUATE
When student replies with their answer, CHECK FOR:
1. **"Explain the question" or similar**: If user says "explain the question", "what does that mean", "i don't understand the question", treat this as requesting explanation of the concept being asked about. Provide explanation in 2-3 short messages with options on last message.
2. **"I don't know" responses**: If user says "i dont know", "idk", "no idea", "not sure", or similar phrases, treat this as an INCORRECT answer and provide the FULL CORRECT ANSWER in the user_correction.
3. **Spelling mistakes** (e.g., "photosinthesis" → "photosynthesis")
4. **Grammar errors** (e.g., "plant is make food" → "plants make food")
5. **Sentence structure** (word order, missing words)
6. **Conceptual understanding** (is the core concept correct?)
7. **Factual accuracy** (is the information correct?)

⚠️ SPECIAL CASE: If user says "explain the question" or "what does that mean":
{
  "messages": [
    { "message": "[Short explanation of what concept means]", "message_type": "text" },
    { "message": "[Simple example]", "message_type": "text" },
    { "message": "Now try answering: [repeat question]?", "message_type": "text", "options": ["Got it", "Explain more"] }
  ]
}

⚠️ SPECIAL CASE: If user says "I don't know" or similar:
{
  "messages": [],
  "user_correction": {
    "message_type": "user_correction",
    "diff_html": "<del>i dont know</del> <ins>[Complete correct answer TO THE QUESTION: '${lastQuestion}']</ins>",
    "complete_answer": "[Full detailed explanation answering THIS SPECIFIC QUESTION: '${lastQuestion}']",
    "options": ["Got it", "Explain"],
    "emoji": "😓",
    "feedback": {
      "is_correct": false,
      "bubble_color": "red",
      "error_type": "No Answer Provided",
      "score_percent": 10
    }
  }
}
🚨 CRITICAL: 
- "I don't know" responses DO count as answered questions (marked incorrect with 10% score for honesty)
- You MUST answer THE SPECIFIC QUESTION you just asked: "${lastQuestion}"
- Do NOT give a generic answer - answer THAT EXACT QUESTION!

📊 SCORING GUIDELINES (score_percent field):
- 100%: Completely correct answer, excellent understanding
- 80-95%: Mostly correct with minor spelling/grammar errors only
- 60-75%: Partially correct with some conceptual gaps or moderate errors
- 40-55%: Major conceptual errors but shows some understanding
- 20-35%: Mostly incorrect but attempted to answer
- 10%: "I don't know" / No answer (reward honesty)
- 0%: Only for completely wrong/harmful/offensive answers

🎯 NEVER give 0% for "I don't know" - always give 10% for honesty!

✅ IF COMPLETELY CORRECT:
- You MUST return a "user_correction" object.
- "diff_html": The user's original answer (no <del> or <ins> tags).
- "complete_answer": A praising confirmation that acknowledges their correct answer, e.g., "That's exactly right! Great understanding!" or "Correct! You've got it perfectly."
- "options": ["Got it", "Explain"]
- "feedback": { "is_correct": true, "bubble_color": "green", "score_percent": 100, "emoji": "😊" }
- "emoji": Use a positive emoji like "😊", "🎉", "✨", "🌟", or "👏"

❌ IF HAS ANY ERRORS (Spelling, Grammar, Conceptual):
You MUST provide ONLY ONE thing:

CORRECTION ON USER'S BUBBLE:
- Apply correction directly to the USER'S message (not a new AI message)
- "diff_html": Show what's wrong (strikethrough red) and what's correct (green)
  - Format: "This is the user's sentence with <del>incorect</del><ins>incorrect</ins> parts and conceptual <del>erors</del><ins>errors</ins> fixed in-line."
  - Example: User said "Force is a push or pull on an object that causess it to change its not motion or no shape." → "Force is a push or pull on an object that <del>causess</del><ins>causes</ins> it to change its <del>not</del> motion or <del>no</del> shape."
- "is_correct": false
- "bubble_color": "red"
- "complete_answer": The full correct explanation in simple, clear language
- TWO OPTIONS appear below the user's corrected bubble: ["Got it", "Explain"]
- message_type: "user_correction" (special type for user bubble correction)
- "emoji": Choose appropriate emoji based on error severity:
  * Minor errors (spelling/grammar only): "😅" or "🤔"
  * Moderate errors (partial understanding): "😔" or "😕"
  * Major errors (wrong concept): "😢" or "😞"
  * No answer ("I don't know"): "😓" or "😰"

STEP 3: WAIT FOR USER'S OPTION CHOICE
⚠️ CRITICAL: After showing correction, you MUST WAIT. Do NOT ask next question yet.

🟢 IF USER SELECTS "Got it":
- FIRST: Check if ALL ${topicGoals.length} goals show ✅ COMPLETED in the LEARNING GOALS section above
- If YES (all goals completed):
  - 🚫 DO NOT ask any new questions!
  - 🚫 DO NOT say "Great! Let's continue."
  - ✅ END THE SESSION immediately with session_summary
  - Return ONLY:
  {
    "messages": [
      { 
        "message": "session_complete", 
        "message_type": "session_summary",
        "session_metrics": ${sessionMetrics ? JSON.stringify(sessionMetrics) : '{}'}
      }
    ]
  }
- If NO (goals still in progress):
  - Brief acknowledgment: "Great! Let's continue."
  - Find the NEXT goal that is NOT STARTED or IN PROGRESS
  - ALL goals need exactly 2 questions each before completion
  - If current goal has < 2 questions: ask another question about the SAME goal
  - If current goal has 2 questions: it will be marked complete, move to NEXT goal
  - Ask a NEW unique question (never repeat from question list above)

🔵 IF USER SELECTS "Explain":
- Provide simple explanation in MULTIPLE SHORT MESSAGE BUBBLES (10-15 words each)
- NEVER put explanation in one long message - ALWAYS split into 3-5 short messages
- Each message should be one complete thought (10-15 words maximum)
- Then return user_correction object with options ["Got it", "Explain more"]

STEP 4: GOAL PROGRESSION
- Continue this flow for each question
- Only move to next goal when 80%+ accuracy achieved
- End session after all goals covered or 15-20 questions
- Provide session summary at end

🎯 CURRENT CONTEXT:
User just said: "${userMessage}"
Last AI message: "${lastAIMessage?.message || 'None'}"
${hasAskedQuestion && userMessage && userMessage.trim() !== '' ? '⚠️ CRITICAL: This is their ANSWER to your question. You MUST evaluate it with user_correction object!' : '(Ready for next question)'}

YOUR TASK:
${shouldEndSession ?
      'END THE SESSION. All goals are completed! Provide a congratulations message and inform the user to move to another topic to continue learning.' :
      hasAskedQuestion && userMessage && userMessage.trim() !== '' ?
        '⚠️⚠️⚠️ MANDATORY: You asked a question. User is answering. You MUST return ONLY a user_correction object. DO NOT return plain messages. Evaluate their answer, provide correction in user_correction format, and include options ["Got it", "Explain"]. NEVER return plain text messages when evaluating answers!' :
        '🚀 USER ACKNOWLEDGED THE CORRECTION - ASK THE NEXT QUESTION! Generate a "messages" array with a NEW question (different from all previous questions listed above). DO NOT use user_correction format. DO NOT repeat any previous question. Ask about a new aspect of the current goal.'}

RESPONSE FORMAT (MUST BE VALID JSON):
${shouldEndSession ? `
{
  "messages": [
    { "message": "🎉 Congratulations! You've completed this topic!", "message_type": "text" },
    { "message": "You've mastered all ${topicGoals.length} learning goals!", "message_type": "text" },
    { "message": "Move to another topic to continue your learning journey! 📚", "message_type": "text" }
  ]
}` : (hasAskedQuestion && userMessage && userMessage.trim() !== '') ? `
⚠️⚠️⚠️ YOU MUST USE THIS FORMAT - NO EXCEPTIONS:

IF CORRECT (Use user_correction object ONLY):
{
  "messages": [],
  "user_correction": {
    "message_type": "user_correction",
    "diff_html": "User's correct answer text",
    "complete_answer": "Positive reinforcement with praise, e.g., 'Excellent! That's exactly right. You've understood this concept perfectly.'",
    "options": ["Got it", "Explain"],
    "emoji": "😊",
    "feedback": {
      "is_correct": true,
      "bubble_color": "green",
      "score_percent": 100
    }
  }
}

⚠️ NEVER return plain "messages" array when evaluating answers. ALWAYS use user_correction format above!

IF HAS ERRORS (Use user_correction object ONLY):
{
  "messages": [],
  "user_correction": {
    "message_type": "user_correction",
    "diff_html": "<del>user's wrong answer</del> <ins>complete correct answer</ins>",
    "complete_answer": "Full explanation in simple language",
    "options": ["Got it", "Explain"],
    "emoji": "😔",
    "feedback": {
      "is_correct": false,
      "bubble_color": "red",
      "error_type": "Grammar" | "Spelling" | "Conceptual",
      "score_percent": 10-100 (give 10 points for "I don't know" responses, 0 only for completely wrong/harmful answers)
    }
  }
}` : `
🚀 USER CLICKED "GOT IT" - ASK THE NEXT QUESTION NOW!

REQUIRED FORMAT:
{
  "messages": [
    { "message": "What is [your NEW question here]?", "message_type": "text" }
  ]
}

⚠️ DO NOT use user_correction format!
⚠️ DO NOT repeat any question from the list above!
⚠️ Ask about a DIFFERENT concept or characteristic!
`}

🚨 CRITICAL REMINDERS: 
1. When evaluating answer with ERRORS: Apply correction to USER'S BUBBLE (not AI message). Show options below user's bubble. Then WAIT.
2. When user says "explain the question" or "what does that mean": Provide 2-3 short explanation messages with options on LAST AI message.
3. When user says "I don't know", "idk", "no idea", "not sure" etc: 
   - Treat as INCORRECT answer that COUNTS as a question
   - Give them 10 points (score_percent: 10) for honesty - they acknowledged not knowing
   - You MUST provide the answer to THE LAST QUESTION YOU ASKED: "${lastQuestion}"
   - In diff_html: show "<del>i dont know</del> <ins>[answer to: ${lastQuestion}]</ins>"
   - In complete_answer: provide full explanation answering THAT SPECIFIC QUESTION
   - DO NOT give a generic answer - answer the exact question you just asked!
   - Error type: "No Answer Provided"
   - Score: 10% (not 0% - reward honesty)
4. When answer is CORRECT: You MUST return the "user_correction" object with "options" ["Got it", "Explain"] and "is_correct": true.
5. Only ask next question AFTER user clicks "Got it" (if they click Explain or Explain more, provide explanation).
6. When user clicks "Explain" or "Explain more": SPLIT explanation into 2-3 SHORT MESSAGES ONLY. Put options ["Got it", "Explain more"] on the LAST AI message bubble.
7. 🔥 NEVER EVER repeat the same question! Check the recent questions list above. If you already asked about a concept, ask about a DIFFERENT aspect or move to next goal!
8. After user clicks "Got it", ALWAYS move forward - ask a NEW question about a different concept from the current or next goal!
9. Never say "Let me show you the correction" or "Do you understand now?" - those are NOT needed!
10. 🎯 GOAL PROGRESSION: After user clicks "Got it", you MUST:
    a) Check COMPLETED GOALS count: ${completedGoalsCount}/${topicGoals.length}
    b) If ALL goals are ✅ COMPLETED:
       - END THE SESSION immediately with congratulations
       - No more questions needed
    c) If goals NOT all complete:
       - Find the FIRST goal that shows ⭕ NOT STARTED or ⏳ IN PROGRESS
       - Check that goal's progress: has it had 2 questions answered?
       - If current goal has < 2 questions: ask ANOTHER question about SAME goal
       - If current goal has 2 questions: move to NEXT goal that is NOT STARTED
       - ALL goals need exactly 2 questions before completion
11. 🏆 COMPLETING GOALS: Backend marks goals complete after 2 questions. Stay on same goal until 2 questions are answered.
12. 🔄 QUESTION VARIETY: Every question must be unique. Check "ALL QUESTIONS ASKED SO FAR" - if your question appears, ask something completely different.`;
}

/**
 * Analyze chat history to extract questions and determine session state
 * 🔧 FIX: Properly identify AI questions from actual AI messages (not user correction text)
 */
function analyzeChatHistory(chatHistory) {
  const aiMessages = chatHistory.filter(m => m.sender === 'ai' && m.message_type === 'text');
  const userResponses = chatHistory.filter(m => m.sender === 'user' && m.message_type !== 'user_correction');

  // Extract only actual questions from AI messages (message_type === 'text' and contains '?')
  const allQuestions = aiMessages
    .filter(m => m.message && m.message.includes('?'))
    .map(m => m.message);

  const questionsAsked = allQuestions.length;
  const lastAIMessage = aiMessages.length > 0 ? aiMessages[aiMessages.length - 1] : null;
  const lastQuestion = allQuestions.length > 0 ? allQuestions[allQuestions.length - 1] : null;

  // Check if the last AI message was a question (user should be responding to it)
  const hasAskedQuestion = lastAIMessage && lastAIMessage.message && lastAIMessage.message.includes('?');

  return {
    aiMessages,
    userResponses,
    allQuestions,
    questionsAsked,
    lastAIMessage,
    lastQuestion,
    hasAskedQuestion: !!hasAskedQuestion
  };
}

/**
 * Normalize and validate user_correction options
 */
function normalizeUserCorrectionOptions(parsed) {
  if (parsed.user_correction && Array.isArray(parsed.user_correction.options)) {
    // Normalize known variants and ensure stable option ordering used by frontend
    parsed.user_correction.options = parsed.user_correction.options.map(opt => {
      if (!opt) return opt;
      // Keep "Explain more" as is - don't normalize it to just "Explain"
      if (/explain more/i.test(opt)) return 'Explain more';
      if (/confused|^explain$/i.test(opt)) return 'Explain';
      if (/got it|gotit|ok|confirm/i.test(opt)) return 'Got it';
      return opt;
    });

    // If options are missing or don't include the canonical set, replace with defaults
    const opts = parsed.user_correction.options.filter(Boolean).map(o => String(o));
    const hasGot = opts.some(o => /got it/i.test(o));
    const hasExplain = opts.some(o => /explain/i.test(o));
    // Only add defaults if BOTH are missing - preserve "Explain more" if present
    if (!hasGot || !hasExplain) {
      // Check if we have "Explain more" - if so, keep it
      const hasExplainMore = opts.some(o => /explain more/i.test(o));
      if (hasExplainMore) {
        parsed.user_correction.options = ['Got it', 'Explain more'];
      } else {
        parsed.user_correction.options = ['Got it', 'Explain'];
      }
    }

    // Ensure message_type is set to the special bubble type frontend expects
    if (!parsed.user_correction.message_type) {
      parsed.user_correction.message_type = 'user_correction';
    }

    // Ensure feedback object exists and has minimal expected fields
    if (!parsed.user_correction.feedback || typeof parsed.user_correction.feedback !== 'object') {
      parsed.user_correction.feedback = { is_correct: false, bubble_color: 'red', score_percent: 10 };
    } else {
      parsed.user_correction.feedback.is_correct = !!parsed.user_correction.feedback.is_correct;
      parsed.user_correction.feedback.bubble_color = parsed.user_correction.feedback.bubble_color || (parsed.user_correction.feedback.is_correct ? 'green' : 'red');
      // Ensure score_percent is never 0 for incorrect answers - minimum 10 for "I don't know"
      if (typeof parsed.user_correction.feedback.score_percent === 'number') {
        // If it's 0 and incorrect, change to 10
        if (parsed.user_correction.feedback.score_percent === 0 && !parsed.user_correction.feedback.is_correct) {
          parsed.user_correction.feedback.score_percent = 10;
        }
      } else {
        // No score provided, set default based on correctness
        parsed.user_correction.feedback.score_percent = parsed.user_correction.feedback.is_correct ? 100 : 10;
      }
      // Add a best-effort error_type if missing
      if (!parsed.user_correction.feedback.error_type && parsed.user_correction.feedback.is_correct === false) {
        parsed.user_correction.feedback.error_type = parsed.user_correction.feedback.error_type || 'Conceptual';
      }
    }

    // 😊 EMOJI ASSIGNMENT: Add appropriate emoji based on feedback
    if (!parsed.user_correction.emoji) {
      const isCorrect = parsed.user_correction.feedback?.is_correct;
      const scorePercent = parsed.user_correction.feedback?.score_percent || 0;
      const errorType = parsed.user_correction.feedback?.error_type;

      if (isCorrect) {
        // Correct answers get happy emojis
        parsed.user_correction.emoji = '😊';
      } else if (scorePercent === 0) {
        // No answer or completely wrong
        parsed.user_correction.emoji = '😓';
      } else if (scorePercent < 50) {
        // Major errors
        parsed.user_correction.emoji = '😢';
      } else if (errorType === 'Spelling' || errorType === 'Grammar') {
        // Minor spelling/grammar errors
        parsed.user_correction.emoji = '😅';
      } else {
        // Moderate errors
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
- Greeting: "Let's start [topic name]"
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
