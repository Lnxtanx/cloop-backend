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
const V = require("./validate");
const E = require("./evaluator");
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
      criterion_results: [{ id: "effect", satisfied: true, evidence: "increase", required: true }],
      contradictions: [],
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

// ── Screenshot Failure Regressions ─────────────────────────────────────────

// 1. Toy car with decimal and units
test("regression: toy-car answer with decimal and units is preserved as ANSWER and not severed", () => {
  const resolved = E.resolveOptionAnswer("0.5 N", null);
  assert.strictEqual(resolved.isOption, false);
  const out = V.enforce({
    messages: [{ message: "Which effect of force explains why a slowly moving toy car on the table accelerates when we push it with 0.5 newtons?" }]
  }, { phase: "DIALOGUE", currentGoalTitle: "Effects of force", currentGoalDescription: "A force can change speed" });
  assert.ok(out.questionReplaced);
  assert.ok(!out.messages.at(-1).message.startsWith("5 newtons"));
});

// 2. Box-to-ball switching
test("regression: box-to-ball switching fails scenario validation and triggers grounded replacement", () => {
  const explanation = "A heavy wooden box is resting on the rough floor.";
  const conflictingQuestion = "What happens when the ball is kicked across the grass?";
  assert.strictEqual(V.validateScenarioConsistency(explanation, conflictingQuestion), false);

  const out = V.enforce({
    messages: [
      { message: explanation },
      { message: conflictingQuestion }
    ],
    lastQuestionRubric: { criteria: [{ id: "motion", description: "Motion changes", required: true }], model_answer: "Motion changes" }
  }, { phase: "DIALOGUE", currentGoalTitle: "Friction", currentGoalDescription: "Friction opposes motion" });

  assert.strictEqual(out.questionReplaced, true);
  assert.ok(out.questionRecord);
  assert.strictEqual(out.questionRecord.assisted, false);
});

// 3. Clarification without penalties
test("regression: clarification queries ('Which box?', 'Which ball?', 'What is Goal 1?') carry no penalty", async () => {
  for (const query of ["Which box?", "Which ball?", "What is Goal 1?", "can you clarify the question?"]) {
    const evalRes = await E.evaluateStudentTurn({
      studentMessage: query,
      lastQuestionText: "Does the box move?",
      phase: "DIALOGUE",
      topicTitle: "Forces",
      currentGoal: { title: "Contact forces", description: "Friction is a contact force" }
    });
    assert.strictEqual(evalRes.intent, "HELP");
    assert.strictEqual(evalRes.help_subtype, "question_clarification");
    assert.strictEqual(evalRes.suggested_action, "CLARIFY_QUESTION");

    let s = S.initialState(3);
    s.stuckStreak = 0;
    s.consecutiveWrong = 0;
    const nextS = S.advance(s, evalRes);
    assert.strictEqual(nextS.stuckStreak, 0, "clarification should not increment stuckStreak");
    assert.strictEqual(nextS.consecutiveWrong, 0, "clarification should not increment consecutiveWrong");
    assert.strictEqual(nextS.wantsVideo, false, "clarification should not trigger video");

    const ins = S.instructionFor(nextS, evalRes);
    assert.strictEqual(ins, "clarify_question");
  }
});

// 4. Hidden "why" requirements
test("regression: visible classification question does not fail on unasked why/explanation requirements", async () => {
  const question = "Is friction a contact or non-contact force?";
  const alignment = E.validateQuestionRubricAlignment(question, {
    criteria: [{ id: "why", description: "Explain why surfaces interact", required: true }],
    model_answer: "Explain why surfaces interact"
  });
  assert.strictEqual(alignment.aligned, false);
});

// 5. Generic Goal questions
test("regression: buildFocusedFallback never produces generic Goal questions or unbacked formulas", () => {
  const fallbackGeneric = V.buildFocusedFallback({
    currentGoalTitle: "Goal 1",
    currentGoalDescription: "Friction opposes motion between surfaces",
    topicTitle: "Friction"
  });
  const qText = fallbackGeneric.messages[0].message;
  assert.ok(!qText.includes("Goal 1"), "fallback must never expose internal goal label 'Goal 1'");
  assert.ok(!qText.includes("any formula with units"), "fallback must not demand unsupported formulas");
  assert.match(qText, /friction/i);
});

