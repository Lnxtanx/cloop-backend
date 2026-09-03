/**
 * Adversarial simulation of the session shape.
 *
 * Plays whole sessions and asserts, on every turn, what a student would
 * actually experience — including the three things the last live session got
 * wrong: multiple choice used as teaching, an option letter graded without its
 * text, and a session that ends with no report.
 *
 *   node services/tutor-core/simulate.js --sessions 400 --seed 42
 */

const S = require("./state");
const { buildReport } = require("./summary");

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const TOPICS = [
  { title: "Chemical Properties of Acids and Bases", goals: ["Acid-metal reactions", "Acid-carbonate reactions", "Base-metal reactions", "Gas testing", "Comparing reactivity"] },
  { title: "Friction", goals: ["Identify friction", "Compare surfaces", "Reduce friction", "Friction in daily life"] },
  { title: "Linear Equations", goals: ["Name the unknown", "Isolate the variable", "Check the solution"] },
  { title: "Photosynthesis", goals: ["Inputs", "Outputs", "Chlorophyll", "Limiting factors", "Experiments", "Food chains"] },
];

const ERRORS = ["Conceptual Error", "Calculation Error", "Spelling Error", "Incomplete Answer"];

const STUDENTS = [
  { text: "vinegar reacts with chalk and gives off a gas", intent: "ANSWER", kind: "answer", correct: true },
  { text: "carbon dioxide", intent: "ANSWER", kind: "answer", correct: true },
  { text: "yes salt and water", intent: "ANSWER", kind: "answer", correct: true },
  { text: "hydrogen gas", intent: "ANSWER", kind: "answer", correct: false, errorType: "Conceptual Error" },
  { text: "gas of hydoyeg", intent: "ANSWER", kind: "answer", correct: false, errorType: "Conceptual Error" },
  { text: "ok", intent: "ACK", kind: "stuck" },
  { text: "pls explain", intent: "HELP_REQUEST", kind: "stuck" },
  { text: "i dont know", intent: "IDK", kind: "stuck" },
  { text: "my dog is called rex", intent: "OFF_TOPIC", kind: "offtopic" },
  { text: "asdfghjk", intent: "GIBBERISH", kind: "offtopic" },
];

/**
 * Instructions that just carry on with the lesson plan.
 *
 * If the student said "I don't know" or "explain it" and the tutor answers
 * with one of these, it has ignored them — which is exactly what production
 * did when the two modules disagreed about what an intent is called.
 */
const CARRY_ON = new Set([
  "probe_prior_knowledge", "teach_theory", "state_objectives",
  "open_goal_dialogue", "continue_dialogue", "assess_with_mcq",
]);

const violations = [];
const instructionsSeen = new Set();
const typesByPhase = new Map();
function check(cond, label, detail) {
  if (!cond) violations.push({ label, detail });
}

