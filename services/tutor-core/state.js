/**
 * Tutor session state — owned by the server, never inferred from model output.
 *
 * Session shape:
 *
 *   PROBE → THEORY → OBJECTIVES → [ DIALOGUE ×2 → CHECK ×1 ] per goal → WRAP → DONE
 *
 *   PROBE       one open question, unscored, to see what they already know
 *   THEORY      the concept explained, with a diagram and key points attached
 *   OBJECTIVES  what this session will get them to, in one line
 *   DIALOGUE    the core loop — the student WRITES answers and gets corrected
 *   CHECK       one multiple-choice question, to assess what the dialogue taught
 *   WRAP        a mastery report computed from what actually happened
 *
 * Two things this file exists to guarantee.
 *
 * Multiple choice is assessment, not teaching. The question TYPE is decided
 * here, per phase, and handed to the generator — it is never left to the model.
 * When the previous version only hinted at it in a JSON schema comment, the
 * model produced multiple choice on nearly every turn and students stopped
 * writing anything at all.
 *
 * And the phase is never read back out of the model's own output. Deriving it
 * from message_type tags the model had written meant a forgotten tag stalled
 * the session and a dropped message silently regressed it.
 *
 * Every function here is pure: same input, same output, no I/O, no clock, no
 * randomness. `advance` never mutates the state it is given.
 */

const PHASES = ["PROBE", "THEORY", "OBJECTIVES", "DIALOGUE", "CHECK", "WRAP", "DONE"];

/** Written answers per goal. The heart of the session. */
const OPEN_PER_GOAL = 2;

/** Multiple-choice checks per goal. Assessment only, after the teaching. */
const MCQ_PER_GOAL = 1;

/** Attempts at one question before moving on rather than trapping the student. */
const MAX_ATTEMPTS = 3;

/** Consecutive off-topic answers before the session closes politely. */
const OFF_TOPIC_STRIKES = 3;

/**
 * Hard stop on total turns.
 *
 * Sessions may run long to reach the academic outcome, so there is no tight
 * question budget — but a student who answers "i don't know" indefinitely must
 * still reach a summary rather than looping forever.
 */
const MAX_TURNS = 60;

/** Mastery bands, applied to a goal's accuracy. */
const BANDS = [
  { min: 0.8, label: "Mastered" },
  { min: 0.6, label: "Proficient" },
  { min: 0.4, label: "Developing" },
  { min: 0.0, label: "Emerging" },
];

function initialState(goalTotal) {
  const total = Math.max(1, goalTotal | 0);
  return {
    phase: "PROBE",
    goalIndex: 0,
    goalTotal: total,
    openThisGoal: 0,
    mcqThisGoal: 0,
    totalQuestions: 0,
    totalTurns: 0,
    consecutiveWrong: 0,
    offTopicStreak: 0,
    reteachPending: false,
    lastQuestionText: "",
    lastQuestionType: "open",
    lastQuestionOptions: null,
    probeAnswer: null,
    perGoal: Array.from({ length: total }, () => ({ correct: 0, total: 0, errors: [] })),
    endedReason: null,
  };
}

/**
 * The question type this phase asks for. Decided here, never by the model.
 * Only CHECK is multiple choice — everywhere else the student writes.
 * WRAP and DONE ask nothing, so they return null rather than claiming a type.
 */
function questionTypeFor(phase) {
  if (phase === "WRAP" || phase === "DONE") return null;
  return phase === "CHECK" ? "mcq" : "open";
}

/** Whether an answer in this phase counts toward mastery. */
function isScored(phase) {
  return phase === "DIALOGUE" || phase === "CHECK";
}

/** Which attachments this turn should carry. The server decides, not the model. */
function attachmentsFor(state) {
  switch (state.phase) {
    case "THEORY":
      return ["diagram", "key_points"];
    case "OBJECTIVES":
      return ["objectives"];
    case "DIALOGUE":
      // A video only when a goal opens, and only if the student is struggling.
      return state.openThisGoal === 0 && state.consecutiveWrong > 0 ? ["video"] : [];
    case "WRAP":
      return ["revision_sheet", "mastery_report"];
    default:
      return [];
  }
}

/**
 * Advance the session by one turn.
 *
 * @param {object} state
 * @param {object} event
 * @param {string}  event.intent      - ANSWER | ACK | HELP | IDK
 * @param {boolean} [event.correct]   - grader verdict; read only when intent is ANSWER
 * @param {boolean} [event.offTopic]  - unrelated, as opposed to wrong
 * @param {string}  [event.errorType] - grader's error category, recorded for the report
 * @param {string}  [event.answerText]
 * @param {string}  [event.questionText]
 * @param {Array}   [event.questionOptions]
 */
