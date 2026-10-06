const test = require('node:test');
const assert = require('node:assert/strict');

const modelPath = require.resolve('../ai/deepseek-client');
let response;
let failure;
let lastPrompt;
require.cache[modelPath] = {
  id: modelPath, filename: modelPath, loaded: true,
  exports: {
    invokeModel: async (prompt) => { lastPrompt = prompt; if (failure) throw failure; return response; },
    extractJson: JSON.parse
  }
};
const { generateTutorResponse, buildTutorPrompt, guidanceFor } = require('./tutor-generator');

const rubric = { criteria: [{ id: 'direction', description: 'Force can change direction', required: true }], model_answer: 'Force can change direction' };
const params = {
  topicTitle: 'Effects of force', currentGoalTitle: 'Change of shape',
  currentGoalDescription: 'A force can change shape; stretching, compressing and bending are shape changes',
  previousGoalTitle: 'Change of direction', previousGoalDescription: 'A force can change direction',
  lastQuestionText: 'What does hitting a moving ball sideways change?', lastQuestionRubric: rubric,
  phase: 'DIALOGUE', questionType: 'open', stateInstruction: 'open_goal_dialogue',
  studentMessage: 'friction', evaluatorResult: { intent: 'ANSWER', is_correct: false, complete_answer: 'Force can change direction' },
  sameAssessment: false
};

function reset() { failure = null; response = ''; }

test('generated question retains its private grading rubric', async () => {
  reset();
  response = JSON.stringify({ messages: [{ message: 'What happens when a sponge is squeezed?', message_type: 'text' }], lastQuestionRubric: { criteria: [{ id: 'shape', description: 'Its shape changes', required: true }], model_answer: 'Its shape changes' } });
  const out = await generateTutorResponse(params);
  assert.strictEqual(out.lastQuestionRubric.model_answer, 'Its shape changes');
  assert.ok(lastPrompt.includes('"is_correct":false'));
  assert.ok(lastPrompt.includes('"previous_goal":{"title":"Change of direction"'));
  assert.ok(lastPrompt.includes('"next_goal":{"title":"Change of shape"'));
  assert.ok(lastPrompt.includes('NEVER say "Exactly right"'));
});

test('roundup requires complete uncoached recall and separate factual criteria', () => {
  const prompt = buildTutorPrompt({ ...params, phase: 'ROUNDUP', stateInstruction: 'roundup_recall' });
  assert.ok(prompt.includes('ALL distinct required core facts'));
  assert.ok(prompt.includes('do not leak the current recall answer'));
  assert.ok(prompt.includes('A one-word answer to one component does not satisfy a multi-part rubric'));
  assert.ok(prompt.includes('If same_assessment is false, assistance directives apply only to the prior answer'));
  assert.ok(!prompt.includes('start bubble 1 with a clear, concise validation'));
});

test('an initial turn has neutral evaluation instead of an invented answer verdict', () => {
  const prompt = buildTutorPrompt({ ...params, evaluatorResult: undefined, studentMessage: '' });
  assert.ok(prompt.includes('"intent":"NONE","is_correct":null'));
});

test('a failed new question generates grounded recall rather than a dummy MCQ', async () => {
  reset(); failure = new Error('model unavailable');
  const out = await generateTutorResponse({ ...params, phase: 'CHECK', questionType: 'mcq', stateInstruction: 'assess_with_mcq' });
  assert.strictEqual(out.fallbackQuestionType, 'open');
  assert.ok(out.messages.at(-1).message.includes('Change of shape'));
  assert.strictEqual(out.messages.at(-1).options, undefined);
  assert.strictEqual(out.lastQuestionRubric.criteria.length, 2);
  assert.ok(!JSON.stringify(out).includes('Correct concept principle'));
});

test('failed retry repeats the actual pending assessment and explains its stored answer first', async () => {
  reset(); failure = new Error('model unavailable');
  const out = await generateTutorResponse({ ...params, sameAssessment: true, stateInstruction: 'hint_then_easier' });
  assert.strictEqual(out.messages[0].message, 'Force can change direction');
  assert.strictEqual(out.messages.at(-1).message, params.lastQuestionText);
  assert.deepStrictEqual(out.lastQuestionRubric, rubric);
});

test('failed new roundup does not leak a definition before asking recall', async () => {
  reset(); failure = new Error('model unavailable');
  const out = await generateTutorResponse({ ...params, phase: 'ROUNDUP', stateInstruction: 'hint_then_easier', sameAssessment: false });
  assert.strictEqual(out.messages.length, 1);
  assert.ok(out.messages[0].message.includes('Change of shape'));
});

test('failed roundup retry teaches first while retaining the complete pending question', async () => {
  reset(); failure = new Error('model unavailable');
  const out = await generateTutorResponse({ ...params, phase: 'ROUNDUP', stateInstruction: 'hint_then_easier', sameAssessment: true });
  assert.strictEqual(out.messages.length, 2);
  assert.strictEqual(out.messages[0].message, 'Force can change direction');
  assert.strictEqual(out.messages.at(-1).message, params.lastQuestionText);
  assert.deepStrictEqual(out.lastQuestionRubric, rubric);
});

test('missing rubric is treated as a generation failure', async () => {
  reset(); response = JSON.stringify({ messages: [{ message: 'What happens to the ball?' }] });
  const out = await generateTutorResponse(params);
  assert.strictEqual(out.fallbackQuestionType, 'open');
  assert.strictEqual(out.lastQuestionRubric.model_answer, params.currentGoalDescription);
});

test('early wrap language does not celebrate full completion or confirmed mastery', async () => {
  reset(); failure = new Error('model unavailable');
  const reportBrief = { overall_mastery_percent: 40, ended_reason: 'turn_limit', session_completed: false, recall_completed: false };
  const out = await generateTutorResponse({ ...params, phase: 'WRAP', stateInstruction: 'wrap_with_report', reportBrief });
  assert.strictEqual(out.lastQuestionRubric, null);
  assert.ok(!/great job|finished|completed|mastery/i.test(out.messages[0].message));
  const guidance = guidanceFor('wrap_with_report', reportBrief);
  assert.ok(guidance.includes('40%'));
  assert.ok(guidance.includes('Do not claim all goals achieved'));
});

test('fallback teaching searches stored facts when the preferred answer exceeds the bubble limit', async () => {
  reset(); failure = new Error('model unavailable');
  const longAnswer = 'A force applied to a moving object can change several properties of that object depending on the size and direction of the force acting upon it.';
  const out = await generateTutorResponse({ ...params, sameAssessment: true, stateInstruction: 'hint_then_easier',
    evaluatorResult: { ...params.evaluatorResult, complete_answer: longAnswer },
    lastQuestionRubric: { ...rubric, model_answer: longAnswer },
    previousGoalDescription: 'A force can change direction; a sideways push can turn a moving ball' });
  assert.strictEqual(out.messages[0].message, 'A force can change direction');
  assert.strictEqual(out.messages.at(-1).message, params.lastQuestionText);
});
