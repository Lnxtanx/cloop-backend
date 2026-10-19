/**
 * Socratic Tutor Agent - Core Decision Loop
 *
 * Implements the Socratic dialogue cycle:
 * 1. Intent & Academic Evaluation (DeepSeek-V4-Pro with Always-On Thinking)
 * 2. 5-Phase State Progression (THEORY -> DIALOGUE -> CHECK -> ROUNDUP -> WRAP)
 * 3. 2-Attempt Scaffolding Policy (Prevents infinite loops on "I don't know")
 * 4. Micro-Bubble Delivery with Dynamic Expansion for Explanations
 * 5. Grounded Final Revision Sheet Generation
 */

const { evaluateStudentTurn } = require('./evaluators/answer-evaluator');
const {
  advance,
  instructionFor,
  initialState,
  questionTypeFor,
  isScored,
  attachmentsFor,
  
  normalizeIntent,
  scoredGoalIndex,
  buildGoalMap,
  computeTeachingCoverage,
  computeChecksCompleted,
  isGoalTaught,
} = require('./state/state-machine');
const { generateTutorResponse } = require('./generators/dialogue-generator');
const { generateRevisionSheet, buildFallbackRevisionSheet } = require('./generators/revision-generator');
const { enforce } = require('./formatters/bubble-formatter');
const { getCachedDiagram } = require('./tools/diagram-tool');

let buildReport, reportBrief;
try {
  ({ buildReport, reportBrief } = require('../../../services/tutor-core/summary'));
} catch (_) {
  buildReport = () => ({ session_completed: false, overall_mastery_percent: 0 });
  reportBrief = () => 'Session in progress';
}

let buildAcademicNotes;
try {
  ({ buildAcademicNotes } = require('../../../services/tutor-core/academic-notes'));
} catch (_) {
  buildAcademicNotes = () => null;
}

function inspectDeliveredTeaching(messages, goal, academicNotes) {
  const text = (messages || []).map(m => m.message || '').join(' ').toLowerCase();
  const coverage = { definition: false, explanation: false, formula: false, example: false };
  if (!text) return coverage;

  if (/\b(defined as|is defined as|means that|is the|refers to|called|known as|concept of)\b/i.test(text) ||
      (academicNotes?.definition && text.includes(academicNotes.definition.toLowerCase().slice(0, 20)))) {
    coverage.definition = true;
  }
  if (/\b(because|when|causes|results in|mechanism|occurs when|due to|this happens|as a result)\b/i.test(text) ||
      (academicNotes?.mechanism && text.includes(academicNotes.mechanism.toLowerCase().slice(0, 20)))) {
    coverage.explanation = true;
  }
  if (/\b(formula|measured in|units?|si unit|kg|m\/s|n\b|joules?|p\s*=|f\s*=|v\s*=)\b/i.test(text) ||
      (academicNotes?.formulas?.length && academicNotes.formulas.some(f => text.includes(String(f).toLowerCase())))) {
    coverage.formula = true;
  }
  if (/\b(for example|e\.g\.|such as|imagine|consider|like when|take a|for instance)\b/i.test(text)) {
    coverage.example = true;
  }
  return coverage;
}

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
  if (state && Object.hasOwn(state, 'lastQuestionOptions')) return state.lastQuestionOptions || null;
  const history = Array.isArray(chatHistory) ? chatHistory : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.sender !== 'ai' || !msg.message || !/[?？]/.test(msg.message)) continue;
    return Array.isArray(msg.options) && msg.options.length ? msg.options : null;
  }
  return null;
}

const noEvaluation = () => ({
  intent: 'ACK',
  is_correct: null,
  score_percent: null,
  error_type: null,
  diff_html: null,
  complete_answer: null,
  evaluation_status: 'not_applicable',
});

const ASSISTANCE = new Set([
  'correct_and_reask',
  'reteach_new_angle',
  'hint_then_easier',
  'explain_differently',
  'give_starter',
  'reveal_and_move_on',
  'teach_theory_analogy',
]);

function closingMessage(report) {
  if (!report.total_questions) return 'We paused without graded evidence. Your revision sheet is ready for another try.';
  if (report.legacy_evidence) return `Recorded score: ${report.overall_mastery_percent}%. Earlier evidence needs a fresh session to confirm mastery.`;
  if (report.mastery_confirmed) return `You earned ${report.overall_mastery_percent}% with independent recall. Your revision sheet is ready!`;
  if (report.ended_reason !== 'complete' || !report.recall_completed || report.assessment_coverage_percent < 100) {
    return `Assessed answers: ${report.overall_mastery_percent}%. Coverage is incomplete; use your revision sheet to practise.`;
  }
  return `Your score is ${report.overall_mastery_percent}%. Review the goals needing independent recall in your revision sheet.`;
}

