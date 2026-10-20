/**
 * Actual production Socratic agent, with only external provider/inspector I/O stubbed.
 * These tests deliberately bypass the compatibility orchestrator's stub detector.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
function turnData(prompt) {
  const line = prompt.split('\n').find(value => value.startsWith('{"topic":'));
  assert.ok(line, 'Generator supplied a structured turn context');
  return JSON.parse(line);
}
const TOPIC = { id: 713, title: 'What Is a Force?', content: 'A force is a push or pull acting on an object. Objects exert force on one another. A force can start or stop motion.' };
const GOALS = [
  { id: 201, title: 'Define force', description: 'A force is a push or pull acting on an object.' },
  { id: 202, title: 'Identify interacting objects', description: 'Objects exert force on one another through interactions.' },
  { id: 203, title: 'Describe effects of force', description: 'A force can start or stop motion.' },
];
function questionFor(goal) {
  if (/interacting/.test(goal.title)) return { question: 'Which objects interact when your hand pushes a ball?', answer: 'Your hand and the ball interact.' };
  if (/effects/.test(goal.title)) return { question: 'What can a force do to motion?', answer: GOALS[2].description };
  return { question: 'What is meant by force?', answer: GOALS[0].description };
}
async function invokeModel(prompt, messages, options) {
  calls.push({ prompt, messages, options });
  if (options.subFeature === 'revision-sheet') throw new Error('Revision outage exercises deterministic fallback.');
  if (options.subFeature === 'evaluator') {
    const data = JSON.parse(messages[0].content);
    const answer = data.student_answer;
    const intent = /^(?:i don[’']?t know|idk|don[’']?t know)$/i.test(answer) ? 'IDK'
      : /^(?:ok|okay|got it)$/i.test(answer) ? 'ACK' : 'ANSWER';
    const wrong = answer === 'WRONG';
    const hidden = answer === 'UNFAIR_RUBRIC';
    return JSON.stringify({
      intent,
      criterion_results: intent === 'ANSWER' ? data.rubric.criteria.map((criterion, i) => ({
        id: criterion.id, satisfied: !(wrong || (hidden && i === 0)),
        evidence: wrong || hidden ? 'The requested content is absent.' : answer,
        question_requirement: hidden && i === 0 ? null : data.last_question,
      })) : [],
      contradictions: [], error_type: wrong ? 'Incomplete' : null,
      diff_html: null, complete_answer: data.rubric.model_answer,
      feedback: wrong ? 'Add the requested fact.' : null,
    });
  }
  assert.equal(options.subFeature, 'dialogue-generator');
  const data = turnData(prompt);
  if (data.response_mode === 'offer_choice') return JSON.stringify({
    messages: [{ message: 'Would you like me to explain the answer, or would you like another try?', message_type: 'text' }],
    lastQuestionRubric: null,
  });
  if (['explain', 'task_repair'].includes(data.response_mode)) return JSON.stringify({
    messages: [{ message: 'A force is a push or pull acting on an object.', message_type: 'text' },
      { message: 'An effect means the change caused by that force, such as starting or stopping motion.', message_type: 'text' }],
    lastQuestionRubric: null,
  });
  const item = questionFor(data.next_goal);
  const isMcq = /Question type: mcq\./.test(prompt);
  const teaching = data.previous_evaluation.intent === 'IDK';
  return JSON.stringify({
    messages: [
      { message: teaching ? 'A force is a push or pull acting on an object.' : item.answer, message_type: 'text' },
      { message: teaching ? 'Is pushing a door an example of force?' : item.question, message_type: 'text',
        ...(isMcq ? { options: [{ text: item.answer, value: item.answer }, { text: 'Objects never interact.', value: 'Objects never interact.' }] } : {}) },
    ],
    lastQuestionRubric: { criteria: [{ id: 'fact_1', description: item.answer, required: true }], model_answer: item.answer,
      ...(isMcq ? { correct_option_text: item.answer } : {}) },
  });
}
for (const specifier of ['../../ai/providers', '../ai/deepseek-client']) {
  const filename = require.resolve(specifier);
  require.cache[filename] = { id: filename, filename, loaded: true, exports: { invokeModel, extractJson: JSON.parse } };
}
const inspectorPath = require.resolve('../../ai/agents/socratic-tutor/inspector/inspector-store');
require.cache[inspectorPath] = { id: inspectorPath, filename: inspectorPath, loaded: true, exports: { recordInspectorTurn: async () => {} } };

const { processTurn } = require('../../ai/agents/socratic-tutor/agent');
const S = require('../../ai/agents/socratic-tutor/state/state-machine');
function seeded(phase = 'DIALOGUE') {
  const state = { ...S.initialState(GOALS.length), phase };
  const item = questionFor(GOALS[0]);
  state.lastQuestionText = item.question;
  state.lastQuestionRubric = { criteria: [{ id: 'fact_1', description: item.answer, required: true }], model_answer: item.answer };
  state.lastQuestionRecord = { questionId: 'force-definition', questionText: item.question, rubric: state.lastQuestionRubric,
    learning_point_id: `goal_0_${phase.toLowerCase()}` };
  return state;
}
async function turn(state, studentMessage, history = []) {
  return processTurn({ currentState: state, studentMessage, topic: TOPIC, goals: GOALS, chatHistory: history,
    userProfile: { grade_level: 6, board: 'CBSE' } });
}

test('active agent: all three goals still pass DIALOGUE/CHECK/ROUNDUP before reports, sheet and stars', async () => {
  let result = await turn(null, '');
  const phases = [result.nextState.phase];
  for (let i = 0; i < 30 && result.nextState.phase !== 'WRAP'; i++) {
    assert.equal(result.masteryReport, null);
    assert.ok(result.nextState.lastQuestionRubric, `Pending academic task in ${result.nextState.phase}`);
    const answer = result.nextState.lastQuestionRubric.correct_option_text || result.nextState.lastQuestionRubric.model_answer;
    result = await turn(result.nextState, answer);
    phases.push(result.nextState.phase);
  }
  assert.equal(result.nextState.phase, 'WRAP');
  assert.equal(phases.filter(phase => phase === 'ROUNDUP').length, 3);
  assert.equal(result.masteryReport.total_questions, 9);
  assert.equal(result.masteryReport.correct_answers, 9);
  assert.equal(result.masteryReport.overall_mastery_percent, 100);
  assert.equal(result.masteryReport.star_rating, 5);
  assert.equal(result.masteryReport.recall_completed, true);
  assert.equal(result.masteryReport.goals_completed, 3);
  assert.equal(result.all_goals_completed, true);
  assert.ok(result.revisionSheet.key_concepts.length >= 3);
  assert.ok(result.attachments.includes('revision_sheet'));
  const before = calls.length;
  const done = await turn(result.nextState, 'ok');
  assert.equal(done.nextState.phase, 'DONE');
  assert.equal(calls.length, before, 'DONE reuses stored artifacts without another model request');
});

test('active agent: first IDK teaches; second offers choice while preserving pending question', async () => {
  const state = seeded();
  const first = await turn(state, "I don't know");
  assert.equal(first.nextState.phase, state.phase);
  assert.equal(first.userCorrection, null);
  assert.equal(first.gradedThisTurn, false);
  assert.ok(first.messages.some(bubble => /push or pull/.test(bubble.message)));
  assert.equal(first.nextState.totalQuestions, 0);
  assert.deepEqual(first.attachments, []);
  const pending = structuredClone(first.nextState.lastQuestionRubric);
  const second = await turn(first.nextState, "I don't know");
  assert.equal(second.nextState.response_mode, 'offer_choice');
  assert.equal(second.questionType, 'choice');
  assert.equal(second.messages.at(-1).options.length, 2);
  assert.deepEqual(second.nextState.lastQuestionRubric, pending);
  assert.equal(second.nextState.totalQuestions, 0);
  assert.deepEqual(second.attachments, []);
});

test('active agent: explanation holds phase, preserves the task, and resumes only after acknowledgement', async () => {
  const state = seeded();
  const explanation = await turn(state, 'Explain the answer');
  assert.equal(explanation.nextState.phase, 'DIALOGUE');
  assert.equal(explanation.nextState.pendingAdvanceAfterExplanation, true);
  assert.equal(explanation.questionType, 'none');
  assert.ok(explanation.messages.every(message => !/[?？]$/.test(message.message)));
  assert.equal(explanation.userCorrection, null);
  assert.equal(explanation.gradedThisTurn, false);
  assert.equal(explanation.nextState.totalQuestions, 0);
  assert.equal(explanation.nextState.perGoal[0].total, 0);
  assert.equal(explanation.nextState.lastQuestionText, state.lastQuestionText);
  assert.deepEqual(explanation.nextState.lastQuestionRubric, state.lastQuestionRubric);
  const next = await turn(explanation.nextState, 'ok');
  assert.equal(next.nextState.phase, 'CHECK');
  assert.equal(next.nextState.totalQuestions, 0);
  assert.equal(next.userCorrection, null);
});

test('active agent: clarification during recall holds recall pointer and failed-attempt count', async () => {
  const state = seeded('ROUNDUP');
  state.roundupIndex = 0;
  const repaired = await turn(state, 'What do you mean?');
  assert.equal(repaired.nextState.phase, 'ROUNDUP');
  assert.equal(repaired.nextState.roundupIndex, 0);
  assert.equal(repaired.nextState.totalQuestions, 0);
  const support = repaired.nextState.learning_support[repaired.nextState.active_learning_point_id];
  assert.equal(support.unsuccessful_responses, 0);
  assert.equal(repaired.questionType, 'none');
  assert.equal(repaired.userCorrection, null);
  assert.deepEqual(repaired.nextState.lastQuestionRubric, state.lastQuestionRubric);
});

test('active agent: an unsupported hidden rubric obligation repairs the task without wrong-answer evidence', async () => {
  const state = seeded();
  const repaired = await turn(state, 'UNFAIR_RUBRIC');
  assert.equal(repaired.evaluatorResult.evaluation_status, 'repair_needed');
  assert.equal(repaired.nextState.phase, state.phase);
  assert.equal(repaired.nextState.totalQuestions, 0);
  assert.equal(repaired.userCorrection, null);
  assert.equal(repaired.gradedThisTurn, false);
  assert.equal(repaired.questionType, 'none');
  assert.equal(repaired.nextState.learning_support[repaired.nextState.active_learning_point_id].unsuccessful_responses, 0);
});

test('active agent: clarification after one wrong answer does not produce the two-miss choice', async () => {
  const wrong = await turn(seeded(), 'WRONG');
  assert.equal(wrong.nextState.totalQuestions, 1);
  const clarification = await turn(wrong.nextState, 'What do you mean?');
  assert.equal(clarification.nextState.response_mode, 'task_repair');
  assert.equal(clarification.nextState.totalQuestions, 1);
  assert.equal(clarification.nextState.learning_support[clarification.nextState.active_learning_point_id].unsuccessful_responses, 1);
  assert.equal(clarification.userCorrection, null);
});

test('active agent: the support choice also protects unscored THEORY and OBJECTIVES turns', async () => {
  for (const phase of ['THEORY', 'OBJECTIVES']) {
    const state = seeded(phase);
    const first = await turn(state, "I don't know");
    const second = await turn(first.nextState, "I don't know");
    assert.equal(second.nextState.phase, phase, `${phase} must not silently consume the second IDK`);
    assert.equal(second.nextState.response_mode, 'offer_choice');
    assert.equal(second.messages.at(-1).options.length, 2);
    assert.equal(second.nextState.totalQuestions, 0);
    assert.equal(second.userCorrection, null);
  }
});

test('active agent: revealing the last recall answer does not bypass explanation or certify mastery', async () => {
  let result = await turn(null, '');
  for (let i = 0; i < 25; i++) {
    if (result.nextState.phase === 'ROUNDUP' && result.nextState.roundupIndex === 2) break;
    const answer = result.nextState.lastQuestionRubric.correct_option_text || result.nextState.lastQuestionRubric.model_answer;
    result = await turn(result.nextState, answer);
  }
  assert.equal(result.nextState.phase, 'ROUNDUP');
  assert.equal(result.nextState.roundupIndex, 2);
  const totalBefore = result.nextState.totalQuestions;
  const explanation = await turn(result.nextState, 'Explain the answer');
  assert.equal(explanation.nextState.phase, 'ROUNDUP');
  assert.equal(explanation.nextState.pendingAdvanceAfterExplanation, true);
  assert.equal(explanation.masteryReport, null);
  assert.equal(explanation.nextState.totalQuestions, totalBefore);
  assert.ok(explanation.messages.every(message => !/[?？]$/.test(message.message)));
  const wrapped = await turn(explanation.nextState, 'ok');
  assert.equal(wrapped.nextState.phase, 'WRAP');
  assert.ok(wrapped.masteryReport);
  assert.ok(wrapped.revisionSheet);
  assert.equal(wrapped.masteryReport.mastery_confirmed, false);
  assert.equal(wrapped.masteryReport.recall_passed, false);
  assert.equal(wrapped.masteryReport.incorrect_answers, 0, 'Asking for the answer is not a wrong academic answer');
});

test('active agent: a rejected rubric is replaced before the next answer is graded', async () => {
  const state = seeded();
  const repair = await turn(state, 'UNFAIR_RUBRIC');
  assert.equal(repair.nextState.awaitingAcademicQuestion, true);
  assert.equal(repair.nextState.lastQuestionRubric, null);
  const before = calls.filter(call => call.options.subFeature === 'evaluator').length;
  const replacement = await turn(repair.nextState, 'ok');
  assert.equal(calls.filter(call => call.options.subFeature === 'evaluator').length, before);
  assert.equal(replacement.nextState.phase, 'DIALOGUE');
  assert.ok(replacement.nextState.lastQuestionRubric);
  assert.equal(replacement.nextState.awaitingAcademicQuestion, false);
  assert.equal(replacement.nextState.totalQuestions, 0);
  const answer = await turn(replacement.nextState, replacement.nextState.lastQuestionRubric.model_answer);
  assert.equal(answer.nextState.phase, 'CHECK');
  assert.equal(answer.nextState.totalQuestions, 1);
});

test('active agent: explicit media requests do not become failed academic answers', async () => {
  const state = seeded();
  const before = calls.filter(call => call.options.subFeature === 'evaluator').length;
  const video = await turn(state, 'Show me a video explaining force');
  assert.equal(calls.filter(call => call.options.subFeature === 'evaluator').length, before);
  assert.equal(video.nextState.phase, state.phase);
  assert.equal(video.nextState.totalQuestions, 0);
  assert.equal(video.userCorrection, null);
  assert.deepEqual(video.attachments, ['video']);
  assert.equal(video.nextState.learning_support[video.nextState.active_learning_point_id].unsuccessful_responses, 0);
});

test('active agent: queued recap continues without another model call or lost academic task', async () => {
  const state = seeded();
  state.response_mode = 'task_repair';
  state.supportRequestKind = 'recap_topic';
  state.supportContinuation = [
    { message: 'A force is a push or pull.', message_type: 'text', support_fact_id: 'fact_1' },
    { message: 'Objects exert forces on one another.', message_type: 'text', support_fact_id: 'fact_2' },
    { message: 'A force can start or stop motion.', message_type: 'text', support_fact_id: 'fact_3' },
    { message: 'A force can change direction.', message_type: 'text', support_fact_id: 'fact_4' },
  ];
  const before = calls.length;
  const page = await turn(state, 'continue');
  assert.equal(calls.length, before);
  assert.ok(page.messages.some(item => item.message === 'A force is a push or pull.'));
  assert.ok(page.nextState.supportContinuation.length > 0);
  assert.deepEqual(page.nextState.lastQuestionRubric, state.lastQuestionRubric);
  const last = await turn(page.nextState, 'continue');
  assert.equal(calls.length, before);
  assert.equal(last.nextState.supportContinuation.length, 0);
  assert.equal(last.nextState.totalQuestions, 0);
  assert.equal(last.nextState.phase, state.phase);
  assert.ok(last.messages.every(item => !/[?？]$/.test(item.message)));
});
