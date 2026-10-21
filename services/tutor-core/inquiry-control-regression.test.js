const test = require('node:test');
const assert = require('node:assert/strict');
const { controlRequest, teachingRequest, requestEvaluation } = require('./learning-requests');

const exitInputs = [
  'Pls end this session', 'Please end this session', 'Please end the session.',
  'OK. Please end this lesson.', 'I got it. Pls finish this session now.',
  'Could you please end this session?', 'I would like to end this session',
  'wrap up this chat', 'exit',
];
const moveInputs = [
  'I got it. Move on', 'OK, please move on.', 'Got it. Next question.',
  'Pls skip this question', 'teach something else', 'next',
];
const academicInputs = [
  'The force stops motion.', 'I stop the ball with my foot.',
  'The reaction ends when fuel is exhausted.', 'Stop the reaction by removing heat.',
  'The motion stops at the end of the slope.', 'Please do not end this session.',
  "Don't end this session", 'Never stop this lesson.',
  'If we end this session, will I get a report?', 'How do I end this session?',
  'What does "end this session" mean?', '"End this session"', "'end this session'",
  'The instruction says: "move on".', 'We should observe before we move on.',
];

test('exact transcript exit and composite move-on commands share one parser', () => {
  for (const input of exitInputs) {
    assert.equal(controlRequest(input), 'end_session', input);
    assert.equal(teachingRequest(input), 'end_session', input);
  }
  for (const input of moveInputs) {
    assert.equal(controlRequest(input), 'move_on', input);
    assert.equal(teachingRequest(input), 'move_on', input);
  }
});

test('science answers, negations, quoted commands and conditional language are not session commands', () => {
  for (const input of academicInputs) assert.equal(controlRequest(input), null, input);
  assert.equal(teachingRequest('Ok. Give me a list of all that I have been taught.'), 'recap_topic');
  assert.equal(teachingRequest('Before we move on, give me a list of what we have covered.'), 'recap_topic');
  assert.equal(teachingRequest('Tell me everything I learned so far'), 'recap_topic');
});

test('control evaluations cannot accidentally ask the state to clarify instead of exit/move', () => {
  assert.equal(requestEvaluation('end_session').suggested_action, 'END_SESSION');
  assert.equal(requestEvaluation('move_on').suggested_action, 'MOVE_ON');
  assert.equal(requestEvaluation('recap_topic').suggested_action, 'CLARIFY_TASK');
});

for (const [label, S] of [['production', require('../../ai/agents/socratic-tutor/state/state-machine')], ['compatibility', require('./state')]]) {
  const pending = () => ({ ...S.initialState(3), phase: 'ROUNDUP', roundupIndex: 2, goalIndex: 2,
    awaitingAcademicQuestion: true, response_mode: 'task_repair' });

  test(`${label}: all transcript exit variants escape an awaiting-question recovery loop`, () => {
    for (const input of exitInputs) {
      const state = S.advance(pending(), { intent: 'ACK', answerText: input });
      assert.equal(state.phase, 'WRAP', input);
      assert.equal(state.endedReason, 'user_requested', input);
      assert.equal(state.totalQuestions, 0, input);
    }
  });

  test(`${label}: composite move-on is routed before awaiting-question guard`, () => {
    for (const input of moveInputs) {
      const state = S.advance(pending(), { intent: 'ACK', answerText: input });
      assert.equal(state.phase, 'WRAP', input);
      assert.equal(state.endedReason, 'complete', input);
      assert.equal(state.perGoal[2].assessments.ROUNDUP.outcome, 'skipped', input);
      assert.equal(state.totalQuestions, 0, input);
    }
  });

  test(`${label}: exact recap request holds the recall pointer without a failed attempt`, () => {
    const state = S.advance(pending(), { intent: 'ACK', answerText: 'Ok. Give me a list of all that I have been taught.' });
    assert.equal(state.phase, 'ROUNDUP');
    assert.equal(state.roundupIndex, 2);
    assert.equal(state.supportRequestKind, 'recap_topic');
    assert.equal(state.totalQuestions, 0);
    assert.equal(state.learning_support[state.active_learning_point_id].unsuccessful_responses, 0);
  });

  test(`${label}: negated commands and academic stopping answers never end the session`, () => {
    for (const input of academicInputs) {
      assert.notEqual(S.advance(pending(), { intent: 'ACK', answerText: input }).endedReason, 'user_requested', input);
    }
  });
}

// Test both real evaluator entry points while proving controls make no model call.
let providerCalls = 0;
for (const path of ['../ai/deepseek-client', '../../ai/providers']) {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true,
    exports: { invokeModel: async () => { providerCalls++; throw new Error('Controls must not use a provider.'); }, extractJson: JSON.parse } };
}
for (const [label, E] of [['production', require('../../ai/agents/socratic-tutor/evaluators/answer-evaluator')], ['compatibility', require('./evaluator')]]) {
  test(`${label}: exact transcript controls are intercepted without a rubric or model call`, async () => {
    for (const [input, kind] of [
      ...exitInputs.map(value => [value, 'end_session']),
      ...moveInputs.map(value => [value, 'move_on']),
      ['Ok. Give me a list of all that I have been taught.', 'recap_topic'],
    ]) {
      const before = providerCalls;
      const result = await E.evaluateStudentTurn({ studentMessage: input, phase: 'ROUNDUP',
        topicTitle: 'Introduction to Scientific Inquiry', response_mode: 'task_repair' });
      assert.equal(result.request_kind, kind, input);
      assert.equal(result.evaluation_status, 'not_applicable', input);
      assert.equal(result.is_correct, null, input);
      assert.equal(result.userCorrection, null, input);
      assert.equal(providerCalls, before, input);
      assert.equal(E.detectRequestKind(input), kind, input);
    }
  });
}
