// Session commands are parsed once, before grading and before recovery guards.
// Match an actual short imperative, not a keyword inside a science answer.
function commandClauses(text) {
  return String(text || '').trim().replace(/[’]/g, "'")
    .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, ' ')
    .split(/[.!?;\n]+/)
    .map(clause => {
      let value = clause.trim();
      if (/^'[^']*'$/.test(value)) return '';
      for (let i = 0; i < 4; i++) {
        const next = value
          .replace(/^(?:ok(?:ay)?|yes|got it|i got it|i(?:'ve| have) got it|i understand|understood|thanks|thank you|alright)\b[\s,:—-]*/i, '')
          .replace(/^(?:(?:please|pls|plz|kindly)\s+|(?:can|could|would)\s+(?:you|we)\s+)/i, '')
          .replace(/[,\s]+(?:please|pls|plz)$/i, '').trim();
        if (next === value) break;
        value = next;
      }
      return value;
    }).filter(Boolean);
}

function controlRequest(text) {
  for (const value of commandClauses(text)) {
    // A lesson/session noun is required for "stop/end", so "stop motion"
    // and "end the reaction" remain academic answers.
    if (/^(?:(?:end|finish|close|stop)\s+(?:(?:the|this|my|our)\s+)?(?:session|chat|class|lesson)(?:\s+(?:now|here|for me))?|(?:stop|wrap\s+up|finish|end)\s+(?:here|now)|let's\s+(?:stop|wrap\s+up|finish|end)(?:\s+(?:here|now))?|wrap\s+up(?:\s+(?:(?:the|this|my|our)\s+)?(?:session|chat|class|lesson))?|i\s+(?:want|would\s+like)\s+to\s+(?:stop|quit|leave|exit|end)(?:\s+(?:(?:the|this|my|our)\s+)?(?:session|chat|lesson|now|here))?|quit|exit|khatam\s+karo)$/i.test(value)) return 'end_session';
    if (/^(?:next(?:\s+(?:question|topic))?|move\s+on|proceed|skip(?:\s+(?:(?:the|this)\s+)?(?:question|topic|one))?|teach\s+(?:me\s+)?something\s+(?:else|elase)|(?:a\s+)?different\s+topic|(?:i(?:'m| am)\s+)?not\s+in\s+(?:the\s+)?mood)$/i.test(value)) return 'move_on';
  }
  return null;
}

// Request-only turns must not be graded as answers to a pending science task.
function teachingRequest(text) {
  const value = String(text || '').trim();
  const control = controlRequest(value);
  if (control) return control;
  if (/^(?:please\s+|pls\s+)?explain(?:\s+(?:it|this|that|again))?[.!?]*$/i.test(value)) return 'explain_answer';
  if (/\b(?:recap|summari[sz]e|summary|revise\s+(?:all|the\s+topic))\b/i.test(value) ||
      /\b(?:list|show|give|tell)\b.{0,70}\b(?:all\s+)?(?:concepts?|definitions?|key\s+terms?)\b/i.test(value) ||
      /\b(?:list|show|give|tell|summari[sz]e|review)\b.{0,100}\b(?:taught|learn(?:ed|t)|covered|so\s+far)\b/i.test(value)) return 'recap_topic';
  if (/\b(?:give|show|need|want|use|with)\s+(?:(?:me|us)\s+)?(?:(?:a|an|and|another|one|some)\s+)?examples?\b/i.test(value)) return 'give_example';
  if (/\b(?:what|why)\s+do\s+you\s+mean\b|\bwhat\s+does\s+.+\s+mean\b/i.test(value)) return 'clarify_term';
  return null;
}

function requestEvaluation(kind) {
  const action = { end_session: 'END_SESSION', move_on: 'MOVE_ON', try_again: 'RETRY',
    explain_answer: 'EXPLAIN_ANSWER', media_request: 'PROVIDE_MEDIA' }[kind] || 'CLARIFY_TASK';
  return {
    intent: ['end_session', 'move_on', 'try_again'].includes(kind) ? 'ACK' : 'HELP', is_correct: null, score_percent: null, error_type: null,
    diff_html: null, complete_answer: null, feedback: null, criterion_results: [], contradictions: [],
    evaluation_status: 'not_applicable', graded_by: null, userCorrection: null,
    request_kind: kind, requestKind: kind,
    suggested_action: action,
  };
}

module.exports = { teachingRequest, requestEvaluation, controlRequest };
