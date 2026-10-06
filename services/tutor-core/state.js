/**
 * Tutor session state — owned by the server, never inferred from model output.
 *
 * Session shape:
 *
 *   PROBE → THEORY → OBJECTIVES → [ DIALOGUE ×1 → CHECK ×1 ] per goal → ROUNDUP → WRAP → DONE
 *
 *   PROBE       one open question, unscored, to see what they already know
 *   THEORY      the concept explained, with a diagram and key points attached
 *   OBJECTIVES  what this session will get them to, in one line
 *   DIALOGUE    the core loop — the student WRITES answers and gets corrected
 *   CHECK       one multiple-choice question, to assess what the dialogue taught
 *   ROUNDUP     the exam-readiness round — one written recall question per goal,
 *               asking the student to state that goal's key definition or formula
 *               in their own words. Scored. Confirms mastery BEFORE any score is
 *               given, so the final figure rests on recall, not recognition alone.
 *   WRAP        a mastery report computed from what actually happened
 *
 * Pacing:
 *   1 open question + 1 MCQ check per goal, then 1 recall question per goal in
 *   the round-up = 3 scored questions per goal. The round-up touches every goal,
 *   so a normal session assesses the whole syllabus before scoring.
 *
 * Each goal/phase has one assessment slot. Its first assessable response fixes
 * credit; retries are diagnostic attempts. Assistance cannot erase an initial
 * error, and skipped or unavailable assessments are reported separately.
 *
 * Every function here is pure: same input, same output, no I/O, no clock, no
 * randomness. `advance` never mutates the state it is given.
 */

const PHASES = ["PROBE", "THEORY", "OBJECTIVES", "DIALOGUE", "CHECK", "ROUNDUP", "WRAP", "DONE"];

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

/** 1 written teaching question per goal, followed by MCQ and final recall. */
const OPEN_PER_GOAL = 1;

/** 1 multiple-choice check per goal. Assessment only, after dialogue. */
const MCQ_PER_GOAL = 1;

/**
 * 1 written recall question per goal in the closing round-up. The student must
 * state that goal's key definition or formula in their own words — the exam-
 * readiness gate that every goal passes through before a score is given.
 */
const RECALL_PER_GOAL = 1;

/** Attempts at one question before moving on rather than trapping the student. */
const MAX_ATTEMPTS = 3;

/** Consecutive off-topic answers before the session closes politely. */
const OFF_TOPIC_STRIKES = 3;

/**
 * Consecutive non-answers ("ok", "idk", "explain") before the tutor stops
 * asking, explains the answer, and moves on.
 */
const STUCK_LIMIT = 2;

/** Deepest the escalation ladder is ever walked in one turn. */
const LADDER_DEPTH = 3;

/** Hard stop on total turns across the session. */
const MAX_TURNS = 40;

/** A grading outage may hold a question, but must not trap the student. */
const MAX_UNVERIFIED_ATTEMPTS = 3;

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
    roundupIndex: 0,
    recallThisGoal: 0,
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
    wantsVideo: false,
    lastInstruction: null,
    instructionRepeats: 0,
    assessmentAdvanced: true,
    questionAssisted: false,
    evaluatorUnavailableStreak: 0,
    assessmentVersion: 2,
    perGoal: Array.from({ length: total }, () => ({ correct: 0, total: 0, errors: [], assessments: {} })),
    endedReason: null,
  };
}

/** The question type this phase asks for. Decided here, never by the model. */
function questionTypeFor(phase) {
  if (phase === "WRAP" || phase === "DONE") return null;
  // ROUNDUP is written recall: the student must produce the definition/formula,
  // not pick it from options. Only CHECK is multiple choice.
  return phase === "CHECK" ? "mcq" : "open";
}

/** Whether an answer in this phase counts toward mastery. */
function isScored(phase) {
  return phase === "DIALOGUE" || phase === "CHECK" || phase === "ROUNDUP";
}

/** A goal is completed only after all three slots are assessed and finalized. */
function goalCompletion(state, index) {
  const assessments = state?.perGoal?.[index]?.assessments;
  return ["DIALOGUE", "CHECK", "ROUNDUP"].every((phase) =>
    assessments?.[phase]?.completed === true && assessments?.[phase]?.assessed === true);
}

/**
 * The goal index a scored answer belongs to. In the per-goal teaching loop that
 * is `goalIndex`; in the closing round-up the tutor walks the goals again, so
 * it is `roundupIndex`. Everything else has no goal, so it falls back safely.
 */
function scoredGoalIndex(state) {
  return state.phase === "ROUNDUP" ? (state.roundupIndex || 0) : state.goalIndex;
}