// 6. Incomplete corrections
test("regression: incomplete corrections are omitted rather than severed mid-word", () => {
  const fullAnswer = "Signs of a chemical reaction include a change in colour, evolution of gas, change in temperature, or formation of a precipitate.";
  const diffHtml = `<del>fizz</del><ins>${fullAnswer}</ins>`;
  const sanitized = V.sanitizeDiffHtml(diffHtml, "fizz");
  assert.strictEqual(sanitized, null, "unsuitable short diff should be omitted, leaving complete_answer intact");
});

// 7. Double-escaped apostrophes
test("regression: apostrophes are never double-escaped (don't -> don&#39;t, not don&amp;#39;t)", () => {
  assert.strictEqual(V.escapeHtml("don't"), "don&#39;t");
  assert.strictEqual(V.escapeHtml("don&#39;t"), "don&#39;t");
  assert.strictEqual(V.escapeHtml("don&amp;#39;t"), "don&#39;t");
  assert.strictEqual(E.escapeHtml("don't"), "don&#039;t");
  assert.strictEqual(E.escapeHtml("don&#039;t"), "don&#039;t");
  assert.strictEqual(E.escapeHtml("don&amp;#039;t"), "don&#039;t");
});

// 8. Topic heading fallback cleaning & no double question marks (??)
test("regression: cleanConceptHeading strips Topic/Goal prefixes and prevents ??", () => {
  assert.strictEqual(V.cleanConceptHeading("Topic 3: Objects interacting with other objects?", "Forces"), "Objects interacting with other objects");
  assert.strictEqual(V.cleanConceptHeading("Goal 1: Newton's Third Law", "Forces"), "Newton's Third Law");
  assert.strictEqual(V.cleanConceptHeading("Chapter 2 - Action and Reaction", "Forces"), "Action and Reaction");

  const fallbackWithTopic = V.buildFocusedFallback({
    currentGoalTitle: "Topic 3: Objects interacting with other objects?",
    currentGoalDescription: "Forces occur in matched interaction pairs",
    topicTitle: "Forces"
  });
  const qText = fallbackWithTopic.messages[0].message;
  assert.ok(!qText.includes("Topic 3:"), "question should never include 'Topic 3:' prefix");
  assert.ok(!qText.includes("??"), "question should never end in double question marks ??");
  assert.ok(qText.endsWith("?"), "question should end with a single question mark");

  const questionHeading = V.buildFocusedFallback({
    currentGoalTitle: "What is inertia?",
    currentGoalDescription: "Inertia is the tendency of an object to resist changes in motion",
    topicTitle: "Laws of Motion"
  });
  const qText2 = questionHeading.messages[0].message;
  assert.strictEqual(qText2, "What is inertia?", "pre-phrased question heading should not be wrapped with 'What is meant by What is...'");
});

// 9. Separating learning objectives from factual definitions in model answers
test("regression: cleanObjectiveText strips pedagogical imperative verbs from model answers", () => {
  const objective = "Identify the two or more objects interacting in each situation and describe the force.";
  const cleaned = V.cleanObjectiveText(objective);
  assert.ok(!cleaned.toLowerCase().startsWith("identify"), "pedagogical imperative 'identify' should be stripped");
  assert.strictEqual(cleaned, "Two or more objects interacting in each situation.");

  const understandObjective = "Understand that action and reaction act on different bodies simultaneously.";
  const cleaned2 = V.cleanObjectiveText(understandObjective);
  assert.strictEqual(cleaned2, "Action and reaction act on different bodies simultaneously.");

  const fallback = V.buildFocusedFallback({
    currentGoalTitle: "Interacting objects",
    currentGoalDescription: "Identify the two or more objects interacting in each situation and describe the force.",
    academicNotes: { definition: "When one object exerts a force on another, the second exerts an equal and opposite force on the first." }
  });
  assert.strictEqual(fallback.lastQuestionRubric.model_answer, "When one object exerts a force on another, the second exerts an equal and opposite force on the first.");
});

