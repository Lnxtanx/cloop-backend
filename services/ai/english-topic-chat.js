const { invokeModel, extractJson } = require('./deepseek-client');
const prisma = require('../../lib/prisma');

/**
 * English AI Topic Tutor Service
 * Interactive conversational roleplay, real-time grammar & vocabulary error correction, and goal tracking.
 */

/**
 * Build the system prompt for the English Conversational AI Tutor
 */
function buildEnglishTutorSystemPrompt({
  topicTitle,
  topicDescription,
  topicGoals,
  currentGoal,
  completedGoalsCount,
  questionsAsked,
  userResponses,
  lastQuestion,
  shouldEndSession,
  isFirstMessage,
  userMessage,
  userProfile
}) {
  if (shouldEndSession) {
    return `🎉 ALL SCENARIO GOALS COMPLETED FOR "${topicTitle}"!

Return ONLY a valid JSON object with key "message_type": "session_summary".
JSON format:
{
  "messages": [
    {
      "message": "Congratulations! You have completed all fluency goals for this scenario.",
      "message_type": "session_summary"
    }
  ]
}`;
  }

  const learnerName = userProfile?.name || "Learner";
  const targetGoal = userProfile?.study_goal || "English Fluency";
  const fluencyLevel = userProfile?.fluencyLevel || "Intermediate";
  const nativeLang = userProfile?.preferred_language || "English";

  const goalsListStr = topicGoals.map((g, i) => {
    const isCompleted = g.chat_goal_progress?.[0]?.is_completed || false;
    return `${i + 1}. "${g.title}" - ${isCompleted ? '✅ COMPLETED' : '⭕ IN PROGRESS'}`;
  }).join('\n');

  return `You are an expert English Fluency Coach and Roleplay Partner.
Learner Context:
- Name: ${learnerName}
- Target Goal: ${targetGoal}
- Current Fluency Level: ${fluencyLevel}
- Native Explanation Language: ${nativeLang}

Current Scenario / Topic: "${topicTitle}"
Scenario Overview: "${topicDescription}"

Learning Objectives:
${goalsListStr}

Active Goal: "${currentGoal ? currentGoal.title : 'General Fluency Practice'}"

YOUR DUAL ROLE:
1. ROLEPLAY PARTNER: Respond naturally in character for the scenario "${topicTitle}" (e.g. interviewer, executive, barista, colleague). Ask engaging follow-up questions to keep the conversation flowing.
2. LIVE GRAMMAR & FLUENCY TUTOR: Evaluate the user's latest response "${userMessage}" for grammar, vocabulary choice, sentence structure, tone, and spelling.

RULES FOR EVALUATION & RESPONSE:
- Always output strictly valid JSON only. Do not include markdown code blocks (\`\`\`json).
- Include a "user_correction" object evaluating the user's response:
  - "diff_html": Generate HTML string showing exact edits. Use <del>red strikethrough</del> for errors or unnatural phrasing, and <ins>green underline</ins> for correct/natural phrasing. (e.g. "I <del>goes</del> <ins>went</ins> to <ins>the</ins> office yesterday.")
  - "feedback": { "is_correct": boolean, "score_percent": number (0-100), "error_type": "Grammar" | "Vocabulary" | "Structure" | "Tone" | "Spelling" | "None", "explanation": "Short 1-sentence tip explaining the fix" }
  - "complete_answer": "Complete, natural native-speaker version of what the user tried to say."
  - "emoji": "😊" if score >= 80, "😅" if 50-79, "😓" if < 50.
- Include a "messages" array containing the AI roleplay response to continue the conversation naturally:
  - "message": "In-character AI response continuing the conversation and asking the next question."
  - "message_type": "text"
  - "options": Optional array of 2-3 suggested quick response options [{ "text": "...", "value": "..." }]

JSON OUTPUT SCHEMA:
{
  "user_correction": {
    "diff_html": "I <del>goes</del> <ins>went</ins> to <ins>the</ins> office.",
    "complete_answer": "I went to the office yesterday.",
    "emoji": "😅",
    "feedback": {
      "is_correct": false,
      "score_percent": 75,
      "error_type": "Grammar",
      "explanation": "Use past tense 'went' instead of 'goes' when talking about yesterday."
    }
  },
  "goal_status": {
    "current_goal_satisfied": boolean,
    "reason": "Brief reason"
  },
  "messages": [
    {
      "message": "AI Roleplay tutor response continuing the scenario...",
      "message_type": "text",
      "options": [
        { "text": "Option 1", "value": "Option 1" }
      ]
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
  currentGoal = null,
  topicGoals = [],
  userId = null,
  topicId = null,
  userProfile = {}
}) {
  try {
    const completedGoalsCount = topicGoals.filter(g => g.chat_goal_progress?.[0]?.is_completed).length;
    const shouldEndSession = topicGoals.length > 0 && completedGoalsCount === topicGoals.length;

    const systemPrompt = buildEnglishTutorSystemPrompt({
      topicTitle,
      topicDescription,
      topicGoals,
      currentGoal,
      completedGoalsCount,
      questionsAsked: chatHistory.length,
      userResponses: chatHistory.filter(m => m.sender === 'user'),
      lastQuestion: chatHistory.filter(m => m.sender === 'ai').pop()?.message || '',
      shouldEndSession,
      isFirstMessage: chatHistory.length === 0,
      userMessage,
      userProfile
    });

    const messages = [];
    const recentHistory = chatHistory.slice(-6);
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

    if (!parsed.messages || !Array.isArray(parsed.messages)) {
      parsed.messages = [
        {
          message: parsed.message || "That's interesting! Tell me more about that.",
          message_type: "text"
        }
      ];
    }

    if (parsed.user_correction) {
      if (!parsed.user_correction.message_type) {
        parsed.user_correction.message_type = 'user_correction';
      }
      if (!parsed.user_correction.diff_html) {
        parsed.user_correction.diff_html = userMessage;
      }
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
      messages: [
        { message: "Great job! Let's keep practicing.", message_type: "text" }
      ]
    };
  }
}

/**
 * Generate initial scenario greeting (Agentic AI Tutor starts with 2 messages)
 */
async function generateEnglishTopicGreeting(topicTitle, topicDescription, topicGoals = [], userProfile = {}) {
  const learnerName = userProfile?.name ? userProfile.name.split(" ")[0] : "there";
  
  const systemPrompt = `You are an AI English Tutor initiating an interactive scenario roleplay.
Scenario Title: "${topicTitle}"
Description: "${topicDescription}"
Learner Name: ${learnerName}

Return ONLY a valid JSON object with a "messages" array containing 2 messages:
1. Message 1: Topic greeting: "Let's start ${topicTitle}! 📚"
2. Message 2: An in-character opening scenario question asking ${learnerName} the first question to start the conversation.

JSON Output Format:
{
  "messages": [
    {
      "message": "Let's start ${topicTitle}! 📚",
      "message_type": "text"
    },
    {
      "message": "In-character opening scenario question for ${learnerName}...",
      "message_type": "text",
      "options": [
        { "text": "Suggested response 1", "value": "Suggested response 1" }
      ]
    }
  ]
}`;

  try {
    const responseText = await invokeModel(systemPrompt, [{ role: 'user', content: `Start scenario: ${topicTitle}` }]);
    const parsed = extractJson(responseText);

    if (parsed && parsed.messages && Array.isArray(parsed.messages) && parsed.messages.length > 0) {
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
        message: `Welcome to "${topicTitle}"! I'm your AI roleplay partner. Could you introduce yourself and tell me what brings you here today?`,
        message_type: "text",
        options: [
          { text: "Hi! I'm excited to practice my English.", value: "Hi! I'm excited to practice my English." },
          { text: "Hello, let me introduce myself.", value: "Hello, let me introduce myself." }
        ]
      }
    ]
  };
}

module.exports = {
  generateEnglishTopicChatResponse,
  generateEnglishTopicGreeting
};
