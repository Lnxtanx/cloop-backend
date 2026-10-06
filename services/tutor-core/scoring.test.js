const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./state');
const { buildReport } = require('./summary');

const right = { intent: 'ANSWER', correct: true, evaluationStatus: 'available' };
const wrong = { intent: 'ANSWER', correct: false, errorType: 'Conceptual', evaluationStatus: 'available' };
const inPhase = (phase, count = 1) => ({ ...S.initialState(count), phase, assessmentAdvanced: false });
const goals = [{ title: 'Effects of force' }, { title: 'Shape changes' }];

test('a retry is an attempt at one scored slot and cannot replace an initial error', () => {
  let state = S.advance(inPhase('DIALOGUE'), wrong);
  state = S.advance(state, right);
  assert.equal(state.phase, 'CHECK');
  assert.equal(state.perGoal[0].total, 1);
  assert.equal(state.perGoal[0].correct, 0);
  assert.equal(state.totalQuestions, 1);
  const slot = state.perGoal[0].assessments.DIALOGUE;
  assert.equal(slot.outcome, 'incorrect');
  assert.equal(slot.attempts.length, 2);
  assert.equal(slot.completed, true);
});

test('maximum wrong attempts reveal the old answer and reset pressure for the next slot', () => {
  let state = inPhase('DIALOGUE');
  for (let i = 0; i < S.MAX_ATTEMPTS; i++) state = S.advance(state, wrong);
  assert.equal(state.phase, 'CHECK');
  assert.equal(state.perGoal[0].total, 1);
  assert.equal(state.perGoal[0].assessments.DIALOGUE.attempts.length, 3);
  assert.equal(state.revealPending, true);
  assert.equal(state.revealGoalIndex, 0);
  assert.equal(state.revealPhase, 'DIALOGUE');
  assert.equal(state.consecutiveWrong, 0);
  assert.equal(state.stuckStreak, 0);
  state = S.advance(state, wrong);
  assert.equal(state.phase, 'CHECK');
  assert.equal(state.consecutiveWrong, 1);
  assert.equal(state.perGoal[0].total, 2);
});

for (const intent of ['IDK', 'HELP']) {
  test(`${intent} followed by a hinted correct answer records assistance without independent mastery credit`, () => {
    let state = S.advance(inPhase('ROUNDUP'), { intent });
    assert.equal(state.perGoal[0].total, 0);
    assert.equal(state.perGoal[0].assessments.ROUNDUP.assisted, true);
    state = S.advance(state, right);
    assert.equal(state.phase, 'WRAP');
    assert.equal(state.perGoal[0].total, 1);
    assert.equal(state.perGoal[0].correct, 0);
    const report = buildReport(state, goals.slice(0, 1));
    assert.equal(report.recall_completed, true);
    assert.equal(report.recall_passed, false);
    assert.equal(report.assisted_answers, 1);
    assert.equal(report.incorrect_answers, 0);
    assert.equal(report.mastery_confirmed, false);
    assert.equal(report.areas_to_improve.length, 1);
  });
}

test('a neutral acknowledgement alone does not consume or fail an assessment', () => {
  let state = S.advance(inPhase('DIALOGUE'), { intent: 'ACK' });
  state = S.advance(state, right);
  assert.equal(state.perGoal[0].total, 1);
  assert.equal(state.perGoal[0].correct, 1);
  assert.equal(state.perGoal[0].assessments.DIALOGUE.assisted, false);
});

test('an answer shown in a hint before the first response cannot earn independent credit', () => {
  const state = S.advance(inPhase('DIALOGUE'), { ...right, previousQuestionAssisted: true });
  const report = buildReport(state, goals.slice(0, 1));
  assert.equal(report.correct_answers, 0);
  assert.equal(report.assisted_answers, 1);
  assert.equal(report.incorrect_answers, 0);
  assert.equal(report.overall_mastery_percent, 0);
});

test('skipped non-answer slots are identified separately from scored errors', () => {
  let state = inPhase('ROUNDUP');
  state = S.advance(state, { intent: 'IDK' });
  state = S.advance(state, { intent: 'IDK' });
  const report = buildReport(state, goals.slice(0, 1));
  assert.equal(state.phase, 'WRAP');
  assert.equal(report.total_questions, 0);
  assert.equal(report.incorrect_answers, 0);
  assert.equal(report.assessments_skipped, 1);
  assert.equal(report.per_goal[0].band, 'Not covered');
  assert.equal(report.recall_completed, false);
  assert.deepEqual(report.incomplete_recall, ['Effects of force']);
});

test('an evaluator outage never credits even a supplied correct-ish fallback', () => {
  let state = inPhase('DIALOGUE');
  state = S.advance(state, { ...right, evaluationStatus: 'unavailable' });
  assert.equal(state.phase, 'DIALOGUE');
  assert.equal(state.perGoal[0].total, 0);
  assert.equal(state.perGoal[0].correct, 0);
  assert.equal(state.perGoal[0].assessments.DIALOGUE.outcome, 'unverified');
  state = S.advance(state, right);
  assert.equal(state.phase, 'CHECK');
  assert.equal(state.perGoal[0].total, 1);
  assert.equal(state.perGoal[0].correct, 1);
});

