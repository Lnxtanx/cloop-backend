/**
 * Adversarial simulation of the tutor core.
 *
 * Plays whole sessions against a mock model that misbehaves in every way the
 * real one has: prose instead of JSON, three bubbles, 40-word bubbles, pill
 * narration, raw mermaid, "Right —" on a correction, empty strings, nothing at
 * all. The point is not that the model behaves — it is that the architecture
 * holds when it does not.
 *
 *   node services/tutor-core/simulate.js
 *   node services/tutor-core/simulate.js --sessions 500 --seed 42
 */

const S = require("./state");
const { enforce, wordCount, endsWithQuestion } = require("./validate");

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const TOPICS = [
  { title: "Friction", goals: ["Identify friction", "Compare surfaces", "Reduce friction", "Friction in daily life"] },
  { title: "Chemical Reactions", goals: ["Signs of a reaction", "Reactants and products", "Balancing", "Everyday reactions", "Rusting"] },
  { title: "Linear Equations", goals: ["Name the unknown", "Isolate the variable", "Check the solution"] },
  { title: "Trophic Levels", goals: ["Producers", "Consumers", "Energy loss", "Food webs"] },
  { title: "Metals and Non-metals", goals: ["Physical properties", "Reaction with acid", "Uses"] },
  { title: "Photosynthesis", goals: ["Inputs", "Outputs", "Chlorophyll", "Light stage", "Dark stage", "Limiting factors", "Experiments", "Food chains"] },
];

const LONG = "This is a deliberately long explanation that runs well past the cap and keeps going with more clauses and more detail than any student could reasonably read in a single chat bubble on a phone screen while sitting on a bus.";

const MISBEHAVIOURS = [
  { name: "well-formed", make: (q) => ({ messages: [{ message: q }] }) },
  { name: "three bubbles", make: (q) => ({ messages: [{ message: "First thought." }, { message: "Second thought." }, { message: q }] }) },
  { name: "five bubbles", make: (q) => ({ messages: [1, 2, 3, 4].map((n) => ({ message: `Thought ${n}.` })).concat([{ message: q }]) }) },
  { name: "40-word bubble", make: (q) => ({ messages: [{ message: LONG }, { message: q }] }) },
  { name: "long, no question", make: () => ({ messages: [{ message: LONG }] }) },
  { name: "narrates the pill", make: (q) => ({ messages: [{ message: `Open the 'Remember This' card, then tell me: ${q}` }] }) },
  { name: "mermaid in prose", make: (q) => ({ messages: [{ message: "```mermaid\ngraph LR\nA-->B\n```" }, { message: q }] }) },
  { name: "praise + correction", make: (q) => ({ messages: [{ message: "Right — actually that isn't it." }, { message: q }] }) },
  { name: "open-ended ending", make: () => ({ messages: [{ message: "So that's the idea." }, { message: "Any questions?" }] }) },
  { name: "statement ending", make: () => ({ messages: [{ message: "Good job, you've got it." }] }) },
  { name: "empty strings", make: () => ({ messages: [{ message: "" }, { message: "   " }] }) },
  { name: "options only", make: () => ({ messages: [{ message: "", options: ["Yes", "No"] }] }) },
  { name: "nothing at all", make: () => ({}) },
  { name: "not an object", make: () => null },
];

const STUDENTS = [
  { text: "because it is rough", intent: "ANSWER", correct: true },
  { text: "iron", intent: "ANSWER", correct: true },
  { text: "2", intent: "ANSWER", correct: true },
  { text: "the plastic bottle", intent: "ANSWER", correct: false },
  { text: "stay fresh", intent: "ANSWER", correct: false },
  { text: "ok", intent: "ACK" },
  { text: "next", intent: "ACK" },
  { text: "pls explain", intent: "HELP" },
  { text: "i dont know", intent: "IDK" },
  { text: "bananas are yellow", intent: "ANSWER", correct: false, offTopic: true },
];

const violations = [];
const seen = new Set();
function check(cond, label, detail) {
  if (!cond) violations.push({ label, detail });
}

const MAX_BUBBLES_ALLOWED = 2; // hard cap: max 2 bubbles (ideally 1)