/**
 * Execute a Socratic Tutor Agent turn
 *
 * @param {Object} params
 * @param {string} [params.studentMessage=''] - Student input message
 * @param {Object} params.topic - Topic metadata ({ id, title, content })
 * @param {Array} [params.goals=[]] - Target learning goals
 * @param {Array} [params.chatHistory=[]] - Chat history turns
 * @param {Object|null} [params.currentState=null] - Persistent agent session state
 * @param {Object} [params.userProfile={}] - User academic profile ({ grade_level, board })
 * @param {boolean} [params.wantsVideo=false] - Video attachment trigger
 * @param {Object|null} [params.akgContext=null] - Academic Knowledge Graph context
 * @param {number|null} [params.userId=null] - Authenticated user ID for telemetry attribution
 * @returns {Promise<Object>} Agent turn output
 */
async function processTurn({
  studentMessage = '',
  topic,
  goals = [],
  chatHistory = [],
  currentState = null,
  userProfile = {},
  wantsVideo = false,
  akgContext = null,
  userId = null,
}) {
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
    const isAwaitingChoice = Boolean(state.response_mode === 'offer_choice' || (state.active_learning_point_id && state.learning_support?.[state.active_learning_point_id]?.awaiting_choice));
    evaluatorResult = await evaluateStudentTurn({
      studentMessage,
      lastQuestionText,
      lastQuestionOptions,
      lastQuestionRubric: state.lastQuestionRubric || null,
      lastQuestionRecord: state.lastQuestionRecord || null,
      scenario: state.lastQuestionRecord?.scenario || null,
      phase: state.phase,
      response_mode: state.response_mode || null,
      awaiting_learning_choice: isAwaitingChoice,
      topicTitle: topic.title,
      topicContent: topic.content || '',
      currentGoal,
      goalIndex: scoredGoalIndex(state),
      totalGoals: goalTotal,
      classLevel,
      akgContext,
      userId,
    });
  }

  const intent = normalizeIntent(evaluatorResult.intent);
  const nextState = starting ? { ...state } : advance(state, {
    intent,
    correct: evaluatorResult.is_correct,
    evaluationStatus: evaluatorResult.evaluation_status,
    helpSubtype: evaluatorResult.help_subtype,
    suggestedAction: evaluatorResult.suggested_action,
    previousQuestionAssisted: state.questionAssisted,
    offTopic: intent === 'OFF_TOPIC',
    errorType: evaluatorResult.error_type,
    answerText: evaluatorResult.resolved_answer || studentMessage,
    wantsVideo,
    requestKind: evaluatorResult.request_kind || evaluatorResult.requestKind || null,
    request_kind: evaluatorResult.request_kind || evaluatorResult.requestKind || null,
    lastQuestionRecord: state.lastQuestionRecord || null,
  });

  const stateInstruction = instructionFor(nextState, {
    intent: starting ? 'ANSWER' : intent,
    helpSubtype: evaluatorResult.help_subtype,
    suggestedAction: evaluatorResult.suggested_action,
  });
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
        revisionSheet = await generateRevisionSheet({
          topicTitle: topic.title,
          goals,
          keyErrors: masteryReport.key_errors,
          classLevel,
          masteryReport,
          userId,
        });
      } catch {
        revisionSheet = buildFallbackRevisionSheet({
          topicTitle: topic.title,
          goals,
          keyErrors: masteryReport.key_errors,
          masteryReport,
        });
      }
    }
    nextState.wrapArtifacts = { masteryReport, revisionSheet };
  }

  const generatorGoal = goalForState(nextState);
  const currentGoalIdx = scoredGoalIndex(nextState);
  const academicNotes = generatorGoal ? buildAcademicNotes(generatorGoal, topic.content || '') : null;
  const isRepetitionComplaint = /\b(already\s+asked|same\s+question|asked\s+(this\s+)?before|repeat(ing|ed)?)\b/i.test(studentMessage || '');
  const isHelpOrIdk = intent === 'HELP' || intent === 'IDK';
  const sameAssessment = !starting && !nextState.assessmentAdvanced && !ending &&
    state.phase === nextState.phase && scoredGoalIndex(state) === currentGoalIdx &&
    !isRepetitionComplaint && !isHelpOrIdk;
  const goalMap = buildGoalMap(goals, currentGoalIdx, nextState.phase);

  const generationContext = {
    topicTitle: topic.title,
    currentGoalTitle: generatorGoal.title,
    currentGoalDescription: generatorGoal.description || '',
    topicContent: topic.content || '',
    academicNotes,
    previousGoalTitle: currentGoal.title,
    previousGoalDescription: currentGoal.description || '',
    studentMessage,
    evaluatorResult,
    stateInstruction,
    questionType,
    phase: nextState.phase,
    response_mode: nextState.response_mode || null,
    learning_point_id: nextState.active_learning_point_id || null,
    learning_support: nextState.learning_support || null,
    reportBrief: masteryReport ? reportBrief(masteryReport) : null,
    lastQuestionText,
    lastQuestionRubric: state.lastQuestionRubric || null,
    lastQuestionOptions,
    sameAssessment,
    isHelpOrIdk,
    intent,
    isRepetitionComplaint,
    recentHistory: chatHistory,
    classLevel,
    wantsVideo: attachments.includes('video') && wantsVideo,
    akgContext,
    goals,
    goalIndex: currentGoalIdx,
    totalGoals: goalTotal,
    goalMap,
    userId,
  };

  const rawTutorOutput = ending
    ? { messages: [{ message: closingMessage(masteryReport), message_type: 'text' }] }
    : await generateTutorResponse(generationContext);

  const validated = enforce(rawTutorOutput, {
    ...generationContext,
    isCorrect: evaluatorResult.is_correct,
    diffHtml: evaluatorResult.diff_html,
    studentMessage: evaluatorResult.resolved_answer || studentMessage,
  });

  questionType = validated.questionType;
  const finalBubble = validated.messages[validated.messages.length - 1];
  nextState.lastQuestionText = ending ? '' : finalBubble?.message || '';
  nextState.lastQuestionOptions = ending ? null : finalBubble?.options || null;
  nextState.lastQuestionRubric = ending ? null : validated.lastQuestionRubric;
  nextState.lastQuestionRecord = ending ? null : (validated.questionRecord || null);
  nextState.lastQuestionType = questionType;
  nextState.questionAssisted = (sameAssessment && (state.questionAssisted || ASSISTANCE.has(stateInstruction))) || Boolean(validated.questionAssisted);

  if (!ending && nextState.teachingCoverage && nextState.teachingCoverage[currentGoalIdx]) {
    const turnCoverage = inspectDeliveredTeaching(validated.messages, generatorGoal, academicNotes);
    const existing = nextState.teachingCoverage[currentGoalIdx];
    existing.definition = existing.definition || turnCoverage.definition;
    existing.explanation = existing.explanation || turnCoverage.explanation;
    existing.formula = existing.formula || turnCoverage.formula;
    existing.example = existing.example || turnCoverage.example;
  }

  const gradedThisTurn = !terminal && intent === 'ANSWER' && isScored(state.phase) &&
    typeof evaluatorResult.is_correct === 'boolean' && evaluatorResult.evaluation_status !== 'unavailable';
  const isAnswer = !terminal && !starting && intent === 'ANSWER' && evaluatorResult.userCorrection !== null;
  const userCorrection = isAnswer ? {
    message_type: 'user_correction',
    diff_html: validated.diff_html || null,
    complete_answer: evaluatorResult.complete_answer || null,
    emoji: evaluatorResult.is_correct === true ? '😊' : '😅',
    feedback: {
      is_correct: evaluatorResult.is_correct,
      error_type: evaluatorResult.error_type || null,
      explanation: evaluatorResult.feedback || (evaluatorResult.is_correct === true
        ? 'Your answer meets the question requirements.'
        : evaluatorResult.is_correct === false
          ? 'Review the corrected concept, then try again.'
          : 'This answer could not be graded. Please try again.'),
      evaluation_status: evaluatorResult.evaluation_status || 'available',
    },
  } : null;

  const diagram = attachments.includes('diagram') ? getCachedDiagram(topic.title, generatorGoal.title, generatorGoal) : null;
  const teachingCoveragePercent = computeTeachingCoverage(nextState);
  const checksCompleted = computeChecksCompleted(nextState);
  const assessmentHandoff = ending ? {
    topic: topic.title,
    sourceVersion: 'v1',
    teachingCoverage: nextState.teachingCoverage,
    misconceptions: (nextState.perGoal || []).flatMap(g => g.errors || []),
    assistanceHistory: (nextState.perGoal || []).map((g, idx) => ({
      goalIndex: idx,
      assisted: Object.values(g.assessments || {}).some(a => a.assisted),
    })),
  } : null;

  return {
    evaluatorResult,
    intent,
    answeredPhase: state.phase,
    gradedThisTurn,
    nextState,
    stateInstruction,
    questionType,
    attachments,
    masteryReport,
    revisionSheet,
    messages: validated.messages,
    userCorrection,
    mermaid_diagram: diagram,
    teaching_coverage_percent: teachingCoveragePercent,
    checks_completed: checksCompleted,
    assessment_handoff: assessmentHandoff,
    all_goals_completed: !!(masteryReport?.session_completed && masteryReport?.recall_completed &&
      masteryReport.goals_completed === masteryReport.goals_total),
    session_closed: ending,
    session_completed: masteryReport?.session_completed || false,
    mastery_confirmed: masteryReport?.mastery_confirmed || false,
  };
}

module.exports = {
  processTurn,
  findLastQuestion,
  findLastQuestionOptions,
  closingMessage,
};
