const test = require("node:test");
const assert = require("node:assert");
const S = require("./state");

const run = (s, events) => events.reduce((st, e) => S.advance(st, e), s);
const correct = { intent: "ANSWER", correct: true };
const wrong = { intent: "ANSWER", correct: false };

test("GREET is exited once the first question is answered", () => {
  assert.strictEqual(S.advance(S.initialState(5), correct).phase, "TEACH");
});

test("WRAP reaches DONE — the session can end", () => {
  let s = S.initialState(2);
  for (let i = 0; i < 30 && s.phase !== "DONE"; i++) s = S.advance(s, correct);
  assert.strictEqual(s.phase, "DONE");
  assert.strictEqual(s.endedReason, "complete");
});

test("a wrong answer does not advance the goal or spend budget", () => {
  const s = S.advance(S.initialState(3), wrong);
  assert.strictEqual(s.totalQuestions, 0, "a wrong answer spent budget");
  assert.strictEqual(s.reteachPending, true);
});

test("both teaching tiers are reachable", () => {
  let s = S.initialState(3);
  s = S.advance(s, wrong);
  assert.strictEqual(S.instructionFor(s, { intent: "ANSWER" }), "correct_and_reask");
  s = S.advance(s, wrong);
  assert.strictEqual(S.instructionFor(s, { intent: "ANSWER" }), "reteach_new_angle");
});

test("a student is never trapped on one question", () => {
  let s = S.initialState(3);
  for (let i = 0; i < S.MAX_ATTEMPTS; i++) s = S.advance(s, wrong);
  assert.strictEqual(s.totalQuestions, 1, "never moved on after MAX_ATTEMPTS");
  assert.strictEqual(s.consecutiveWrong, 0);
});

test("non-answers never advance phase, goal or budget", () => {
  const base = { ...S.initialState(3), phase: "TEACH", questionsThisGoal: 1, totalQuestions: 4 };
  for (const intent of ["ACK", "HELP", "IDK"]) {
    const s = S.advance(base, { intent });
    assert.strictEqual(s.phase, base.phase, `${intent} moved the phase`);
    assert.strictEqual(s.goalIndex, base.goalIndex, `${intent} moved the goal`);
    assert.strictEqual(s.totalQuestions, base.totalQuestions, `${intent} spent budget`);
  }
});

test("every goal is taught, whatever the topic size", () => {
  for (const total of [1, 2, 3, 5, 8, 12]) {
    let s = S.initialState(total);
    const seen = new Set();
    for (let i = 0; i < 300 && s.phase !== "DONE"; i++) {
      if (s.phase === "GREET" || s.phase === "TEACH") seen.add(s.goalIndex);
      s = S.advance(s, correct);
    }
    assert.strictEqual(seen.size, total, `only ${seen.size}/${total} goals taught`);
  }
});

test("the question budget is never exceeded", () => {
  for (const total of [1, 3, 5, 8, 12]) {
    let s = S.initialState(total);
    for (let i = 0; i < 300 && s.phase !== "DONE"; i++) {
      s = S.advance(s, { intent: "ANSWER", correct: i % 3 !== 0 });
      assert.ok(s.totalQuestions <= S.TOTAL_QUESTION_BUDGET, `budget blown: ${s.totalQuestions}`);
    }
  }
});

test("three off-topic answers close the session politely", () => {
  const s = run(S.initialState(3), Array(3).fill({ intent: "ANSWER", offTopic: true }));
  assert.strictEqual(s.phase, "WRAP");
  assert.strictEqual(s.endedReason, "off_topic");
  assert.strictEqual(S.instructionFor(s, {}), "close_off_topic");
});

test("one on-topic answer resets the off-topic streak", () => {
  const s = run(S.initialState(3), [
    { intent: "ANSWER", offTopic: true },
    { intent: "ANSWER", offTopic: true },
    correct,
  ]);
  assert.strictEqual(s.offTopicStreak, 0);
});

test("a struggling student is never closed on", () => {
  let s = S.initialState(3);
  for (let i = 0; i < 20 && s.phase !== "DONE"; i++) s = S.advance(s, wrong);
  assert.notStrictEqual(s.endedReason, "off_topic");
});

test("advance never mutates its input", () => {
  const s = S.initialState(3);
  const before = JSON.stringify(s);
  S.advance(s, correct);
  assert.strictEqual(JSON.stringify(s), before);
});

test("every reachable state yields an instruction", () => {
  let s = S.initialState(4);
  for (let i = 0; i < 80; i++) {
    for (const intent of ["ANSWER", "ACK", "HELP", "IDK"]) {
      const ins = S.instructionFor(s, { intent });
      assert.ok(typeof ins === "string" && ins, `no instruction for ${s.phase}/${intent}`);
    }
    s = S.advance(s, { intent: "ANSWER", correct: i % 3 !== 0 });
  }
});

test("fuzz: 2000 mixed sessions always terminate and stay in budget", () => {
  const intents = ["ANSWER", "ANSWER", "ANSWER", "ACK", "HELP", "IDK"];
  for (let seed = 0; seed < 2000; seed++) {
    let s = S.initialState(1 + (seed % 9));
    let answers = 0;
    let i = 0;
    for (; i < 500 && s.phase !== "DONE"; i++) {
      const intent = intents[(seed * 7 + i * 3) % intents.length];
      if (intent === "ANSWER") answers++;
      s = S.advance(s, {
        intent,
        correct: (seed + i) % 4 !== 0,
        offTopic: (seed + i) % 37 === 0,
      });
      assert.ok(s.totalQuestions <= S.TOTAL_QUESTION_BUDGET, `seed ${seed}: budget ${s.totalQuestions}`);
      assert.ok(s.goalIndex < s.goalTotal, `seed ${seed}: goal index ${s.goalIndex}/${s.goalTotal}`);
    }
    // A session made only of non-answers legitimately never ends; one that
    // received real answers must.
    if (answers > 40) assert.strictEqual(s.phase, "DONE", `seed ${seed}: no termination`);
  }
});

test("instructionFor(post-advance) does not carry a re-teach into a correct answer", () => {
  // A student asks for help, then answers correctly. Reading the state that
  // went INTO advance would tell the tutor to correct a mistake that isn't there.
  let s = S.advance(S.initialState(3), { intent: "HELP" });
  assert.strictEqual(S.instructionFor(s, { intent: "HELP" }), "explain_differently");

  const stale = S.instructionFor(s, { intent: "ANSWER" });
  const fresh = S.instructionFor(S.advance(s, correct), { intent: "ANSWER" });
  assert.strictEqual(stale, "correct_and_reask", "pre-advance state is stale, as documented");
  assert.notStrictEqual(fresh, "correct_and_reask", "post-advance must not correct a right answer");
  assert.strictEqual(fresh, "acknowledge_and_ask_next");
});