function runSession(seed, topic) {
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];

  let state = S.initialState(topic.goals.length);
  let turns = 0;
  let prevInstruction = null;
  let longestRepeat = 1;
  let repeatRun = 1;
  let openAsked = 0;
  let mcqAsked = 0;
  let guard = 0;
  const phasesSeen = new Set();

  while (state.phase !== "DONE" && guard++ < 400) {
    const before = state;
    phasesSeen.add(before.phase);

    // The server decides the question type — the model is never asked.
    const qType = S.questionTypeFor(before.phase);
    const scored = S.isScored(before.phase);
    const attachments = S.attachmentsFor(before);
    if (!typesByPhase.has(before.phase)) typesByPhase.set(before.phase, new Set());
    typesByPhase.get(before.phase).add(qType);

    // WRAP asks nothing, so it legitimately has no question type.
    const asksSomething = before.phase !== "WRAP";
    check(asksSomething ? ["open", "mcq"].includes(qType) : qType === null,
      "unexpected question type", `${before.phase}: ${qType}`);
    check(qType === "mcq" ? before.phase === "CHECK" : true,
      "multiple choice outside the assessment phase", `${before.phase}`);
    if (before.phase === "PROBE") check(!scored, "the opening probe was scored", "PROBE");
    if (before.phase === "THEORY") check(attachments.includes("diagram") && attachments.includes("key_points"),
      "theory turn carried no diagram or key points", "THEORY");

    if (qType === "open") openAsked++;
    else if (qType === "mcq") mcqAsked++;

    const student = pick(STUDENTS);
    const instruction = S.instructionFor(before, { intent: student.intent });
    instructionsSeen.add(instruction);
    check(Boolean(instruction), "no instruction for a reachable state", `${before.phase}/${student.intent}`);

    // THE FAILURE THAT SHIPPED. Identical directives produce identical
    // bubbles, and a live student was sent the same two sentences three turns
    // running. Closing instructions are exempt: WRAP says its one thing.
    const closing = instruction === "wrap_with_report" || instruction === "close_off_topic" || instruction === "session_over";
    if (!closing) {
      check(instruction !== prevInstruction,
        "the tutor repeated itself verbatim", `${before.phase}: ${instruction} twice`);
    }
    // A student who says they are stuck must be answered, not read the script.
    //
    // `kind` is the fixture's own ground truth, deliberately NOT derived from
    // the code under test. An earlier version of this check asked the state
    // machine to classify the intent first, which meant a broken classifier
    // silently skipped the check that would have caught it.
    if (student.kind === "stuck") {
      check(!CARRY_ON.has(instruction),
        "the tutor ignored a stuck student and carried on with the lesson",
        `${student.intent} in ${before.phase} → ${instruction}`);
    }

    repeatRun = instruction === prevInstruction ? repeatRun + 1 : 1;
    if (repeatRun > longestRepeat) longestRepeat = repeatRun;
    prevInstruction = instruction;

    // Every non-closing turn must leave the student something to write.
    check(closing || ["open", "mcq"].includes(qType),
      "a turn left the student with nothing to answer", `${before.phase}/${instruction}`);

    state = S.advance({ ...before, lastInstruction: instruction }, {
      intent: student.intent,
      correct: student.correct,
      offTopic: student.offTopic,
      errorType: student.errorType || pick(ERRORS),
      answerText: student.text,
      questionText: `Question about ${topic.goals[before.goalIndex] || topic.title}?`,
      questionOptions: qType === "mcq" ? [{ text: "Calcium carbonate", value: "A" }, { text: "Sodium chloride", value: "B" }] : null,
    });
    turns++;

    if (student.kind !== "answer") {
      // A non-answer holds the phase — unless the student has been stuck for
      // STUCK_LIMIT turns, in which case the tutor gives the answer and moves
      // on rather than looping on a question they cannot begin.
      const held = state.phase === before.phase;
      const closed = before.phase === "WRAP" && state.phase === "DONE";
      const limit = state.endedReason === "turn_limit" || state.endedReason === "off_topic";
      const escaped = state.revealPending === true;
      check(held || closed || limit || escaped,
        `phase advanced on ${student.intent}`, `${before.phase}→${state.phase}`);
      check(state.perGoal[before.goalIndex].total === before.perGoal[before.goalIndex].total,
        `a non-answer was scored`, `${student.intent} in ${before.phase}`);
    }
    check(state.goalIndex < state.goalTotal, "goal index ran past the goal count", `${state.goalIndex}/${state.goalTotal}`);
    check(state.perGoal.length === state.goalTotal, "per-goal tallies lost a goal", "");

    // The options the tutor offered must survive into the next turn, or a
    // letter cannot be resolved to its text before grading.
    if (qType === "mcq") {
      check(Array.isArray(state.lastQuestionOptions) && state.lastQuestionOptions.length > 0,
        "MCQ options were not carried into state", before.phase);
    }
  }

  check(guard < 400, "session never reached DONE", topic.title);

  // ── the report ─────────────────────────────────────────────────────────
  const report = buildReport(state, topic.goals.map((t) => ({ title: t })));
  check(typeof report.overall_mastery_percent === "number", "no mastery percentage", topic.title);
  check(report.overall_mastery_percent >= 0 && report.overall_mastery_percent <= 100,
    "mastery percentage out of range", String(report.overall_mastery_percent));
  check(report.per_goal.length === topic.goals.length, "report lost a goal", topic.title);
  check(Array.isArray(report.key_errors), "no key errors list", topic.title);
  check(Array.isArray(report.learned_well) && Array.isArray(report.areas_to_improve),
    "report missing the learned/improve split", topic.title);
  const counted = report.learned_well.length + report.areas_to_improve.length + report.not_covered.length;
  check(counted === topic.goals.length, "goals unaccounted for in the report",
    `${counted} of ${topic.goals.length}`);
  for (const g of report.per_goal) {
    check(g.correct <= g.asked, "more correct than asked", g.goal);
    check(g.accuracy_percent >= 0 && g.accuracy_percent <= 100, "goal accuracy out of range", g.goal);
  }

  // The student must have written far more than they clicked.
  return { turns, openAsked, mcqAsked, phasesSeen, report, longestRepeat };
}

function main() {
  const a = process.argv.slice(2);
  const n = Number(a[a.indexOf("--sessions") + 1]) || 300;
  const seed0 = Number(a[a.indexOf("--seed") + 1]) || 1;

  let turns = 0, open = 0, mcq = 0, withReport = 0, worstRepeat = 1;
  const allPhases = new Set();
  for (let i = 0; i < n; i++) {
    const r = runSession(seed0 + i, TOPICS[i % TOPICS.length]);
    turns += r.turns; open += r.openAsked; mcq += r.mcqAsked;
    if (r.report.per_goal.length) withReport++;
    if (r.longestRepeat > worstRepeat) worstRepeat = r.longestRepeat;
    for (const p of r.phasesSeen) allPhases.add(p);
  }

  const openShare = ((open / (open + mcq)) * 100).toFixed(1);
  console.log("TUTOR CORE — session shape simulation");
  console.log(`  sessions        ${n} across ${TOPICS.length} topics`);
  console.log(`  turns           ${turns}  (${(turns / n).toFixed(1)} per session)`);
  console.log(`  written : mcq   ${open} : ${mcq}   (${openShare}% of questions are written answers)`);
  console.log(`  phases seen     ${[...allPhases].join(" → ")}`);
  console.log(`  instructions    ${[...instructionsSeen].sort().join(", ")}`);
  console.log(`  reports built   ${withReport}/${n}`);
  console.log(`  longest run of the same directive   ${worstRepeat}`);
  console.log("");
  for (const [phase, types] of typesByPhase) {
    console.log(`    ${phase.padEnd(11)} asks ${[...types].join(" + ")}`);
  }
  console.log("");

  if (violations.length) {
    const by = new Map();
    for (const v of violations) {
      if (!by.has(v.label)) by.set(v.label, []);
      by.get(v.label).push(v.detail);
    }
    console.log(`✗ ${violations.length} INVARIANT VIOLATION(S)\n`);
    for (const [label, d] of [...by].sort((x, y) => y[1].length - x[1].length)) {
      console.log(`  ${label}  ×${d.length}`);
      console.log(`      e.g. ${d[0]}`);
    }
    process.exit(1);
  }
  console.log("✓ no invariant violated in any turn of any session");
}

if (require.main === module) main();
module.exports = { runSession, TOPICS, STUDENTS };
