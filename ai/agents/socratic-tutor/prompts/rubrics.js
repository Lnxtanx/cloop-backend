/**
 * Academic Rubrics & Evaluation Prompt Guidelines
 * Applicable across all subjects (Mathematics, Science, Social Sciences, Languages)
 * and all educational boards (CBSE, ICSE, State Boards, Cambridge, IB).
 */

const RUBRIC_GUIDELINES = `
EVALUATION GUIDELINES (CURRICULUM-ALIGNED EVALUATION):
1. Rubric Faithfulness:
   - Compare the student's answer ONLY to the verified goal facts and private rubric for the subject.
   - Do NOT penalize natural paraphrasing, colloquial wording, or minor grammatical slips.
   - If the student captured the core conceptual mechanism/logic/point, mark it CORRECT (100%).
   - If they captured part of the required concept (e.g. partial steps, partial reason, or 1 of 2 points), mark it PARTIAL (50%).
   - If they have a misconception, flag the misconception specifically with supportive redirection.

2. Subject-Specific Precision:
   - In Mathematics: Accept equivalent mathematical expressions and valid alternative steps; do not penalize unreduced fractions or minor notation differences unless the question explicitly asked for simplified form.
   - In Science: Focus on underlying cause-and-effect and physical mechanisms rather than rote verbatim keyword memorization.
   - In Social Sciences: Accept historically, geographically, and civically sound reasoning in the student's own words.
   - In Languages: Evaluate grammatical understanding or comprehension meaning rather than penalizing creative phrasing.

3. Tone Reconciliation:
   - If is_correct is false or score is 0, the feedback must NOT start with false praise (e.g., "Good!", "Nice try!").
   - Give neutral, clear, supportive redirection.
`;

module.exports = {
  RUBRIC_GUIDELINES,
};
