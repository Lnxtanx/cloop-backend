const { invokeModel, extractJson } = require('../ai/deepseek-client');

/**
 * Step 3: Focused Pedagogical Dialogue Generator (The Socratic Tutor)
 *
 * Runs the second LLM call at temperature 0.4.
 * Produces 1 to 3 conversational, encouraging bubbles (max 20 words each).
 * The final bubble must always end with an answerable question or prompt.
 *
 * @param {object} params
 * @param {string} params.topicTitle
 * @param {string} params.currentGoalTitle
 * @param {string} params.studentMessage
 * @param {object} params.evaluatorResult - From Step 1
 * @param {string} params.stateInstruction - From Step 2 (instructionFor)
 * @param {string} params.lastQuestionText
 * @param {Array}  [params.recentHistory] - Last 2-3 turns for conversational flow
 * @param {string} [params.classLevel]
 * @returns {Promise<object>} { messages: Array }
 */
async function generateTutorResponse({
  topicTitle,
  currentGoalTitle,
  studentMessage,
  evaluatorResult,
  stateInstruction,
  lastQuestionText,
  recentHistory = [],
  classLevel = 'Class 10'
}) {
  // Build human-readable directive summary
  let directiveGuidance = '';
  switch (stateInstruction) {
    case 'acknowledge_and_ask_next':
      directiveGuidance = 'Validate their correct answer in 1 sentence. Then ask the next concept question.';
      break;
    case 'correct_and_reask':
      directiveGuidance = 'Acknowledge the attempt, clarify the specific misconception in 1 sentence, and re-ask an easier version of the question.';
      break;
    case 'reteach_new_angle':
      directiveGuidance = 'Switch to an intuitive everyday Indian analogy (e.g. cricket, sharing food, bicycles). Then ask a simple concept verification question.';
      break;
    case 'introduce_next_goal':
      directiveGuidance = 'Briefly connect previous learning to the new goal in 1 sentence. Ask the first question for this new goal. DO NOT GREET OR SAY HELLO!';
      break;
    case 'reask_shorter':
      directiveGuidance = 'The student acknowledged ("ok"). Re-frame the question concisely or provide 2-3 options.';
      break;
    case 'hint_then_easier':
      directiveGuidance = 'Give 1 helpful hint without giving away the full answer. Prompt them to try again.';
      break;
    case 'explain_differently':
      directiveGuidance = 'Explain the core mechanism in simple terms. Ask if they can see how it applies.';
      break;
    case 'close_off_topic':
      directiveGuidance = 'Politely suggest pausing the study session for now, and warmly invite them back when ready to study.';
      break;
    case 'wrap':
      directiveGuidance = 'Warmly celebrate their completion of this topic in 1-2 encouraging sentences!';
      break;
    case 'greet_and_ask':
      directiveGuidance = 'Welcome the student briefly to the topic in 1 sentence, and ask the opening question.';
      break;
    default:
      directiveGuidance = 'Encourage the student and ask the next progressive question.';
  }

  // Format recent chat context
  const recentTurnsText = (recentHistory || [])
    .slice(-4)
    .map(m => `${m.sender === 'user' ? 'Student' : 'Tutor'}: "${m.message}"`)
    .join('\n');

  const systemPrompt = `You are Cloop, a friendly, encouraging Socratic tutor for ${classLevel} students.
Topic: "${topicTitle}"
Current Goal: "${currentGoalTitle}"

SITUATION FOR THIS TURN:
- Last Question: "${lastQuestionText || 'Initial introduction'}"
- Student Message: "${studentMessage || 'None'}"
- Evaluation: Intent is ${evaluatorResult?.intent || 'ANSWER'}${evaluatorResult?.is_correct !== null ? `, Correct: ${evaluatorResult.is_correct}` : ''}${evaluatorResult?.error_type ? `, Error: ${evaluatorResult.error_type}` : ''}
- Directive: ${directiveGuidance}

${recentTurnsText ? `RECENT CHAT CONTEXT:\n${recentTurnsText}\n` : ''}
STRICT GENERATION RULES:
1. Produce 1 to 3 conversational message bubbles.
2. WORD LIMIT: Every single bubble MUST BE strictly under 20 words. No long paragraphs!
3. TERMINAL QUESTION: The final bubble MUST end with an answerable question or prompt for the student (ending with '?').
4. Tone: Warm, natural, and encouraging. Never use robotic phrases or exaggerated praise ("Awesome!", "Brilliant!") for basic answers. Use genuine warmth ("Spot on!", "Nice work.", "Almost!").
5. Output STRICT JSON only.

Output Schema:
{
  "messages": [
    {
      "message": "First message bubble text (under 20 words)...",
      "message_type": "text"
    },
    {
      "message": "Question bubble ending with '?' (under 20 words)",
      "message_type": "text",
      "options": [
        { "text": "Option A", "value": "A" },
        { "text": "Option B", "value": "B" }
      ] // Include options only when helpful for multiple-choice scaffolding
    }
  ]
}`;

  const messages = [
    {
      role: 'user',
      content: `Respond to the student following the directive: "${directiveGuidance}"`
    }
  ];

  try {
    const rawResponse = await invokeModel(systemPrompt, messages, {
      temperature: 0.4,
      maxTokens: 450,
      jsonFormat: true,
      featureArea: 'tutor-core',
      subFeature: 'dialogue-generator'
    });

    const parsed = extractJson(typeof rawResponse === 'string' ? rawResponse : rawResponse.text);

    if (parsed && Array.isArray(parsed.messages) && parsed.messages.length > 0) {
      return { messages: parsed.messages };
    }

    throw new Error('Tutor LLM returned invalid message array');
  } catch (error) {
    console.error('[Tutor-Core Generator] Dialogue generation failed, using fallback:', error.message);

    // Context-sensitive fallback bubbles
    const fallbackBubbles = [];

    if (stateInstruction === 'wrap') {
      fallbackBubbles.push({
        message: 'Great job completing this topic!',
        message_type: 'text'
      });
    } else if (stateInstruction === 'close_off_topic') {
      fallbackBubbles.push({
        message: "Let's pause here for now.",
        message_type: 'text'
      });
      fallbackBubbles.push({
        message: 'Come back whenever you are ready to study!',
        message_type: 'text'
      });
    } else if (evaluatorResult?.is_correct === false) {
      fallbackBubbles.push({
        message: "Nice attempt, but let's look closer.",
        message_type: 'text'
      });
      fallbackBubbles.push({
        message: `How would you explain ${currentGoalTitle.toLowerCase()} in your own words?`,
        message_type: 'text'
      });
    } else {
      fallbackBubbles.push({
        message: 'Good progress!',
        message_type: 'text'
      });
      fallbackBubbles.push({
        message: `What happens next in ${topicTitle}?`,
        message_type: 'text'
      });
    }

    return { messages: fallbackBubbles };
  }
}

module.exports = {
  generateTutorResponse
};
