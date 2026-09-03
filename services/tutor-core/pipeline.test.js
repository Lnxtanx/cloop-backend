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

// ── stub the two model-backed steps ────────────────────────────────────────
const evaluatorPath = require.resolve("./evaluator");
const generatorPath = require.resolve("./tutor-generator");

let nextVerdict = null;
const generatorCalls = [];

require.cache[evaluatorPath] = {
  id: evaluatorPath,
  filename: evaluatorPath,
  loaded: true,
  exports: {
    evaluateStudentTurn: async () => nextVerdict,
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
      return {
        messages: [{ message: `Reply for ${params.stateInstruction}?`, message_type: "text" }],
      };
    },
  },
};

const { processTutorTurn } = require("./orchestrator");
const S = require("./state");

const TOPIC = { id: 1, title: "Nature – Our Science Laboratory", content: "" };
const GOALS = [
  { id: 1, title: "Identify substances" },
  { id: 2, title: "Describe testing methods" },
  { id: 3, title: "Demonstrate experimentation" },
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

// ── the 😢 on a prediction that was never assessed ─────────────────────────
test("no correction is shown for a phase that does not count toward mastery", async () => {
  for (const phase of ["PROBE", "THEORY", "OBJECTIVES"]) {
    const state = { ...S.initialState(GOALS.length), phase };
    const r = await turn(state, "It is increase", {
      is_correct: false,
      score_percent: 40,
      error_type: "Conceptual",
      diff_html: "<del>It is increase</del><ins>It will fizz more</ins>",
    });
    assert.strictEqual(r.userCorrection, null, `${phase} still shows a red correction`);
    assert.strictEqual(r.gradedThisTurn, false, `${phase} claims to have graded the answer`);
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
});
