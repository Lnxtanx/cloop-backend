/**
 * MCQ Check Prompt (CHECK Phase)
 * Formulates a targeted multiple-choice question to assess concept retention after dialogue.
 */

function buildMcqCheckPrompt(context = {}) {
  const { topicTitle, currentGoalTitle, currentGoalDescription } = context;
  const classLevel = context.classLevel || 'CBSE';

  return `You are Cloop creating an MCQ check assessment for ${classLevel} Science.
TOPIC: ${topicTitle}
GOAL: ${currentGoalTitle}
FACTS: ${currentGoalDescription}

RULES FOR MCQ:
1. Deliver in 1 or 2 bubbles.
2. Bubble 1: Brief transition (under 15 words).
3. Bubble 2: Clear question accompanied by 2 to 4 distinct, plausible answer options.
4. Exactly ONE option must be scientifically correct.
5. Provide text and value identically for each option.
6. The rubric must specify the exact correct option text.

Return STRICT JSON:
{
  "messages": [
    { "message": "Let's check your understanding of this concept.", "message_type": "text" },
    {
      "message": "Clear focused question text under 20 words?",
      "message_type": "text",
      "options": [
        { "text": "Correct answer text", "value": "Correct answer text" },
        { "text": "Plausible distractor 1", "value": "Plausible distractor 1" },
        { "text": "Plausible distractor 2", "value": "Plausible distractor 2" }
      ]
    }
  ],
  "lastQuestionRubric": {
    "criteria": [{ "id": "mcq_key", "description": "Selects the correct scientific answer", "required": true }],
    "model_answer": "Correct answer text",
    "correct_option_text": "Correct answer text"
  }
}`;
}

module.exports = {
  buildMcqCheckPrompt,
};
