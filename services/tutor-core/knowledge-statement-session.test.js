/**
 * The Scientific Inquiry session again, through the production agent, with the
 * catalog's real goal shape: every description is an objective. With knowledge
 * statements on the goals, the recap lists facts and a failed generation still
 * gets a sourced recall question, instead of "ungraded" and an incomplete report.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

let mode = 'valid';
const calls = [];
async function invokeModel(prompt, messages, options) {
  calls.push(options.subFeature);
  if (options.subFeature === 'revision-sheet') throw new Error('Offline deterministic sheet');
  if (options.subFeature === 'evaluator') {
    let ctx = {};
    try { ctx = JSON.parse(messages?.[0]?.content || '{}'); } catch (_) {}
    const ids = [...new Set([...JSON.stringify(ctx).matchAll(/"id":"([^"]+)"/g)].map(m => m[1]))];
    return JSON.stringify({ intent: 'ANSWER', criterion_results: ids.map(id => ({ id, required: true, satisfied: true, evidence: 'stated' })),
      contradictions: [], error_type: null, diff_html: null, complete_answer: null, feedback: 'Accurate.', reasoning: 'meets rubric' });
  }
  // 'invalid': the model returns an explanation with no usable question.
  return JSON.stringify({ messages: [{ message: 'An observation comes from the senses.', message_type: 'text' }], lastQuestionRubric: null });
}
for (const specifier of ['../../ai/providers', '../ai/deepseek-client']) {
  const filename = require.resolve(specifier);
  require.cache[filename] = { id: filename, filename, loaded: true, exports: { invokeModel, extractJson: JSON.parse } };
}
const inspector = require.resolve('../../ai/agents/socratic-tutor/inspector/inspector-store');
require.cache[inspector] = { id: inspector, filename: inspector, loaded: true, exports: { recordInspectorTurn: async () => {} } };
const { processTurn } = require('../../ai/agents/socratic-tutor/agent');
const S = require('../../ai/agents/socratic-tutor/state/state-machine');

const topic = { title: 'Introduction to Scientific Inquiry', content: '' };
const objectiveOnly = [
  { id: 1, title: 'Identify the core components of scientific inquiry', description: 'Students will identify the core components of scientific inquiry.' },
  { id: 2, title: 'Explain the role of curiosity and questioning', description: 'Students will explain the role of curiosity and questioning.' },
  { id: 3, title: 'Differentiate between observations and inferences', description: 'Students will differentiate between observations and inferences.' },
];
const KNOWLEDGE = [
  'Scientific inquiry includes curiosity, questioning and observation.',
  'Curiosity sparks questions that begin scientific investigations.',
  'An observation is information gathered directly through the senses or instruments; an inference is a conclusion based on observations and prior knowledge.',
];
const withKnowledge = objectiveOnly.map((g, i) => ({ ...g, knowledge_statement: KNOWLEDGE[i], knowledge_verified: false }));

const turn = (state, studentMessage, goals) => processTurn({ currentState: state, topic, goals, studentMessage,
  userProfile: { grade_level: 6, board: 'CBSE' } });
const atLastRecall = (extra = {}) => ({ ...S.initialState(3), phase: 'ROUNDUP', roundupIndex: 2, goalIndex: 2, ...extra });
test.beforeEach(() => { mode = 'valid'; calls.length = 0; });

test('recap lists every goal\'s facts even though every description is an objective', async () => {
  const state = atLastRecall({ awaitingAcademicQuestion: true, response_mode: 'task_repair' });
  let result = await turn(state, 'Ok. Give me a list of all that I have been taught.', withKnowledge);
  let text = result.messages.map(m => m.message).join(' ');
  for (let i = 0; result.nextState.supportContinuation?.length && i < 5; i++) {
    result = await turn(result.nextState, 'continue', withKnowledge);
    text += ' ' + result.messages.map(m => m.message).join(' ');
  }
  assert.match(text, /curiosity, questioning and observation/i);
  assert.match(text, /sparks questions/i);
  assert.match(text, /an inference is a conclusion/i);
  assert.doesNotMatch(text, /clearer way to ask/i);
  assert.equal(result.nextState.phase, 'ROUNDUP', 'a recap does not move the recall pointer');
  assert.equal(result.nextState.totalQuestions, 0, 'and is not graded');
});

test('the same recap without statements still has nothing to list (the gap this column closes)', async () => {
  const state = atLastRecall({ awaitingAcademicQuestion: true, response_mode: 'task_repair' });
  const result = await turn(state, 'Ok. Give me a list of all that I have been taught.', objectiveOnly);
  assert.doesNotMatch(result.messages.map(m => m.message).join(' '), /sparks questions/i);
});

test('when DeepSeek gives no usable recall question, the statement still produces a graded one', async () => {
  mode = 'invalid';
  const result = await turn(atLastRecall({ response_mode: 'check' }), 'Ok', withKnowledge);
  assert.equal(result.messages.at(-1).message, 'Define observation and inference?');
  assert.equal(result.nextState.lastQuestionRubric.criteria.length, 2);
  assert.notEqual(result.nextState.questionRepairStreak, 1, 'no repair turn is spent');

  const answered = await turn(result.nextState, 'An observation comes from the senses; an inference is a conclusion from it.', withKnowledge);
  assert.equal(answered.nextState.phase, 'WRAP');
  assert.equal(answered.masteryReport.assessments_unverified ?? 0, 0, 'every recall was actually assessed');
});
