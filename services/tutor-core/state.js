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
const MAX_TURNS = 60;

/** A grading outage may hold a question, but must not trap the student. */
const MAX_UNVERIFIED_ATTEMPTS = 3;

/** Mastery bands, applied to a goal's accuracy. */
const BANDS = [
  { min: 0.8, label: "Mastered" },
  { min: 0.6, label: "Proficient" },
  { min: 0.4, label: "Developing" },
  { min: 0.0, label: "Emerging" },
];

const CHOICE_QUESTION = "Would you like me to explain the answer, or would you like another try?";
const RESPONSE_MODES = ["check", "teach", "offer_choice", "explain", "task_repair", "closing"];

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
    teachingCoverage: Array.from({ length: total }, () => ({ definition: false, explanation: false, formula: false, example: false })),
    lastQuestionRecord: null,
    active_learning_point_id: null,
    response_mode: "check",
    learning_support: {},
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
  state.active_learning_point_id = null;
  state.response_mode = (state.phase === "WRAP" || state.phase === "DONE") ? "closing" : (reveal ? "explain" : "check");
}

function learningPointIdFor(state, event = {}) {
  if (event.learningPointId) return String(event.learningPointId);
  if (event.active_learning_point_id) return String(event.active_learning_point_id);
  if (state.active_learning_point_id) return String(state.active_learning_point_id);
  if (state.lastQuestionRecord?.learning_point_id) return String(state.lastQuestionRecord.learning_point_id);
  if (state.phase === "PROBE") return "probe";
  if (state.phase === "THEORY") return "theory";
  if (state.phase === "OBJECTIVES") return "objectives";
  if (state.phase === "ROUNDUP") return `roundup_goal_${state.roundupIndex || 0}`;
  return `goal_${scoredGoalIndex(state) || 0}_${String(state.phase || '').toLowerCase()}`;
}

