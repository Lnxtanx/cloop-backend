const { invokeModel, extractJson } = require('../ai/deepseek-client');

/**
 * Step 3: Focused Pedagogical Dialogue Generator (The Socratic Tutor)
 *
 * Runs the second LLM call at temperature 0.4.
 * Produces 1 to 2 conversational, encouraging bubbles (max 20 words each).
 * Respects the server-decided questionType ('open' vs 'mcq').
 *
 * Socratic Rule: On "I don't know" or help requests, ALWAYS explain the concept
 * first in simple terms before asking the check question.
 *
 * @param {object} params
 * @param {string} params.topicTitle
 * @param {string} params.currentGoalTitle
 * @param {string} params.studentMessage
 * @param {object} params.evaluatorResult - From Step 1
 * @param {string} params.stateInstruction - From Step 2 (instructionFor)
 * @param {string} [params.questionType] - 'open' | 'mcq' | null (from questionTypeFor)
 * @param {string} [params.phase] - Current session phase
 * @param {object} [params.reportBrief] - Brief mastery metrics if in WRAP
 * @param {string} params.lastQuestionText
 * @param {Array}  [params.recentHistory] - Last 2-3 turns for conversational flow
 * @param {string} [params.classLevel]
 * @param {boolean} [params.wantsVideo] - Student explicitly requested a video
 * @returns {Promise<object>} { messages: Array }
 */
