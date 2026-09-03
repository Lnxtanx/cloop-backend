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

/**
 * The intents this module understands.
 *
 * The evaluator names some of them differently, and for one live session that
 * difference was the whole bug: the evaluator classified "I don't know" as
 * HELP_REQUEST, nothing here matched it, and the turn fell through to the
 * phase default — so the tutor re-sent the same two bubbles, word for word,
 * every time the student said they were stuck.
 *
 * Every intent now arrives through `normalizeIntent`, and it accepts both
 * vocabularies, so the two modules cannot drift apart again. Anything
 * unrecognised is treated as HELP rather than silently falling through: a
 * student we cannot classify is a student who needs a hand, not one who should
 * be read the same sentence twice.
 */
const INTENTS = ["ANSWER", "ACK", "HELP", "IDK", "OFF_TOPIC"];

const INTENT_ALIASES = {
  ANSWER: "ANSWER",
  ACK: "ACK",
  ACKNOWLEDGE: "ACK",
  HELP: "HELP",
  HELP_REQUEST: "HELP",
  EXPLAIN: "HELP",
  IDK: "IDK",
  DONT_KNOW: "IDK",
  UNSURE: "IDK",
  OFF_TOPIC: "OFF_TOPIC",
  OFFTOPIC: "OFF_TOPIC",
  GIBBERISH: "OFF_TOPIC",
};

/** Map any spelling of an intent onto the one this module acts on. */
function normalizeIntent(intent) {
  if (!intent) return "ANSWER";
  return INTENT_ALIASES[String(intent).trim().toUpperCase()] || "HELP";
}

/** Written answers per goal. The heart of the session. */
const OPEN_PER_GOAL = 2;

/** Multiple-choice checks per goal. Assessment only, after the teaching. */
const MCQ_PER_GOAL = 1;

/** Attempts at one question before moving on rather than trapping the student. */
const MAX_ATTEMPTS = 3;

/** Consecutive off-topic answers before the session closes politely. */
const OFF_TOPIC_STRIKES = 3;

/**
 * Consecutive non-answers ("ok", "idk", "explain") before the tutor stops
 * asking, gives the answer, and moves on. Matches MAX_ATTEMPTS so a stuck
 * student and a wrong student get the same three chances.
 */
const STUCK_LIMIT = 3;

/** Deepest the escalation ladder is ever walked in one turn. */
const LADDER_DEPTH = 3;

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
    stuckStreak: 0,
    revealPending: false,
    lastInstruction: null,
    instructionRepeats: 0,
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
  const intent = normalizeIntent(event.intent);
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

  // ── repeated off-topic answers close the session kindly ──────────────────
  //
  // This runs BEFORE the non-answer return below. It used to run after, which
  // made it unreachable: the evaluator reports off-topic as an intent of its
  // own, so every off-topic turn took the early return and the strike counter
  // never moved off zero. The polite close was dead code in production.
  if (intent === "OFF_TOPIC" || event.offTopic) {
    s.offTopicStreak = state.offTopicStreak + 1;
    if (s.offTopicStreak >= OFF_TOPIC_STRIKES) {
      s.phase = "WRAP";
      s.endedReason = "off_topic";
    }
    return s;
  }
  s.offTopicStreak = 0;

  // ── non-answers hold the phase, but not forever ──────────────────────────
  //
  // Holding the phase is right: an "ok" or an "I don't know" is not an answer
  // and must not be scored or spend a question. But holding it unconditionally
  // means a student who never answers never reaches the end of the session. By
  // the third consecutive non-answer the tutor has given a hint, an easier
  // question and a sentence starter, so it tells them the answer and moves on.
  if (intent !== "ANSWER") {
    s.stuckStreak = (state.stuckStreak || 0) + 1;
    s.reteachPending = intent === "HELP" || intent === "IDK";
    if (s.stuckStreak >= STUCK_LIMIT) {
      s.stuckStreak = 0;
      s.reteachPending = false;
      s.revealPending = true; // tell them the answer on the way past
      s.phase = nextPhase(state, s);
      s.lastQuestionType = questionTypeFor(s.phase);
    }
    return s;
  }
  s.stuckStreak = 0;
  s.revealPending = false;

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

/**
 * Where to go when the turn would otherwise repeat itself.
 *
 * A directive that was just used cannot be used again: identical directives
 * produce near-identical bubbles, and a student who says "I don't know" twice
 * was being read the same two sentences twice. Each rung teaches the same
 * point a different way, and the last rung stops asking and starts helping —
 * a stuck student is never left staring at a question they cannot begin.
 */
const ESCALATION = {
  probe_prior_knowledge: "probe_simpler",
  probe_simpler: "give_starter",
  teach_theory: "teach_theory_analogy",
  teach_theory_analogy: "give_starter",
  state_objectives: "restate_objectives_simpler",
  restate_objectives_simpler: "give_starter",
  open_goal_dialogue: "hint_then_easier",
  continue_dialogue: "hint_then_easier",
  assess_with_mcq: "assess_with_mcq_simpler",
  assess_with_mcq_simpler: "give_starter",
  reask_shorter: "hint_then_easier",
  hint_then_easier: "give_starter",
  explain_differently: "teach_theory_analogy",
  correct_and_reask: "reteach_new_angle",
  reteach_new_angle: "give_starter",
  redirect_to_topic: "reask_shorter",
  give_starter: "reveal_and_move_on",
  reveal_and_move_on: "give_starter",
};

/** Walk `steps` rungs down the ladder from `instruction`. */
function escalate(instruction, steps) {
  let cur = instruction;
  for (let i = 0; i < steps; i++) cur = ESCALATION[cur] || "give_starter";
  return cur;
}

/** The instruction this phase and intent call for, before any escalation. */
function baseInstruction(state, intent) {
  if (state.phase === "DONE") return "session_over";
  if (state.phase === "WRAP") {
    return state.endedReason === "off_topic" ? "close_off_topic" : "wrap_with_report";
  }
  if (state.revealPending) return "reveal_and_move_on";
  if (intent === "OFF_TOPIC") return "redirect_to_topic";
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

/**
 * What the generator should be told to do this turn.
 *
 * Never returns the instruction the previous turn used. The closing
 * instructions are exempt: a session that has reached WRAP or DONE says its
 * one closing thing, and escalating away from it would reopen a finished
 * session.
 */
function instructionFor(state, event = {}) {
  const intent = normalizeIntent(event.intent);
  const base = baseInstruction(state, intent);
  if (base === "wrap_with_report" || base === "close_off_topic" || base === "session_over") {
    return base;
  }

  // How hard the student is stuck decides how far down the ladder we go. It
  // has to be the streak, not just "is this the same as last time": comparing
  // against the previous instruction alone made the tutor alternate between
  // two rungs forever, so a student who kept saying "I don't know" was offered
  // a hint and a re-explanation in turn and never a way to start writing.
  const pressure = intent === "ANSWER" ? 0 : Math.max(0, (state.stuckStreak || 0) - 1);
  let next = escalate(base, Math.min(pressure, LADDER_DEPTH));

  // Belt and braces: whatever the ladder says, never say the same thing twice.
  if (next === state.lastInstruction) next = escalate(next, 1);
  return next;
}

/** The band a proportion falls into. */
function bandFor(accuracy) {
  return (BANDS.find((b) => accuracy >= b.min) || BANDS[BANDS.length - 1]).label;
}

module.exports = {
  PHASES,
  INTENTS,
  ESCALATION,
  STUCK_LIMIT,
  LADDER_DEPTH,
  escalate,
  normalizeIntent,
  baseInstruction,
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
