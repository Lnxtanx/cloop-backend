// A missing/invalid generated task is a tutor failure, never student evidence.
// Two unsuccessful replacements must not trap the learner in an ACK loop.
const MAX_QUESTION_REPAIRS = 2;

function recordQuestionRecovery(state, next, validated, { ending = false } = {}) {
  const key = `${next.phase}:${next.goalIndex || 0}:${next.roundupIndex || 0}`;
  const failed = !ending && validated.taskRepair === true && validated.questionType === 'none' &&
    next.awaitingAcademicQuestion === true && !next.pendingAdvanceAfterExplanation && !next.supportRequestKind;
  if (!failed) {
    next.questionRepairStreak = 0;
    next.questionRepairKey = key;
    return { action: 'none', attempts: 0, reason: null };
  }
  const attempts = state.questionRepairKey === key ? (state.questionRepairStreak || 0) + 1 : 1;
  next.questionRepairStreak = attempts;
  next.questionRepairKey = key;
  const reason = validated.fallbackReason || 'invalid_question_contract';
  if (attempts < MAX_QUESTION_REPAIRS) return { action: 'retry', attempts, reason };

  const index = next.phase === 'ROUNDUP' ? (next.roundupIndex || 0) : (next.goalIndex || 0);
  if (['DIALOGUE', 'CHECK', 'ROUNDUP'].includes(next.phase) && next.perGoal?.[index]) {
    next.perGoal = next.perGoal.map((goal, i) => i !== index ? goal : {
      ...goal,
      assessments: { ...goal.assessments, [next.phase]: {
        ...(goal.assessments?.[next.phase] || { assessed: false, assisted: false, attempts: [] }),
        outcome: goal.assessments?.[next.phase]?.assessed ? goal.assessments[next.phase].outcome : 'unverified',
        completed: true, question_generation_unavailable: true,
      } },
    });
  }
  next.awaitingAcademicQuestion = false;
  next.pendingAdvanceAfterExplanation = true;
  next.response_mode = 'explain';
  next.lastQuestionText = '';
  next.lastQuestionRubric = null;
  next.lastQuestionOptions = null;
  next.lastQuestionRecord = null;
  next.lastQuestionType = 'none';
  validated.messages = [{ message: "Great effort! Let's continue forward to explore the next part together.", message_type: 'text' }];
  return { action: 'skip_unverified', attempts, reason };
}

module.exports = { recordQuestionRecovery, MAX_QUESTION_REPAIRS };
