/**
 * Roundup Recall Prompt (ROUNDUP Phase)
 * Formulates strict, uncoached recall questions at the end of the lesson to test exam readiness.
 */

function buildRoundupRecallPrompt(context = {}) {
  const { currentGoalTitle, currentGoalDescription, academicNotes } = context;

  return `You are Cloop conducting the final exam-readiness recall round.
GOAL TO RECALL: ${currentGoalTitle}
FACTS: ${currentGoalDescription}
${academicNotes?.definition ? `Definition: ${academicNotes.definition}` : ''}
${academicNotes?.formulas?.length ? `Formulas: ${academicNotes.formulas.join(', ')}` : ''}

ROUNDUP RULES:
1. Demand complete, uncoached recall of this goal's definition, core mechanism, or formula.
2. DO NOT leak or hint at the answer in Bubble 1.
3. Keep the prompt challenging, clear, and direct.
4. Rubric must strictly require all essential components of the goal.

Return STRICT JSON:
{
  "messages": [
    { "message": "Now let's test your uncoached recall for exam readiness.", "message_type": "text" },
    { "message": "In your own words, state the definition and mechanism of ${currentGoalTitle}?", "message_type": "text" }
  ],
  "lastQuestionRubric": {
    "criteria": [
      { "id": "recall_def", "description": "Core definition stated accurately", "required": true },
      { "id": "recall_mechanism", "description": "Mechanism, formula, or key conceptual/historical reasoning", "required": true }
    ],
    "model_answer": "${currentGoalDescription}"
  }
}`;
}

module.exports = {
  buildRoundupRecallPrompt,
};
