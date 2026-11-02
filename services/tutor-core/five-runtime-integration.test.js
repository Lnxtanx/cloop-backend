/** Both actual tutor routes; provider and inspector I/O are stubbed. */
const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
let badGeneration = false;
const ANSWER = 'A force is a push or pull acting on an object.';
const TOPIC = { id: 741, title: 'What Is a Force?', content: ANSWER, textbook_content: ANSWER };
const GOALS = [{ id: 51, title: 'Define force', description: ANSWER }];

function turnData(prompt) {
  const line = String(prompt).split('\n').find(value => value.startsWith('{"topic":'));
  assert.ok(line, 'Structured turn data is supplied to the generator.');
  return JSON.parse(line);
}
async function invokeModel(prompt, messages, config) {
  calls.push(config.subFeature);
  if (config.subFeature === 'revision-sheet') throw new Error('Offline revision fallback.');
  if (config.subFeature === 'evaluator') {
    const data = JSON.parse(messages[0].content);
    const intent = /^(?:ok|okay|yes|got it)$/i.test(data.student_answer) ? 'ACK' : 'ANSWER';
    const wrong = data.student_answer === 'WRONG';
    return JSON.stringify({ intent,
      criterion_results: intent === 'ANSWER' ? data.rubric.criteria.map(item => ({
        id: item.id, satisfied: !wrong, evidence: wrong ? 'No push or pull is identified.' : data.student_answer,
        question_requirement: data.last_question,
      })) : [], contradictions: [], error_type: wrong ? 'Conceptual' : null,
      complete_answer: data.rubric?.model_answer || ANSWER,
      feedback: wrong ? 'Consider the push or pull between the objects.' : null });
  }
  assert.equal(config.subFeature, 'dialogue-generator');
  const data = turnData(prompt);
  if (data.response_mode === 'offer_choice') return JSON.stringify({
    messages: [{ message: 'Would you like me to explain the answer, or would you like another try?', message_type: 'text' }],
    lastQuestionRubric: null,
  });
  if (['explain', 'task_repair'].includes(data.response_mode)) return JSON.stringify({
    messages: [{ message: ANSWER, message_type: 'text' }], lastQuestionRubric: null,
  });
  if (badGeneration) return JSON.stringify({ messages: [], lastQuestionRubric: null });
  const mcq = /Question type:\s*mcq\b/i.test(prompt);
  return JSON.stringify({
    messages: [{ message: mcq ? 'Which statement correctly defines force?' : 'What is meant by force?', message_type: 'text',
      ...(mcq ? { options: [ANSWER, 'Force is stored inside a moving object.', 'Force means change in position.']
        .map(text => ({ text, value: text })) } : {}) }],
    lastQuestionRubric: { criteria: [{ id: 'definition', description: ANSWER, required: true }],
      model_answer: ANSWER, ...(mcq ? { correct_option_text: ANSWER } : {}) },
  });
}
for (const name of ['../../ai/providers', '../ai/deepseek-client']) {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports: { invokeModel, extractJson: JSON.parse } };
}
const inspector = require.resolve('../../ai/agents/socratic-tutor/inspector/inspector-store');
require.cache[inspector] = { id: inspector, filename: inspector, loaded: true,
  exports: { recordInspectorTurn: async () => {} } };

const { processTurn } = require('../../ai/agents/socratic-tutor/agent');
const { processTutorTurn } = require('./orchestrator');
const STATES = { agent: require('../../ai/agents/socratic-tutor/state/state-machine'), fallback: require('./state') };

function seed(route, phase = 'DIALOGUE') {
  const rubric = { criteria: [{ id: 'definition', description: ANSWER, required: true }], model_answer: ANSWER };
  return { ...STATES[route].initialState(1), phase, includeReasoningMcq: true,
    lastQuestionText: 'What is meant by force?', lastQuestionType: 'open', lastQuestionOptions: null,
    lastQuestionRubric: rubric, lastQuestionRecord: { questionId: 'initial-definition',
      questionText: 'What is meant by force?', rubric, options: null,
      learning_point_id: `goal_0_${phase.toLowerCase()}` } };
}
async function turn(route, currentState, studentMessage, overrides = {}) {
  const params = { currentState, studentMessage, topic: TOPIC, goals: GOALS,
    chatHistory: [], userProfile: { grade_level: 8, board: 'CBSE' }, ...overrides };
  if (route === 'agent') return processTurn(params);
  const previous = process.env.USE_LOCAL_TUTOR_CORE;
  process.env.USE_LOCAL_TUTOR_CORE = '1';
  try { return await processTutorTurn(params); }
  finally { if (previous === undefined) delete process.env.USE_LOCAL_TUTOR_CORE; else process.env.USE_LOCAL_TUTOR_CORE = previous; }
}
test.beforeEach(() => { calls.length = 0; badGeneration = false; });

