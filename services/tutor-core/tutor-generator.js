const { invokeModel, extractJson } = require('../ai/deepseek-client');

/**
 * Step 3: Focused Pedagogical Dialogue Generator (The Socratic Tutor)
 *
 * Runs the second LLM call at temperature 0.4.
 * Produces 1 to 2 conversational, encouraging bubbles (max 20 words each).
 * Respects the server-decided questionType ('open' vs 'mcq').
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
  classLevel = 'Class 10'
}) {
  // Build human-readable directive summary
  let directiveGuidance = '';
  switch (stateInstruction) {
    case 'probe_prior_knowledge':
      directiveGuidance = 'Ask one open, friendly question to explore what the student already knows about this topic. Spark curiosity! Do not provide options; the student must write.';
      break;
    case 'teach_theory':
      directiveGuidance = 'Explain the core mechanism in 1 intuitive sentence with an everyday Indian analogy (e.g. food, sports, daily life). Then ask an open prediction question.';
      break;
    case 'state_objectives':
      directiveGuidance = 'In 1 sentence, state what the student will learn today. Ask an opening question to get started.';
      break;
    case 'open_goal_dialogue':
      directiveGuidance = 'Connect to the goal in 1 brief sentence. Ask a focused open-ended question that requires the student to write their thought.';
      break;
    case 'continue_dialogue':
      directiveGuidance = 'Validate their response in 1 sentence. Then ask the next concept question. The student must write their answer.';
      break;
    case 'assess_with_mcq':
      directiveGuidance = 'Ask a single multiple-choice question to assess this goal. Provide 2 to 4 clear options with letters (A, B, C, D).';
      break;
    case 'correct_and_reask':
      directiveGuidance = 'Acknowledge the attempt warmly, clarify the specific misconception in 1 sentence, and re-ask an easier version of the question.';
      break;
    case 'reteach_new_angle':
      directiveGuidance = 'Switch to an intuitive everyday Indian analogy (e.g. cricket, tea, bicycles). Then ask a simple concept verification question.';
      break;
    case 'reask_shorter':
      directiveGuidance = 'The student acknowledged ("ok"). Re-frame the question concisely in fewer words.';
      break;
    case 'hint_then_easier':
      directiveGuidance = 'Give 1 helpful hint without giving away the full answer. Prompt them to try again.';
      break;
    case 'explain_differently':
      directiveGuidance = 'Explain the core mechanism in simple terms. Ask if they can see how it applies.';
      break;
    case 'probe_simpler':
      directiveGuidance = 'They could not start. Ask a much simpler yes/no or one-word version of the same opening question.';
      break;
    case 'teach_theory_analogy':
      directiveGuidance = 'The first explanation did not land. Explain the same idea with a completely different everyday Indian analogy, then ask a simple check question.';
      break;
    case 'restate_objectives_simpler':
      directiveGuidance = 'Restate what they will learn today in plainer, shorter words. Ask one easy opening question they can answer in a few words.';
      break;
    case 'assess_with_mcq_simpler':
      directiveGuidance = 'Ask an easier multiple-choice question on the same goal, with only 2 clearly different options.';
      break;
    case 'give_starter':
      directiveGuidance = 'They are stuck. Give them the first half of the answer as a sentence starter and ask them to finish it, e.g. "The gas formed is ___". Never leave them with nothing to write.';
      break;
    case 'reveal_and_move_on':
      directiveGuidance = 'They are still stuck after several tries. Tell them the answer plainly in 1 sentence, warmly and without blame, then ask the next question.';
      break;
    case 'redirect_to_topic':
      directiveGuidance = 'That was off topic. Acknowledge briefly and warmly, then bring them straight back with the study question.';
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
      "message": "First conversational bubble (under 20 words)",
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

${recentTurnsText ? `RECENT CHAT CONTEXT:\n${recentTurnsText}\n` : ''}
STRICT GENERATION RULES:
1. Produce 1 or 2 conversational message bubbles (ideally 1, maximum 2). Never more than 2 bubbles.
2. WORD LIMIT: Every single bubble MUST BE strictly under 20 words. No long paragraphs!
3. TERMINAL QUESTION: ${isWrap ? 'Do NOT ask any question.' : "The final bubble MUST end with an answerable question for the student (ending with '?')."}
4. Tone: Warm, natural, and encouraging. Never use hollow robotic praise ("Awesome!", "Brilliant!"). Use genuine warmth ("Spot on!", "Nice work.", "Almost!").
5. Output STRICT JSON only.

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

    // Context-sensitive fallback bubbles
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