/** Which attachments this turn should carry. The server decides, not the model. */
function attachmentsFor(state) {
  switch (state.phase) {
    case "THEORY":
      return ["diagram", "key_points"];
    case "OBJECTIVES":
      return ["objectives"];
    case "DIALOGUE": {
      if (state.wantsVideo) return ["video"];
      // A video only when a goal opens, and only if the student is struggling.
      return state.openThisGoal === 0 && state.consecutiveWrong > 0 ? ["video"] : [];
    }
    case "ROUNDUP":
      // The round-up is pure assessment: no diagram, no video, just recall.
      return [];
    case "WRAP":
      return ["revision_sheet", "mastery_report"];
    default:
      return [];
  }
}

/** Copy nested evidence, including sessions persisted before slot scoring. */
function copyGoalEvidence(goal = {}) {
  const assessments = Object.fromEntries(Object.entries(goal.assessments || {}).map(([phase, slot]) => [phase, {
    ...slot,
    attempts: (slot.attempts || []).map((attempt) => ({ ...attempt })),
  }]));
  return {
    ...goal,
    correct: Number.isFinite(goal.correct) ? goal.correct : 0,
    total: Number.isFinite(goal.total) ? goal.total : 0,
    errors: [...(goal.errors || [])],
    assessments,
  };
}

/** One scored slot per goal/phase. Retries are diagnostic evidence only. */
function assessmentFor(state) {
  const goal = state.perGoal[scoredGoalIndex(state)];
  if (!goal || !isScored(state.phase)) return null;
  if (!goal.assessments[state.phase]) {
    goal.assessments[state.phase] = {
      outcome: "pending", assessed: false, assisted: false, completed: false, attempts: [],
    };
  }
  return goal.assessments[state.phase];
}

/** Reset question-specific pressure whenever a new assessment opens. */
function advanceQuestion(prev, state, { reveal = false } = {}) {
  state.revealPending = reveal;
  state.revealGoalIndex = reveal ? scoredGoalIndex(prev) : null;
  state.revealPhase = reveal ? prev.phase : null;
  state.phase = nextPhase(prev, state);
  state.lastQuestionType = questionTypeFor(state.phase);
  state.stuckStreak = 0;
  state.consecutiveWrong = 0;
  state.evaluatorUnavailableStreak = 0;
  state.reteachPending = false;
  state.questionAssisted = false;
  state.assessmentAdvanced = true;
}

/** Advance the session by one turn; grade the final allowed answer first. */
function advance(state, event = {}) {
  const s = {
    ...state,
    perGoal: (state.perGoal || []).map(copyGoalEvidence),
    assessmentAdvanced: false,
  };
  const intent = normalizeIntent(event.intent);
  s.totalTurns = (state.totalTurns || 0) + 1;
  s.wantsVideo = !!event.wantsVideo;

  // All branches apply the cap after processing the current response.
  const finish = () => {
    if (s.totalTurns >= MAX_TURNS && s.phase !== "DONE" && s.phase !== "WRAP") {
      s.phase = "WRAP";
      s.endedReason = "turn_limit";
    } else if (s.phase === "WRAP" && !s.endedReason) {
      s.endedReason = "complete";
    }
    return s;
  };

  if (event.questionText) s.lastQuestionText = event.questionText;
  if (event.questionOptions !== undefined) s.lastQuestionOptions = event.questionOptions;

  if (state.phase === "DONE") return s;

  if (state.phase === "WRAP") {
    s.phase = "DONE";
    s.endedReason = s.endedReason || "complete";
    return s;
  }

  // ── Repeated off-topic answers close the session kindly ──────────────────
  if (intent === "OFF_TOPIC" || event.offTopic) {
    s.evaluatorUnavailableStreak = 0;
    s.offTopicStreak = (state.offTopicStreak || 0) + 1;
    if (s.offTopicStreak >= OFF_TOPIC_STRIKES) {
      s.phase = "WRAP";
      s.endedReason = "off_topic";
    }
    return finish();
  }
  s.offTopicStreak = 0;

  const slot = isScored(state.phase) ? assessmentFor(s) : null;
  const previousAssisted = event.previousQuestionAssisted === true || state.questionAssisted === true;
  if (slot && previousAssisted) slot.assisted = true;

  // ── Non-answers hold the phase, but move forward after STUCK_LIMIT ───────
  if (intent !== "ANSWER") {
    s.evaluatorUnavailableStreak = 0;
    if (slot) {
      slot.attempts.push({ intent, correct: null, assisted: previousAssisted, evaluator_status: "not_applicable" });
      if (intent === "HELP" || intent === "IDK") slot.assisted = true;
    }
    s.stuckStreak = (state.stuckStreak || 0) + 1;
    s.reteachPending = intent === "HELP" || intent === "IDK";
    if (s.stuckStreak >= STUCK_LIMIT) {
      if (slot) {
        if (!slot.assessed) slot.outcome = "skipped";
        slot.completed = true;
      }
      advanceQuestion(state, s, { reveal: true });
    }
    return finish();
  }
  s.stuckStreak = 0;
  s.revealPending = false;

  // A failed evaluator is unknown evidence, never a correct-ish answer.
  const unavailable = event.evaluationStatus === "unavailable" || typeof event.correct !== "boolean";
  if (unavailable) {
    if (slot) {
      slot.attempts.push({ intent, correct: null, assisted: previousAssisted, evaluator_status: "unavailable" });
      if (!slot.assessed) slot.outcome = "unverified";
    }
    s.evaluatorUnavailableStreak = (state.evaluatorUnavailableStreak || 0) + 1;
    s.reteachPending = false;
    if (s.evaluatorUnavailableStreak >= MAX_UNVERIFIED_ATTEMPTS) {
      if (slot) slot.completed = true;
      advanceQuestion(state, s);
    }
    return finish();
  }
  s.evaluatorUnavailableStreak = 0;

  // The first assessable response fixes credit for this slot. Later hints and
  // easier checks can teach, but cannot retrospectively certify recall.
  if (slot) {
    const g = s.perGoal[scoredGoalIndex(state)];
    slot.attempts.push({
      intent, correct: event.correct, assisted: previousAssisted || slot.assisted,
      evaluator_status: "available", error_type: event.errorType || null,
    });
    if (!slot.assessed) {
      slot.assessed = true;
      slot.first_correct = event.correct;
      slot.outcome = event.correct === true && !slot.assisted ? "correct"
        : (slot.assisted ? "assisted" : "incorrect");
      g.total += 1;
      if (slot.outcome === "correct") g.correct += 1;
      s.totalQuestions = (state.totalQuestions || 0) + 1;
    }
    if (event.correct === false && event.errorType) g.errors.push(event.errorType);
  }

  if (state.phase === "PROBE") s.probeAnswer = event.answerText || null;

  // ── A wrong answer in an assessed phase is re-taught before moving on ─────
  if (event.correct === false && isScored(state.phase)) {
    s.consecutiveWrong = (state.consecutiveWrong || 0) + 1;
    if (s.consecutiveWrong < MAX_ATTEMPTS) {
      s.reteachPending = true;
      if (slot) slot.assisted = true;
      return finish();
    }
    if (slot) slot.completed = true;
    advanceQuestion(state, s, { reveal: true });
    return finish();
  }
  if (slot) slot.completed = true;
  advanceQuestion(state, s);
  return finish();
}

