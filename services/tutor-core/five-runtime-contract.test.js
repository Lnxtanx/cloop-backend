const test = require('node:test');
const assert = require('node:assert/strict');
const { persistQuestionContract } = require('./question-contract');

const rubric = { criteria: [{ id: 'cell', description: 'Identify the cell.', required: true }],
  model_answer: 'The cell is the basic structural and functional unit of life.' };
const question = 'What is the basic structural and functional unit of life?';
const seed = () => ({ phase: 'DIALOGUE', goalIndex: 0, assessmentAdvanced: false,
  lastQuestionText: question, lastQuestionOptions: null, lastQuestionType: 'open',
  lastQuestionRubric: rubric, lastQuestionRecord: { questionText: question, rubric } });

test('bad replacement clears all stale fields and waits for a real academic task', () => {
  const before = seed();
  const next = { ...before };
  persistQuestionContract(before, next, { messages: [{ message: 'Try another task?' }], questionType: 'open',
    lastQuestionRubric: null });
  for (const field of ['lastQuestionOptions', 'lastQuestionRubric', 'lastQuestionRecord']) assert.equal(next[field], null);
  assert.equal(next.lastQuestionText, '');
  assert.equal(next.lastQuestionType, 'none');
  assert.equal(next.awaitingAcademicQuestion, true);
});

test('an invalid-generation support fallback retires the previous task', () => {
  const before = seed();
  const next = { ...before };
  persistQuestionContract(before, next, { messages: [{ message: 'Let me find a clearer way to ask this.' }],
    questionType: 'none', taskRepair: true, fallbackReason: 'invalid_question_contract' });
  assert.equal(next.lastQuestionRubric, null);
  assert.equal(next.lastQuestionText, '');
  assert.equal(next.awaitingAcademicQuestion, true);
});

test('ordinary support choices preserve the pending private task', () => {
  const before = seed();
  const next = { ...before };
  persistQuestionContract(before, next, { messages: [{ message: 'Explain or try again?' }],
    questionType: 'choice', lastQuestionRubric: null });
  assert.equal(next.lastQuestionText, question);
  assert.deepEqual(next.lastQuestionRubric, rubric);
  assert.equal(next.awaitingAcademicQuestion, false);
});

test('a complete valid replacement survives retirement of the invalid old task', () => {
  const before = seed();
  const next = { ...before };
  const fresh = { criteria: [{ id: 'nucleus', description: 'Identify nucleus.', required: true }], model_answer: 'The nucleus.' };
  persistQuestionContract(before, next, { messages: [{ message: 'Which part regulates cell activities?' }],
    questionType: 'open', lastQuestionRubric: fresh }, false, true);
  assert.equal(next.lastQuestionText, 'Which part regulates cell activities?');
  assert.deepEqual(next.lastQuestionRubric, fresh);
  assert.equal(next.awaitingAcademicQuestion, false);
});

test('MCQ persistence rejects a missing key or duplicate actual answer text', () => {
  for (const options of [
    [{ text: 'Nucleus', value: 'Nucleus' }, { text: 'Tissue', value: 'Tissue' }],
    [{ text: 'Cell', value: 'Cell' }, { text: 'Cell', value: 'Cell' }],
  ]) {
    const before = seed();
    const next = { ...before };
    persistQuestionContract(before, next, { messages: [{ message: question, options }],
      questionType: 'mcq', lastQuestionRubric: { ...rubric, correct_option_text: 'Cell' } });
    assert.equal(next.lastQuestionRubric, null);
    assert.equal(next.lastQuestionOptions, null);
    assert.equal(next.awaitingAcademicQuestion, true);
  }
});

test('WRAP clears a pending task without changing the report state', () => {
  const before = seed();
  const next = { ...before, phase: 'WRAP', perGoal: [{ total: 3, correct: 2 }] };
  persistQuestionContract(before, next, { messages: [{ message: 'Session complete.' }], questionType: 'none' }, true);
  assert.equal(next.lastQuestionRubric, null);
  assert.equal(next.lastQuestionText, '');
  assert.deepEqual(next.perGoal, [{ total: 3, correct: 2 }]);
});
