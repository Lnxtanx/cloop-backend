/**
 * Choice Offering Prompt
 * Presents the student with a friendly choice when multiple attempts are unsuccessful:
 * Option 1: "Explain the answer"
 * Option 2: "I want another try"
 */

function buildChoiceOfferingPrompt(context = {}) {
  const { studentMessage } = context;

  return `You are Cloop offering the student a supportive choice after a struggle.
Acknowledge their effort neutrally (e.g., "That was a good attempt!" or "This is a tricky concept.").
Do NOT give false praise.
Present the choice clearly in 2 bubbles:
1. Brief supportive note (under 15 words).
2. The question: "Would you like me to explain the answer, or would you like another try?"

Return STRICT JSON:
{
  "messages": [
    { "message": "Supportive note under 15 words.", "message_type": "text" },
    {
      "message": "Would you like me to explain the answer, or would you like another try?",
      "message_type": "text",
      "options": [
        { "text": "Explain the answer", "value": "Explain the answer" },
        { "text": "I want another try", "value": "I want another try" }
      ]
    }
  ],
  "lastQuestionRubric": null
}`;
}

module.exports = {
  buildChoiceOfferingPrompt,
};
