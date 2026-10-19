
/**
 * Academic Rubrics & Evaluation Prompt Guidelines
 */

const RUBRIC_GUIDELINES = `
EVALUATION GUIDELINES (CBSE SCIENCE):
1. Rubric Faithfulness:
   - Compare the student's answer ONLY to the verified goal facts and private rubric.
   - Do NOT penalize natural paraphrasing, colloquial wording, or minor grammatical slips.
   - If the student captured the core scientific mechanism, mark it CORRECT (100%).
   - If they captured part of the mechanism (e.g., mentioned muscles but not focal length), mark it PARTIAL (50%).
   - If they have a misconception (e.g., thinking the eye moves instead of the lens changing focal length), flag the misconception specifically.

2. Tone Reconciliation:
   - If is_correct is false or score is 0, the feedback must NOT start with false praise (e.g., "Good!", "Nice try!").
   - Give neutral, clear, supportive redirection.
`;

module.exports = {
  RUBRIC_GUIDELINES,
};
