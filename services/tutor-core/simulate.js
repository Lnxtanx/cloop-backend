/**
 * Seeded adversarial simulation of server-owned pacing and evidence.
 *
 *   node services/tutor-core/simulate.js --sessions 400 --seed 42
 *
 * Expected score evidence is tracked independently from state.perGoal. A
 * failure exits nonzero so this simulation can be used in deployment checks.
 */
const S = require('./state');
const { buildReport } = require('./summary');

function rng(seed) {
  let value = seed >>> 0 || 1;
  return () => ((value = (value * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const TOPICS = [
  { title: 'Chemical Properties of Acids and Bases', goals: ['Acid-metal reactions', 'Acid-carbonate reactions', 'Base-metal reactions', 'Gas testing', 'Comparing reactivity'] },
  { title: 'Friction', goals: ['Identify friction', 'Compare surfaces', 'Reduce friction', 'Friction in daily life'] },
  { title: 'Linear Equations', goals: ['Name the unknown', 'Isolate the variable', 'Check the solution'] },
  { title: 'Photosynthesis', goals: ['Inputs', 'Outputs', 'Chlorophyll', 'Limiting factors', 'Experiments', 'Food chains'] },
];

// Fixture kind is independent ground truth, not the classifier under test.
const STUDENTS = [
  { text: 'carbon dioxide', intent: 'ANSWER', kind: 'answer', correct: true },
  { text: 'yes salt and water', intent: 'ANSWER', kind: 'answer', correct: true },
  { text: 'hydrogen gas', intent: 'ANSWER', kind: 'answer', correct: false, errorType: 'Conceptual' },
  { text: 'gas of hydoyeg', intent: 'ANSWER', kind: 'answer', correct: false, errorType: 'Incomplete' },
  { text: 'ok', intent: 'ACK', kind: 'ack' },
  { text: 'pls explain', intent: 'HELP_REQUEST', kind: 'assistance' },
  { text: 'i dont know', intent: 'IDK', kind: 'assistance' },
  { text: 'my dog is called rex', intent: 'OFF_TOPIC', kind: 'offtopic' },
  { text: 'asdfghjk', intent: 'GIBBERISH', kind: 'offtopic' },
  { text: 'a scientific answer during an outage', intent: 'ANSWER', kind: 'unavailable', correct: null, evaluationStatus: 'unavailable' },
  // A historical fallback called an outage answer correct-ish. It earns none.
  { text: 'a guessed fallback answer', intent: 'ANSWER', kind: 'unavailable', correct: true, evaluationStatus: 'unavailable' },
];

const CARRY_ON = new Set(['probe_prior_knowledge', 'teach_theory', 'state_objectives',
  'open_goal_dialogue', 'continue_dialogue', 'assess_with_mcq', 'roundup_recall']);
const ASSISTANCE = new Set(['correct_and_reask', 'reteach_new_angle', 'hint_then_easier',
  'explain_differently', 'give_starter', 'reveal_and_move_on', 'teach_theory_analogy']);
const SCORED_PHASES = new Set(['DIALOGUE', 'CHECK', 'ROUNDUP']);

/** Identity uses phase/counters, not the implementation's advancement flag. */
function questionIdentity(state) {
  if (state.phase === 'ROUNDUP') return `ROUNDUP:${state.roundupIndex || 0}:${state.recallThisGoal || 0}`;
  if (state.phase === 'DIALOGUE') return `DIALOGUE:${state.goalIndex}:${state.openThisGoal || 0}`;
  if (state.phase === 'CHECK') return `CHECK:${state.goalIndex}:${state.mcqThisGoal || 0}`;
  return state.phase;
}

function runSession(seed, topic, { students = STUDENTS, sequence = null } = {}) {
  const rand = rng(seed);
  const violations = [];
  const instructionsSeen = new Set();
  const phasesSeen = new Set();
  const typesByPhase = new Map();
  const expected = new Map();
  const check = (condition, label, detail) => {
    if (!condition) violations.push({ label, detail });
  };
  const pick = (values) => values[Math.floor(rand() * values.length)];
  let state = S.initialState(topic.goals.length);
  // Bootstrap asks PROBE without inventing a student's first response.
  let previousInstruction = S.instructionFor(state, { intent: 'ANSWER' });
  state.lastInstruction = previousInstruction;
  let turns = 0, openAsked = 0, mcqAsked = 0, repeatRun = 1, longestRepeat = 1;
  const guardLimit = 400;

  while (state.phase !== 'DONE' && turns < guardLimit) {
    const before = state;
    const beforeIdentity = questionIdentity(before);
    const qType = S.questionTypeFor(before.phase);
    const scored = SCORED_PHASES.has(before.phase);
    const goalIndex = before.phase === 'ROUNDUP' ? (before.roundupIndex || 0) : before.goalIndex;
    phasesSeen.add(before.phase);
    if (!typesByPhase.has(before.phase)) typesByPhase.set(before.phase, new Set());
    typesByPhase.get(before.phase).add(qType);
    check(before.phase === 'WRAP' ? qType === null : ['open', 'mcq'].includes(qType),
      'unexpected question type', `${before.phase}: ${qType}`);
    check(qType !== 'mcq' || before.phase === 'CHECK', 'multiple choice outside CHECK', before.phase);
    check(before.phase !== 'PROBE' || !S.isScored(before.phase), 'the opening probe was scored', before.phase);
    if (before.phase === 'THEORY') {
      const attachments = S.attachmentsFor(before);
      check(attachments.includes('diagram') && attachments.includes('key_points'),
        'theory omitted diagram/key points', before.phase);
    }
    if (qType === 'open') openAsked++;
    if (qType === 'mcq') mcqAsked++;

    const student = sequence ? sequence[turns % sequence.length] : pick(students);
    const unavailable = student.kind === 'unavailable';
    if (scored) {
      if (!expected.has(beforeIdentity)) expected.set(beforeIdentity, { goalIndex, phase: before.phase, assisted: false, assessed: false, credit: false });
      const slot = expected.get(beforeIdentity);
      if (student.kind === 'assistance' || before.questionAssisted) slot.assisted = true;
      if (student.kind === 'answer' && !unavailable && typeof student.correct === 'boolean' && !slot.assessed) {
        slot.assessed = true;
        slot.credit = student.correct === true && !slot.assisted;
      }
    }

    state = S.advance(before, {
      intent: student.intent, correct: student.correct,
      evaluationStatus: unavailable ? 'unavailable' : 'evaluated',
      previousQuestionAssisted: before.questionAssisted,
      errorType: student.errorType || null, answerText: student.text,
    });
    // Match orchestration: decide the generator directive AFTER advancing.
    const instruction = S.instructionFor(state, { intent: student.intent });
    instructionsSeen.add(instruction);
    check(typeof instruction === 'string' && instruction.length > 0,
      'no instruction for reachable state', `${state.phase}/${student.intent}`);
    const closing = ['WRAP', 'DONE'].includes(state.phase);
    const sameQuestion = beforeIdentity === questionIdentity(state);
    const neutralOutageRetry = unavailable && instruction === 'reask_shorter';
    if (!closing && sameQuestion && !neutralOutageRetry) {
      check(instruction !== previousInstruction, 'same question repeated its directive', `${beforeIdentity}: ${instruction}`);
    }
    if (student.kind === 'assistance') {
      check(closing || !CARRY_ON.has(instruction), 'stuck student received no assistance', `${student.intent}: ${instruction}`);
    }
    if (!closing && !sameQuestion && scored && !state.revealPending) {
      check(!ASSISTANCE.has(instruction), 'a new assessment leaked a hint before an answer', `${beforeIdentity} -> ${questionIdentity(state)}: ${instruction}`);
    }
    repeatRun = instruction === previousInstruction && sameQuestion ? repeatRun + 1 : 1;
    longestRepeat = Math.max(longestRepeat, repeatRun);
    previousInstruction = instruction;
    state.lastInstruction = instruction;
    state.questionAssisted = !closing && sameQuestion && (before.questionAssisted || ASSISTANCE.has(instruction));
    const nextType = S.questionTypeFor(state.phase);
    state.lastQuestionText = closing ? '' : `Question about ${topic.goals[state.phase === 'ROUNDUP' ? state.roundupIndex : state.goalIndex]}?`;
    state.lastQuestionOptions = nextType === 'mcq'
      ? [{ text: 'Calcium carbonate', value: 'Calcium carbonate' }, { text: 'Sodium chloride', value: 'Sodium chloride' }] : null;
    turns++;

    if (student.kind !== 'answer' || unavailable) {
      check(state.perGoal.every((goal, index) => goal.correct === before.perGoal[index].correct && goal.total === before.perGoal[index].total),
        'non-answer or unavailable grading changed score', `${student.kind} in ${before.phase}`);
    }
    for (let index = 0; index < state.perGoal.length; index++) {
      const expectedSlots = [...expected.values()].filter((slot) => slot.goalIndex === index && slot.assessed);
      const expectedCorrect = expectedSlots.filter((slot) => slot.credit).length;
      const actual = state.perGoal[index];
      check(actual.total === expectedSlots.length && actual.correct === expectedCorrect,
        'score disagrees with independent first-response evidence', `goal ${index + 1}: ${actual.correct}/${actual.total} expected ${expectedCorrect}/${expectedSlots.length}`);
      check(actual.total <= 3 && actual.correct <= actual.total, 'goal exceeded three score slots', `goal ${index + 1}: ${actual.correct}/${actual.total}`);
    }
    check(state.goalIndex < state.goalTotal && (state.roundupIndex || 0) < state.goalTotal,
      'goal pointer exceeded goal count', `${state.goalIndex}/${state.roundupIndex}`);
    check(state.perGoal.length === topic.goals.length, 'state lost a goal', topic.title);
  }

  check(state.phase === 'DONE', 'session never terminated', topic.title);
  check(turns <= S.MAX_TURNS + 1, 'termination exceeded turn budget', `${turns} turns`);
  const report = buildReport(state, topic.goals.map((title) => ({ title })));
  const expectedSlots = [...expected.values()].filter((slot) => slot.assessed);
  const expectedCorrect = expectedSlots.filter((slot) => slot.credit).length;
  const expectedScore = expectedSlots.length ? Math.round(expectedCorrect / expectedSlots.length * 100) : 0;
  check(report.overall_mastery_percent === expectedScore, 'report score differs from evidence', `${report.overall_mastery_percent}, expected ${expectedScore}`);
  check(report.total_questions === expectedSlots.length, 'report counted diagnostic retries as questions', String(report.total_questions));
  check(report.correct_answers + report.incorrect_answers + report.assisted_answers === report.total_questions,
    'report answer counts do not reconcile', topic.title);
  check(report.per_goal.length === topic.goals.length, 'report lost a goal', topic.title);
  check(report.learned_well.length + report.areas_to_improve.length + report.not_covered.length === topic.goals.length,
    'report left goals unaccounted', topic.title);
  for (let index = 0; index < report.per_goal.length; index++) {
    const goal = report.per_goal[index];
    const independentRecall = [...expected.values()].find((slot) => slot.goalIndex === index && slot.phase === 'ROUNDUP');
    check(goal.band !== 'Mastered' || independentRecall?.credit === true,
      'goal mastered without independent recall', goal.goal);
    check(!goal.recall_passed || independentRecall?.credit === true,
      'assisted or wrong recall was passed', goal.goal);
    check(goal.accuracy_percent >= 0 && goal.accuracy_percent <= 100, 'goal score out of range', goal.goal);
  }
  check(!report.mastery_confirmed || report.per_goal.every((goal) => goal.recall_passed),
    'session mastery claimed before all recall passed', topic.title);

  return { turns, openAsked, mcqAsked, phasesSeen, typesByPhase, instructionsSeen, report, longestRepeat, violations, state };
}

/** Bounded reporting is kept separate so tests can verify a failed exit. */
function printViolations(violations, log = console.log) {
  const grouped = new Map();
  for (const violation of violations) {
    const group = grouped.get(violation.label) || { count: 0, example: violation.detail };
    group.count++;
    grouped.set(violation.label, group);
  }
  if (!violations.length) {
    log('✓ no invariant violated in any turn of any session');
    return 0;
  }
  log(`✗ ${violations.length} INVARIANT VIOLATION(S)`);
  for (const [label, detail] of [...grouped].sort((left, right) => right[1].count - left[1].count).slice(0, 12)) {
    log(`  ${label} ×${detail.count}: ${detail.example}`);
  }
  return 1;
}

function main(args = process.argv.slice(2), log = console.log) {
  const sessionsIndex = args.indexOf('--sessions');
  const seedIndex = args.indexOf('--seed');
  const sessions = Math.max(1, Number(sessionsIndex < 0 ? 300 : args[sessionsIndex + 1]) || 300);
  const seed = Number(seedIndex < 0 ? 1 : args[seedIndex + 1]) || 1;
  const violations = [];
  let turns = 0, open = 0, mcq = 0, reports = 0, worstRepeat = 1;
  const phases = new Set();
  for (let index = 0; index < sessions; index++) {
    const result = runSession(seed + index, TOPICS[index % TOPICS.length]);
    turns += result.turns; open += result.openAsked; mcq += result.mcqAsked;
    reports += result.report.per_goal.length > 0 ? 1 : 0;
    worstRepeat = Math.max(worstRepeat, result.longestRepeat);
    for (const phase of result.phasesSeen) phases.add(phase);
    violations.push(...result.violations);
  }
  log(`TUTOR CORE: ${sessions} sessions across ${TOPICS.length} topics; ${turns} turns`);
  log(`Written/MCQ: ${open}/${mcq}; reports: ${reports}/${sessions}; repeated same-question directives: ${worstRepeat}`);
  log(`Phases: ${[...phases].join(' -> ')}`);
  return printViolations(violations, log);
}

if (require.main === module) process.exitCode = main();
module.exports = { runSession, questionIdentity, printViolations, main, TOPICS, STUDENTS };