// 10. Preserve teaching explanations on HELP/IDK in ROUNDUP
test("regression: enforce in ROUNDUP preserves generator explanation on HELP/IDK turn", () => {
  const rawOutput = {
    messages: [
      { message: "When you push against a wall, the wall pushes back on you with equal force." },
      { message: "What force does the wall exert in return?" }
    ]
  };
  const enforced = V.enforce(rawOutput, {
    phase: "ROUNDUP",
    currentGoalTitle: "Newton's Third Law",
    currentGoalDescription: "Action and reaction forces are equal in magnitude and opposite in direction",
    isHelpOrIdk: true,
    sameAssessment: false,
    stateInstruction: "hint_then_easier"
  });

  assert.ok(enforced.messages.length >= 1, "explanation bubble must be preserved on HELP/IDK turn");
  assert.strictEqual(enforced.questionType, "none", "HELP should explain without another compulsory recall question");
  assert.strictEqual(enforced.messages[0].message, "When you push against a wall, the wall pushes back on you with equal force.");
  assert.strictEqual(enforced.questionAssisted, true);
});

// 11. Hand/wall suddenly becomes hand/desk: scenario conflict detection across question and rubric
test("regression: scenario consistency detects conflicting surfaces between explanation, question, and rubric", () => {
  const explanation = "When your hand pushes against the wall with 10 newtons of force.";
  const questionDesk = "What force does the desk exert on your hand?";
  assert.strictEqual(V.validateScenarioConsistency(explanation, questionDesk), false, "wall vs desk must trigger scenario inconsistency");

  const questionWall = "What force does the wall exert on your hand?";
  const rubricDesk = {
    criteria: [{ id: "force", description: "Desk exerts equal force", required: true }],
    model_answer: "The desk exerts 10 newtons on your hand."
  };
  assert.strictEqual(V.validateScenarioConsistency(null, questionWall, rubricDesk), false, "question (wall) vs rubric (desk) must fail scenario consistency");

  const rubricWall = {
    criteria: [{ id: "force", description: "Wall exerts equal force", required: true }],
    model_answer: "The wall exerts 10 newtons on your hand."
  };
  assert.strictEqual(V.validateScenarioConsistency(explanation, questionWall, rubricWall), true, "matching wall scenario across all components passes");
});

// 12. Evaluator validates saved scenario alignment
test("regression: evaluator validateQuestionRubricAlignment detects conflict with saved scenario", () => {
  const question = "What force does the desk exert on your hand?";
  const rubric = {
    criteria: [{ id: "force", description: "Equal force", required: true }],
    model_answer: "Equal force"
  };
  const savedScenario = { object: "wall", summary: "hand pushes wall" };

  const alignment = E.validateQuestionRubricAlignment(question, rubric, savedScenario);
  assert.strictEqual(alignment.aligned, false);
  assert.ok(alignment.reason.includes("conflicts with saved scenario"));
});

// 13. Question record is rebuilt from final delivered bubble after fallback
test("regression: questionRecord matches delivered final bubble when fallback replaces an overlong question", () => {
  const overlong = "Can you describe what happens to the motion and speed of an object when a balanced or unbalanced force acts upon it in various real-world situations?";
  const enforced = V.enforce({
    messages: [{ message: overlong }]
  }, {
    phase: "DIALOGUE",
    currentGoalTitle: "Balanced forces",
    currentGoalDescription: "Balanced forces produce no change in motion"
  });

  assert.strictEqual(enforced.questionReplaced, true);
  const deliveredFinal = enforced.messages.at(-1).message;
  assert.ok(enforced.questionRecord);
  assert.strictEqual(enforced.questionRecord.questionText, deliveredFinal, "questionRecord.questionText must match the delivered final bubble");
  assert.ok(!enforced.questionRecord.questionText.includes("real-world situations"));
});

// 14. HTML entity unescaping in chat prose
test("regression: cleanProse unescapes HTML entities so &#39; is not rendered literally", () => {
  assert.strictEqual(V.cleanProse("Don&#39;t push too hard."), "Don't push too hard.");
  assert.strictEqual(V.cleanProse("It&quot;s a contact force."), 'It"s a contact force.');
  assert.strictEqual(V.cleanProse("Salt &amp; water"), "Salt & water");
});
