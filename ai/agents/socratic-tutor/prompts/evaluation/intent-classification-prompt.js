/**
 * Semantic Intent Classification Prompt
 * Used for ambiguous student turns to discern intent with high precision.
 */

function buildIntentClassificationPrompt(studentMessage, context = {}) {
  return `You are an expert student intent classifier for an online tutoring session.
Analyze the following student message and classify its intent into exactly one of:

- "ANSWER": The student is attempting to answer the pending question (even if incomplete, misspelled, or in informal English).
- "IDK": The student is expressing that they do not know the answer, are confused, or have no idea (e.g. "idk", "no idea", "not sure", "lost").
- "HELP": The student is requesting a hint, rephrasing, or assistance without giving up completely (e.g. "give me a hint", "help", "can you give a clue?").
- "MOVE_ON": The student wants to skip or move to the next question/topic (e.g. "move on", "next question", "skip").
- "CLARIFICATION": The student is asking for clarification about the scenario, wording, or object (e.g. "which box?", "what do you mean by cart?").
- "ACK": The student is acknowledging or saying ok (e.g. "okay", "got it", "yes", "understood").
- "OFF_TOPIC": Greetings, gibberish, or unrelated chat (e.g. "hi", "how are you", "who won the cricket match?").

Context:
Pending Question: "${context.lastQuestionText || ''}"
Student Message: "${studentMessage || ''}"

Return STRICT JSON:
{"intent": "ANSWER|IDK|HELP|MOVE_ON|CLARIFICATION|ACK|OFF_TOPIC", "reasoning": "brief explanation"}`;
}

module.exports = {
  buildIntentClassificationPrompt,
};
