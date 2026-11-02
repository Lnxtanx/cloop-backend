const test = require('node:test');
const assert = require('node:assert/strict');

const answer = 'A force is a push or pull.';
const question = 'Which statement correctly defines force?';
const options = [answer, 'Force is stored inside moving objects.', 'Force is change in position.']
  .map(text => ({ text, value: text }));
const rubric = { criteria: [{ id: 'definition', description: answer, required: true }],
  model_answer: answer, correct_option_text: answer };
const raw = () => ({ messages: [{ message: question, options }], lastQuestionRubric: rubric });

for (const filename of ['./validate', '../../ai/agents/socratic-tutor/formatters/bubble-formatter']) {
  const V = require(filename);

  test(`${filename}: existing reasoning ROUNDUP MCQ retains its options and exact private key`, () => {
    const out = V.enforce(raw(), { phase: 'ROUNDUP', questionType: 'mcq', shuffleOptions: true,
      currentGoalTitle: 'Define force', currentGoalDescription: `${answer} Forces act between objects.` });
    assert.equal(out.questionType, 'mcq');
    assert.equal(out.messages.at(-1).message, question);
    assert.deepEqual(new Set(out.messages.at(-1).options.map(item => item.text)), new Set(options.map(item => item.text)));
    assert.equal(out.lastQuestionRubric.correct_option_text, answer);
    assert.deepEqual(out.questionRecord.options, out.messages.at(-1).options);
  });

  test(`${filename}: replay keeps saved ROUNDUP button order even if provider sends a different order`, () => {
    const saved = [options[2], options[0], options[1]];
    const out = V.enforce(raw(), { phase: 'ROUNDUP', questionType: 'mcq', shuffleOptions: true,
      sameAssessment: true, lastQuestionText: question, lastQuestionOptions: saved, lastQuestionRubric: rubric });
    assert.deepEqual(out.messages.at(-1).options, saved);
    assert.equal(out.lastQuestionRubric.correct_option_text, answer);
  });

  test(`${filename}: CHECK retry retains the existing pending task and saved order`, () => {
    const saved = [options[1], options[2], options[0]];
    const out = V.enforce(raw(), { phase: 'CHECK', questionType: 'mcq', shuffleOptions: true,
      sameAssessment: true, lastQuestionText: question, lastQuestionOptions: saved, lastQuestionRubric: rubric });
    assert.deepEqual(out.messages.at(-1).options, saved);
    assert.equal(out.messages.at(-1).message, question);
  });

  test(`${filename}: missing source and rubric cause ungraded repair, never a question-as-answer rubric`, () => {
    const out = V.enforce({ messages: [{ message: 'Which part controls the cell?' }] }, {
      phase: 'DIALOGUE', questionType: 'open', currentGoalTitle: 'Identify cell structures',
      currentGoalDescription: 'Students will identify cell structures.' });
    assert.equal(out.questionType, 'none');
    assert.equal(out.lastQuestionRubric, null);
    assert.equal(out.fallbackReason, 'invalid_question_contract');
  });

  test(`${filename}: a changed open question without a rubric cannot inherit the old answer`, () => {
    const out = V.enforce({ messages: [{ message: 'Which part controls the cell?' }] }, {
      phase: 'DIALOGUE', questionType: 'open', sameAssessment: true,
      lastQuestionText: 'What is force?', lastQuestionRubric: rubric });
    assert.equal(out.questionType, 'none');
    assert.equal(out.lastQuestionRubric, null);
    assert.equal(out.fallbackReason, 'invalid_question_contract');
  });
}
