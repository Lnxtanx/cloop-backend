const { evaluateStudentTurn } = require('./evaluator');
const { advance, instructionFor, initialState, questionTypeFor, isScored, attachmentsFor, normalizeIntent, scoredGoalIndex } = require('./state');
const { generateTutorResponse } = require('./tutor-generator');
const { enforce } = require('./validate');
const { getCachedDiagram } = require('./diagram-cache');
const { buildReport, reportBrief } = require('./summary');
const { generateRevisionSheet, buildFallbackRevisionSheet } = require('./revision-generator');

function findLastQuestion(chatHistory, state) {
  if (state?.lastQuestionText) return state.lastQuestionText;
  const history = Array.isArray(chatHistory) ? chatHistory : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.sender === 'ai' && msg.message && /[?？]/.test(msg.message)) return msg.message;
  }
  return 'What do you understand about this concept?';
}

function findLastQuestionOptions(chatHistory, state) {
  // An explicit null means the last question was written. Never resurrect old MCQs.
  if (state && Object.hasOwn(state, 'lastQuestionOptions')) return state.lastQuestionOptions || null;
  const history = Array.isArray(chatHistory) ? chatHistory : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.sender !== 'ai' || !msg.message || !/[?？]/.test(msg.message)) continue;
    return Array.isArray(msg.options) && msg.options.length ? msg.options : null;
  }
  return null;
}

const noEvaluation = () => ({ intent: 'ACK', is_correct: null, score_percent: null,
  error_type: null, diff_html: null, complete_answer: null, evaluation_status: 'not_applicable' });
const ASSISTANCE = new Set(['correct_and_reask', 'reteach_new_angle', 'hint_then_easier',
  'explain_differently', 'give_starter', 'reveal_and_move_on', 'teach_theory_analogy']);

function closingMessage(report) {
  if (!report.total_questions) return 'We paused without graded evidence. Your revision sheet is ready for another try.';
  if (report.legacy_evidence) return `Recorded score: ${report.overall_mastery_percent}%. Earlier evidence needs a fresh session to confirm mastery.`;
  if (report.mastery_confirmed) return `You earned ${report.overall_mastery_percent}% with independent recall. Your revision sheet is ready!`;
  if (report.ended_reason !== 'complete' || !report.recall_completed || report.assessment_coverage_percent < 100) {
    return `Assessed answers: ${report.overall_mastery_percent}%. Coverage is incomplete; use your revision sheet to practise.`;
  }
  return `Your score is ${report.overall_mastery_percent}%. Review the goals needing independent recall in your revision sheet.`;
}

