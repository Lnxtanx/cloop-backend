// Keep the academic task separate from a support choice, explanation or recap.
const FIELDS = ['lastQuestionText', 'lastQuestionOptions', 'lastQuestionRubric', 'lastQuestionRecord', 'lastQuestionType'];
const { isGoalHeadingQuestion } = require('./validate');

function isAcademicQuestionContract(questionText, rubric, options, questionType) {
  if (!String(questionText || '').trim() || isGoalHeadingQuestion(questionText) ||
      !rubric?.criteria?.length || !String(rubric.model_answer || '').trim()) return false;
  const ids = new Set();
  for (const criterion of rubric.criteria) {
    const id = String(criterion?.id || '').trim();
    if (!id || !String(criterion.description || '').trim() || ids.has(id)) return false;
    ids.add(id);
  }
  if (questionType === 'mcq') {
    if (!Array.isArray(options) || options.length < 2 || options.length > 4) return false;
    const texts = options.map(option => option?.text);
    if (texts.some((text, index) => !text || options[index].value !== text) || new Set(texts).size !== texts.length) return false;
    return texts.filter(text => text === rubric.correct_option_text).length === 1;
  }
  return questionType === 'open' && !options?.length;
}

function clearQuestionContract(next, awaitingAcademicQuestion = false) {
  Object.assign(next, { lastQuestionText: '', lastQuestionOptions: null, lastQuestionRubric: null,
    lastQuestionRecord: null, lastQuestionType: 'none', awaitingAcademicQuestion });
}

function persistQuestionContract(state, next, validated, ending = false, retireInvalid = false) {
  next.lastDisplayedQuestionType = validated.questionType || 'none';
  if (ending) {
    Object.assign(next, { lastQuestionText: '', lastQuestionOptions: null, lastQuestionRubric: null,
      lastQuestionRecord: null, lastQuestionType: null, awaitingAcademicQuestion: false });
    return;
  }
  const final = validated.messages?.at(-1);
  const hasReplacement = isAcademicQuestionContract(final?.message, validated.lastQuestionRubric, final?.options, validated.questionType);
  if (retireInvalid && !hasReplacement) {
    clearQuestionContract(next, true);
    return;
  }
  const support = validated.questionType === 'choice' || validated.questionType === 'none' || validated.taskRepair;
  if (support) {
    if (['invalid_question_contract', 'scenario_contract_mismatch'].includes(validated.fallbackReason)) {
      clearQuestionContract(next, true);
      return;
    }
    const malformedPendingTask = isGoalHeadingQuestion(state.lastQuestionText);
    const sameTask = !retireInvalid && !malformedPendingTask && !next.assessmentAdvanced && state.phase === next.phase &&
      (state.phase !== 'ROUNDUP' || state.roundupIndex === next.roundupIndex) && state.goalIndex === next.goalIndex;
    if (sameTask) {
      for (const field of FIELDS) next[field] = state[field] ?? (field === 'lastQuestionText' ? '' : null);
    } else {
      Object.assign(next, { lastQuestionText: '', lastQuestionOptions: null, lastQuestionRubric: null,
        lastQuestionRecord: null, lastQuestionType: 'none' });
    }
    next.awaitingAcademicQuestion = !next.lastQuestionRubric && !next.pendingAdvanceAfterExplanation;
    return;
  }
  // Never leave the previous rubric/options behind when a generated question is
  // incomplete. Recovery is ungraded until one complete replacement is saved.
  if (!hasReplacement) {
    clearQuestionContract(next, true);
    return;
  }
  Object.assign(next, { lastQuestionText: final?.message || '', lastQuestionOptions: final?.options || null,
    lastQuestionRubric: validated.lastQuestionRubric || null, lastQuestionRecord: validated.questionRecord || null,
    lastQuestionType: validated.questionType, awaitingAcademicQuestion: false });
}

module.exports = { persistQuestionContract, isAcademicQuestionContract, clearQuestionContract };
