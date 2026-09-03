/**
 * Tutor session state — owned by the server, never inferred from model output.
 *
 * Three phases: GREET → TEACH → WRAP → DONE.
 *
 * The previous design re-derived the phase on every request by scanning chat
 * history for message_type tags the model itself had written:
 *
 *     const hasExamDef = aiMessages.some(m => m.message_type === 'exam_definition')
 *
 * That makes the state machine's inputs the model's outputs. Forget a tag and
 * the session sticks in a phase forever; emit one early and it skips ahead;
 * drop a message and the phase silently regresses. It is also why the prompt
 * had to grow so large — it was the only thing holding the contract together.
 *
 * Every function here is pure: same input, same output, no I/O, no clock, no
 * randomness. `advance` never mutates the state it is given.
 */

const PHASES = ["GREET", "TEACH", "WRAP", "DONE"];

/** Session-wide question budget. The arc is ~12 questions. */
const TOTAL_QUESTION_BUDGET = 12;

/** Questions per goal, before the budget is shared out. */
const MAX_QUESTIONS_PER_GOAL = 2;

/**
 * Wrong answers on the same question before we move on anyway.
 *
 * Three, not two, so both teaching tiers are reachable: the first wrong answer
 * gets a correction and an easier re-ask, the second gets the concept taught a
 * different way, and the third moves on rather than trapping the student. At
 * two, the second tier fires on the same turn the goal advances and the first
 * tier is dead code.
 */
const MAX_ATTEMPTS = 3;

/** Consecutive off-topic answers before the session is closed politely. */
const OFF_TOPIC_STRIKES = 3;

/**
 * How many questions this goal gets.
 *
 * A fixed 2 per goal silently drops goals on a large topic: 8 goals × 2 = 16
 * against a budget of 12, so the last four are never taught. Sharing the budget
 * out means every goal gets at least one question.
 */
function questionsPerGoal(goalTotal) {
  const total = Math.max(1, goalTotal | 0);
  if (total * MAX_QUESTIONS_PER_GOAL <= TOTAL_QUESTION_BUDGET) return MAX_QUESTIONS_PER_GOAL;
  return Math.max(1, Math.floor(TOTAL_QUESTION_BUDGET / total));
}

function initialState(goalTotal) {
  const total = Math.max(1, goalTotal | 0);
  return {
    phase: "GREET",
    goalIndex: 0,
    goalTotal: total,
    questionsPerGoal: questionsPerGoal(total),
    questionsThisGoal: 0,
    totalQuestions: 0,
    consecutiveWrong: 0,
    offTopicStreak: 0,
    reteachPending: false,
    lastQuestionText: "",
    endedReason: null,
  };
}

/**
 * Advance the session by one turn.
 *
 * @param {object} state
 * @param {object} event
 * @param {string}  event.intent      - ANSWER | ACK | HELP | IDK
 * @param {boolean} [event.correct]   - grader verdict; only read when intent is ANSWER
 * @param {boolean} [event.offTopic]  - grader saw an unrelated answer, not a wrong one
 * @param {string}  [event.questionText] - the question this turn asked
 * @returns {object} a new state
 */
function advance(state, event = {}) {
  const s = { ...state };
  const intent = event.intent || "ANSWER";
  if (event.questionText) s.lastQuestionText = event.questionText;

  // ── the session is over ──────────────────────────────────────────────────
  if (state.phase === "DONE") return s;

  // WRAP is a single turn: it delivers the revision sheet and closes.
  if (state.phase === "WRAP") {
    s.phase = "DONE";
    s.endedReason = s.endedReason || "complete";
    return s;
  }

  // ── non-answers never advance anything ──────────────────────────────────
  // "ok", "explain", "idk" must not move the phase, the goal, or the budget.
  // A question stays open until it gets a real attempt.
  if (intent !== "ANSWER") {
    s.reteachPending = intent === "HELP" || intent === "IDK";
    return s;
  }

  // ── politely close on repeated off-topic answers ─────────────────────────
  // Driven by the grader, not by the shape of the characters: a student
  // struggling scores low but stays on topic, and telling them their real
  // answer is nonsense is far worse than grading nonsense.
  if (event.offTopic) {
    s.offTopicStreak = state.offTopicStreak + 1;
    if (s.offTopicStreak >= OFF_TOPIC_STRIKES) {
      s.phase = "WRAP";
      s.endedReason = "off_topic";
    }
    return s;
  }
  s.offTopicStreak = 0;

  // ── a wrong answer re-teaches before it advances ─────────────────────────
  // The guard is on the attempt count, not on "is this the first one". Testing
  // `consecutiveWrong === 0` means the SECOND wrong answer skips the re-teach
  // and advances the goal as if it were correct, and the counter never reaches
  // 2, so a second-attempt instruction can never fire.
  if (event.correct === false) {
    s.consecutiveWrong = state.consecutiveWrong + 1;
    if (s.consecutiveWrong < MAX_ATTEMPTS) {
      s.reteachPending = true;
      return s; // same question, taught differently — costs no budget
    }
    // Attempts exhausted. Count it and move on rather than trap them.
  }

  s.reteachPending = false;
  s.consecutiveWrong = 0;
  s.questionsThisGoal = state.questionsThisGoal + 1;
  s.totalQuestions = state.totalQuestions + 1;

  // GREET asks the first question; answering it begins TEACH.
  if (state.phase === "GREET") s.phase = "TEACH";

  if (s.totalQuestions >= TOTAL_QUESTION_BUDGET) {
    s.phase = "WRAP";
    return s;
  }

  if (s.questionsThisGoal >= state.questionsPerGoal) {
    const nextGoal = state.goalIndex + 1;
    if (nextGoal >= state.goalTotal) {
      s.phase = "WRAP";
      return s;
    }
    s.goalIndex = nextGoal;
    s.questionsThisGoal = 0;
  }

  return s;
}

/**
 * What the orchestrator should tell the model to do this turn.
 *
 * CALL ORDER MATTERS. Pass the state returned by `advance`, never the state
 * that went into it:
 *
 *     const next = advance(state, { intent, correct, offTopic });
 *     const instruction = instructionFor(next, { intent });   // correct
 *
 * Reading the pre-advance state carries `reteachPending` over from the previous
 * turn, so a student who asks "explain" and then answers correctly is told they
 * made a mistake.
 */
function instructionFor(state, event = {}) {
  const intent = event.intent || "ANSWER";
  if (state.phase === "DONE") return "session_over";
  if (state.phase === "WRAP") {
    return state.endedReason === "off_topic" ? "close_off_topic" : "wrap";
  }
  if (intent === "ACK") return "reask_shorter";
  if (intent === "IDK") return "hint_then_easier";
  if (intent === "HELP") return "explain_differently";
  if (state.reteachPending) {
    // 1st wrong: correct it and re-ask easier. 2nd+: teach it a different way.
    return state.consecutiveWrong >= 2 ? "reteach_new_angle" : "correct_and_reask";
  }
  if (state.questionsThisGoal === 0 && state.totalQuestions > 0) return "introduce_next_goal";
  if (state.phase === "GREET") return "greet_and_ask";
  return "acknowledge_and_ask_next";
}

module.exports = {
  PHASES,
  TOTAL_QUESTION_BUDGET,
  MAX_QUESTIONS_PER_GOAL,
  MAX_ATTEMPTS,
  OFF_TOPIC_STRIKES,
  questionsPerGoal,
  initialState,
  advance,
  instructionFor,
};
