/** History serialization must not reveal a pending rubric/key or internal scores. */
function publicChatProcess(process) {
  const internal = process.feedback || {};
  const correction = internal.user_correction?.feedback || {};
  const evaluation = internal.evaluator_result || {};
  const closed = ['WRAP', 'DONE'].includes(internal.session_state?.phase);
  return {
    id: process.id, chat_id: process.chat_id, user_message: process.user_message,
    corrected_message: process.corrected_message, ai_response: process.ai_response,
    created_at: process.created_at, updated_at: process.updated_at,
    feedback: {
      is_correct: correction.is_correct ?? evaluation.is_correct ?? null,
      error_type: correction.error_type || evaluation.error_type || null,
      explanation: correction.explanation || evaluation.feedback || null,
      mastery_report: closed ? internal.mastery_report || null : null,
    },
  };
}
module.exports = { publicChatProcess };
