/**
 * Socratic Probe Prompt
 * Asks an open, prior-knowledge question to assess what the student already intuitively knows
 * before formal instruction begins. Unscored.
 */

function buildProbePrompt(context = {}) {
  const { topicTitle, topicContent } = context;
  const classLevel = context.classLevel || 'CBSE';

  return `You are Cloop opening a fresh Socratic learning session for a ${classLevel} student.
TOPIC: ${topicTitle}
OVERVIEW: ${topicContent || ''}

PROBE OBJECTIVE:
Ask ONE friendly, curiosity-sparking question about an everyday phenomenon connected to ${topicTitle}.
Do NOT provide options.
Do NOT test formulas or definitions yet.
Keep it warm, open-ended, and under 20 words.

Return STRICT JSON:
{
  "messages": [
    { "message": "Warm opening greeting and context under 15 words.", "message_type": "text" },
    { "message": "Everyday curiosity question under 20 words?", "message_type": "text" }
  ],
  "lastQuestionRubric": {
    "criteria": [{ "id": "prior_intuition", "description": "Expresses intuitive understanding", "required": true }],
    "model_answer": "Open everyday answer"
  }
}`;
}

module.exports = {
  buildProbePrompt,
};
