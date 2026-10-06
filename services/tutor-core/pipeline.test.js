/**
 * End-to-end tests for the orchestrator, with both model calls stubbed.
 *
 * The pipeline had no test of its own, which is how a vocabulary mismatch
 * between two of its steps reached production: each module was individually
 * fine, and nothing exercised the seam between them.
 *
 * The stubs are installed through require.cache before the orchestrator is
 * loaded, so no network call is ever made and the tests are deterministic.
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const clientPath = require.resolve('../ai/deepseek-client');
require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: {
  invokeModel: async () => { throw new Error('Stubbed provider unavailable'); },
  extractJson: JSON.parse,
} };

// ── stub the two model-backed steps ────────────────────────────────────────
const evaluatorPath = require.resolve("./evaluator");
const generatorPath = require.resolve("./tutor-generator");

let nextVerdict = null;
const generatorCalls = [];
const evaluatorCalls = [];
let generatorUnavailable = false;

require.cache[evaluatorPath] = {
  id: evaluatorPath,
  filename: evaluatorPath,
  loaded: true,
  exports: {
    evaluateStudentTurn: async (params) => { evaluatorCalls.push(params); return nextVerdict; },
    resolveOptionAnswer: (m) => ({ isOption: false, resolvedText: m, raw: m }),
  },
};

require.cache[generatorPath] = {
  id: generatorPath,
  filename: generatorPath,
  loaded: true,
  exports: {
    generateTutorResponse: async (params) => {
      generatorCalls.push(params);
      if (generatorUnavailable) return { messages: [] };
      const rubric = { criteria: [{ id: 'concept', description: params.currentGoalDescription || params.currentGoalTitle, required: true }],
        model_answer: params.currentGoalDescription || params.currentGoalTitle };
      return {
        messages: [{ message: `Explain ${params.currentGoalTitle}?`, message_type: "text",
          ...(params.questionType === 'mcq' ? { options: [{ text: rubric.model_answer, value: rubric.model_answer },
            { text: 'The effect remains unchanged', value: 'The effect remains unchanged' }] } : {}) }],
        lastQuestionRubric: { ...rubric, ...(params.questionType === 'mcq' ? { correct_option_text: rubric.model_answer } : {}) },
      };
    },
  },
};

const { processTutorTurn } = require("./orchestrator");
const S = require("./state");

const TOPIC = { id: 1, title: "Nature – Our Science Laboratory", content: "" };
const GOALS = [
  { id: 1, title: "Identify substances", description: 'Substances can be identified by characteristic physical and chemical properties' },
  { id: 2, title: "Describe testing methods", description: 'A test must observe a characteristic property to distinguish substances' },
  { id: 3, title: "Demonstrate experimentation", description: 'Experiments compare observations while controlling other conditions' },
];

function verdict(over = {}) {
  return {
    intent: "ANSWER",
    is_correct: true,
    score_percent: 90,
    error_type: null,
    diff_html: null,
    complete_answer: null,
    suggested_action: "MOVE_ON",
    reasoning: "",
    evaluation_status: 'evaluated',
    resolved_answer: null,
    ...over,
  };
}

async function turn(state, studentMessage, v) {
  nextVerdict = verdict(v);
  return processTutorTurn({
    studentMessage,
    topic: TOPIC,
    goals: GOALS,
    chatHistory: [],
    currentState: state,
  });
}

// ── the live failure, driven through the real pipeline ─────────────────────
test("three turns of 'I don't know' produce three different directives", async () => {
  let state = null;
  const instructions = [];

  let r = await turn(state, "It is creating carbon dioxide", { is_correct: true });
  state = r.nextState;
  instructions.push(r.stateInstruction);

  for (let i = 0; i < 3; i++) {
    r = await turn(state, "I don't know", {
      intent: "HELP_REQUEST",
      is_correct: null,
      score_percent: null,
    });
    state = r.nextState;
    instructions.push(r.stateInstruction);
  }

  const dupes = instructions.filter((x, i) => i > 0 && x === instructions[i - 1]);
  assert.deepStrictEqual(dupes, [], `repeated directives: ${instructions.join(" → ")}`);
});

test("the instruction is written back so the next turn can see it", async () => {
  const r = await turn(null, "carbon dioxide", { is_correct: true });
  assert.strictEqual(r.nextState.lastInstruction, r.stateInstruction);
});

test("HELP_REQUEST reaches the state machine as HELP", async () => {
  const r = await turn(null, "explain please", { intent: "HELP_REQUEST", is_correct: null });
  assert.strictEqual(r.intent, "HELP");
});

// ── visual error correction is provided while mastery tallies are protected ─────
test("error correction box is shown on incorrect answers while mastery tallies are protected", async () => {
  for (const phase of ["PROBE", "THEORY", "OBJECTIVES"]) {
    const state = { ...S.initialState(GOALS.length), phase };
    const r = await turn(state, "It is increase", {
      is_correct: false,
      score_percent: 40,
      error_type: "Conceptual",
      diff_html: "<del>It is increase</del><ins>It will fizz more</ins>",
    });
    assert.ok(r.userCorrection, `${phase} must provide a visual error correction box`);
    assert.strictEqual(r.gradedThisTurn, false, `${phase} claims to have graded mastery`);
  }
});

test("a wrong answer in an assessed phase still gets its correction", async () => {
  for (const phase of ["DIALOGUE", "CHECK"]) {
    const state = { ...S.initialState(GOALS.length), phase };
    const r = await turn(state, "hydrogen", {
      is_correct: false,
      score_percent: 20,
      error_type: "Conceptual",
      diff_html: "<del>hydrogen</del><ins>carbon dioxide</ins>",
    });
    assert.ok(r.userCorrection, `${phase} lost the correction`);
    assert.strictEqual(r.userCorrection.diff_html, "<del>hydrogen</del><ins>carbon dioxide</ins>");
  }
});

// ── multiple choice stays assessment ───────────────────────────────────────
test("the generator is told to ask for writing everywhere but the check", async () => {
  generatorCalls.length = 0;
  let state = null;
  for (let i = 0; i < 12; i++) {
    const r = await turn(state, "an answer", { is_correct: true });
    state = r.nextState;
    if (state.phase === "DONE") break;
  }
  const mcq = generatorCalls.filter((c) => c.questionType === "mcq");
  assert.ok(mcq.length > 0, "assessment never happened");
  assert.ok(mcq.every((c) => c.phase === "CHECK"), "multiple choice used outside the check phase");
  const open = generatorCalls.filter((c) => c.questionType === "open");
  assert.ok(open.length > mcq.length, "the student clicks more than they write");
});

test("three off-topic turns close the session with a report", async () => {
  let state = null;
  let r;
  for (let i = 0; i < 3; i++) {
    r = await turn(state, "my dog is called rex", { intent: "OFF_TOPIC", is_correct: null });
    state = r.nextState;
  }
  assert.strictEqual(state.phase, "WRAP");
  assert.strictEqual(state.endedReason, "off_topic");
  assert.ok(r.masteryReport, "the session closed without a report");
  assert.strictEqual(r.stateInstruction, "close_off_topic");
  assert.strictEqual(r.all_goals_completed, false);
  assert.strictEqual(r.mastery_confirmed, false);
});

test('Cloop starts without grading a fictional student response', async () => {
  const evaluations = evaluatorCalls.length;
  const r = await processTutorTurn({ topic: TOPIC, goals: GOALS });
  assert.strictEqual(r.nextState.phase, 'PROBE');
  assert.strictEqual(r.nextState.totalTurns, 0);
  assert.strictEqual(evaluatorCalls.length, evaluations);
  assert.strictEqual(r.userCorrection, null);
  assert.ok(r.nextState.lastQuestionRubric);
  assert.ok(r.messages.at(-1).message.endsWith('?'));
});

test('normal session assesses three slots per goal before confirming mastery', async () => {
  let r = await processTutorTurn({ topic: TOPIC, goals: GOALS });
  let s = r.nextState;
  for (let i = 0; i < 20 && s.phase !== 'WRAP'; i++) {
    r = await turn(s, 'a complete independent answer');
    s = r.nextState;
    if (s.phase !== 'WRAP') {
      assert.strictEqual(r.masteryReport, null);
      assert.ok(!('score_percent' in r.userCorrection.feedback));
    }
  }
  assert.strictEqual(s.phase, 'WRAP');
  assert.strictEqual(r.masteryReport.total_questions, GOALS.length * 3);
  assert.ok(r.masteryReport.per_goal.every(g => g.asked === 3 && g.recall_passed));
  assert.strictEqual(r.mastery_confirmed, true);
  assert.strictEqual(r.all_goals_completed, true);
  assert.match(r.messages[0].message, /100%/);
});

test('a hinted retry teaches without increasing earned score or duplicating question counts', async () => {
  let r = await turn({ ...S.initialState(GOALS.length), phase: 'DIALOGUE' }, 'a wrong concept', {
    is_correct: false, error_type: 'Conceptual', complete_answer: GOALS[0].description,
    feedback: 'A characteristic property is needed to identify a substance.'
  });
  assert.strictEqual(r.nextState.perGoal[0].total, 1);
  assert.strictEqual(r.nextState.questionAssisted, true);
  assert.strictEqual(r.userCorrection.emoji, '😅');
  assert.match(r.userCorrection.feedback.explanation, /characteristic/);
  r = await turn(r.nextState, 'the correct answer after the explanation');
  assert.strictEqual(r.nextState.phase, 'CHECK');
  assert.strictEqual(r.nextState.perGoal[0].total, 1);
  assert.strictEqual(r.nextState.perGoal[0].correct, 0);
});

test('round-up grades the recall pointer and ignores old option letters/numbers', async () => {
  const state = { ...S.initialState(GOALS.length), phase: 'ROUNDUP', goalIndex: 2, roundupIndex: 0,
    lastQuestionOptions: null, lastQuestionType: 'open' };
  const r = await processTutorTurn({ currentState: state, topic: TOPIC, goals: GOALS, studentMessage: '2',
    chatHistory: [{ sender: 'ai', message: 'Which option?', options: [{ text: 'Old A' }, { text: 'Old B' }] }] });
  const call = evaluatorCalls.at(-1);
  assert.strictEqual(call.currentGoal.id, GOALS[0].id);
  assert.strictEqual(call.goalIndex, 0);
  assert.strictEqual(call.lastQuestionOptions, null);
  assert.strictEqual(call.studentMessage, '2');
  assert.strictEqual(r.nextState.perGoal[0].total, 1);
  assert.strictEqual(r.nextState.perGoal[2].total, 0);
  assert.strictEqual(generatorCalls.at(-1).currentGoalTitle, GOALS[1].title);
  assert.strictEqual(r.stateInstruction, 'roundup_recall');
  assert.deepStrictEqual(r.attachments, []);
});

test('unavailable grading provides neutral feedback and never creates score evidence', async () => {
  const r = await turn({ ...S.initialState(GOALS.length), phase: 'ROUNDUP' }, 'friction', {
    is_correct: null, score_percent: null, evaluation_status: 'unavailable' });
  assert.strictEqual(r.nextState.phase, 'ROUNDUP');
  assert.strictEqual(r.nextState.perGoal[0].total, 0);
  assert.strictEqual(r.gradedThisTurn, false);
  assert.strictEqual(r.userCorrection.feedback.is_correct, null);
  assert.ok(!('score_percent' in r.userCorrection.feedback));
  assert.strictEqual(r.stateInstruction, 'reask_shorter');
  assert.strictEqual(r.nextState.questionAssisted, false);
});

test('generator outage retains an answerable source-grounded question and private rubric', async () => {
  generatorUnavailable = true;
  try {
    const r = await turn({ ...S.initialState(GOALS.length), phase: 'DIALOGUE' }, 'complete answer');
    assert.strictEqual(r.nextState.phase, 'CHECK');
    assert.strictEqual(r.questionType, 'open');
    assert.ok(r.messages.at(-1).message.endsWith('?'));
    assert.ok(!r.messages.some(m => m.options));
    assert.strictEqual(r.nextState.lastQuestionRubric.model_answer, GOALS[0].description);
  } finally { generatorUnavailable = false; }
});

test('closed sessions reuse reports and revision sheets without fresh evaluator or generator calls', async () => {
  let r = await turn({ ...S.initialState(GOALS.length), totalTurns: S.MAX_TURNS - 1, phase: 'DIALOGUE' }, 'complete answer');
  assert.strictEqual(r.nextState.phase, 'WRAP');
  assert.ok(r.revisionSheet);
  const counts = [evaluatorCalls.length, generatorCalls.length];
  const report = r.masteryReport;
  const sheet = r.revisionSheet;
  r = await turn(r.nextState, 'next');
  assert.strictEqual(r.nextState.phase, 'DONE');
  assert.deepStrictEqual([evaluatorCalls.length, generatorCalls.length], counts);
  assert.strictEqual(r.masteryReport, report);
  assert.strictEqual(r.revisionSheet, sheet);
  assert.strictEqual(r.all_goals_completed, false);
  assert.strictEqual(r.userCorrection, null);
});