/** Advance the session by one turn; grade the final allowed answer first. */
function advance(state, event = {}) {
  const s = {
    ...state,
    perGoal: (state.perGoal || []).map(copyGoalEvidence),
    teachingCoverage: (state.teachingCoverage || []).map(c => ({ ...c })),
    assessmentAdvanced: false,
  };
  const intent = normalizeIntent(event.intent);
  s.totalTurns = (state.totalTurns || 0) + 1;
  s.wantsVideo = !!event.wantsVideo;

  const learningSupport = {};
  if (state.learning_support && typeof state.learning_support === 'object') {
    for (const [k, v] of Object.entries(state.learning_support)) {
      learningSupport[k] = { ...v };
    }
  }
  s.learning_support = learningSupport;

  const pointId = learningPointIdFor(state, event);
  s.active_learning_point_id = pointId;

  if (!learningSupport[pointId]) {
    learningSupport[pointId] = {
      unsuccessful_responses: 0,
      attempt_count: 0,
      awaiting_learning_choice: false,
      awaiting_choice: false,
      assisted: false,
    };
  }
  const currentPoint = learningSupport[pointId];

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

  const slot = isScored(state.phase) ? assessmentFor(s) : null;
  const previousAssisted = event.previousQuestionAssisted === true || state.questionAssisted === true;
  if (slot && previousAssisted) slot.assisted = true;

  // ── Route explicit control requests before academic handling ─────────────
  const requestKind = event.requestKind || event.request_kind || null;

  // 1. Question clarification: repair visible question without penalty
  const isClarification = requestKind === 'clarify_task' ||
    event.helpSubtype === 'question_clarification' ||
    event.help_subtype === 'question_clarification' ||
    event.suggestedAction === 'CLARIFY_TASK' || event.suggested_action === 'CLARIFY_TASK' ||
    event.suggestedAction === 'CLARIFY_QUESTION' || event.suggested_action === 'CLARIFY_QUESTION';
  if (isClarification) {
    s.response_mode = 'task_repair';
    s.evaluatorUnavailableStreak = 0;
    s.reteachPending = false;
    s.wantsVideo = false;
    return finish();
  }

  // 2. Direct explanation request: "Tell me the answer" / "Please explain"
  if (requestKind === 'explain_answer' || event.suggestedAction === 'EXPLAIN_ANSWER') {
    currentPoint.awaiting_learning_choice = false;
    currentPoint.awaiting_choice = false;
    currentPoint.assisted = true;
    s.response_mode = 'explain';
    s.reteachPending = false;
    s.evaluatorUnavailableStreak = 0;
    if (slot) {
      slot.assisted = true;
      if (!slot.assessed) {
        slot.assessed = true;
        slot.first_correct = false;
        slot.outcome = "assisted";
        s.perGoal[scoredGoalIndex(state)].total += 1;
        s.totalQuestions = (state.totalQuestions || 0) + 1;
      }
      slot.completed = true;
    }
    advanceQuestion(state, s, { reveal: true });
    return finish();
  }

  // 3. Retry request: "Another try"
  if (requestKind === 'try_again' || event.suggestedAction === 'RETRY') {
    currentPoint.awaiting_learning_choice = false;
    currentPoint.awaiting_choice = false;
    currentPoint.unsuccessful_responses = 0;
    currentPoint.attempt_count = 0;
    currentPoint.assisted = true;
    s.response_mode = 'check';
    s.reteachPending = true;
    s.questionAssisted = true;
    s.evaluatorUnavailableStreak = 0;
    if (slot) slot.assisted = true;
    return finish();
  }

  // 4. Move on request: "Teach something else"
  if (requestKind === 'move_on') {
    currentPoint.awaiting_learning_choice = false;
    currentPoint.awaiting_choice = false;
    currentPoint.assisted = true;
    s.response_mode = 'check';
    s.reteachPending = false;
    s.evaluatorUnavailableStreak = 0;
    if (slot && !slot.assessed) {
      slot.outcome = "skipped";
      slot.completed = true;
    }
    advanceQuestion(state, s);
    return finish();
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

  // ── When awaiting choice, resolve text choice if requestKind was not set ─
  if (currentPoint.awaiting_learning_choice || state.response_mode === 'offer_choice') {
    const rawAnswer = String(event.answerText || '').trim().toLowerCase();
    const wantsTry = /\b(try|again|retry|another|attempt|let\s+me|second\s+one|option\s*2)\b/i.test(rawAnswer);
    const wantsExplain = /\b(explain|answer|tell\s+me|why|solution|what\s+is\s+it|first\s+one|option\s*1)\b/i.test(rawAnswer) ||
      intent === 'IDK' || intent === 'HELP';

    if (wantsTry) {
      currentPoint.awaiting_learning_choice = false;
      currentPoint.awaiting_choice = false;
      currentPoint.unsuccessful_responses = 0;
      currentPoint.attempt_count = 0;
      currentPoint.assisted = true;
      s.response_mode = 'check';
      s.reteachPending = true;
      s.questionAssisted = true;
      if (slot) slot.assisted = true;
      return finish();
    } else if (wantsExplain) {
      currentPoint.awaiting_learning_choice = false;
      currentPoint.awaiting_choice = false;
      currentPoint.assisted = true;
      s.response_mode = 'explain';
      s.reteachPending = false;
      if (slot) {
        slot.assisted = true;
        if (!slot.assessed) {
          slot.outcome = "skipped";
          slot.completed = true;
        }
      }
      advanceQuestion(state, s, { reveal: true });
      return finish();
    }
  }

  // ── Non-answers hold the phase, but move forward after STUCK_LIMIT ───────
  if (intent !== "ANSWER") {
    s.evaluatorUnavailableStreak = 0;
    if (slot) {
      slot.attempts.push({ intent, correct: null, assisted: previousAssisted, evaluator_status: "not_applicable" });
      if (intent === "HELP" || intent === "IDK") slot.assisted = true;
    }
    s.stuckStreak = (state.stuckStreak || 0) + 1;
    s.reteachPending = intent === "HELP" || intent === "IDK";

    if (state.phase !== 'ROUNDUP' && (intent === "IDK" || intent === "HELP")) {
      currentPoint.unsuccessful_responses = (currentPoint.unsuccessful_responses || 0) + 1;
      currentPoint.attempt_count = currentPoint.unsuccessful_responses;
      currentPoint.assisted = true;
      if (currentPoint.unsuccessful_responses === 2) {
        currentPoint.awaiting_learning_choice = true;
        currentPoint.awaiting_choice = true;
        s.response_mode = 'offer_choice';
        s.reteachPending = false;
        return finish();
      }
    }

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

  // ── Correct answer: clear struggle and advance ───────────────────────────
  if (event.correct === true) {
    currentPoint.awaiting_learning_choice = false;
    currentPoint.awaiting_choice = false;
    currentPoint.unsuccessful_responses = 0;
    currentPoint.attempt_count = 0;
    s.response_mode = 'check';
    s.consecutiveWrong = 0;
    if (slot) slot.completed = true;
    advanceQuestion(state, s);
    return finish();
  }

  // ── A wrong answer in an assessed phase is re-taught or offered choice ───
  if (event.correct === false && isScored(state.phase)) {
    s.consecutiveWrong = (state.consecutiveWrong || 0) + 1;
    currentPoint.unsuccessful_responses = (currentPoint.unsuccessful_responses || 0) + 1;
    currentPoint.attempt_count = currentPoint.unsuccessful_responses;
    currentPoint.assisted = true;

    if (currentPoint.unsuccessful_responses >= 2) {
      // Second unsuccessful response: stop academic questioning and offer choice
      currentPoint.awaiting_learning_choice = true;
      currentPoint.awaiting_choice = true;
      s.response_mode = 'offer_choice';
      s.reteachPending = false;
      if (s.consecutiveWrong >= MAX_ATTEMPTS) {
        if (slot) slot.completed = true;
        advanceQuestion(state, s, { reveal: true });
      }
      return finish();
    }

    // First unsuccessful response: explain gap + easier check
    s.response_mode = 'teach';
    s.reteachPending = true;
    if (slot) slot.assisted = true;
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
  offer_choice: "give_starter",
  explain_answer: "give_starter",
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
  if (state.response_mode === "offer_choice") return "offer_choice";
  if (state.response_mode === "explain") return "explain_answer";
  if (state.response_mode === "task_repair") return "clarify_question";
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
  // Direct question clarification request
  if (event.helpSubtype === 'question_clarification' ||
      event.help_subtype === 'question_clarification' ||
      event.suggestedAction === 'CLARIFY_TASK' ||
      event.suggested_action === 'CLARIFY_TASK' ||
      event.suggestedAction === 'CLARIFY_QUESTION' ||
      event.suggested_action === 'CLARIFY_QUESTION' ||
      state.response_mode === 'task_repair') {
    return 'clarify_question';
  }
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

const PHASE_PURPOSES = {
  PROBE: 'Find what the student already knows before teaching.',
  THEORY: 'Explain the core concept using an everyday example and clear theory.',
  OBJECTIVES: 'State what the student will learn in this session.',
  DIALOGUE: 'Teach the concept and guide the student to write answers.',
  CHECK: 'Check understanding with an MCQ assessment.',
  ROUNDUP: 'End-of-lesson written recall of goals just taught, without hints.',
  WRAP: 'Summarize the session and review mastery without asking questions.',
  DONE: 'Session finished.',
};

function buildGoalMap(goals = [], currentIndex = 0, phase = 'DIALOGUE') {
  const goalList = Array.isArray(goals) && goals.length ? goals : [];
  const total = goalList.length || 1;
  const current = Math.min(Math.max(currentIndex || 0, 0), Math.max(0, total - 1));
  const mappedGoals = goalList.map((g, idx) => {
    const status = idx < current ? 'covered' : idx === current ? 'current' : 'upcoming';
    return {
      index: idx + 1,
      title: typeof g === 'string' ? g : (g?.title || `Goal ${idx + 1}`),
      status
    };
  });
  return {
    progress: `goal ${current + 1} of ${total}`,
    phase_purpose: PHASE_PURPOSES[phase] || 'Teach and clarify the current topic.',
    goals: mappedGoals
  };
}

function computeTeachingCoverage(state) {
  const coverageList = state?.teachingCoverage || [];
  if (!coverageList.length) return 0;
  const taughtCount = coverageList.filter(c => c.definition || c.explanation).length;
  return Math.round((taughtCount / coverageList.length) * 100);
}

function computeChecksCompleted(state) {
  return (state?.perGoal || []).reduce((sum, g) => {
    const slots = Object.values(g.assessments || {});
    return sum + slots.filter(s => s.completed && s.assessed).length;
  }, 0);
}

function isGoalTaught(state, index) {
  const coverage = state?.teachingCoverage?.[index];
  if (!coverage) return false;
  return Boolean(coverage.definition || coverage.explanation);
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
  PHASE_PURPOSES,
  buildGoalMap,
  computeTeachingCoverage,
  computeChecksCompleted,
  isGoalTaught,
  CHOICE_QUESTION,
  RESPONSE_MODES,
  learningPointIdFor,
};
