const { invokeModel, extractJson } = require('./deepseek-client');
const prisma = require('../../lib/prisma');

/**
 * English AI Topic Tutor Service
 * Powered by DeepSeek (deepseek-chat) for real-time conversational roleplay
 * and Indian-English grammar correction with live HTML diffs.
 */

/**
 * Build the system prompt for the English Conversational AI Tutor
 */
function buildEnglishTutorSystemPrompt({
  topicTitle,
  topicDescription,
  topicGoals,
  turnNumber,
  totalTurns,
  chatHistory,
  userMessage,
  userProfile
}) {
  const learnerName = userProfile?.name ? userProfile.name.split(" ")[0] : "Learner";
  const fluencyLevel = userProfile?.fluencyLevel || userProfile?.englishLevel || "Intermediate";

  const goalsListStr = topicGoals.map((g, i) => {
    const done = g.is_completed ? '✅' : '⭕';
    return `${done} Goal ${g.id || i + 1}: "${g.title}"`;
  }).join('\n');

  const turnInfo = `Turn ${turnNumber} of approximately ${totalTurns}.`;
  const isNearEnd = turnNumber >= totalTurns - 2 && turnNumber < totalTurns;
  const shouldEnd = turnNumber >= totalTurns;

  let endingInstruction = '';
  if (shouldEnd) {
    endingInstruction = `
⚠️ THIS IS THE FINAL TURN. You MUST end the scenario now.
Set "session_ended": true.
Provide a warm closing summary in your message acknowledging ${learnerName}'s effort, mentioning 1 key strength and 1 area to practice next.`;
  } else if (isNearEnd) {
    endingInstruction = `
⚠️ The session is wrapping up (${totalTurns - turnNumber} turns remaining).
Begin guiding the conversation towards a natural conclusion.`;
  }

  return `You are Cloop AI, an expert English Fluency Coach and realistic roleplay partner.
You are running an interactive speaking/chat scenario with ${learnerName}.

SCENARIO: "${topicTitle}"
CONTEXT: ${topicDescription || 'Practical English conversation'}
LEARNER: ${learnerName} (Fluency Level: ${fluencyLevel})
${turnInfo}
${endingInstruction}

SCENARIO GOALS:
${goalsListStr}

YOUR CORE TUTORING LOOP (MANDATORY EVERY TURN):
1. EVALUATE & CORRECT (Grammar Coach):
   - Carefully inspect what the learner just typed for Indian-English common errors:
     * Tense misuse (e.g. "I am having two years experience" → "I have two years of experience", "yesterday I go" → "yesterday I went")
     * Redundancy / Indianisms ("revert back" → "reply", "prepone" → "reschedule earlier", "do the needful" → "handle this")
     * Question inversion ("Why you are saying that?" → "Why are you saying that?", "Where you are going?" → "Where are you going?")
     * Preposition errors ("discuss about" → "discuss", "order for food" → "order food", "listen me" → "listen to me")
     * Subject-verb agreement ("he do" → "he does", "she don't" → "she doesn't")
   - If the user's sentence is grammatically correct and natural:
     * "diff_html" MUST match the user's sentence without any <del> or <ins> tags.
     * "is_correct": true
     * "score_percent": 90-100
     * "error_type": "None"
     * "explanation": "Clear, natural, and accurate phrasing!"
   - If the user made errors:
     * "diff_html": Use <del>error</del> and <ins>correction</ins> tags inline around exact changed words.
       Example: "I <del>am having</del><ins>have</ins> two years <ins>of</ins> experience."
     * "complete_answer": The full, polished sentence.
     * "is_correct": false
     * "score_percent": Calculate realistically (40-85 depending on severity).
     * "error_type": One of "Grammar", "Vocabulary", "Sentence Structure", "Spelling", "Tone".
     * "explanation": ONE clear, friendly sentence explaining the rule (e.g., "Use 'have' instead of 'am having' for possession/experience.").

2. ACKNOWLEDGE & ASK NEXT QUESTION (Topic Tutor):
   - In "messages[0].message":
     * Step A: Briefly acknowledge the user's response in 1-2 conversational sentences (stay in character as tutor/partner).
     * Step B: Then ask the NEXT QUESTION to drill the next skill/goal in "${topicTitle}".
     * Keep your total response concise (2-3 sentences max).
     * NEVER provide multiple-choice options (A, B, C, D). The learner must type their own answer.

GOAL TRACKING:
- Check if the user's reply satisfies any of the scenario goals listed above.
- In "goal_status", return "completed_goal_ids" (array of numbers like [1, 2]) and "goals_completed" (array of matching goal titles).

OUTPUT FORMAT:
Respond in valid JSON format matching this exact structure:
{
  "user_correction": {
    "diff_html": "HTML highlighting changes using <del>errors</del> and <ins>corrections</ins>",
    "complete_answer": "The fully corrected natural sentence",
    "emoji": "😊 (score >= 80) | 😅 (score 50-79) | 😓 (score < 50)",
    "feedback": {
      "is_correct": true,
      "score_percent": 95,
      "error_type": "None",
      "explanation": "Great natural response!"
    }
  },
  "goal_status": {
    "completed_goal_ids": [1],
    "goals_completed": ["Goal title"],
    "all_goals_done": false
  },
  "session_ended": false,
  "messages": [
    {
      "message": "Brief acknowledgment (1-2 sentences) + the next topic question for the learner.",
      "message_type": "text"
    }
  ]
}`;
}

