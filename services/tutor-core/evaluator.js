const { invokeModel, extractJson } = require('../ai/deepseek-client');

/**
 * Escape HTML special characters for safe rendering in diff_html
 */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Step 1: Evaluator Engine (Intent Classification & Semantic Grading)
 *
 * Runs a single, fast DeepSeek V3 call at temperature 0.0.
 * Determines if the message is an answer, acknowledgement, help request,
 * off-topic distraction, or gibberish. If it is an answer, it grades the
 * attempt, scores it, and generates a surgical <del>/<ins> diff.
 *
 * @param {object} params
 * @param {string} params.studentMessage - Raw text from student
 * @param {string} params.lastQuestionText - Question the tutor previously asked
 * @param {string} params.topicTitle - Topic title (e.g., "Chemical Reactions")
 * @param {string} [params.topicContent] - Optional background content of the topic
 * @param {object} params.currentGoal - { id, title, description }
 * @param {number} params.goalIndex - Current 0-based goal index
 * @param {number} params.totalGoals - Total goals in topic
 * @param {string} [params.classLevel] - Class level (e.g. "Class 10 CBSE")
 * @returns {Promise<object>} EvaluatorResult
 */
async function evaluateStudentTurn({
  studentMessage,
  lastQuestionText,
  topicTitle,
  topicContent = '',
  currentGoal,
  goalIndex = 0,
  totalGoals = 1,
  classLevel = 'Class 10'
}) {
  const trimmed = (studentMessage || '').trim();

  // Instant fallback for completely empty input
  if (!trimmed) {
    return {
      intent: 'HELP_REQUEST',
      is_correct: null,
      score_percent: null,
      error_type: null,
      diff_html: null,
      complete_answer: null,
      suggested_action: 'GIVE_HINT',
      reasoning: 'Empty student message received'
    };
  }

  const systemPrompt = `You are Cloop's Academic Evaluator Engine for ${classLevel}.
Analyze the student's message with high accuracy, classify their intent, grade their answer against the target concept, and output clean, structured JSON.

TOPIC: ${topicTitle}
CURRENT GOAL: ${currentGoal?.title || 'Core Concept'} (Goal ${goalIndex + 1} of ${totalGoals})
LAST QUESTION ASKED BY TUTOR: "${lastQuestionText || 'Initial introduction'}"
${currentGoal?.description ? `GOAL DESCRIPTION: ${currentGoal.description}` : ''}
${topicContent ? `TOPIC SUMMARY: ${topicContent.substring(0, 300)}...` : ''}

INTENT CLASSIFICATION RULES:
- "ANSWER": ANY attempt to answer the question, including single digits ("2", "3"), option letters ("A", "b"), single words ("covalent", "friction"), formulas, or full sentences. Never classify short answers or numbers as GIBBERISH!
- "ACK": Student acknowledges without answering (e.g. "ok", "okay", "got it", "continue", "next", "yes", "understood").
- "HELP_REQUEST": Student expresses confusion or asks for help (e.g. "explain", "i don't understand", "idk", "give me a hint", "what does that mean?").
- "OFF_TOPIC": Student says something unrelated to the topic or asks conversational small talk (e.g. "who made you?", "what is your favorite game?").
- "GIBBERISH": Pure keyboard smash or random noise (e.g. "asdfghjk", "zzz12345!@#").

GRADING RULES (Only evaluate when intent is "ANSWER"):
- If the student grasped the core intuition even with minor phrasing or spelling issues: is_correct = true, score_percent >= 80.
- If incorrect, incomplete, or contains conceptual errors: is_correct = false, score_percent < 70.
- When is_correct is false, ALWAYS provide diff_html using <del>student error</del><ins>correct text</ins>. Keep the correction surgical and under 15 words.
- When is_correct is true, diff_html MUST be null.

Output STRICT JSON matching this schema:
{
  "intent": "ANSWER" | "ACK" | "HELP_REQUEST" | "OFF_TOPIC" | "GIBBERISH",
  "is_correct": boolean | null,
  "score_percent": number | null,
  "error_type": "Conceptual" | "Factual" | "Incomplete" | "Spelling" | "Calculation" | null,
  "diff_html": string | null,
  "complete_answer": string | null,
  "suggested_action": "MOVE_ON" | "RETEACH_NEW_ANGLE" | "GIVE_HINT" | "SIMPLIFY" | "HANDLE_OFF_TOPIC" | "REASK",
  "reasoning": string
}`;

  const messages = [
    {
      role: 'user',
      content: `STUDENT MESSAGE: "${trimmed}"`
    }
  ];

  try {
    const rawResponse = await invokeModel(systemPrompt, messages, {
      temperature: 0.0,
      maxTokens: 800,
      jsonFormat: true,
      featureArea: 'tutor-core',
      subFeature: 'evaluator'
    });

    const parsed = extractJson(typeof rawResponse === 'string' ? rawResponse : rawResponse.text);

    if (!parsed || !parsed.intent) {
      throw new Error('Invalid or missing evaluator JSON response');
    }

    // Sanitize intent
    const validIntents = ['ANSWER', 'ACK', 'HELP_REQUEST', 'OFF_TOPIC', 'GIBBERISH'];
    const intent = validIntents.includes(parsed.intent) ? parsed.intent : 'ANSWER';

    const result = {
      intent,
      is_correct: intent === 'ANSWER' ? Boolean(parsed.is_correct) : null,
      score_percent: intent === 'ANSWER' && typeof parsed.score_percent === 'number' ? Math.max(0, Math.min(100, parsed.score_percent)) : null,
      error_type: intent === 'ANSWER' && !parsed.is_correct ? (parsed.error_type || 'Conceptual') : null,
      diff_html: intent === 'ANSWER' && !parsed.is_correct ? (parsed.diff_html || null) : null,
      complete_answer: parsed.complete_answer || null,
      suggested_action: parsed.suggested_action || (intent === 'ANSWER' ? (parsed.is_correct ? 'MOVE_ON' : 'RETEACH_NEW_ANGLE') : 'REASK'),
      reasoning: parsed.reasoning || ''
    };

    // Strikethrough Fallback Guard: If wrong but diff_html was omitted, guarantee a clean diff
    if (result.intent === 'ANSWER' && result.is_correct === false && !result.diff_html) {
      const safeTarget = result.complete_answer || 'the correct answer';
      result.diff_html = `<del>${escapeHtml(trimmed)}</del><ins>${escapeHtml(safeTarget)}</ins>`;
    }

    return result;
  } catch (error) {
    console.error('[Tutor-Core Evaluator] Evaluation failed, using safe fallback:', error.message);

    // Resilient fallback logic
    const lower = trimmed.toLowerCase();
    let fallbackIntent = 'ANSWER';
    if (/^(ok(ay)?|k|got it|continue|next|yes)$/.test(lower)) fallbackIntent = 'ACK';
    else if (/^(help|explain|idk|i don'?t know)$/.test(lower)) fallbackIntent = 'HELP_REQUEST';

    return {
      intent: fallbackIntent,
      is_correct: fallbackIntent === 'ANSWER' ? true : null, // Default to encouraging on network error
      score_percent: fallbackIntent === 'ANSWER' ? 75 : null,
      error_type: null,
      diff_html: null,
      complete_answer: null,
      suggested_action: fallbackIntent === 'ANSWER' ? 'MOVE_ON' : 'REASK',
      reasoning: 'Fallback generated due to evaluator error: ' + error.message
    };
  }
}

module.exports = {
  evaluateStudentTurn,
  escapeHtml
};
