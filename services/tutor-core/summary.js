/**
 * The end-of-session mastery report.
 *
 * Every figure here is computed from what actually happened in the session —
 * the per-goal tallies the state machine recorded as answers were graded. The
 * model is never asked how well the student did.
 *
 * That separation is deliberate. A tutor that both teaches and scores its own
 * teaching produced "Right — all three are solids" attached to `is_correct:
 * true, score 100%`. The report is the one artefact a parent or teacher will
 * actually read, and it is the last place an invented number belongs. The model
 * gets the numbers and writes the sentences around them; it does not produce
 * them.
 *
 * Legacy tallies stay readable, but unmatched totals cannot certify mastery.
 * `score_evidence` labels that history and `fresh_session_recommended` asks
 * callers to start a fully evidenced assessment instead of inventing slots.
 */

const { bandFor, goalCompletion, OPEN_PER_GOAL, MCQ_PER_GOAL, RECALL_PER_GOAL } = require("./state");

const pct = (n, d) => (d === 0 ? 0 : Math.round((n / d) * 100));

/**
 * Build the report.
 *
 * @param {object} state - the final session state
 * @param {Array<{id?: number, title: string}>} goals
 * @returns {object} the mastery report
 */
function buildReport(state, goals = []) {
  const evidence = state.perGoal || [];
  const expectedPerGoal = OPEN_PER_GOAL + MCQ_PER_GOAL + RECALL_PER_GOAL;
  const perGoal = evidence.map((g, i) => {
    const slots = Object.values(g.assessments || {});
    const recall = g.assessments?.ROUNDUP;
    const asked = Math.max(0, g.total || 0);
    const correct = Math.min(asked, Math.max(0, g.correct || 0));
    const accuracy = asked === 0 ? 0 : correct / asked;
    const recallCompleted = !!(recall?.completed && recall.assessed);
    const recallPassed = !!(recallCompleted && recall.outcome === "correct" && !recall.assisted);
    const assessedSlots = slots.filter((slot) => slot.assessed);
    const legacyEvidence = asked !== assessedSlots.length;
    const scoreEvidence = legacyEvidence
      ? (assessedSlots.length ? "legacy_mixed" : "legacy_totals") : "assessment_slots";
    const assistedAnswers = assessedSlots.filter((slot) => slot.first_correct === true && slot.outcome !== "correct").length;
    // Old persisted tallies remain readable, but cannot establish recall.
    const incorrect = Math.max(0, asked - correct - assistedAnswers);
    const complete = goalCompletion(state, i);
    let band = asked === 0 ? "Not covered" : bandFor(accuracy);
    if (band === "Mastered" && (legacyEvidence || !recallPassed || assessedSlots.length < expectedPerGoal)) band = "Proficient";
    return {
      goal_id: goals[i]?.id || i + 1,
      goal: goals[i]?.title || `Goal ${i + 1}`,
      goal_title: goals[i]?.title || `Goal ${i + 1}`,
      asked,
      questions_asked: asked,
      correct,
      correct_answers: correct,
      incorrect_answers: incorrect,
      assisted_answers: assistedAnswers,
      assisted_assessments: assessedSlots.filter((slot) => slot.assisted).length,
      skipped_assessments: slots.filter((slot) => slot.outcome === "skipped").length,
      unverified_assessments: slots.filter((slot) => slot.outcome === "unverified").length,
      assessment_coverage_percent: Math.min(100, pct(asked, expectedPerGoal)),
      accuracy_percent: pct(correct, asked),
      score_percent: pct(correct, asked),
      band,
      errors: [...new Set(g.errors || [])],
      error_count: (g.errors || []).length,
      attempts: slots.reduce((sum, slot) => sum + (slot.attempts || []).length, 0),
      attempted: asked > 0,
      is_completed: complete,
      recall_completed: recallCompleted,
      recall_passed: recallPassed,
      mastery_confirmed: band === "Mastered",
      score_evidence: scoreEvidence,
      legacy_evidence: legacyEvidence,
      fresh_session_recommended: legacyEvidence,
    };
  });

  const attempted = perGoal.filter((g) => g.attempted);
  const asked = attempted.reduce((n, g) => n + g.asked, 0);
  const correct = attempted.reduce((n, g) => n + g.correct, 0);
  const incorrect = attempted.reduce((n, g) => n + g.incorrect_answers, 0);
  const assisted = attempted.reduce((n, g) => n + g.assisted_answers, 0);
  const overall = pct(correct, asked);
  const recallCompleted = perGoal.length > 0 && perGoal.every((g) => g.recall_completed);
  const recallPassed = perGoal.length > 0 && perGoal.every((g) => g.recall_passed);
  const masteryConfirmed = perGoal.length > 0 && perGoal.every((g) => g.mastery_confirmed);
  const legacyEvidence = perGoal.some((g) => g.legacy_evidence);
  const hasAssessmentSlots = evidence.some((g) => Object.values(g.assessments || {}).some((slot) => slot.assessed));
  const scoreEvidence = legacyEvidence
    ? (hasAssessmentSlots ? "legacy_mixed" : "legacy_totals") : "assessment_slots";

  // Diagnostic mistakes include retries, while the score counts each slot once.
  const counts = new Map();
  for (const g of evidence) for (const e of g.errors || []) counts.set(e, (counts.get(e) || 0) + 1);
  const keyErrors = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count }));

  const learnedWell = attempted.filter((g) => g.recall_passed && (g.band === "Mastered" || g.band === "Proficient"));
  // A strong MCQ/dialogue average cannot hide missing or assisted recall.
  const toImprove = attempted.filter((g) => !learnedWell.includes(g));
  const notCovered = perGoal.filter((g) => !g.attempted);
  const expected = perGoal.length * expectedPerGoal;
  let overallBand = asked === 0 ? "Not covered" : bandFor(correct / asked);
  if (overallBand === "Mastered" && !masteryConfirmed) overallBand = "Proficient";
  let stars = overall >= 90 ? 5 : overall >= 75 ? 4 : overall >= 60 ? 3 : overall >= 40 ? 2 : 1;
  if (!masteryConfirmed) stars = Math.min(stars, 4);
  const performanceLevel = overall >= 80 && masteryConfirmed ? "Excellent" : overall >= 60 ? "Good" : "Needs Improvement";

  return {
    overall_mastery_percent: overall,
    score_percent: overall,
    overall_score_percent: overall,
    overall_band: overallBand,
    star_rating: stars,
    performance_level: performanceLevel,
    total_questions: asked,
    questions_asked: asked,
    correct_answers: correct,
    questions_correct: correct,
    incorrect_answers: incorrect,
    assisted_answers: assisted,
    goals_covered: attempted.length,
    goals_completed: perGoal.filter((g) => g.is_completed).length,
    goals_total: perGoal.length,
    assessments_expected: expected,
    assessments_assessed: asked,
    assessments_skipped: perGoal.reduce((n, g) => n + g.skipped_assessments, 0),
    assessments_unverified: perGoal.reduce((n, g) => n + g.unverified_assessments, 0),
    assessment_coverage_percent: Math.min(100, pct(asked, expected)),
    recall_completed: recallCompleted,
    recall_passed: recallPassed,
    recall_goals_completed: perGoal.filter((g) => g.recall_completed).length,
    recall_goals_passed: perGoal.filter((g) => g.recall_passed).length,
    incomplete_recall: perGoal.filter((g) => !g.recall_completed).map((g) => g.goal),
    mastery_confirmed: masteryConfirmed,
    score_evidence: scoreEvidence,
    legacy_evidence: legacyEvidence,
    fresh_session_recommended: legacyEvidence,
    session_completed: state.endedReason === "complete" && (state.phase === "WRAP" || state.phase === "DONE"),
    ended_reason: state.endedReason || "complete",

    learned_well: learnedWell.map((g) => ({
      goal: g.goal,
      goal_title: g.goal,
      accuracy_percent: g.accuracy_percent,
      band: g.band,
    })),
    areas_to_improve: toImprove.map((g) => ({
      goal: g.goal,
      goal_title: g.goal,
      accuracy_percent: g.accuracy_percent,
      band: g.band,
      errors: g.errors,
      recall_completed: g.recall_completed,
      recall_passed: g.recall_passed,
    })),
    weak_goals: toImprove.map((g) => ({
      goal_title: g.goal,
      score_percent: g.accuracy_percent,
    })),
    has_weak_areas: toImprove.length > 0,
    not_covered: notCovered.map((g) => g.goal),
    key_errors: keyErrors,
    top_error_types: keyErrors,
    per_goal: perGoal,
    goal_performance: perGoal,
  };
}

/**
 * The facts the model may write prose around — and nothing more.
 *
 * Passing the whole report invites the model to restate figures in its own
 * words and get them wrong. This hands over only what a closing message needs.
 */
function reportBrief(report) {
  return {
    overall_mastery_percent: report.overall_mastery_percent,
    strongest: report.learned_well[0]?.goal || null,
    weakest: report.areas_to_improve[0]?.goal || null,
    top_error: report.key_errors[0]?.type || null,
    goals_covered: report.goals_covered,
    goals_total: report.goals_total,
    recall_completed: report.recall_completed,
    recall_passed: report.recall_passed,
    assessment_coverage_percent: report.assessment_coverage_percent,
    ended_reason: report.ended_reason,
  };
}

module.exports = { buildReport, reportBrief, pct };
