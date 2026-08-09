const { invokeModel, extractJson } = require('./deepseek-client');
const prisma = require('../../lib/prisma');

/**
 * English AI Topic Tutor Service
 * Agentic conversational roleplay with real-time grammar correction.
 * AI sets its own teaching goals, tracks progress, and decides when to end.
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
  const fluencyLevel = userProfile?.fluencyLevel || "Intermediate";

  const goalsListStr = topicGoals.map((g, i) => {
    const done = g.is_completed ? '✅' : '⭕';
    return `${done} ${i + 1}. "${g.title}"`;
  }).join('\n');

  const turnInfo = `Turn ${turnNumber} of approximately ${totalTurns}.`;
  const isNearEnd = turnNumber >= totalTurns - 2;
  const shouldEnd = turnNumber >= totalTurns;

  let endingInstruction = '';
  if (shouldEnd) {
    endingInstruction = `
⚠️ THIS IS THE FINAL TURN. You MUST end the scenario now.
Set "session_ended": true and provide a brief session summary in your message.
Mention what ${learnerName} did well and one area to improve.`;
  } else if (isNearEnd) {
    endingInstruction = `
⚠️ The session is ending soon (${totalTurns - turnNumber} turns left).
Start wrapping up the conversation naturally. Begin steering toward a closing.`;
  }

  return `You are an expert English Fluency Coach and Roleplay Partner for "${topicTitle}".

LEARNER: ${learnerName} (Level: ${fluencyLevel})
SCENARIO: "${topicTitle}" — ${topicDescription || 'English conversational practice'}
${turnInfo}
${endingInstruction}

LEARNING GOALS FOR THIS SCENARIO:
${goalsListStr}

YOUR DUAL ROLE:
1. ROLEPLAY PARTNER: Stay in character for "${topicTitle}". Respond naturally as the scenario character (interviewer, colleague, barista, etc). Ask ONE clear follow-up question to continue the conversation.
2. GRAMMAR TUTOR: Evaluate the user's message for grammar, vocabulary, spelling, and sentence structure errors.

CRITICAL RULES:
- Keep your roleplay response SHORT (2-3 sentences max + 1 question). Do NOT write paragraphs.
- Do NOT provide multiple-choice options. The user must type their own answer.
- Always output ONLY valid JSON. No markdown code fences.
- Evaluate EVERY user message for errors, even small ones.

JSON OUTPUT FORMAT:
{
  "user_correction": {
    "diff_html": "HTML with <del>errors</del> and <ins>corrections</ins>",
    "complete_answer": "The fully corrected natural sentence",
    "emoji": "😊 if score>=80, 😅 if 50-79, 😓 if <50",
    "feedback": {
      "is_correct": true/false,
      "score_percent": 0-100,
      "error_type": "Grammar|Vocabulary|Spelling|Structure|Tone|None",
      "explanation": "One short sentence explaining the fix"
    }
  },
  "goal_status": {
    "goals_completed": ["Goal title 1", "Goal title 2"],
    "all_goals_done": false
  },
  "session_ended": false,
  "messages": [
    {
      "message": "Short in-character response (2-3 sentences) + one follow-up question",
      "message_type": "text"
    }
  ]
}`;
}

/**
 * Main AI function to evaluate user response and generate English tutor response
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
  try {
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

    const responseText = await invokeModel(
      systemPrompt,
      messages,
      {
        temperature: 0.7,
        userId,
        featureArea: 'english_tutor_chat',
        subFeature: 'eval_turn'
      }
    );

    const parsed = extractJson(responseText);

    if (!parsed) {
      throw new Error('Failed to parse JSON response from AI model');
    }

    // Ensure messages array exists
    if (!parsed.messages || !Array.isArray(parsed.messages)) {
      parsed.messages = [
        {
          message: parsed.message || "That's interesting! Tell me more.",
          message_type: "text"
        }
      ];
    }

    // Strip any options the AI may have included
    for (const msg of parsed.messages) {
      delete msg.options;
    }

    // Ensure user_correction exists
    if (!parsed.user_correction) {
      parsed.user_correction = {
        diff_html: userMessage,
        complete_answer: userMessage,
        emoji: '😊',
        feedback: { is_correct: true, score_percent: 100, error_type: 'None', explanation: 'Good job!' }
      };
    }

    if (!parsed.user_correction.diff_html) {
      parsed.user_correction.diff_html = userMessage;
    }

    // Ensure session_ended flag
    if (typeof parsed.session_ended !== 'boolean') {
      parsed.session_ended = turnNumber >= totalTurns;
    }

    return parsed;
  } catch (error) {
    console.error('❌ Error generating English topic chat response:', error);
    return {
      user_correction: {
        diff_html: userMessage,
        complete_answer: userMessage,
        emoji: '😊',
        feedback: { is_correct: true, score_percent: 100, error_type: 'None', explanation: 'Good effort!' }
      },
      session_ended: false,
      messages: [
        { message: "Great! Let's keep practicing. Tell me more about that.", message_type: "text" }
      ]
    };
  }
}

/**
 * Generate initial scenario greeting (AI starts the conversation)
 */
async function generateEnglishTopicGreeting(topicTitle, topicDescription, topicGoals = [], userProfile = {}) {
  const learnerName = userProfile?.name ? userProfile.name.split(" ")[0] : "there";
  
  const systemPrompt = `You are an AI English Tutor starting an interactive scenario roleplay.
Scenario: "${topicTitle}"
Description: "${topicDescription}"
Learner: ${learnerName}

Return ONLY valid JSON with a "messages" array containing exactly 2 messages:
1. A brief topic greeting (one line, include 📚 emoji)
2. An in-character opening that sets the scene in 2-3 sentences and asks ${learnerName} one opening question.

RULES:
- Do NOT include "options" or multiple-choice. The user types their own answer.
- Keep messages short and natural.
- No markdown code fences.

JSON format:
{
  "messages": [
    { "message": "Let's start ${topicTitle}! 📚", "message_type": "text" },
    { "message": "Short scene-setting + question for ${learnerName}...", "message_type": "text" }
  ]
}`;

  try {
    const responseText = await invokeModel(systemPrompt, [{ role: 'user', content: `Start scenario: ${topicTitle}` }]);
    const parsed = extractJson(responseText);

    if (parsed && parsed.messages && Array.isArray(parsed.messages) && parsed.messages.length > 0) {
      // Strip any options the AI may have included
      for (const msg of parsed.messages) {
        delete msg.options;
      }
      return parsed;
    }
  } catch (err) {
    console.error('Error generating English topic greeting:', err);
  }

  return {
    messages: [
      {
        message: `Let's start ${topicTitle}! 📚`,
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