function runSession(seed, topic) {
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];

  let state = S.initialState(topic.goals.length);
  let lastQuestion = "";
  let turns = 0;
  let guard = 0;

  while (state.phase !== "DONE" && guard++ < 300) {
    const student = pick(STUDENTS);
    const before = state;

    state = S.advance(before, {
      intent: student.intent,
      correct: student.correct,
      offTopic: student.offTopic,
    });
    const instruction = S.instructionFor(state, { intent: student.intent });
    seen.add(instruction);

    const mis = pick(MISBEHAVIOURS);
    const q = `What happens to ${topic.goals[state.goalIndex] || topic.title}?`;
    const raw = mis.make(q);

    const out = enforce(raw, {
      isCorrect: student.intent === "ANSWER" ? student.correct ?? null : null,
      phase: state.phase,
      fallbackQuestion: lastQuestion && endsWithQuestion(lastQuestion) ? lastQuestion : q,
      diffHtml: student.correct === false ? "<del>x</del><ins>y</ins>" : null,
      studentMessage: student.text,
    });

    const where = `${topic.title} #${++turns} ${before.phase}→${state.phase}/${student.intent} [${mis.name}]`;

    // ── what a student would experience ──────────────────────────────────
    check(out.messages.length >= 1, "turn produced no bubble", where);
    check(out.messages.length <= MAX_BUBBLES_ALLOWED, `more than ${MAX_BUBBLES_ALLOWED} bubbles (${out.messages.length})`, where);
    for (const m of out.messages) {
      const hasOptions = Array.isArray(m.options) && m.options.length > 0;
      check(Boolean(m.message && m.message.trim()) || hasOptions, "blank bubble reached the student", where);
      check(wordCount(m.message) <= 20, `bubble over 20 words (${wordCount(m.message)})`, where);
      check(!/```|graph (TD|LR)|-->/.test(m.message), "diagram syntax in prose", where);
      check(!/open the .*(card|pill)|tap the|check the (card|diagram)/i.test(m.message), "narrated a pill", where);
    }
    if (state.phase !== "WRAP" && state.phase !== "DONE") {
      const last = out.messages[out.messages.length - 1];
      const ok = endsWithQuestion(last.message) || (Array.isArray(last.options) && last.options.length > 0);
      check(ok, "turn ends with nothing answerable", `${where}: ${JSON.stringify(last.message).slice(0, 60)}`);
    }
    if (student.intent !== "ANSWER") {
      // WRAP is a single closing turn: any reply to it ends the session, by
      // design. Every other phase must be immovable by a non-answer.
      const closingWrap = before.phase === "WRAP" && state.phase === "DONE";
      check(out.diff_html === null, "a non-answer got a strikethrough", where);
      check(state.phase === before.phase || closingWrap, `phase advanced on ${student.intent}`, where);
      check(state.totalQuestions === before.totalQuestions, `${student.intent} spent budget`, where);
      check(state.goalIndex === before.goalIndex, `${student.intent} moved the goal`, where);
    }
    check(state.totalQuestions <= S.TOTAL_QUESTION_BUDGET, `budget blown (${state.totalQuestions})`, where);
    check(state.goalIndex < state.goalTotal, `goal index ${state.goalIndex}/${state.goalTotal}`, where);

    const lastMsg = out.messages[out.messages.length - 1].message;
    if (endsWithQuestion(lastMsg)) lastQuestion = lastMsg;
  }
  check(guard < 300, "session never reached DONE", topic.title);
  return turns;
}

function main() {
  const a = process.argv.slice(2);
  const n = Number(a[a.indexOf("--sessions") + 1]) || 200;
  const seed0 = Number(a[a.indexOf("--seed") + 1]) || 1;

  let turns = 0;
  for (let i = 0; i < n; i++) turns += runSession(seed0 + i, TOPICS[i % TOPICS.length]);

  console.log("TUTOR CORE — adversarial simulation");
  console.log(`  sessions       ${n} across ${TOPICS.length} topics`);
  console.log(`  turns          ${turns}`);
  console.log(`  failure modes  ${MISBEHAVIOURS.length} model, ${STUDENTS.length} student`);
  console.log(`  instructions   ${[...seen].sort().join(", ")}`);
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
module.exports = { runSession, MISBEHAVIOURS, STUDENTS, TOPICS };
