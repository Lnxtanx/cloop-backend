const { evaluateStudentTurn, resolveOptionAnswer } = require('./evaluator');
const { advance, instructionFor, initialState, questionTypeFor, isScored, attachmentsFor, normalizeIntent } = require('./state');
const { generateTutorResponse } = require('./tutor-generator');
const { enforce } = require('./validate');
const { getCachedDiagram } = require('./diagram-cache');
const { buildReport, reportBrief } = require('./summary');

/**
 * Extract the last question asked by the tutor from chat history or state
 */
function findLastQuestion(chatHistory, state) {
  if (state?.lastQuestionText) {
    return state.lastQuestionText;
  }

  if (Array.isArray(chatHistory)) {
    for (let i = chatHistory.length - 1; i >= 0; i--) {
      const msg = chatHistory[i];
      if (msg.sender === 'ai' && msg.message && /[?？]/.test(msg.message)) {
        return msg.message;
      }
    }
  }

  return 'What do you understand about this concept?';
}

/**
 * The Central Orchestrator Pipeline
 *
 * Runs Steps 1 -> 2 -> 3 -> 4:
 * 1. Evaluates user input (resolves option letters, semantic intent, grading, diff).
 * 2. Advances server-owned state machine (crisp 2-turn per goal progression).
 * 3. Generates Socratic dialogue bubbles (explains first on struggle, respects questionType).
 * 4. Deterministically validates and auto-heals output before persistence.
 *
 * @param {object} params
 * @param {string} params.studentMessage
 * @param {object} params.topic - { id, title, content }
 * @param {Array}  params.goals - Array of global_topic_goals
 * @param {Array}  params.chatHistory - Recent admin_chat messages
 * @param {object} [params.currentState] - Session state from DB or memory
 * @param {object} [params.userProfile] - { board, grade_level, name }
 * @param {boolean} [params.wantsVideo] - Explicit or detected video request
 * @returns {Promise<object>} Orchestrated turn result
 */
async function processTutorTurn({
  studentMessage,
  topic,
  goals = [],
  chatHistory = [],
  currentState = null,
  userProfile = {},
  wantsVideo = false
}) {
  const goalTotal = Math.max(1, goals.length);
  const state = currentState || initialState(goalTotal);

  const currentGoalIndex = Math.min(state.goalIndex, goalTotal - 1);
  const currentGoal = goals[currentGoalIndex] || {
    id: 0,
    title: topic.title,
    description: ''
  };

  const lastQuestionText = findLastQuestion(chatHistory, state);
  const classLevel = userProfile.grade_level ? `Class ${userProfile.grade_level}` : 'Class 10';

  // ── Step 1: Evaluator Engine (LLM Call 1, Temp 0.0, ~1.5s) ──────────────────
  const evaluatorResult = await evaluateStudentTurn({
    studentMessage,
    lastQuestionText,
    lastQuestionOptions: state.lastQuestionOptions,
    topicTitle: topic.title,
    topicContent: topic.content || '',
    currentGoal,
    goalIndex: currentGoalIndex,
    totalGoals: goalTotal,
    classLevel
  });

  // ── Step 2: State Machine Advance (Pure JS, < 1ms) ──────────────────────────
  const intent = normalizeIntent(evaluatorResult.intent);
  const answeredPhase = state.phase; // the phase the student was answering IN

  const nextState = advance(state, {
    intent,
    correct: evaluatorResult.is_correct,
    offTopic: intent === 'OFF_TOPIC',
    errorType: evaluatorResult.error_type,
    answerText: evaluatorResult.resolved_answer || studentMessage,
    wantsVideo
  });

  // CRITICAL INVARIANT: instructionFor is called strictly on POST-ADVANCE state
  const stateInstruction = instructionFor(nextState, { intent });

  // Remember it, so the next turn cannot issue the same directive again.
  nextState.lastInstruction = stateInstruction;

  const questionType = questionTypeFor(nextState.phase);
  const attachments = attachmentsFor(nextState);

  // If wrapping, build mastery report and brief
  let masteryReport = null;
  let masteryBrief = null;
  if (nextState.phase === 'WRAP' || nextState.phase === 'DONE') {
    masteryReport = buildReport(nextState, goals);
    masteryBrief = reportBrief(masteryReport);
  }

  // ── Step 3: Socratic Dialogue Generator (LLM Call 2, Temp 0.4, ~2.0s) ──────
  const rawTutorOutput = await generateTutorResponse({
    topicTitle: topic.title,
    currentGoalTitle: currentGoal.title,
    studentMessage,
    evaluatorResult,
    stateInstruction,
    questionType,
    phase: nextState.phase,
    reportBrief: masteryBrief,
    lastQuestionText,
    recentHistory: chatHistory,
    classLevel,
    wantsVideo
  });

  // ── Step 3b: Diagram / Attachments Retrieval ──────────────────────────────
  let mermaidDiagram = null;
  if (attachments.includes('diagram')) {
    mermaidDiagram = getCachedDiagram(topic.title, currentGoal.title, currentGoal);
  }

  // ── Step 4: Quality & Structural Validator (Pure JS, < 1ms) ────────────────
  const fallbackQuestion = questionType === 'mcq'
    ? `Which of these best explains ${currentGoal.title}?`
    : `What do you think is the next key step in ${currentGoal.title}?`;

  const validated = enforce(rawTutorOutput, {
    isCorrect: evaluatorResult.is_correct,
    phase: nextState.phase,
    questionType,
    fallbackQuestion,
    diffHtml: evaluatorResult.diff_html,
    studentMessage: evaluatorResult.resolved_answer || studentMessage
  });

  // Remember the new question & options in state for next turn
  const finalBubble = validated.messages[validated.messages.length - 1];
  if (finalBubble && finalBubble.message) {
    nextState.lastQuestionText = finalBubble.message;
    nextState.lastQuestionOptions = Array.isArray(finalBubble.options) && finalBubble.options.length > 0
      ? finalBubble.options
      : null;
  } else {
    nextState.lastQuestionOptions = null;
  }

  // Build user correction object for UI
  // Any answer attempt evaluated as incorrect receives a correction box with diff_html
  // so the student visibly sees what to correct.
  const gradedThisTurn = intent === 'ANSWER' && isScored(answeredPhase);
  const userCorrection = intent === 'ANSWER' && evaluatorResult.is_correct === false ? {
    message_type: 'user_correction',
    diff_html: validated.diff_html,
    complete_answer: evaluatorResult.complete_answer,
    emoji: evaluatorResult.score_percent === 0 ? '😓' : (evaluatorResult.score_percent < 50 ? '😅' : '😊'),
    feedback: {
      is_correct: false,
      score_percent: evaluatorResult.score_percent,
      error_type: evaluatorResult.error_type
    }
  } : null;

  return {
    evaluatorResult,
    intent,
    answeredPhase,
    gradedThisTurn,
    nextState,
    stateInstruction,
    questionType,
    attachments,
    masteryReport,
    messages: validated.messages,
    userCorrection,
    mermaid_diagram: mermaidDiagram,
    all_goals_completed: nextState.phase === 'WRAP' || nextState.phase === 'DONE'
  };
}

module.exports = {
  processTutorTurn,
  findLastQuestion
};
