const { invokeModel, extractJson } = require('../ai/deepseek-client');

/**
 * Snap correctness/completeness score to 0, 0.5, or 1.0
 */
function snap(n) {
  n = Number(n);
  if (isNaN(n)) return 0;
  if (n <= 0.25) return 0;
  if (n < 0.75) return 0.5;
  return 1;
}

/**
 * Classify a short/non-academic student message (RULE THREE). Returns an intent
 * string so the grader can avoid scoring non-answers as if they were attempts:
 *   ANSWER       a real academic attempt
 *   ACK          "ok" "yes" "got it" "continue" "done" "next" — agreement, not an answer
 *   HELP         "explain" "pls explain" "more detail" — request for teaching
 *   NO_ATTEMPT   "i dont know" "idk" "skip" "pass" blank
 *   GIBBERISH    mashed keys / no real words
 *   OFF_TOPIC_DISRUPTION  a real sentence but unrelated, or abuse
 */
function intentOf(answer) {
  const trimmed = (answer || '').trim();
  if (!trimmed) return 'NO_ATTEMPT';
  const lower = trimmed.toLowerCase().replace(/'/g, ''); // "i don't" and "i dont" both count
  const tl = lower.trim();

  // Pure punctuation / emoji / mashed keys → GIBBERISH
  if (!/[a-z]/i.test(trimmed)) {
    return 'GIBBERISH';
  }

  // Single/very-short agreement or nudge → ACK (never an answer).
  // The WHOLE message must be just the ack word(s) — "ok i think its friction"
  // is an ANSWER, not an ACK. Strip punctuation first so "ok!" counts as ACK.
  const stripped = tl.replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
  if (/^(ok(ay)?|k|kk|yes|ya|yeah|yep|yup|fine|sure|done|got it|gotit|hm+|mm+|next|continue|go on|thank(s)?|thx|ty)$/.test(stripped)) return 'ACK';
  // HELP — a request for teaching, not an answer. Phrases matched with a relaxed
  // boundary so "i didnt understand" / "cant understand" / "what do you mean" all hit.
  if (/^(explain|help|explain please|pls explain|please explain|help me|explain more)$/.test(stripped)
      || /\b(pls explain|please explain|explain more|explain please)\b/.test(tl)
      || /(^|[.]\s*)(how|why|what does that mean|what do you mean|whats that|meaning)\b/.test(tl)
      || /(doesnt|does not|didnt|did not|dont|do not|cant|cannot|could not|couldnt)\s+understand\b/.test(tl)
      || /(^|[.]\s*)(i am not following|i cant follow|confus(ed|ing)|lost|not clear)\b/.test(tl)) return 'HELP';
  // Genuine "I don't know" style non-attempts
  if (/(^|[.]\s*)(i dont know|no idea|idk|i dont understand|i am not sure|im not sure|guess|maybe|dunno)\b/.test(lower)) return 'NO_ATTEMPT';
  if (/^(dont know|no|nah|skip|pass|hint|help)$/.test(tl)) return 'NO_ATTEMPT';

  // Too short to be a meaningful answer (avoid scoring stray "a", "the", "so")
  if (trimmed.length < 3) return 'GIBBERISH';

  return 'ANSWER';
}

/**
 * Whether the student made a genuine academic attempt (vs. off-task chatter,
 * "I don't know", empty input, an agreement, a help request, or gibberish).
 */
function isRealAttempt(answer) {
  return intentOf(answer) === 'ANSWER';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Deterministic fallback diff_html: only produced when the student made a real attempt
 * but the grading model omitted the <del>/<ins> markup. Builds a minimal, always-valid
 * strikethrough using the corrected answer so the correction bubble always renders with
 * strike-through even if the model under-delivers. Right answers produce no markup.
 */
function buildFallbackDiffHtml(answer, isCorrect, completeAnswer, correctTerm) {
  if (isCorrect) return null;
  if (!isRealAttempt(answer)) return null;
  const shown = (answer || '').replace(/<\/?[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!shown) return null;
  const corrected = (correctTerm && correctTerm.trim())
    ? correctTerm.trim().replace(/<\/?[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    : (completeAnswer && completeAnswer.trim().replace(/<\/?[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  if (!corrected) return null;
  return `<del>${escapeHtml(shown)}</del><ins>${escapeHtml(corrected)}</ins>`;
}

/**
 * Grounded Answer Evaluation Engine
 * Evaluates student answer against reference topicContent at temperature: 0
 * Derives is_correct from rubric scores (correctness === 1 and completeness >= 0.5)
 */

// Result for a non-attempt ("I don't know", blank, off-task). diff_html and
// complete_answer are null so the frontend renders NO correction bubble and the
// tutor's re-teach bubble does the teaching. score_percent === 10 per spec.
function noAttemptResult() {
  return {
    is_correct: false,
    correctness: 0,
    completeness: 0,
    score_percent: 10,
    error_type: "Knowledge Gap",
    diff_html: null,
    complete_answer: null,
    correct_term: null
  };
}

async function gradeAnswer({ answer, question, topicTitle, topicContent }) {
  if (!answer || !answer.trim()) {
    return { ...noAttemptResult(), input_intent: 'NO_ATTEMPT' };
  }

  // RULE THREE — classify BEFORE grading. A non-ANSWER (agreement, help request,
  // "I don't know", gibberish, or pure punctuation) must NEVER be scored as a wrong
  // attempt. It produces no red bubble, no strikethrough, and no real score — the
  // tutor's re-ask / re-teach bubble carries the turn.
  const intent = intentOf(answer);
  if (intent !== 'ANSWER') {
    return { ...noAttemptResult(), input_intent: intent };
  }

  // No genuine academic attempt (e.g. "I don't know", "no idea", "idk", off-task).
  // Do NOT run the model here: a no-attempt must NOT produce any correction bubble
  // or leak the model's reasoning as a "Corrections" annotation. The tutor's re-teach
  // bubble handles the teaching instead.
  if (!isRealAttempt(answer)) {
    return { ...noAttemptResult(), input_intent: 'NO_ATTEMPT' };
  }

  const systemPrompt = `You are an EVALUATION ENGINE (not a chatbot). Grade ONE answer against the question and the reference text.
VERIFY facts (e.g., a 5-sided polygon is a pentagon, not an octagon).
Fixing spelling does NOT make a wrong fact correct.
Return STRICT JSON only. Do NOT include markdown fences.

REFERENCE (source of truth):
"""${(topicContent || '').slice(0, 3000)}"""

TOPIC: "${topicTitle || ''}"
QUESTION: "${question || ''}"

Return JSON matching this exact structure:
{
  "is_correct": boolean,
  "correctness": 0 | 0.5 | 1,
  "completeness": 0 | 0.5 | 1,
  "score_percent": number (0-100),
  "error_type": "None" | "Conceptual Error" | "Spelling Error" | "Knowledge Gap" | "Incomplete Answer",
  "diff_html": string or null,
  "complete_answer": string,
  "correct_term": string or null
}

diff_html STRICT RULES:
- It is ONLY the student's sentence re-written with in-place <del> and <ins> marks.
  Example: "<del>the snake will strave</del><ins>the snake will starve</ins>".
- It MUST NOT contain any grading commentary, explanation, feedback, or sentence
  about the answer. All explanation belongs in complete_answer, NEVER in diff_html.
- If the answer has nothing worth striking, set diff_html = null.
- Strip the original question phrasing; only annotate the student's own words.`;

  try {
    const rawText = await invokeModel(
      systemPrompt,
      [{ role: 'user', content: `STUDENT ANSWER:\n"${answer}"` }],
      { temperature: 0, maxTokens: 1024, featureArea: 'topic_chat', subFeature: 'answer_grader' }
    );

    const raw = extractJson(rawText);
    if (!raw) {
      throw new Error('Failed to extract JSON from grader response');
    }

    const c = snap(raw.correctness);
    const m = snap(raw.completeness);

    // Grounded rule: is_correct is derived from rubric, not model claim
    const isCorrect = c === 1 && m >= 0.5;

    // Only trust diff_html that is a REAL strikethrough annotation (<del>/<ins>).
    // A plain-text string here is grader commentary ("The student's answer does not
    // address...") that must NEVER surface in the "Corrections" box.
    const modelDiff = typeof raw.diff_html === 'string' && /<del>|<ins>/.test(raw.diff_html)
      ? raw.diff_html
      : null;

    return {
      is_correct: isCorrect,
      correctness: c,
      completeness: m,
      score_percent: typeof raw.score_percent === 'number' ? raw.score_percent : (isCorrect ? 100 : Math.round((c * 0.6 + m * 0.4) * 100)),
      error_type: isCorrect ? null : (raw.error_type || "Conceptual Error"),
      diff_html: modelDiff || buildFallbackDiffHtml(answer, isCorrect, raw.complete_answer, raw.correct_term),
      complete_answer: raw.complete_answer || answer,
      correct_term: raw.correct_term || null,
      input_intent: 'ANSWER'
    };
  } catch (err) {
    console.error('[answer-grader] ❌ Error grading answer:', err.message);
    // Fallback on error
    return {
      is_correct: false,
      correctness: 0.5,
      completeness: 0.5,
      score_percent: 50,
      error_type: "Conceptual Error",
      diff_html: buildFallbackDiffHtml(answer, false, null, null),
      complete_answer: answer,
      correct_term: null
    };
  }
}

module.exports = {
  gradeAnswer
};