test('an outage during fresh recall uses neutral retries without hinting or removing independent credit', () => {
  let state = { ...inPhase('ROUNDUP'), lastInstruction: 'roundup_recall' };
  for (let attempt = 0; attempt < S.MAX_UNVERIFIED_ATTEMPTS - 1; attempt++) {
    state = S.advance(state, { intent: 'ANSWER', correct: null, evaluationStatus: 'unavailable' });
    const instruction = S.instructionFor(state, { intent: 'ANSWER' });
    assert.equal(instruction, 'reask_shorter');
    assert.equal(state.perGoal[0].assessments.ROUNDUP.assisted, false);
    state.lastInstruction = instruction;
  }
  state = S.advance(state, right);
  assert.equal(state.perGoal[0].correct, 1);
  assert.equal(state.perGoal[0].assessments.ROUNDUP.outcome, 'correct');
  assert.equal(buildReport(state, goals.slice(0, 1)).recall_passed, true);
});

test('a reliable help request after an outage receives teaching rather than another outage retry', () => {
  let state = S.advance(inPhase('ROUNDUP'), { intent: 'ANSWER', correct: null, evaluationStatus: 'unavailable' });
  state = S.advance(state, { intent: 'IDK' });
  assert.equal(state.evaluatorUnavailableStreak, 0);
  assert.equal(S.instructionFor(state, { intent: 'IDK' }), 'hint_then_easier');
  assert.equal(state.perGoal[0].assessments.ROUNDUP.assisted, true);
});

test('null correctness is unknown evidence and neither correct nor incorrect', () => {
  const state = S.advance(inPhase('ROUNDUP'), { intent: 'ANSWER', correct: null });
  assert.equal(state.phase, 'ROUNDUP');
  const report = buildReport(state, goals.slice(0, 1));
  assert.equal(report.total_questions, 0);
  assert.equal(report.correct_answers, 0);
  assert.equal(report.incorrect_answers, 0);
  assert.equal(report.assessments_unverified, 1);
});

test('unavailable evaluation has a bounded escape with incomplete recall', () => {
  let state = inPhase('ROUNDUP');
  for (let i = 0; i < S.MAX_UNVERIFIED_ATTEMPTS; i++) {
    state = S.advance(state, { intent: 'ANSWER', correct: null, evaluationStatus: 'unavailable' });
  }
  const report = buildReport(state, goals.slice(0, 1));
  assert.equal(state.phase, 'WRAP');
  assert.equal(state.revealPending, false);
  assert.equal(state.evaluatorUnavailableStreak, 0);
  assert.equal(report.assessments_unverified, 1);
  assert.equal(report.recall_completed, false);
  assert.equal(report.recall_passed, false);
  assert.equal(report.assessment_coverage_percent, 0);
});

test('the final allowed answer is recorded before the turn cap closes the session', () => {
  const before = { ...inPhase('DIALOGUE'), totalTurns: S.MAX_TURNS - 1 };
  const state = S.advance(before, right);
  assert.equal(state.phase, 'WRAP');
  assert.equal(state.endedReason, 'turn_limit');
  assert.equal(state.perGoal[0].correct, 1);
  assert.equal(state.perGoal[0].total, 1);
});

test('a perfect partial session exposes coverage and cannot claim confirmed mastery', () => {
  const state = S.advance(inPhase('DIALOGUE', 2), right);
  const report = buildReport({ ...state, phase: 'WRAP', endedReason: 'turn_limit' }, goals);
  assert.equal(report.overall_mastery_percent, 100);
  assert.equal(report.overall_band, 'Proficient');
  assert.equal(report.assessment_coverage_percent, 17);
  assert.equal(report.mastery_confirmed, false);
  assert.equal(report.recall_completed, false);
  assert.equal(report.performance_level, 'Good');
  assert.equal(report.per_goal[0].is_completed, false);
  assert.equal(report.areas_to_improve.length, 1);
  assert.equal(report.not_covered.length, 1);
});

test('failed recall remains a practice area even when other assessment accuracy is high', () => {
  let state = inPhase('DIALOGUE');
  state = S.advance(state, right);
  state = S.advance(state, right);
  state = S.advance(state, wrong);
  state = S.advance(state, right);
  const report = buildReport(state, goals.slice(0, 1));
  assert.equal(report.total_questions, 3);
  assert.equal(report.correct_answers, 2);
  assert.equal(report.overall_mastery_percent, 67);
  assert.equal(report.per_goal[0].band, 'Proficient');
  assert.equal(report.recall_completed, true);
  assert.equal(report.recall_passed, false);
  assert.equal(report.learned_well.length, 0);
  assert.equal(report.areas_to_improve.length, 1);
  assert.equal(report.session_completed, true);
  assert.equal(report.mastery_confirmed, false);
});