/** The server persists question contracts privately; students receive bubbles and feedback only. */
async function processTutorTurn({ studentMessage = '', topic, goals = [], chatHistory = [],
  currentState = null, userProfile = {}, wantsVideo = false }) {
  const goalTotal = Math.max(1, goals.length);
  const state = currentState || initialState(goalTotal);
  const fallbackGoal = { id: 0, title: topic.title, description: topic.content || '' };
  const goalForState = st => goals[Math.min(scoredGoalIndex(st) || 0, goalTotal - 1)] || fallbackGoal;
  const currentGoal = goalForState(state);
  const lastQuestionText = findLastQuestion(chatHistory, state);
  const lastQuestionOptions = state.lastQuestionType === 'open' ? null : findLastQuestionOptions(chatHistory, state);
  const classLevel = [userProfile.grade_level ? `Class ${userProfile.grade_level}` : 'school', userProfile.board || ''].filter(Boolean).join(' ');
  const starting = !currentState && !String(studentMessage).trim();
  const terminal = state.phase === 'WRAP' || state.phase === 'DONE';

  let evaluatorResult = noEvaluation();
  if (!starting && !terminal) {
    evaluatorResult = await evaluateStudentTurn({ studentMessage, lastQuestionText, lastQuestionOptions,
      lastQuestionRubric: state.lastQuestionRubric || null, phase: state.phase,
      topicTitle: topic.title, topicContent: topic.content || '', currentGoal,
      goalIndex: scoredGoalIndex(state), totalGoals: goalTotal, classLevel });
  }
  const intent = normalizeIntent(evaluatorResult.intent);
  const nextState = starting ? { ...state } : advance(state, { intent,
    correct: evaluatorResult.is_correct, evaluationStatus: evaluatorResult.evaluation_status,
    previousQuestionAssisted: state.questionAssisted, offTopic: intent === 'OFF_TOPIC',
    errorType: evaluatorResult.error_type, answerText: evaluatorResult.resolved_answer || studentMessage, wantsVideo });
  const stateInstruction = instructionFor(nextState, { intent: starting ? 'ANSWER' : intent });
  nextState.lastInstruction = stateInstruction;
  let questionType = questionTypeFor(nextState.phase);
  const attachments = attachmentsFor(nextState);
  const ending = nextState.phase === 'WRAP' || nextState.phase === 'DONE';
  let masteryReport = null;
  let revisionSheet = null;
  if (ending) {
    masteryReport = state.wrapArtifacts?.masteryReport || buildReport(nextState, goals);
    revisionSheet = state.wrapArtifacts?.revisionSheet || null;
    if (!revisionSheet) {
      try {
        revisionSheet = await generateRevisionSheet({ topicTitle: topic.title, goals,
          keyErrors: masteryReport.key_errors, classLevel, masteryReport });
      } catch {
        revisionSheet = buildFallbackRevisionSheet({ topicTitle: topic.title, goals,
          keyErrors: masteryReport.key_errors, masteryReport });
      }
    }
    nextState.wrapArtifacts = { masteryReport, revisionSheet };
  }

  const generatorGoal = goalForState(nextState);
  const sameAssessment = !starting && !nextState.assessmentAdvanced && !ending &&
    state.phase === nextState.phase && scoredGoalIndex(state) === scoredGoalIndex(nextState);
  const generationContext = { topicTitle: topic.title, currentGoalTitle: generatorGoal.title,
    currentGoalDescription: generatorGoal.description || '', topicContent: topic.content || '',
    previousGoalTitle: currentGoal.title, previousGoalDescription: currentGoal.description || '',
    studentMessage, evaluatorResult, stateInstruction, questionType, phase: nextState.phase,
    reportBrief: masteryReport ? reportBrief(masteryReport) : null, lastQuestionText,
    lastQuestionRubric: state.lastQuestionRubric || null, lastQuestionOptions, sameAssessment,
    recentHistory: chatHistory, classLevel, wantsVideo: attachments.includes('video') && wantsVideo };
  // Code owns closing figures and claims. DONE reuses artifacts without model calls.
  const rawTutorOutput = ending
    ? { messages: [{ message: closingMessage(masteryReport), message_type: 'text' }] }
    : await generateTutorResponse(generationContext);
  const validated = enforce(rawTutorOutput, { ...generationContext,
    isCorrect: evaluatorResult.is_correct, diffHtml: evaluatorResult.diff_html,
    studentMessage: evaluatorResult.resolved_answer || studentMessage });
  questionType = validated.questionType;
  const finalBubble = validated.messages[validated.messages.length - 1];
  nextState.lastQuestionText = ending ? '' : finalBubble?.message || '';
  nextState.lastQuestionOptions = ending ? null : finalBubble?.options || null;
  nextState.lastQuestionRubric = ending ? null : validated.lastQuestionRubric;
  nextState.lastQuestionType = questionType;
  nextState.questionAssisted = sameAssessment && (state.questionAssisted || ASSISTANCE.has(stateInstruction));
  const gradedThisTurn = !terminal && intent === 'ANSWER' && isScored(state.phase) &&
    typeof evaluatorResult.is_correct === 'boolean' && evaluatorResult.evaluation_status !== 'unavailable';
  const isAnswer = !terminal && !starting && intent === 'ANSWER';
  const userCorrection = isAnswer ? {
    message_type: 'user_correction', diff_html: validated.diff_html || null,
    complete_answer: evaluatorResult.complete_answer || null,
    emoji: evaluatorResult.is_correct === true ? '😊' : '😅',
    feedback: { is_correct: evaluatorResult.is_correct, error_type: evaluatorResult.error_type || null,
      explanation: evaluatorResult.feedback || (evaluatorResult.is_correct === true
        ? 'Your answer meets the question requirements.' : evaluatorResult.is_correct === false
          ? 'Review the corrected concept, then try again.' : 'This answer could not be graded. Please try again.'),
      evaluation_status: evaluatorResult.evaluation_status || 'available' }
  } : null;
  const diagram = attachments.includes('diagram') ? getCachedDiagram(topic.title, generatorGoal.title, generatorGoal) : null;
  return { evaluatorResult, intent, answeredPhase: state.phase, gradedThisTurn, nextState,
    stateInstruction, questionType, attachments, masteryReport, revisionSheet,
    messages: validated.messages, userCorrection, mermaid_diagram: diagram,
    all_goals_completed: !!(masteryReport?.session_completed && masteryReport?.recall_completed &&
      masteryReport.goals_completed === masteryReport.goals_total),
    session_closed: ending,
    session_completed: masteryReport?.session_completed || false,
    mastery_confirmed: masteryReport?.mastery_confirmed || false };
}

module.exports = { processTutorTurn, findLastQuestion, findLastQuestionOptions, closingMessage };
