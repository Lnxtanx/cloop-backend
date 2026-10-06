const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./state');
const { runSession, questionIdentity, printViolations, main, TOPICS, STUDENTS } = require('./simulate');

const right = { text: 'conceptually correct', intent: 'ANSWER', kind: 'answer', correct: true };
const idk = { text: 'dont know', intent: 'IDK', kind: 'assistance' };
const topic = { title: 'Effects of force', goals: ['Changes to motion and shape'] };

test('seeded adversarial simulation independently verifies scores and bounded sessions', () => {
  for (let seed = 42; seed < 72; seed++) {
    const result = runSession(seed, TOPICS[seed % TOPICS.length]);
    assert.deepEqual(result.violations, [], `seed ${seed}`);
    assert.ok(result.turns <= S.MAX_TURNS + 1);
    assert.ok(result.state.perGoal.every((goal) => goal.total <= 3));
  }
});

test('question identity distinguishes new recall goals while detecting pending retries', () => {
  const initial = { ...S.initialState(2), phase: 'ROUNDUP' };
  assert.equal(questionIdentity(initial), questionIdentity({ ...initial, consecutiveWrong: 2 }));
  assert.notEqual(questionIdentity(initial), questionIdentity({ ...initial, roundupIndex: 1 }));
  assert.notEqual(questionIdentity(initial), questionIdentity({ ...initial, phase: 'DIALOGUE' }));
});

test('successful repeated recall directives on different goals are permitted', () => {
  const result = runSession(42, TOPICS[0], { students: [right] });
  assert.deepEqual(result.violations, []);
  assert.equal(result.report.overall_mastery_percent, 100);
  assert.equal(result.report.total_questions, TOPICS[0].goals.length * 3);
  assert.equal(result.report.recall_passed, true);
  assert.equal(result.longestRepeat, 1);
});

test('IDK-only sessions terminate without mastery or assessment credit', () => {
  const result = runSession(42, TOPICS[1], { students: [idk] });
  assert.deepEqual(result.violations, []);
  assert.equal(result.report.correct_answers, 0);
  assert.equal(result.report.total_questions, 0);
  assert.equal(result.report.mastery_confirmed, false);
  assert.equal(result.report.goals_completed, 0);
  assert.equal(result.report.assessments_skipped, TOPICS[1].goals.length * 3);
});

test('an IDK followed by easier correct recall cannot confirm mastery', () => {
  const result = runSession(42, topic, { sequence: [right, right, right, right, right, idk, right] });
  assert.deepEqual(result.violations, []);
  assert.equal(result.report.total_questions, 3);
  assert.equal(result.report.correct_answers, 2);
  assert.equal(result.report.assisted_answers, 1);
  assert.equal(result.report.recall_completed, true);
  assert.equal(result.report.recall_passed, false);
  assert.equal(result.report.mastery_confirmed, false);
});

test('a neutral outage retry followed by independent correct recall preserves mastery evidence', () => {
  const outage = STUDENTS.find((student) => student.kind === 'unavailable');
  const result = runSession(42, topic, { sequence: [right, right, right, right, right, outage, right] });
  assert.deepEqual(result.violations, []);
  assert.equal(result.report.total_questions, 3);
  assert.equal(result.report.correct_answers, 3);
  assert.equal(result.report.assisted_answers, 0);
  assert.equal(result.report.recall_passed, true);
  assert.equal(result.report.mastery_confirmed, true);
});

for (const outage of STUDENTS.filter((student) => student.kind === 'unavailable')) {
  test(`outage fixture with correctness ${outage.correct} never creates score evidence`, () => {
    const result = runSession(42, TOPICS[2], { students: [outage] });
    assert.deepEqual(result.violations, []);
    assert.equal(result.report.correct_answers, 0);
    assert.equal(result.report.incorrect_answers, 0);
    assert.equal(result.report.total_questions, 0);
    assert.equal(result.report.recall_completed, false);
    assert.ok(result.report.assessments_unverified > 0);
  });
}

test('simulation flags invented credit independently of the state tally implementation', () => {
  const original = S.advance;
  try {
    S.advance = (state, event) => {
      const next = original(state, event);
      if (state.phase === 'DIALOGUE' && event.intent === 'IDK') {
        next.perGoal[0].correct++;
        next.perGoal[0].total++;
      }
      return next;
    };
    const result = runSession(42, topic, { students: [idk] });
    assert.ok(result.violations.some((violation) => violation.label === 'non-answer or unavailable grading changed score'));
    assert.ok(result.violations.some((violation) => violation.label === 'score disagrees with independent first-response evidence'));
    assert.equal(printViolations(result.violations, () => {}), 1);
    assert.equal(main(['--sessions', '10', '--seed', '42'], () => {}), 1);
  } finally {
    S.advance = original;
  }
});

test('reporting returns failure for violations with bounded output', () => {
  const logs = [];
  const violations = Array.from({ length: 30 }, (_, index) => ({ label: `failure ${index}`, detail: 'example' }));
  assert.equal(printViolations(violations, (line) => logs.push(line)), 1);
  assert.ok(logs.length <= 13);
  assert.equal(printViolations([], () => {}), 0);
});

test('CLI main returns a successful status when independent invariants hold', () => {
  const logs = [];
  assert.equal(main(['--sessions', '10', '--seed', '42'], (line) => logs.push(line)), 0);
  assert.ok(logs.some((line) => line.includes('no invariant violated')));
});
