// Request-only turns must not be graded as answers to a pending science task.
function teachingRequest(text) {
  const value = String(text || '').trim();
  if (/^(?:please\s+|pls\s+)?explain(?:\s+(?:it|this|that|again))?[.!?]*$/i.test(value)) return 'explain_answer';
  if (/\b(?:recap|summari[sz]e|summary|revise\s+(?:all|the\s+topic))\b/i.test(value) ||
      /\b(?:list|show|give|tell)\b.{0,35}\b(?:all\s+)?(?:concepts?|definitions?|key\s+terms?)\b/i.test(value)) return 'recap_topic';
  if (/\b(?:give|show|need|want|use|with)\s+(?:(?:me|us)\s+)?(?:(?:a|an|and|another|one|some)\s+)?examples?\b/i.test(value)) return 'give_example';
  if (/\b(?:what|why)\s+do\s+you\s+mean\b|\bwhat\s+does\s+.+\s+mean\b/i.test(value)) return 'clarify_term';
  return null;
}

function requestEvaluation(kind) {
  return {
    intent: 'HELP', is_correct: null, score_percent: null, error_type: null,
    diff_html: null, complete_answer: null, feedback: null, criterion_results: [], contradictions: [],
    evaluation_status: 'not_applicable', graded_by: null, userCorrection: null,
    request_kind: kind, requestKind: kind,
    suggested_action: kind === 'explain_answer' ? 'EXPLAIN_ANSWER' : kind === 'media_request' ? 'PROVIDE_MEDIA' : 'CLARIFY_TASK',
  };
}

module.exports = { teachingRequest, requestEvaluation };
