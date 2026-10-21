const test = require('node:test');
const assert = require('node:assert/strict');

const QUESTION = 'Explain what an observation is, what an inference is, and give one example of each?';
const RUBRIC = {
  criteria: [
    { id: 'observation_definition', description: 'Observation is directly gathered information.', required: true },
    { id: 'inference_definition', description: 'Inference is an evidence-based interpretation.', required: true },
    { id: 'observation_example', description: 'Give an example of directly observed information.', required: true },
    { id: 'inference_example', description: 'Give an interpretation supported by observations.', required: true },
  ],
  model_answer: 'An observation is directly gathered information; an inference is a conclusion based on observations.',
};
const topic = { title: 'Introduction to Scientific Inquiry', content: '' };
const goals = [
  { id: 1, title: 'Core components of scientific inquiry', description: 'Students will identify core components of scientific inquiry.' },
  { id: 2, title: 'Role of curiosity and questioning', description: 'Students will describe the role of curiosity and questioning.' },
  { id: 3, title: 'Observations and inferences', description: 'Students will distinguish observations and inferences and give examples.' },
];
let mode = 'valid';
const calls = [];
async function invokeModel(prompt, messages, options) {
  calls.push(options.subFeature);
  if (options.subFeature === 'revision-sheet') throw new Error('Offline deterministic sheet');
  if (options.subFeature === 'evaluator') return JSON.stringify({ intent: 'ACK', criterion_results: [], contradictions: [], error_type: null });
  if (mode === 'invalid') return JSON.stringify({ messages: [{ message: 'An observation comes directly from information we gather.', message_type: 'text' }], lastQuestionRubric: null });
  const line = prompt.split('\n').find(value => value.startsWith('{"topic":'));
  const data = JSON.parse(line);
  if (['explain', 'task_repair'].includes(data.response_mode)) return JSON.stringify({
    messages: [{ message: 'An observation is directly gathered information; an inference is an evidence-based conclusion.', message_type: 'text' }], lastQuestionRubric: null,
  });
  return JSON.stringify({ messages: [{ message: QUESTION, message_type: 'text' }], lastQuestionRubric: RUBRIC });
}
for (const specifier of ['../../ai/providers', '../ai/deepseek-client']) {
  const filename = require.resolve(specifier);
  require.cache[filename] = { id: filename, filename, loaded: true, exports: { invokeModel, extractJson: JSON.parse } };
}
const inspector = require.resolve('../../ai/agents/socratic-tutor/inspector/inspector-store');
require.cache[inspector] = { id: inspector, filename: inspector, loaded: true, exports: { recordInspectorTurn: async () => {} } };
const { processTurn } = require('../../ai/agents/socratic-tutor/agent');
const S = require('../../ai/agents/socratic-tutor/state/state-machine');
function seeded() {
  return { ...S.initialState(3), phase: 'ROUNDUP', roundupIndex: 2, goalIndex: 2,
    awaitingAcademicQuestion: true, response_mode: 'task_repair', assessmentAdvanced: false };
}
function turn(state, studentMessage, customGoals = goals) {
  return processTurn({ currentState: state, topic, goals: customGoals, studentMessage,
    userProfile: { grade_level: 6, board: 'CBSE' } });
}
test.beforeEach(() => { mode = 'valid'; calls.length = 0; });

test('the exact objective-only last-recall setup retains a valid generated task instead of looping explanations', async () => {
  const result = await turn(seeded(), 'Yes');
  assert.equal(result.questionType, 'open');
  assert.equal(result.messages.at(-1).message, QUESTION);
  assert.equal(result.nextState.awaitingAcademicQuestion, false);
  assert.equal(result.nextState.lastQuestionRubric.criteria.length, 4);
});

test('repeated acknowledgements cannot produce the observed endless final-goal lecture loop', async () => {
  let result = await turn(seeded(), 'Yes');
  for (const answer of ['Yes', 'Ok', 'Correct', 'Got it', 'Ok got it']) {
    if (['WRAP', 'DONE'].includes(result.nextState.phase)) break;
    result = await turn(result.nextState, answer);
  }
  assert.equal(result.nextState.phase, 'WRAP');
  assert.equal(result.masteryReport.incorrect_answers, 0);
  assert.equal(result.masteryReport.mastery_confirmed, false);
  assert.ok(result.revisionSheet);
});

test('an invalid generator is bounded: two repairs, then an unverified item and report after acknowledgement', async () => {
  mode = 'invalid';
  const first = await turn(seeded(), 'Yes');
  assert.equal(first.nextState.questionRepairStreak, 1);
  const second = await turn(first.nextState, 'Ok');
  assert.equal(second.nextState.pendingAdvanceAfterExplanation, true);
  assert.equal(second.nextState.awaitingAcademicQuestion, false);
  assert.match(second.messages[0].message, /ungraded/);
  const end = await turn(second.nextState, 'Ok');
  assert.equal(end.nextState.phase, 'WRAP');
  assert.equal(end.masteryReport.total_questions, 0);
  assert.equal(end.masteryReport.incorrect_answers, 0);
  assert.equal(end.masteryReport.assessments_unverified, 1);
  assert.ok(end.revisionSheet);
});

for (const phrase of ['Pls end this session', 'Please end this session', 'Ok, please stop this lesson']) {
  test(`exact exit request works during the broken-question recovery: ${phrase}`, async () => {
    mode = 'invalid';
    const result = await turn(seeded(), phrase);
    assert.equal(result.nextState.phase, 'WRAP');
    assert.equal(result.masteryReport.ended_reason, 'user_requested');
    assert.ok(!calls.includes('evaluator'));
    assert.ok(!calls.includes('dialogue-generator'));
    assert.ok(result.revisionSheet);
  });
}

test('I got it. Move on advances the held recall pointer without grading the command', async () => {
  const state = { ...seeded(), roundupIndex: 1 };
  const result = await turn(state, 'I got it. Move on');
  assert.equal(result.nextState.roundupIndex, 2);
  assert.equal(result.nextState.totalQuestions, 0);
  assert.ok(!calls.includes('evaluator'));
});

test('the exact list-of-what-taught request gives the recap instead of a ball question', async () => {
  const factual = [
    { ...goals[0], description: 'Scientific inquiry includes observation, curiosity and questioning.' },
    { ...goals[1], description: 'Curiosity motivates questions that can be investigated.' },
    { ...goals[2], description: 'An observation is directly gathered information; An inference is an evidence-based conclusion.' },
  ];
  let result = await turn(seeded(), 'Ok. Give me a list of all that I have been taught.', factual);
  let text = result.messages.map(m => m.message).join(' ');
  for (let i = 0; result.nextState.supportContinuation.length && i < 5; i++) {
    result = await turn(result.nextState, 'continue', factual);
    text += ' ' + result.messages.map(m => m.message).join(' ');
  }
  assert.match(text, /curiosity/i);
  assert.match(text, /observation is directly/i);
  assert.match(text, /inference is an evidence-based/i);
  assert.doesNotMatch(text, /cricket ball/i);
  assert.equal(result.nextState.phase, 'ROUNDUP');
  assert.equal(result.nextState.totalQuestions, 0);
  assert.ok(!calls.includes('evaluator'));
});