function advance(state, event = {}) {
  const s = {
    ...state,
    perGoal: state.perGoal.map((g) => ({ ...g, errors: [...g.errors] })),
  };
  const intent = event.intent || "ANSWER";
  s.totalTurns = state.totalTurns + 1;
  if (event.questionText) s.lastQuestionText = event.questionText;
  if (event.questionOptions !== undefined) s.lastQuestionOptions = event.questionOptions;

  if (state.phase === "DONE") return s;

  if (state.phase === "WRAP") {
    s.phase = "DONE";
    s.endedReason = s.endedReason || "complete";
    return s;
  }

  // Out of turns: still finish properly, with a report.
  if (s.totalTurns >= MAX_TURNS) {
    s.phase = "WRAP";
    s.endedReason = "turn_limit";
    return s;
  }

  // ── non-answers never advance anything ──────────────────────────────────
  if (intent !== "ANSWER") {
    s.reteachPending = intent === "HELP" || intent === "IDK";
    return s;
  }

  // ── repeated off-topic answers close the session kindly ──────────────────
  if (event.offTopic) {
    s.offTopicStreak = state.offTopicStreak + 1;
    if (s.offTopicStreak >= OFF_TOPIC_STRIKES) {
      s.phase = "WRAP";
      s.endedReason = "off_topic";
    }
    return s;
  }
  s.offTopicStreak = 0;

  // ── record mastery evidence before anything moves ────────────────────────
  if (isScored(state.phase)) {
    const g = s.perGoal[state.goalIndex];
    if (g) {
      g.total += 1;
      if (event.correct) g.correct += 1;
      // Every occurrence is recorded, not one per type: the report counts how
      // often a mistake was made, and deduping here would understate it.
      else if (event.errorType) g.errors.push(event.errorType);
    }
    s.totalQuestions = state.totalQuestions + 1;
  }

  if (state.phase === "PROBE") s.probeAnswer = event.answerText || null;

  // ── a wrong answer is re-taught before the session moves on ──────────────
  if (event.correct === false && isScored(state.phase)) {
    s.consecutiveWrong = state.consecutiveWrong + 1;
    if (s.consecutiveWrong < MAX_ATTEMPTS) {
      s.reteachPending = true;
      return s; // same question, taught a different way
    }
  }
  s.reteachPending = false;
  s.consecutiveWrong = 0;

  s.phase = nextPhase(state, s);
  s.lastQuestionType = questionTypeFor(s.phase);
  return s;
}

/** The transition table, kept separate so it reads at a glance. */
function nextPhase(prev, s) {
  switch (prev.phase) {
    case "PROBE":
      return "THEORY";
    case "THEORY":
      return "OBJECTIVES";
    case "OBJECTIVES":
      return "DIALOGUE";

    case "DIALOGUE":
      s.openThisGoal = prev.openThisGoal + 1;
      return s.openThisGoal >= OPEN_PER_GOAL ? "CHECK" : "DIALOGUE";

    case "CHECK": {
      s.mcqThisGoal = prev.mcqThisGoal + 1;
      if (s.mcqThisGoal < MCQ_PER_GOAL) return "CHECK";
      const next = prev.goalIndex + 1;
      if (next >= prev.goalTotal) return "WRAP";
      s.goalIndex = next;
      s.openThisGoal = 0;
      s.mcqThisGoal = 0;
      return "DIALOGUE";
    }

    case "WRAP":
      return "DONE";
    default:
      return "DONE";
  }
}

/** What the generator should be told to do this turn. */
function instructionFor(state, event = {}) {
  const intent = event.intent || "ANSWER";
  if (state.phase === "DONE") return "session_over";
  if (state.phase === "WRAP") {
    return state.endedReason === "off_topic" ? "close_off_topic" : "wrap_with_report";
  }
  if (intent === "ACK") return "reask_shorter";
  if (intent === "IDK") return "hint_then_easier";
  if (intent === "HELP") return "explain_differently";
  if (state.reteachPending) {
    return state.consecutiveWrong >= 2 ? "reteach_new_angle" : "correct_and_reask";
  }
  switch (state.phase) {
    case "PROBE":
      return "probe_prior_knowledge";
    case "THEORY":
      return "teach_theory";
    case "OBJECTIVES":
      return "state_objectives";
    case "CHECK":
      return "assess_with_mcq";
    case "DIALOGUE":
      return state.openThisGoal === 0 ? "open_goal_dialogue" : "continue_dialogue";
    default:
      return "continue_dialogue";
  }
}

/** The band a proportion falls into. */
function bandFor(accuracy) {
  return (BANDS.find((b) => accuracy >= b.min) || BANDS[BANDS.length - 1]).label;
}

module.exports = {
  PHASES,
  OPEN_PER_GOAL,
  MCQ_PER_GOAL,
  MAX_ATTEMPTS,
  OFF_TOPIC_STRIKES,
  MAX_TURNS,
  BANDS,
  initialState,
  advance,
  nextPhase,
  instructionFor,
  questionTypeFor,
  isScored,
  attachmentsFor,
  bandFor,
};
