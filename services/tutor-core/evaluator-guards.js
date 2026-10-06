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
 * A language label alone is not evidence that the concept is right. Credit
 * requires satisfied semantic criteria, without contradictory content.
 */
const LANGUAGE_ONLY_ERRORS = new Set([
  'spelling', 'grammar', 'language', 'typo', 'phrasing', 'wording',
  'syntax', 'punctuation', 'capitalisation', 'capitalization', 'tense',
]);

/**
 * Remove English penalties without inventing a correct concept verdict.
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

  const criteria = Array.isArray(result.criterion_results) ? result.criterion_results : [];
  const hasContradictions = Array.isArray(result.contradictions) && result.contradictions.length > 0;
  const hasContentFaults = Array.isArray(result.content_faults) && result.content_faults.length > 0;
  const semanticFailure = criteria.some(c => c && c.required !== false && c.satisfied === false);
  if (semanticFailure || hasContradictions || hasContentFaults) {
    return { ...result, error_type: hasContradictions || hasContentFaults ? 'Conceptual' : 'Incomplete' };
  }

  const contentProven = criteria.length > 0 &&
    criteria.every(c => c && typeof c.satisfied === 'boolean') &&
    criteria.filter(c => c.required !== false).length > 0 &&
    criteria.filter(c => c.required !== false).every(c => c.satisfied === true) &&
    Array.isArray(result.contradictions) && result.evaluation_status !== 'unavailable';

  if (!contentProven) return {
    ...result,
    is_correct: null,
    score_percent: null,
    error_type: null,
    diff_html: null,
    evaluation_status: 'unavailable',
    suggested_action: 'REASK',
    feedback: 'This answer needs a concept check before it can be graded.',
    reasoning: 'A language-only error label provides no verified content verdict.',
  };

  return {
    ...result,
    is_correct: true,
    score_percent: Math.round(100 * criteria.filter(c => c.satisfied).length / criteria.length),
    error_type: null,
    diff_html: null,
    suggested_action: 'MOVE_ON',
    reasoning: 'The semantic criteria are satisfied; English is not graded.',
  };
}

module.exports = { applyGradingGuards, LANGUAGE_ONLY_ERRORS };
