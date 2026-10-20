// Keep the academic task separate from a support choice, explanation or recap.
const FIELDS = ['lastQuestionText', 'lastQuestionOptions', 'lastQuestionRubric', 'lastQuestionRecord', 'lastQuestionType'];

function persistQuestionContract(state, next, validated, ending = false, retireInvalid = false) {
  next.lastDisplayedQuestionType = validated.questionType || 'none';
  if (ending) {
    Object.assign(next, { lastQuestionText: '', lastQuestionOptions: null, lastQuestionRubric: null,
      lastQuestionRecord: null, lastQuestionType: null, awaitingAcademicQuestion: false });
    return;
  }
  if (retireInvalid) {
    Object.assign(next, { lastQuestionText: '', lastQuestionOptions: null, lastQuestionRubric: null,
      lastQuestionRecord: null, lastQuestionType: 'none', awaitingAcademicQuestion: true });
    return;
  }
  const support = validated.questionType === 'choice' || validated.questionType === 'none' || validated.taskRepair;
  if (support) {
    const sameTask = !next.assessmentAdvanced && state.phase === next.phase &&
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
  const final = validated.messages.at(-1);
  Object.assign(next, { lastQuestionText: final?.message || '', lastQuestionOptions: final?.options || null,
    lastQuestionRubric: validated.lastQuestionRubric || null, lastQuestionRecord: validated.questionRecord || null,
    lastQuestionType: validated.questionType, awaitingAcademicQuestion: false });
}

module.exports = { persistQuestionContract };
