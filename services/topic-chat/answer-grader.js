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
 * Assert whether the student made a genuine academic attempt (vs. off-task chatter,
 * "I don't know", or empty input). Used to decide whether diff_html should be produced.
 */
function isRealAttempt(answer) {
  const trimmed = (answer || '').trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase().replace(/'/g, ''); // "i don't" and "i dont" both count
  if (/(^|[.]\s*)(i dont know|no idea|idk|i dont understand|i am not sure|im not sure|guess|maybe|dunno)\b/.test(lower)) return false;
  if (/^(dont know|no|nah|skip|pass|help|hint|next)$/.test(lower)) return false;
  if (trimmed.length < 3) return false;
  if (!/[a-z]/i.test(trimmed)) return false;
  return true;
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
    return noAttemptResult();
  }

  // No genuine academic attempt (e.g. "I don't know", "no idea", "idk", off-task).
  // Do NOT run the model here: a no-attempt must NOT produce any correction bubble
  // or leak the model's reasoning as a "Corrections" annotation. The tutor's re-teach
  // bubble handles the teaching instead.
  if (!isRealAttempt(answer)) {
    return noAttemptResult();
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
}`;

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

    return {
      is_correct: isCorrect,
      correctness: c,
      completeness: m,
      score_percent: typeof raw.score_percent === 'number' ? raw.score_percent : (isCorrect ? 100 : Math.round((c * 0.6 + m * 0.4) * 100)),
      error_type: isCorrect ? null : (raw.error_type || "Conceptual Error"),
      diff_html: raw.diff_html || buildFallbackDiffHtml(answer, isCorrect, raw.complete_answer, raw.correct_term),
      complete_answer: raw.complete_answer || answer,
      correct_term: raw.correct_term || null
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
