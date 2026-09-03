/**
 * Regression fixtures — real sessions that shipped broken, replayed forever.
 *
 * Every case here is a transcript a student actually saw. They exist so that
 * the same failure cannot ship twice, and so that a refactor that quietly
 * reintroduces one fails loudly instead of reaching a classroom.
 */

const test = require("node:test");
const assert = require("node:assert");
const S = require("./state");
const { applyGradingGuards, LANGUAGE_ONLY_ERRORS } = require("./evaluator-guards");

/** Play a list of turns the way the orchestrator does, recording instructions. */
function replay(turns, goalTotal = 5) {
  let s = S.initialState(goalTotal);
  const trace = [];
  for (const t of turns) {
    s = S.advance(s, t);
    const instruction = S.instructionFor(s, { intent: t.intent });
    s = { ...s, lastInstruction: instruction };
    trace.push({ said: t.label, phase: s.phase, instruction });
  }
  return { state: s, trace };
}

// ── "Nature – Our Science Laboratory", user 92 ─────────────────────────────
// The tutor answered three turns running with the identical two bubbles:
//   "Today you'll learn how to identify substances by their reactions."
//   "What do you think happens when you mix baking soda and lemon juice?"
// because the evaluator returned HELP_REQUEST, nothing in the state machine
// matched it, and the turn fell through to the OBJECTIVES phase default.
const LIVE_SESSION = [
  { intent: "ANSWER", correct: true, label: "It is creating carbon dioxide" },
  { intent: "ANSWER", correct: false, errorType: "Spelling", label: "It is increase" },
  { intent: "HELP_REQUEST", label: "I don't know" },
  { intent: "HELP_REQUEST", label: "I don't know" },
  { intent: "ANSWER", correct: true, label: "Carbon dioxide is created" },
];

test("the live session no longer repeats itself", () => {
  const { trace } = replay(LIVE_SESSION);
  for (let i = 1; i < trace.length; i++) {
    assert.notStrictEqual(
      trace[i].instruction,
      trace[i - 1].instruction,
      `turn ${i + 1} repeats "${trace[i].instruction}" after "${trace[i - 1].said}"`
    );
  }
});

test("HELP_REQUEST is understood, not ignored", () => {
  assert.strictEqual(S.normalizeIntent("HELP_REQUEST"), "HELP");
  assert.strictEqual(S.normalizeIntent("GIBBERISH"), "OFF_TOPIC");
  assert.strictEqual(S.normalizeIntent("IDK"), "IDK");

  // The exact failure: an unmatched intent falling through to the phase default.
  const s = { ...S.initialState(5), phase: "OBJECTIVES", lastInstruction: "state_objectives" };
  const ins = S.instructionFor(s, { intent: "HELP_REQUEST" });
  assert.notStrictEqual(ins, "state_objectives", "HELP_REQUEST still falls through");
});

test("an unknown intent asks for help rather than repeating the phase", () => {
  const s = { ...S.initialState(5), phase: "OBJECTIVES", lastInstruction: "state_objectives" };
  assert.strictEqual(S.normalizeIntent("SOMETHING_NEW"), "HELP");
  assert.notStrictEqual(S.instructionFor(s, { intent: "SOMETHING_NEW" }), "state_objectives");
});

test("a stuck student is always given something they can write", () => {
  let s = S.initialState(3);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    s = S.advance(s, { intent: "IDK" });
    const ins = S.instructionFor(s, { intent: "IDK" });
    s = { ...s, lastInstruction: ins };
    seen.push(ins);
  }
  assert.ok(
    seen.includes("give_starter") || seen.includes("reveal_and_move_on"),
    `never offered a way in: ${seen.join(", ")}`
  );
});

test("saying 'I don't know' forever still finishes the session", () => {
  let s = S.initialState(4);
  for (let i = 0; i < 200 && s.phase !== "DONE"; i++) {
    s = S.advance(s, { intent: "HELP_REQUEST" });
    s = { ...s, lastInstruction: S.instructionFor(s, { intent: "HELP_REQUEST" }) };
  }
  assert.strictEqual(s.phase, "DONE", "a silent student never reaches a summary");
});

// ── "It is increase" marked wrong ──────────────────────────────────────────
// The student had the concept right and the grammar wrong. They got a red
// strikethrough and a crying face.
test("grammar is never the reason an answer is wrong", () => {
  for (const reason of LANGUAGE_ONLY_ERRORS) {
    const graded = applyGradingGuards({
      intent: "ANSWER",
      is_correct: false,
      score_percent: 40,
      error_type: reason,
      diff_html: "<del>It is increase</del><ins>It will fizz more</ins>",
      reasoning: "",
    });
    assert.strictEqual(graded.is_correct, true, `"${reason}" still marks the student wrong`);
    assert.strictEqual(graded.diff_html, null, `"${reason}" still shows a correction`);
    assert.ok(graded.score_percent >= 80);
  }
});

test("a genuinely wrong answer is still marked wrong", () => {
  const graded = applyGradingGuards({
    intent: "ANSWER",
    is_correct: false,
    score_percent: 20,
    error_type: "Conceptual",
    diff_html: "<del>hydrogen</del><ins>carbon dioxide</ins>",
    reasoning: "",
  });
  assert.strictEqual(graded.is_correct, false, "the guard swallowed a real error");
  assert.ok(graded.diff_html);
});

test("a correct answer passes through the guard untouched", () => {
  const input = { intent: "ANSWER", is_correct: true, score_percent: 95, error_type: null, diff_html: null };
  assert.deepStrictEqual(applyGradingGuards(input), input);
});

// ── the 😢 on an unscored prediction ───────────────────────────────────────
test("only assessed phases can produce a correction", () => {
  assert.strictEqual(S.isScored("PROBE"), false);
  assert.strictEqual(S.isScored("THEORY"), false);
  assert.strictEqual(S.isScored("OBJECTIVES"), false);
  assert.strictEqual(S.isScored("DIALOGUE"), true);
  assert.strictEqual(S.isScored("CHECK"), true);
});

// ── the polite close that never fired ──────────────────────────────────────
test("off-topic strikes actually count and close the session", () => {
  let s = S.initialState(3);
  for (let i = 0; i < 3; i++) s = S.advance(s, { intent: "GIBBERISH" });
  assert.strictEqual(s.offTopicStreak, 3, "the strike counter never moved");
  assert.strictEqual(s.phase, "WRAP");
  assert.strictEqual(s.endedReason, "off_topic");
});

test("an off-topic aside does not end a session on its own", () => {
  let s = S.initialState(3);
  s = S.advance(s, { intent: "OFF_TOPIC" });
  s = S.advance(s, { intent: "ANSWER", correct: true });
  assert.strictEqual(s.offTopicStreak, 0, "one aside is held against the student");
  assert.notStrictEqual(s.phase, "WRAP");
});
