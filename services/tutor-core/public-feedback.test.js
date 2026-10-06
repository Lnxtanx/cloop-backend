const test = require('node:test');
const assert = require('node:assert/strict');
const { publicChatProcess } = require('./public-feedback');

test('history preserves feedback while hiding pending answers, rubrics, reasoning and live scores', () => {
  const output = publicChatProcess({ id: 1, chat_id: 7, user_message: 'my answer',
    feedback: { session_state: { phase: 'ROUNDUP', lastQuestionRubric: { model_answer: 'PRIVATE ANSWER' } },
      evaluator_result: { is_correct: false, score_percent: 50, reasoning: 'PRIVATE REASONING', feedback: 'Two effects are missing.' },
      mastery_report: { overall_mastery_percent: 75 } } });
  assert.equal(output.id, 1);
  assert.equal(output.feedback.is_correct, false);
  assert.equal(output.feedback.explanation, 'Two effects are missing.');
  assert.equal(output.feedback.mastery_report, null);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE|score_percent|75|session_state|lastQuestionRubric/);
});

test('closed history can show its earned report and preserve an ungraded null verdict', () => {
  const report = { overall_mastery_percent: 67, recall_passed: false };
  const output = publicChatProcess({ feedback: { session_state: { phase: 'WRAP' },
    user_correction: { feedback: { is_correct: null, explanation: 'The evaluator was unavailable.' } },
    mastery_report: report } });
  assert.equal(output.feedback.is_correct, null);
  assert.equal(output.feedback.mastery_report, report);
  assert.equal(output.feedback.explanation, 'The evaluator was unavailable.');
});
