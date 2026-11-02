const test = require('node:test');
const assert = require('node:assert/strict');

let providerCalls = 0;
const ANSWER = 'A force is a push or pull acting on an object.';
const TOPIC = { id: 72, title: 'What is a Force?', textbook_content: ANSWER };
const GOALS = [{ id: 91, title: 'Define force', description: ANSWER }];
async function invokeModel(prompt, messages, options) {
  if (options.subFeature === 'evaluator') {
    providerCalls++;
    const data = JSON.parse(messages[0].content);
    return JSON.stringify({ intent: 'ANSWER', contradictions: [], error_type: 'Conceptual',
      criterion_results: data.rubric.criteria.map(c => ({ id: c.id, satisfied: false,
        evidence: 'The requested definition is absent.', question_requirement: data.last_question })),
      complete_answer: ANSWER, feedback: 'The answer does not identify a push or pull.' });
  }
  if (options.subFeature === 'revision-sheet') throw new Error('Offline revision fallback');
  const line = String(prompt).split('\n').find(value => value.startsWith('{"topic":'));
  const data = line ? JSON.parse(line) : {};
  if (data.response_mode === 'offer_choice') return JSON.stringify({
    messages: [{ message: 'Let us review this point.', message_type: 'text' }], lastQuestionRubric: null,
  });
  const mcq = /Question type:\s*mcq\b/.test(prompt);
  return JSON.stringify({ messages: [{ message: 'What is meant by force?', message_type: 'text',
    ...(mcq ? { options: [ANSWER, 'Force is motion.'].map(text => ({ text, value: text })) } : {}) }],
    lastQuestionRubric: { criteria: [{ id: 'definition', description: ANSWER, required: true }],
      model_answer: ANSWER, ...(mcq ? { correct_option_text: ANSWER } : {}) } });
}
for (const name of ['../ai/deepseek-client', '../../ai/providers']) {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true,
    exports: { invokeModel, extractJson: JSON.parse } };
}
const inspector = require.resolve('../../ai/agents/socratic-tutor/inspector/inspector-store');
require.cache[inspector] = { id: inspector, filename: inspector, loaded: true,
  exports: { recordInspectorTurn: async () => {} } };

const implementations = [
  ['agent', require('../../ai/agents/socratic-tutor/evaluators/answer-evaluator'),
    require('../../ai/agents/socratic-tutor/state/state-machine')],
  ['fallback', require('./evaluator'), require('./state')],
];
const { processTurn } = require('../../ai/agents/socratic-tutor/agent');
const { processTutorTurn } = require('./orchestrator');
async function turn(route, currentState, studentMessage) {
  const args = { currentState, studentMessage, topic: TOPIC, goals: GOALS, chatHistory: [],
    userProfile: { grade_level: 8, board: 'CBSE' } };
  if (route === 'agent') return processTurn(args);
  const previous = process.env.USE_LOCAL_TUTOR_CORE;
  process.env.USE_LOCAL_TUTOR_CORE = '1';
  try { return await processTutorTurn(args); }
  finally {
    if (previous === undefined) delete process.env.USE_LOCAL_TUTOR_CORE;
    else process.env.USE_LOCAL_TUTOR_CORE = previous;
  }
}
function seed(S, phase = 'DIALOGUE', key = null) {
  const options = key ? [key, 'Something else'].map(text => ({ text, value: text })) : null;
  const rubric = { criteria: [{ id: 'definition', description: ANSWER, required: true }],
    model_answer: key || ANSWER, ...(key ? { correct_option_text: key } : {}) };
  return { ...S.initialState(1), phase, lastQuestionType: key ? 'mcq' : 'open',
    lastQuestionText: 'What is meant by force?', lastQuestionOptions: options,
    lastQuestionRubric: rubric, lastQuestionRecord: { rubric, options, questionText: 'What is meant by force?' } };
}

for (const [route, E, S] of implementations) {
  test(`${route}: ROUNDUP selects its saved key without provider grading`, async () => {
    providerCalls = 0;
    const current = seed(S, 'ROUNDUP', 'Stop');
    const result = await E.evaluateStudentTurn({ phase: 'ROUNDUP', lastQuestionType: 'mcq',
      studentMessage: '1', ...current, lastQuestionOptions: current.lastQuestionOptions,
      currentGoal: GOALS[0], topicTitle: TOPIC.title });
    assert.equal(result.is_correct, true);
    assert.equal(result.graded_by, 'mcq_key');
    assert.equal(providerCalls, 0);
  });

  test(`${route}: saved written ROUNDUP ignores old MCQ options`, async () => {
    providerCalls = 0;
    const current = seed(S, 'ROUNDUP', 'Stop');
    const result = await E.evaluateStudentTurn({ ...current, lastQuestionType: 'open', studentMessage: '1',
      currentGoal: GOALS[0], topicTitle: TOPIC.title });
    assert.notEqual(result.graded_by, 'mcq_key');
    assert.equal(providerCalls, 1);
  });

  test(`${route}: first wrong still teaches naturally; existing later choice hides the correction answer`, async () => {
    const first = await turn(route, seed(S), 'WRONG');
    assert.equal(first.nextState.response_mode, 'teach');
    assert.notEqual(first.questionType, 'choice');
    const second = await turn(route, first.nextState, 'WRONG');
    assert.equal(second.nextState.response_mode, 'offer_choice');
    assert.equal(second.questionType, 'choice');
    assert.equal(second.userCorrection, null);
    assert.equal(second.evaluatorResult.complete_answer, ANSWER);
  });

  for (const key of ['Stop', 'Exit']) {
    test(`${route}: exact displayed ${key} option is an answer rather than a control command`, async () => {
      const result = await turn(route, seed(S, 'CHECK', key), key);
      assert.equal(result.evaluatorResult.graded_by, 'mcq_key');
      assert.equal(result.evaluatorResult.is_correct, true);
      assert.equal(result.nextState.totalQuestions, 1);
      assert.notEqual(result.nextState.endedReason, 'user_requested');
      assert.equal(result.nextState.phase, 'ROUNDUP');
    });
  }

  test(`${route}: explicit stop-session command still exits without grading`, async () => {
    const result = await turn(route, seed(S, 'CHECK', 'Stop'), 'Stop this session');
    assert.equal(result.nextState.phase, 'WRAP');
    assert.equal(result.masteryReport.ended_reason, 'user_requested');
    assert.equal(result.gradedThisTurn, false);
    assert.equal(result.nextState.totalQuestions, 0);
  });

  test(`${route}: ROUNDUP remains written then reasoning MCQ; both responses retain assessment evidence`, () => {
    const first = { ...seed(S, 'ROUNDUP'), includeReasoningMcq: true };
    assert.equal(S.questionTypeFor('ROUNDUP', first), 'open');
    const second = S.advance(first, { intent: 'ANSWER', correct: true });
    assert.equal(second.recallThisGoal, 1);
    assert.equal(S.questionTypeFor('ROUNDUP', second), 'mcq');
    const end = S.advance(second, { intent: 'ANSWER', correct: true });
    assert.equal(end.phase, 'WRAP');
    assert.equal(end.perGoal[0].assessments.ROUNDUP.attempts.length, 2);
    assert.equal(end.perGoal[0].total, 1, 'Existing one-slot scoring is unchanged.');
  });
}
