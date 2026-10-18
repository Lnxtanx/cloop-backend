/**
 * Socratic Tutor Intent Evaluator
 * High-speed classification of student intent and explicit pedagogical requests.
 */

const CLARIFICATION_PATTERN = /^(which|what)\s+(box|ball|car|object|one|goal(\s*\d+)?|diagram|step|cart|sponge|block)\b|\bwhat\s+(is|do\s+you\s+mean\s+by)\s+goal\s*\d*\b|\bwhich\s+one\s+(do\s+you\s+mean|is\s+that)\b|\b(clarify|explain)\s+(the\s+)?(question|wording|scenario)\b|\bcan\s+you\s+clarify\b/i;

const REQUEST_KIND_PATTERNS = Object.freeze({
  explain_answer: /^(?:(?:please\s+)?tell\s+me\s+(?:the\s+)?answer|explain\s+(?:the\s+)?answer|what\s+is\s+the\s+answer|just\s+tell\s+me(?:\s+the\s+)?answer|show\s+(?:me\s+)?(?:the\s+)?answer|give\s+(?:me\s+)?(?:the\s+)?answer|reveal\s+(?:the\s+)?answer)\b/i,
  try_again: /^(?:another\s+(?:try|chance|attempt)|let\s+me\s+try(?:\s+again)?|try\s+again|one\s+more\s+(?:try|chance)|i(?:'ll|\s+will)\s+try(?:\s+again)?|retry|give\s+me\s+another\s+(?:try|chance)|let\s+me\s+have\s+another\s+go)\b/i,
  move_on: /^(?:teach\s+something\s+else|next\s+topic|move\s+on|skip(?:\s+this)?|next\s+question|different\s+topic)\b/i,
  clarify_task: CLARIFICATION_PATTERN,
});

const IDK_PATTERNS = /^(?:i\s*don['’]?t\s*know|no\s*idea|have\s+no\s+idea|idk|not\s*sure|don['’]?t\s*know|have\s*no\s*clue|dunno)\b/i;
const HELP_PATTERNS = /^(?:help|help\s*me|give\s*(?:me\s*)?a?\s*hint|hint|hint\s*please)\b/i;

/**
 * Detect explicit learning request kind
 *
 * @param {string} text - User message
 * @param {Object} context - Optional state context
 * @returns {string|null} 'explain_answer' | 'try_again' | 'move_on' | 'clarify_task' | null
 */
function detectRequestKind(text, context = {}) {
  const clean = String(text || '').trim();
  if (!clean) return null;

  const isAwaitingChoice = Boolean(context.awaiting_learning_choice || context.response_mode === 'offer_choice');
  if (isAwaitingChoice) {
    if (/^(?:explain(?:\s+(?:the\s+)?answer)?|option\s*1|first\s+(?:one|option)|1|yes\s+explain|explanation|show\s+answer)\b/i.test(clean)) {
      return 'explain_answer';
    }
    if (/^(?:(?:another\s+)?try(?:\s+again)?|option\s*2|second\s+(?:one|option)|2|let\s+me\s+try|retry)\b/i.test(clean)) {
      return 'try_again';
    }
  }

  if (REQUEST_KIND_PATTERNS.explain_answer.test(clean)) return 'explain_answer';
  if (REQUEST_KIND_PATTERNS.try_again.test(clean)) return 'try_again';
  if (REQUEST_KIND_PATTERNS.move_on.test(clean)) return 'move_on';
  if (REQUEST_KIND_PATTERNS.clarify_task.test(clean)) return 'clarify_task';

  return null;
}

/**
 * Rapid heuristic intent classification
 *
 * @param {string} text
 * @returns {string|null} 'IDK' | 'HELP' | 'MOVE_ON' | 'CLARIFICATION' | null
 */
function detectFastIntent(text) {
  const clean = String(text || '').trim();
  if (!clean) return 'ACK';

  if (IDK_PATTERNS.test(clean)) return 'IDK';
  if (HELP_PATTERNS.test(clean)) return 'HELP';
  if (REQUEST_KIND_PATTERNS.move_on.test(clean)) return 'MOVE_ON';
  if (CLARIFICATION_PATTERN.test(clean)) return 'CLARIFICATION';

  return null;
}

module.exports = {
  detectRequestKind,
  detectFastIntent,
  REQUEST_KIND_PATTERNS,
  CLARIFICATION_PATTERN,
  IDK_PATTERNS,
  HELP_PATTERNS,
};
