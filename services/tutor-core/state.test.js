const test = require("node:test");
const assert = require("node:assert");
const S = require("./state");
const { buildReport, reportBrief } = require("./summary");

const right = { intent: "ANSWER", correct: true };
const wrong = { intent: "ANSWER", correct: false, errorType: "Conceptual Error" };
const goals = (n) => Array.from({ length: n }, (_, i) => ({ title: `Goal ${i + 1}` }));

/** Play a cooperative session to completion. */
function playThrough(goalTotal, outcomes = [true]) {
  let s = S.initialState(goalTotal);
  const trace = [];
  let i = 0;
  while (s.phase !== "DONE" && i < 200) {
    const scored = S.isScored(s.phase);
    const ok = scored ? outcomes[i % outcomes.length] : true;
    trace.push({ phase: s.phase, type: S.questionTypeFor(s.phase), scored });
    s = S.advance(s, { intent: "ANSWER", correct: ok, errorType: ok ? null : "Conceptual Error" });
    i++;
  }
  return { state: s, trace };
}

// ── the session shape ──────────────────────────────────────────────────────
test("the session runs probe, theory, objectives, then teaching", () => {
  const { trace } = playThrough(3);
  assert.deepStrictEqual(
    trace.slice(0, 4).map((t) => t.phase),
    ["PROBE", "THEORY", "OBJECTIVES", "DIALOGUE"]
  );
});

test("the opening probe is never scored", () => {
  assert.strictEqual(S.isScored("PROBE"), false);
  const s = S.advance(S.initialState(3), { intent: "ANSWER", correct: false, errorType: "X" });
  assert.strictEqual(s.perGoal[0].total, 0, "the probe counted against mastery");
  assert.strictEqual(s.phase, "THEORY");
});

test("multiple choice appears only as assessment, never as teaching", () => {
  for (const p of S.PHASES) {
    const t = S.questionTypeFor(p);
    if (t === "mcq") assert.strictEqual(p, "CHECK", `${p} asked multiple choice`);
  }
  const { trace } = playThrough(4);
  const mcq = trace.filter((t) => t.type === "mcq");
  assert.ok(mcq.length > 0, "no assessment happened at all");
  assert.ok(mcq.every((t) => t.phase === "CHECK"));
});

test("most questions are written answers, not clicks", () => {
  const { trace } = playThrough(5);
  const asked = trace.filter((t) => t.type);
  const open = asked.filter((t) => t.type === "open").length;
  assert.ok(open / asked.length >= 0.6, `only ${open}/${asked.length} were written`);
});

test("theory carries a diagram and key points; wrap carries the report", () => {
  assert.deepStrictEqual(S.attachmentsFor({ phase: "THEORY" }), ["diagram", "key_points"]);
  assert.deepStrictEqual(S.attachmentsFor({ phase: "WRAP" }), ["revision_sheet", "mastery_report"]);
  assert.deepStrictEqual(S.attachmentsFor({ phase: "OBJECTIVES" }), ["objectives"]);
});

test("a video appears only when a struggling student opens a goal", () => {
  assert.deepStrictEqual(S.attachmentsFor({ phase: "DIALOGUE", openThisGoal: 0, consecutiveWrong: 1 }), ["video"]);
  assert.deepStrictEqual(S.attachmentsFor({ phase: "DIALOGUE", openThisGoal: 0, consecutiveWrong: 0 }), []);
  assert.deepStrictEqual(S.attachmentsFor({ phase: "DIALOGUE", openThisGoal: 1, consecutiveWrong: 2 }), []);
});

test("every goal is taught, and the session ends", () => {
  for (const n of [1, 3, 5, 8]) {
    const { state, trace } = playThrough(n);
    assert.strictEqual(state.phase, "DONE", `${n} goals: no termination`);
    assert.strictEqual(state.perGoal.filter((g) => g.total > 0).length, n, `${n} goals: some untaught`);
    assert.ok(trace.length < S.MAX_TURNS, `${n} goals: took ${trace.length} turns`);
  }
});

test("a student who never answers still reaches a summary", () => {
  let s = S.initialState(5);
  for (let i = 0; i < 300 && s.phase !== "DONE"; i++) {
    s = S.advance(s, { intent: "IDK" });
    s = { ...s, lastInstruction: S.instructionFor(s, { intent: "IDK" }) };
  }
  assert.strictEqual(s.phase, "DONE");
  // The stuck-student escape walks the arc to its proper end rather than
  // letting the turn cap cut the session off, so this now ends "complete".
  assert.strictEqual(s.endedReason, "complete");
  const r = buildReport(s, goals(5));
  assert.strictEqual(r.per_goal.length, 5);
  assert.strictEqual(r.not_covered.length, 5, "nothing was answered, so nothing was covered");
});

test("the turn cap still stops a session that would otherwise run forever", () => {
  // Off-topic strikes close at 3, and answers advance, so the cap is reached
  // by a student who keeps answering an unbounded topic. Force the condition
  // directly: the cap must hold regardless of how the session got there.
  let s = { ...S.initialState(5), totalTurns: S.MAX_TURNS - 1 };
  s = S.advance(s, { intent: "ANSWER", correct: true });
  assert.strictEqual(s.phase, "WRAP");
  assert.strictEqual(s.endedReason, "turn_limit");
});