/**
 * Main AI function to evaluate user response and generate English tutor response using DeepSeek
 */
async function generateEnglishTopicChatResponse({
  userMessage,
  topicTitle,
  topicDescription,
  chatHistory = [],
  topicGoals = [],
  turnNumber = 1,
  totalTurns = 10,
  userId = null,
  topicId = null,
  userProfile = {}
}) {
  const systemPrompt = buildEnglishTutorSystemPrompt({
    topicTitle,
    topicDescription,
    topicGoals,
    turnNumber,
    totalTurns,
    chatHistory,
    userMessage,
    userProfile
  });

  const messages = [];
  // Include recent chat history for context (last 8 messages)
  const recentHistory = chatHistory.slice(-8);
  for (const msg of recentHistory) {
    messages.push({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.message || ''
    });
  }

  messages.push({
    role: 'user',
    content: userMessage
  });

  let parsed = null;

  try {
    const responseText = await invokeModel(
      systemPrompt,
      messages,
      {
        modelId: 'deepseek-chat',
        temperature: 0.6,
        jsonFormat: true,
        userId,
        featureArea: 'english_tutor_chat',
        subFeature: 'eval_turn'
      }
    );

    parsed = extractJson(responseText);
  } catch (error) {
    console.warn('⚠️ DeepSeek invocation failed:', error.message);
  }

  // Graceful fallback if DeepSeek call fails
  if (!parsed || !parsed.messages) {
    console.warn('⚠️ Using fallback for topic chat response');
    parsed = {
      user_correction: {
        diff_html: userMessage,
        complete_answer: userMessage,
        emoji: '😊',
        feedback: {
          is_correct: true,
          score_percent: 85,
          error_type: 'None',
          explanation: 'Good job expressing yourself! Keep practicing.'
        }
      },
      goal_status: {
        completed_goal_ids: [1],
        goals_completed: [topicGoals[0]?.title || 'Opening'],
        all_goals_done: false
      },
      session_ended: turnNumber >= totalTurns,
      messages: [
        {
          message: `That's very interesting, ${userProfile?.name ? userProfile.name.split(' ')[0] : 'there'}! Tell me more about that.`,
          message_type: 'text'
        }
      ]
    };
  }

  // Sanitize and guarantee required fields
  if (!parsed.messages || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    parsed.messages = [
      {
        message: parsed.message || "That's a good point! How would you continue from here?",
        message_type: "text"
      }
    ];
  }

  // Strip multiple-choice options if any LLM inserted them
  for (const msg of parsed.messages) {
    delete msg.options;
  }

  // Ensure user_correction structure
  if (!parsed.user_correction) {
    parsed.user_correction = {
      diff_html: userMessage,
      complete_answer: userMessage,
      emoji: '😊',
      feedback: { is_correct: true, score_percent: 90, error_type: 'None', explanation: 'Well said!' }
    };
  }

  if (!parsed.user_correction.diff_html) {
    parsed.user_correction.diff_html = userMessage;
  }

  // Ensure session_ended boolean
  if (typeof parsed.session_ended !== 'boolean') {
    parsed.session_ended = turnNumber >= totalTurns;
  }

  return parsed;
}

/**
 * Generate initial scenario greeting (AI starts the conversation) using DeepSeek
 */
async function generateEnglishTopicGreeting(topicTitle, topicDescription, topicGoals = [], userProfile = {}) {
  const learnerName = userProfile?.name ? userProfile.name.split(" ")[0] : "there";
  
  const systemPrompt = `You are Cloop AI, a warm and engaging English Fluency Coach starting a conversational practice session.
Scenario: "${topicTitle}"
Context: "${topicDescription || 'Practical English conversation'}"
Learner: ${learnerName}

Return ONLY valid JSON with a "messages" array containing exactly 2 messages:
1. A brief topic greeting (one line, include 📚 emoji)
2. An in-character opening that sets the scene in 2-3 sentences and asks ${learnerName} one friendly opening question.

RULES:
- Do NOT include "options" or multiple-choice. The user types their own answer.
- Keep messages short and natural.
- Respond in valid JSON format.

JSON format:
{
  "messages": [
    { "message": "Let's practice ${topicTitle}! 📚", "message_type": "text" },
    { "message": "Short scene-setting + opening question for ${learnerName}...", "message_type": "text" }
  ]
}`;

  try {
    const responseText = await invokeModel(
      systemPrompt,
      [{ role: 'user', content: `Start scenario: ${topicTitle}` }],
      {
        modelId: 'deepseek-chat',
        temperature: 0.6,
        jsonFormat: true
      }
    );
    const parsed = extractJson(responseText);

    if (parsed && parsed.messages && Array.isArray(parsed.messages) && parsed.messages.length > 0) {
      for (const msg of parsed.messages) delete msg.options;
      return parsed;
    }
  } catch (err) {
    console.warn('DeepSeek greeting generation failed:', err.message);
  }

  // Static greeting fallback
  return {
    messages: [
      {
        message: `Let's practice ${topicTitle}! 📚`,
        message_type: "text"
      },
      {
        message: `Welcome, ${learnerName}! I'm your conversation partner for "${topicTitle}". How would you like to begin?`,
        message_type: "text"
      }
    ]
  };
}

module.exports = {
  generateEnglishTopicChatResponse,
  generateEnglishTopicGreeting
};

