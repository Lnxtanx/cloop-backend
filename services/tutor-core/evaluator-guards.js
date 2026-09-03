/**
 * Deterministic guards applied to the evaluator's verdict.
 *
 * The evaluator is a language model, so its grading rules are requests. These
 * are the ones the server enforces afterwards, and they live in their own
 * module — with no network client and no configuration — so they can be tested
 * directly and cheaply.
 */

/**
 * Error categories that describe the student's English, not their science.
 *
 * A live session marked "It is increase" wrong — red strikethrough, crying
 * emoji — for an answer that had the concept exactly right. The evaluator
 * prompt now forbids that, but a prompt is a request. This is the enforcement:
 * a wrong verdict whose stated reason is the wording is not a wrong answer,
 * and it is turned back into a right one before it can reach the student.
 */
const LANGUAGE_ONLY_ERRORS = new Set([
  'spelling', 'grammar', 'language', 'typo', 'phrasing', 'wording',
  'syntax', 'punctuation', 'capitalisation', 'capitalization', 'tense',
]);

/**
 * Reverse a verdict that penalised the student's English.
 *
 * Returns the result unchanged in every other case, so a genuinely wrong
 * answer is still marked wrong and still gets its correction.
 *
 * @param {object} result - an evaluator result
 * @returns {object} the result, with a language-only verdict corrected
 */
function applyGradingGuards(result) {
  if (!result || result.intent !== 'ANSWER' || result.is_correct !== false) return result;

  const reason = String(result.error_type || '').trim().toLowerCase();
  if (!LANGUAGE_ONLY_ERRORS.has(reason)) return result;

  return {
    ...result,
    is_correct: true,
    score_percent: Math.max(80, result.score_percent || 0),
    error_type: null,
    diff_html: null,
    suggested_action: 'MOVE_ON',
    reasoning: `${result.reasoning || ''} [guard: "${reason}" is a language fault, not a content fault — verdict corrected to right]`.trim(),
  };
}

module.exports = { applyGradingGuards, LANGUAGE_ONLY_ERRORS };
