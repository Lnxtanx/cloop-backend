const test = require('node:test');
const assert = require('node:assert/strict');
const { persistQuestionContract } = require('./question-contract');
const { teachingRequest } = require('./learning-requests');

for (const [label, S] of [['production', require('../../ai/agents/socratic-tutor/state/state-machine')], ['compatibility', require('./state')]]) {
  const seed = phase => ({ ...S.initialState(3), phase, lastQuestionText: 'What is meant by force?',
    lastQuestionRubric: { criteria: [{ id: 'definition', description: 'Force is a push or pull.', required: true }], model_answer: 'Force is a push or pull.' } });

  test(`${label}: every teaching/recall phase offers support after two IDKs`, () => {
    for (const phase of ['THEORY', 'OBJECTIVES', 'DIALOGUE', 'CHECK', 'ROUNDUP']) {
      const base = seed(phase);
      const first = S.advance(base, { intent: 'IDK' });
      const second = S.advance(first, { intent: 'IDK' });
      assert.equal(second.phase, phase);
      assert.equal(second.response_mode, 'offer_choice');
      assert.equal(second.totalQuestions, 0);
      assert.equal(second.learning_support[second.active_learning_point_id].unsuccessful_responses, 2);
    }
  });

  test(`${label}: retry grants one attempt while preserving struggle history`, () => {
    let state = S.advance(seed('DIALOGUE'), { intent: 'ANSWER', correct: false });
    state = S.advance(state, { intent: 'IDK' });
    state = S.advance(state, { intent: 'ACK', requestKind: 'try_again' });
    assert.equal(state.learning_support[state.active_learning_point_id].unsuccessful_responses, 2);
    state = S.advance(state, { intent: 'ANSWER', correct: false });
    assert.equal(state.phase, 'DIALOGUE');
    assert.equal(state.response_mode, 'offer_choice');
    assert.equal(state.totalQuestions, 1, 'Retries do not manufacture another assessment slot');
  });

  test(`${label}: clarification, recap and broken-rubric repair never consume recall`, () => {
    for (const event of [{ requestKind: 'clarify_term' }, { requestKind: 'recap_topic' }, { evaluationStatus: 'repair_needed' }]) {
      const base = seed('ROUNDUP');
      const next = S.advance(base, { intent: 'HELP', ...event });
      assert.equal(next.roundupIndex, 0);
      assert.equal(next.phase, 'ROUNDUP');
      assert.equal(next.totalQuestions, 0);
      assert.equal(next.learning_support[next.active_learning_point_id].unsuccessful_responses, 0);
    }
  });

  test(`${label}: requesting an answer produces no wrong answer and ACK resumes`, () => {
    const base = seed('DIALOGUE');
    const explanation = S.advance(base, { intent: 'HELP', requestKind: 'explain_answer' });
    assert.equal(explanation.phase, 'DIALOGUE');
    assert.equal(explanation.totalQuestions, 0);
    assert.equal(explanation.pendingAdvanceAfterExplanation, true);
    assert.equal(explanation.perGoal[0].assessments.DIALOGUE.assessed, false);
    assert.equal(S.advance(explanation, { intent: 'ACK' }).phase, 'CHECK');
  });

  test(`${label}: exit is honored even while waiting for valid source/question`, () => {
    const next = S.advance({ ...seed('DIALOGUE'), awaitingAcademicQuestion: true }, { intent: 'ACK', answerText: 'stop session' });
    assert.equal(next.phase, 'WRAP');
    assert.equal(next.endedReason, 'user_requested');
  });

  test(`${label}: recap state clears after support and cannot force endless recaps`, () => {
    const recap = S.advance(seed('DIALOGUE'), { intent: 'HELP', requestKind: 'recap_topic' });
    assert.equal(recap.supportRequestKind, 'recap_topic');
    const resumed = S.advance(recap, { intent: 'ACK' });
    assert.equal(resumed.supportRequestKind, null);
  });
}

test('a broken rubric is retired; genuine clarification retains a valid pending task', () => {
  const state = { phase: 'DIALOGUE', goalIndex: 0, lastQuestionText: 'What is force?', lastQuestionRubric: { model_answer: 'Force is a push or pull.' } };
  const clarification = { ...state, assessmentAdvanced: false };
  persistQuestionContract(state, clarification, { questionType: 'none' });
  assert.equal(clarification.lastQuestionRubric, state.lastQuestionRubric);
  const repair = { ...state, assessmentAdvanced: false };
  persistQuestionContract(state, repair, { questionType: 'none' }, false, true);
  assert.equal(repair.lastQuestionRubric, null);
  assert.equal(repair.awaitingAcademicQuestion, true);
});

test('conditional recap/example wording cannot be mistaken for permission to move on', () => {
  assert.equal(teachingRequest('Pls list all concepts and definitions before we move on'), 'recap_topic');
  assert.equal(teachingRequest('You need and example'), 'give_example');
  assert.equal(teachingRequest('What do you mean by which effect?'), 'clarify_term');
});