// ── the rules that were breaking sessions ──────────────────────────────────
test("non-answers never advance the phase or the goal", () => {
  const base = { ...S.initialState(3), phase: "DIALOGUE", openThisGoal: 1 };
  for (const intent of ["ACK", "HELP", "IDK"]) {
    const s = S.advance(base, { intent });
    assert.strictEqual(s.phase, "DIALOGUE", `${intent} moved the phase`);
    assert.strictEqual(s.openThisGoal, 1, `${intent} spent a question`);
    assert.strictEqual(s.perGoal[0].total, 0, `${intent} was scored`);
  }
});

test("a wrong answer re-teaches, and both teaching tiers are reachable", () => {
  let s = { ...S.initialState(3), phase: "DIALOGUE" };
  s = S.advance(s, wrong);
  assert.strictEqual(s.phase, "DIALOGUE");
  assert.strictEqual(S.instructionFor(s, { intent: "ANSWER" }), "correct_and_reask");
  s = S.advance(s, wrong);
  assert.strictEqual(S.instructionFor(s, { intent: "ANSWER" }), "reteach_new_angle");
});

test("three off-topic answers close the session with a report", () => {
  let s = S.initialState(3);
  for (let i = 0; i < 3; i++) s = S.advance(s, { intent: "ANSWER", offTopic: true });
  assert.strictEqual(s.phase, "WRAP");
  assert.strictEqual(s.endedReason, "off_topic");
});

test("the options offered are carried into state for the next turn", () => {
  const opts = [{ text: "Calcium carbonate", value: "A" }];
  const s = S.advance({ ...S.initialState(3), phase: "CHECK" }, { intent: "ANSWER", correct: true, questionOptions: opts });
  assert.deepStrictEqual(s.lastQuestionOptions, opts, "options lost — a letter cannot be resolved");
});

test("advance never mutates its input, including the tallies", () => {
  const s = { ...S.initialState(3), phase: "DIALOGUE" };
  const before = JSON.stringify(s);
  S.advance(s, wrong);
  assert.strictEqual(JSON.stringify(s), before);
});

// ── the report ─────────────────────────────────────────────────────────────
test("mastery is computed from what happened, and adds up", () => {
  const { state } = playThrough(4, [true, true, true, false]);
  const r = buildReport(state, goals(4));
  assert.strictEqual(r.questions_correct + (r.questions_asked - r.questions_correct), r.questions_asked);
  assert.ok(r.overall_mastery_percent >= 0 && r.overall_mastery_percent <= 100);
  const accounted = r.learned_well.length + r.areas_to_improve.length + r.not_covered.length;
  assert.strictEqual(accounted, 4, "goals unaccounted for");
});

test("key errors count every occurrence, not one per goal", () => {
  let s = { ...S.initialState(2), phase: "DIALOGUE" };
  for (let i = 0; i < 2; i++) s = S.advance(s, wrong);
  const r = buildReport(s, goals(2));
  const conceptual = r.key_errors.find((e) => e.type === "Conceptual Error");
  assert.strictEqual(conceptual.count, 2, "repeated errors were deduped away");
});

test("a perfect session reports full mastery, a failed one does not", () => {
  const perfect = buildReport(playThrough(3, [true]).state, goals(3));
  assert.strictEqual(perfect.overall_mastery_percent, 100);
  assert.strictEqual(perfect.overall_band, "Mastered");
  assert.strictEqual(perfect.areas_to_improve.length, 0);

  const poor = buildReport(playThrough(3, [false, false, false, true]).state, goals(3));
  assert.ok(poor.overall_mastery_percent < 60, `got ${poor.overall_mastery_percent}%`);
  assert.ok(poor.areas_to_improve.length > 0);
  assert.ok(poor.key_errors.length > 0);
});

test("a goal never covered is reported as not covered, not as zero mastery", () => {
  let s = S.initialState(4);
  for (let i = 0; i < 3; i++) s = S.advance(s, right); // probe, theory, objectives only
  const r = buildReport(s, goals(4));
  assert.strictEqual(r.not_covered.length, 4);
  assert.strictEqual(r.learned_well.length, 0);
  assert.strictEqual(r.areas_to_improve.length, 0, "uncovered goals must not look like failures");
});

test("the brief handed to the model carries no figure it could contradict", () => {
  const r = buildReport(playThrough(3, [true, false]).state, goals(3));
  const b = reportBrief(r);
  assert.strictEqual(b.overall_mastery_percent, r.overall_mastery_percent);
  assert.deepStrictEqual(Object.keys(b).sort(), [
    "goals_covered", "goals_total", "overall_mastery_percent", "strongest", "top_error", "weakest",
  ]);
});

test("every reachable state yields an instruction", () => {
  let s = S.initialState(4);
  for (let i = 0; i < 60; i++) {
    for (const intent of ["ANSWER", "ACK", "HELP", "IDK"]) {
      const ins = S.instructionFor(s, { intent });
      assert.ok(typeof ins === "string" && ins, `no instruction for ${s.phase}/${intent}`);
    }
    s = S.advance(s, { intent: "ANSWER", correct: i % 3 !== 0, errorType: "Conceptual Error" });
  }
});