for (const route of ['agent', 'fallback']) {
  test(`${route}: an ungrounded bad generation cannot carry the previous goal's private contract forward`, async () => {
    const initial = STATES[route].initialState(2);
    const state = { ...seed(route, 'CHECK'), goalTotal: 2, perGoal: initial.perGoal,
      teachingCoverage: initial.teachingCoverage };
    const goals = [GOALS[0], { id: 52, title: 'Identify cell structures',
      description: 'Students will identify cell structures.' }];
    badGeneration = true;
    const result = await turn(route, state, ANSWER, {
      goals, topic: { id: TOPIC.id, title: TOPIC.title, content: '' },
    });
    assert.equal(result.nextState.goalIndex, 1);
    assert.equal(result.questionType, 'none');
    assert.equal(result.nextState.lastQuestionText, '');
    assert.equal(result.nextState.lastQuestionRubric, null);
    assert.equal(result.nextState.lastQuestionOptions, null);
    assert.equal(result.nextState.lastQuestionRecord, null);
    assert.equal(result.nextState.awaitingAcademicQuestion, true);
  });

  test(`${route}: first error retains a natural teaching hint; second error offers support without revealing the answer`, async () => {
    const first = await turn(route, seed(route), 'WRONG');
    assert.equal(first.nextState.response_mode, 'teach');
    assert.notEqual(first.questionType, 'choice');
    assert.equal(first.nextState.totalQuestions, 1);
    assert.equal(first.nextState.learning_support[first.nextState.active_learning_point_id].unsuccessful_responses, 1);
    const second = await turn(route, first.nextState, 'WRONG');
    assert.equal(second.nextState.response_mode, 'offer_choice');
    assert.equal(second.questionType, 'choice');
    assert.equal(second.userCorrection, null, 'Choice UI must not reveal the private answer before another try.');
    assert.equal(second.evaluatorResult.complete_answer, ANSWER, 'Private evaluator evidence remains available.');
    assert.equal(second.nextState.totalQuestions, 1, 'Retries retain the existing scoring policy.');
  });

  test(`${route}: written-first ROUNDUP and reasoning MCQ preserve both evidence turns and closing artifacts`, async () => {
    const dialogue = await turn(route, seed(route), ANSWER);
    assert.equal(dialogue.nextState.phase, 'CHECK');
    const checked = await turn(route, dialogue.nextState, ANSWER);
    assert.equal(checked.nextState.phase, 'ROUNDUP');
    assert.equal(checked.nextState.recallThisGoal, 0);
    assert.equal(checked.questionType, 'open');
    assert.equal(checked.messages.at(-1).options, undefined);
    const recalled = await turn(route, checked.nextState, ANSWER);
    assert.equal(recalled.nextState.phase, 'ROUNDUP');
    assert.equal(recalled.nextState.recallThisGoal, 1);
    assert.equal(recalled.questionType, 'mcq');
    const options = recalled.messages.at(-1).options;
    assert.ok(Array.isArray(options) && options.length >= 2);
    assert.deepEqual(options, recalled.nextState.lastQuestionOptions);
    const keyIndex = options.findIndex(option => option.text === recalled.nextState.lastQuestionRubric.correct_option_text);
    assert.ok(keyIndex >= 0);
    const evaluatorCalls = calls.filter(name => name === 'evaluator').length;
    const wrapped = await turn(route, recalled.nextState, String.fromCharCode(65 + keyIndex));
    assert.equal(wrapped.evaluatorResult.graded_by, 'mcq_key');
    assert.equal(calls.filter(name => name === 'evaluator').length, evaluatorCalls);
    assert.equal(wrapped.nextState.phase, 'WRAP');
    const slot = wrapped.nextState.perGoal[0].assessments.ROUNDUP;
    assert.equal(slot.attempts.length, 2, 'Both ROUNDUP turns remain recorded in the original shared assessment slot.');
    assert.equal(wrapped.masteryReport.total_questions, 3);
    assert.equal(wrapped.masteryReport.correct_answers, 3);
    assert.equal(wrapped.masteryReport.goals_completed, 1);
    assert.equal(wrapped.masteryReport.overall_mastery_percent, 100);
    assert.ok(wrapped.revisionSheet);
    assert.ok(wrapped.attachments.includes('revision_sheet'));
    assert.ok(wrapped.attachments.includes('mastery_report'));
    const before = calls.length;
    const done = await turn(route, wrapped.nextState, 'ok');
    assert.equal(done.nextState.phase, 'DONE');
    assert.equal(calls.length, before);
  });

  test(`${route}: a saved Stop answer is academic while an explicit session exit remains a command`, async () => {
    const state = seed(route, 'CHECK');
    const options = ['Start', 'Stop', 'Turn'].map(text => ({ text, value: text }));
    const rubric = { criteria: [{ id: 'effect', description: 'Identify stopping motion.', required: true }],
      model_answer: 'Stop', correct_option_text: 'Stop' };
    Object.assign(state, { lastQuestionText: 'A goalkeeper catches a moving ball. What is the effect of force?',
      lastQuestionType: 'mcq', lastQuestionOptions: options, lastQuestionRubric: rubric,
      lastQuestionRecord: { questionId: 'stop-effect', options, rubric, learning_point_id: 'goal_0_check' } });
    const answered = await turn(route, state, 'Stop');
    assert.equal(answered.evaluatorResult.graded_by, 'mcq_key');
    assert.equal(answered.evaluatorResult.is_correct, true);
    assert.equal(answered.nextState.phase, 'ROUNDUP');
    assert.notEqual(answered.nextState.endedReason, 'user_requested');
    const before = calls.filter(name => name === 'evaluator').length;
    const ended = await turn(route, state, 'Stop this session');
    assert.equal(ended.nextState.phase, 'WRAP');
    assert.equal(ended.masteryReport.ended_reason, 'user_requested');
    assert.equal(ended.gradedThisTurn, false);
    assert.equal(calls.filter(name => name === 'evaluator').length, before);
  });
}