test('a new goal and a new recall slot use the assessment directive without leaking a hint', () => {
  const freshRecall = { ...inPhase('ROUNDUP', 2), assessmentAdvanced: true, lastInstruction: 'roundup_recall' };
  assert.equal(S.instructionFor(freshRecall, right), 'roundup_recall');
  const freshGoal = { ...inPhase('DIALOGUE', 2), assessmentAdvanced: true, lastInstruction: 'open_goal_dialogue' };
  assert.equal(S.instructionFor(freshGoal, right), 'open_goal_dialogue');
  const repeatedSameSlot = { ...freshRecall, assessmentAdvanced: false };
  assert.equal(S.instructionFor(repeatedSameSlot, right), 'hint_then_easier');
});

test('legacy tallies remain readable but cannot invent an unrecorded recall pass', () => {
  const state = { ...inPhase('ROUNDUP'), perGoal: [{ total: 2, correct: 2, errors: [] }] };
  const report = buildReport(state, goals.slice(0, 1));
  assert.equal(report.total_questions, 2);
  assert.equal(report.overall_mastery_percent, 100);
  assert.equal(report.overall_band, 'Proficient');
  assert.equal(report.recall_passed, false);
  assert.equal(report.score_evidence, 'legacy_totals');
  assert.equal(report.legacy_evidence, true);
  assert.equal(report.fresh_session_recommended, true);
  const upgraded = S.advance(state, right);
  assert.equal(upgraded.perGoal[0].total, 3);
  assert.equal(upgraded.perGoal[0].assessments.ROUNDUP.outcome, 'correct');
});

test('legacy totals mixed with three new correct slots cannot certify mastery', () => {
  let state = { ...inPhase('DIALOGUE'), perGoal: [{ total: 2, correct: 2, errors: [] }] };
  state = S.advance(state, right);
  state = S.advance(state, right);
  state = S.advance(state, right);
  const report = buildReport(state, goals.slice(0, 1));
  assert.equal(report.total_questions, 5, 'legacy totals remain readable');
  assert.equal(report.overall_mastery_percent, 100);
  assert.equal(report.recall_passed, true);
  assert.equal(report.overall_band, 'Proficient');
  assert.equal(report.mastery_confirmed, false);
  assert.equal(report.score_evidence, 'legacy_mixed');
  assert.equal(report.legacy_evidence, true);
  assert.equal(report.per_goal[0].score_evidence, 'legacy_mixed');
  assert.equal(report.per_goal[0].legacy_evidence, true);
  assert.equal(report.per_goal[0].mastery_confirmed, false);
  assert.equal(report.fresh_session_recommended, true);
});

test('fully recorded assessment slots identify the scoring evidence without legacy flags', () => {
  let state = inPhase('DIALOGUE');
  state = S.advance(state, right);
  state = S.advance(state, right);
  state = S.advance(state, right);
  const report = buildReport(state, goals.slice(0, 1));
  assert.equal(report.score_evidence, 'assessment_slots');
  assert.equal(report.legacy_evidence, false);
  assert.equal(report.per_goal[0].legacy_evidence, false);
  assert.equal(report.fresh_session_recommended, false);
  assert.equal(report.mastery_confirmed, true);
});

test('advance never mutates nested diagnostic attempts or assessment outcomes', () => {
  const before = S.advance(inPhase('DIALOGUE'), wrong);
  const snapshot = JSON.stringify(before);
  const after = S.advance(before, right);
  assert.equal(JSON.stringify(before), snapshot);
  assert.notEqual(before.perGoal[0].assessments.DIALOGUE, after.perGoal[0].assessments.DIALOGUE);
  assert.equal(before.perGoal[0].assessments.DIALOGUE.attempts.length, 1);
});

test('goal completion requires assessed finalized slots independently of closing or mastery', () => {
  let state = inPhase('DIALOGUE');
  assert.equal(S.goalCompletion({ ...state, phase: 'WRAP' }, 0), false);
  state = S.advance(state, right);
  state = S.advance(state, right);
  assert.equal(S.goalCompletion(state, 0), false);
  state = S.advance(state, { intent: 'IDK' });
  state = S.advance(state, { intent: 'IDK' });
  assert.equal(S.goalCompletion(state, 0), false);
  assert.equal(buildReport(state, goals.slice(0, 1)).per_goal[0].is_completed, false);
  assert.equal(buildReport(state, goals.slice(0, 1)).mastery_confirmed, false);
  assert.equal(S.goalCompletion(state, 1), false);
  assert.equal(S.goalCompletion(null, 0), false);
  let assessed = inPhase('DIALOGUE');
  assessed = S.advance(assessed, right);
  assessed = S.advance(assessed, right);
  assessed = S.advance(assessed, wrong);
  assessed = S.advance(assessed, right);
  assert.equal(S.goalCompletion(assessed, 0), true);
  assert.equal(buildReport(assessed, goals.slice(0, 1)).mastery_confirmed, false);
});
