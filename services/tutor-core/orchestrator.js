const { evaluateStudentTurn } = require('./evaluator');
const { advance, instructionFor, initialState } = require('./state');
const { generateTutorResponse } = require('./tutor-generator');
const { enforce } = require('./validate');
const { getCachedDiagram } = require('./diagram-cache');

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
 * 1. Evaluates user input (semantic intent, grading, diff).
 * 2. Advances server-owned state machine (budget, goal transitions, off-topic streaks).
 * 3. Generates Socratic dialogue bubbles (<= 20 words each).
 * 4. Deterministically validates and auto-heals output before persistence.
 *
 * @param {object} params
 * @param {string} params.studentMessage
 * @param {object} params.topic - { id, title, content }
 * @param {Array}  params.goals - Array of global_topic_goals
 * @param {Array}  params.chatHistory - Recent admin_chat messages
 * @param {object} [params.currentState] - Session state from DB or memory
 * @param {object} [params.userProfile] - { board, grade_level, name }
 * @returns {Promise<object>} Orchestrated turn result
 */
async function processTutorTurn({
  studentMessage,
  topic,
  goals = [],
  chatHistory = [],
  currentState = null,
  userProfile = {}
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
    topicTitle: topic.title,
    topicContent: topic.content || '',
    currentGoal,
    goalIndex: currentGoalIndex,
    totalGoals: goalTotal,
    classLevel
  });

  // ── Step 2: State Machine Advance (Pure JS, < 1ms) ──────────────────────────
  const isOffTopic = evaluatorResult.intent === 'OFF_TOPIC' || evaluatorResult.intent === 'GIBBERISH';
  const nextState = advance(state, {
    intent: evaluatorResult.intent,
    correct: evaluatorResult.is_correct,
    offTopic: isOffTopic
  });

  // CRITICAL INVARIANT: instructionFor is called strictly on POST-ADVANCE state
  const stateInstruction = instructionFor(nextState, {
    intent: evaluatorResult.intent
  });

  // ── Step 3: Socratic Dialogue Generator (LLM Call 2, Temp 0.4, ~2.0s) ──────
  const rawTutorOutput = await generateTutorResponse({
    topicTitle: topic.title,
    currentGoalTitle: currentGoal.title,
    studentMessage,
    evaluatorResult,
    stateInstruction,
    lastQuestionText,
    recentHistory: chatHistory,
    classLevel
  });

  // ── Step 3b: Diagram Retrieval Off Critical Path (0ms) ──────────────────────
  let mermaidDiagram = null;
  if (nextState.questionsThisGoal === 0 && nextState.phase === 'TEACH') {
    mermaidDiagram = getCachedDiagram(topic.title, currentGoal.title, currentGoal);
  }

  // ── Step 4: Quality & Structural Validator (Pure JS, < 1ms) ────────────────
  const fallbackQuestion = `What do you think is the next key step in ${currentGoal.title}?`;
  const validated = enforce(rawTutorOutput, {
    isCorrect: evaluatorResult.is_correct,
    phase: nextState.phase,
    fallbackQuestion,
    diffHtml: evaluatorResult.diff_html,
    studentMessage
  });

  // Remember the new question in state for next turn's lastQuestionText
  const finalBubble = validated.messages[validated.messages.length - 1];
  if (finalBubble && finalBubble.message) {
    nextState.lastQuestionText = finalBubble.message;
  }

  // Build user correction object for UI
  const userCorrection = evaluatorResult.intent === 'ANSWER' && evaluatorResult.is_correct === false ? {
    message_type: 'user_correction',
    diff_html: validated.diff_html,
    complete_answer: evaluatorResult.complete_answer,
    emoji: evaluatorResult.score_percent === 0 ? '😓' : (evaluatorResult.score_percent < 50 ? '😢' : '😅'),
    feedback: {
      is_correct: false,
      score_percent: evaluatorResult.score_percent,
      error_type: evaluatorResult.error_type
    }
  } : null;

  return {
    evaluatorResult,
    nextState,
    stateInstruction,
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
