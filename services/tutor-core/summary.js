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
 */

const { bandFor } = require("./state");

const pct = (n, d) => (d === 0 ? 0 : Math.round((n / d) * 100));

/**
 * Build the report.
 *
 * @param {object} state - the final session state
 * @param {Array<{id?: number, title: string}>} goals
 * @returns {object} the mastery report
 */
function buildReport(state, goals = []) {
  const perGoal = state.perGoal.map((g, i) => {
    const accuracy = g.total === 0 ? 0 : g.correct / g.total;
    return {
      goal_id: goals[i]?.id || i + 1,
      goal: goals[i]?.title || `Goal ${i + 1}`,
      goal_title: goals[i]?.title || `Goal ${i + 1}`,
      asked: g.total,
      questions_asked: g.total,
      correct: g.correct,
      correct_answers: g.correct,
      incorrect_answers: Math.max(0, g.total - g.correct),
      accuracy_percent: pct(g.correct, g.total),
      score_percent: pct(g.correct, g.total),
      band: g.total === 0 ? "Not covered" : bandFor(accuracy),
      errors: [...new Set(g.errors)], // distinct kinds, for display
      error_count: g.errors.length,
      attempted: g.total > 0,
      is_completed: g.total > 0 && g.correct > 0,
    };
  });

  const attempted = perGoal.filter((g) => g.attempted);
  const asked = attempted.reduce((n, g) => n + g.asked, 0);
  const correct = attempted.reduce((n, g) => n + g.correct, 0);
  const overall = pct(correct, asked);

  // Error types, most frequent first. A tie keeps first-seen order.
  const counts = new Map();
  for (const g of state.perGoal) for (const e of g.errors) counts.set(e, (counts.get(e) || 0) + 1);
  const keyErrors = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count }));

  const mastered = attempted.filter((g) => g.band === "Mastered" || g.band === "Proficient");
  const toImprove = attempted.filter((g) => g.band === "Developing" || g.band === "Emerging");
  const notCovered = perGoal.filter((g) => !g.attempted);

  // Performance stars & level for frontend SessionSummaryCard
  const stars = overall >= 90 ? 5 : overall >= 75 ? 4 : overall >= 60 ? 3 : overall >= 40 ? 2 : 1;
  const performanceLevel = overall >= 80 ? "Excellent" : overall >= 60 ? "Good" : "Needs Improvement";

  return {
    overall_mastery_percent: overall,
    score_percent: overall,
    overall_score_percent: overall,
    overall_band: attempted.length === 0 ? "Not covered" : bandFor(asked === 0 ? 0 : correct / asked),
    star_rating: stars,
    performance_level: performanceLevel,
    total_questions: asked,
    questions_asked: asked,
    correct_answers: correct,
    questions_correct: correct,
    incorrect_answers: Math.max(0, asked - correct),
    goals_covered: attempted.length,
    goals_total: perGoal.length,
    ended_reason: state.endedReason || "complete",

    learned_well: mastered.map((g) => ({
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
  };
}

module.exports = { buildReport, reportBrief, pct };