/** Teaching loop followed by one ROUNDUP recall per goal, then WRAP. */
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
      if (next >= prev.goalTotal) {
        // Every goal has been taught and checked. Before scoring, run the
        // exam-readiness round-up over all goals, starting from the first.
        s.roundupIndex = 0;
        s.recallThisGoal = 0;
        return "ROUNDUP";
      }
      s.goalIndex = next;
      s.openThisGoal = 0;
      s.mcqThisGoal = 0;
      return "DIALOGUE";
    }

    case "ROUNDUP": {
      s.recallThisGoal = prev.recallThisGoal + 1;
      if (s.recallThisGoal < RECALL_PER_GOAL) return "ROUNDUP";
      const nextRecall = (prev.roundupIndex || 0) + 1;
      if (nextRecall >= prev.goalTotal) return "WRAP";
      s.roundupIndex = nextRecall;
      s.recallThisGoal = 0;
      return "ROUNDUP";
    }

    case "WRAP":
      return "DONE";
    default:
      return "DONE";
  }
}

/** Escalation ladder for pedagogical variety and stuck-student progression */
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
  roundup_recall: "hint_then_easier",
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
    case "ROUNDUP":
      return "roundup_recall";
    case "DIALOGUE":
      return state.openThisGoal === 0 ? "open_goal_dialogue" : "continue_dialogue";
    default:
      return "continue_dialogue";
  }
}

/** What the generator should be told to do this turn. */
function instructionFor(state, event = {}) {
  // Infrastructure failures do not show that the student is struggling.
  // A neutral retry preserves independent assessment instead of leaking a
  // hint through the anti-repetition ladder. Repeats are bounded separately.
  if (state.phase !== "WRAP" && state.phase !== "DONE" && state.evaluatorUnavailableStreak > 0) {
    return "reask_shorter";
  }
  const intent = normalizeIntent(event.intent);
  const base = baseInstruction(state, intent);
  if (base === "wrap_with_report" || base === "close_off_topic" || base === "session_over") {
    return base;
  }

  const pressure = intent === "ANSWER" ? 0 : Math.max(0, (state.stuckStreak || 0) - 1);
  let next = escalate(base, Math.min(pressure, LADDER_DEPTH));

  // Repeating the same recall directive for a NEW goal is correct. Escalating
  // it into a hint would leak the answer before that goal was assessed.
  if (!state.assessmentAdvanced && next === state.lastInstruction) next = escalate(next, 1);
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
  RECALL_PER_GOAL,
  MAX_ATTEMPTS,
  OFF_TOPIC_STRIKES,
  MAX_TURNS,
  MAX_UNVERIFIED_ATTEMPTS,
  BANDS,
  initialState,
  advance,
  nextPhase,
  instructionFor,
  questionTypeFor,
  isScored,
  goalCompletion,
  scoredGoalIndex,
  attachmentsFor,
  bandFor,
};