async function generateTutorResponse({
  topicTitle,
  currentGoalTitle,
  studentMessage,
  evaluatorResult,
  stateInstruction,
  questionType = 'open',
  phase = 'DIALOGUE',
  reportBrief = null,
  lastQuestionText,
  recentHistory = [],
  classLevel = 'Class 10',
  wantsVideo = false
}) {
  // Build human-readable directive summary
  let directiveGuidance = '';
  switch (stateInstruction) {
    case 'probe_prior_knowledge':
      directiveGuidance = 'Ask one open, friendly question to explore what the student already knows about this topic. Spark curiosity! Do not provide options; the student must write.';
      break;
    case 'teach_theory':
    case 'teach_theory_and_open':
      directiveGuidance = 'Acknowledge their probe answer warmly. In 1 sentence, explain the core mechanism with an everyday Indian analogy (e.g. cricket, cooking, building blocks). Then ask the first goal question.';
      break;
    case 'state_objectives':
      directiveGuidance = 'Validate their previous answer warmly (e.g. "Spot on! It has fewer electrons."). In 1 sentence, state what we will master today. Then ask an opening question.';
      break;
    case 'open_goal_dialogue':
      directiveGuidance = 'Validate their previous answer warmly. Connect to the goal in 1 brief sentence and ask a focused open concept question.';
      break;
    case 'continue_dialogue':
      directiveGuidance = 'Validate their response clearly in 1 sentence. Then ask the next concept question. The student must write their answer.';
      break;
    case 'assess_with_mcq':
      directiveGuidance = 'Acknowledge their answer warmly (e.g. "Well done!"). Then assess understanding of this goal with one clean multiple-choice question with options (A, B, C).';
      break;
    case 'correct_and_reask':
      directiveGuidance = 'Acknowledge the attempt warmly, clarify the specific misconception in 1 sentence, and re-ask an easier version of the question.';
      break;
    case 'reteach_new_angle':
      directiveGuidance = 'Switch to an intuitive everyday Indian analogy. Explain the mechanism clearly first, then ask a simple concept check question.';
      break;
    case 'reask_shorter':
      directiveGuidance = 'The student acknowledged ("ok"). Re-frame the question concisely in fewer words.';
      break;
    case 'hint_then_easier':
      directiveGuidance = 'The student is stuck. First, explain the key concept simply in 1 clear sentence with an everyday comparison. Then ask an easier check question.';
      break;
    case 'explain_differently':
      directiveGuidance = 'Directly explain the core mechanism in simple, plain terms in 1-2 sentences. Then ask what happens next.';
      break;
    case 'probe_simpler':
      directiveGuidance = 'They could not start. Ask a much simpler yes/no or one-word version of the opening question.';
      break;
    case 'teach_theory_analogy':
      directiveGuidance = 'Explain the core idea clearly using a completely different everyday analogy (e.g. traffic, train tracks, sports), then ask an intuitive check question.';
      break;
    case 'restate_objectives_simpler':
      directiveGuidance = 'In plainer words, explain what we are mastering, and ask one easy opening question.';
      break;
    case 'assess_with_mcq_simpler':
      directiveGuidance = 'Ask an easier multiple-choice question on this goal with 2 clearly distinct options (A and B).';
      break;
    case 'give_starter':
      directiveGuidance = 'Explain the core idea clearly in 1 sentence first. Then provide a sentence starter for them to complete, e.g. "This means that carbon bonds to ___".';
      break;
    case 'reveal_and_move_on':
      directiveGuidance = 'The student is stuck. Explain the answer warmly and plainly in 1 sentence so they learn it. Then ask the next question.';
      break;
    case 'redirect_to_topic':
      directiveGuidance = 'That was off topic. Acknowledge briefly and warmly, then bring them straight back with the concept question.';
      break;
    case 'close_off_topic':
      directiveGuidance = 'Politely suggest pausing the study session for now, and warmly invite them back when ready to study.';
      break;
    case 'wrap_with_report':
      directiveGuidance = reportBrief
        ? `Warmly celebrate completing the session! Mention their overall mastery is ${reportBrief.overall_mastery_percent}%${reportBrief.strongest ? `, strongest in ${reportBrief.strongest}` : ''}. Keep it under 2 encouraging sentences!`
        : 'Warmly celebrate completing this topic in 1-2 encouraging sentences!';
      break;
    case 'session_over':
      directiveGuidance = 'The session is complete. Wish the student well in their studies!';
      break;
    default:
      directiveGuidance = 'Encourage the student and ask the next progressive question.';
  }

  // Format recent chat context
  const recentTurnsText = (recentHistory || [])
    .slice(-4)
    .map(m => `${m.sender === 'user' ? 'Student' : 'Tutor'}: "${m.message}"`)
    .join('\n');

  // Dynamic schema & instruction depending strictly on questionType
  const isMcq = questionType === 'mcq';
  const isWrap = phase === 'WRAP' || phase === 'DONE';

  let schemaInstructions = '';
  if (isMcq) {
    schemaInstructions = `QUESTION FORMAT: MULTIPLE CHOICE (MCQ)
- The final bubble MUST contain a question ending with '?' AND 2 to 4 clear options.
- Schema:
{
  "messages": [
    {
      "message": "Question bubble text ending with '?' (under 20 words)",
      "message_type": "text",
      "options": [
        { "text": "Option text 1", "value": "A" },
        { "text": "Option text 2", "value": "B" },
        { "text": "Option text 3", "value": "C" }
      ]
    }
  ]
}`;
  } else if (isWrap) {
    schemaInstructions = `SESSION ENDING:
- Produce 1 encouraging closing bubble.
- Do NOT ask any questions!
- Schema:
{
  "messages": [
    {
      "message": "Closing celebratory message (under 20 words)",
      "message_type": "text"
    }
  ]
}`;
  } else {
    schemaInstructions = `QUESTION FORMAT: WRITTEN OPEN ANSWER
- The student MUST write their answer. Do NOT provide options or multiple choice buttons!
- Schema:
{
  "messages": [
    {
      "message": "First conversational/explanation bubble (under 20 words)",
      "message_type": "text"
    },
    {
      "message": "Question bubble ending with '?' (under 20 words)",
      "message_type": "text"
    }
  ]
}`;
  }

  const systemPrompt = `You are Cloop, a friendly, encouraging Socratic tutor for ${classLevel} students.
Topic: "${topicTitle}"
Current Goal: "${currentGoalTitle}"
Phase: ${phase} (${questionType ? `Question Type: ${questionType}` : 'Concluding'})

SITUATION FOR THIS TURN:
- Last Question: "${lastQuestionText || 'Initial introduction'}"
- Student Message: "${studentMessage || 'None'}"
- Evaluation: Intent is ${evaluatorResult?.intent || 'ANSWER'}${evaluatorResult?.is_correct !== null ? `, Correct: ${evaluatorResult.is_correct}` : ''}${evaluatorResult?.error_type ? `, Error: ${evaluatorResult.error_type}` : ''}
- Directive: ${directiveGuidance}
${wantsVideo ? '- SPECIAL REQUEST: Student asked for a video. In your first bubble, say: "Here is a video explaining this concept! Take a look:"' : ''}

${recentTurnsText ? `RECENT CHAT CONTEXT:\n${recentTurnsText}\n` : ''}
STRICT GENERATION RULES:
1. Produce 1 or 2 conversational message bubbles (ideally 1, maximum 2). Never more than 2 bubbles.
2. WORD LIMIT: Every single bubble MUST BE strictly under 20 words. No long paragraphs!
3. VALIDATION MANDATE: When studentMessage answers the previous question, start bubble 1 with a clear, concise validation (e.g. "Spot on, fewer electrons!", "Exactly right!"). Never ignore what the student just answered!
4. TERMINAL QUESTION: ${isWrap ? 'Do NOT ask any question.' : "The final bubble MUST end with an answerable question for the student (ending with '?')."}
5. PEDAGOGY: When the student says "I don't know" or struggles, DO NOT ask riddles. EXPLAIN THE CONCEPT FIRST simply in bubble 1, then ask in bubble 2!
6. ANTI-REPETITION: NEVER re-state the chapter overview or lesson objectives ("Today you will learn...") during mid-session turns or hints!
7. Tone: Warm, natural, and encouraging. Never robotic.
8. Output STRICT JSON only.

${schemaInstructions}`;

  const messages = [
    {
      role: 'user',
      content: `Respond following the directive: "${directiveGuidance}"`
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

    const fallbackBubbles = [];

    if (isWrap) {
      fallbackBubbles.push({
        message: 'Great job completing this topic!',
        message_type: 'text'
      });
    } else if (stateInstruction === 'close_off_topic') {
      fallbackBubbles.push({
        message: "Let's pause here for now. You can resume anytime!",
        message_type: 'text'
      });
    } else if (wantsVideo) {
      fallbackBubbles.push({
        message: "Here's a video explaining this concept! Check it out below:",
        message_type: 'text'
      });
    } else if (isMcq) {
      fallbackBubbles.push({
        message: `Which of these best describes ${currentGoalTitle}?`,
        message_type: 'text',
        options: [
          { text: 'Correct concept principle', value: 'A' },
          { text: 'Opposite effect occurs', value: 'B' }
        ]
      });
    } else {
      fallbackBubbles.push({
        message: `What do you think happens in ${currentGoalTitle}?`,
        message_type: 'text'
      });
    }

    return { messages: fallbackBubbles };
  }
}

module.exports = {
  generateTutorResponse
};
