/**
 * Explanation & Scaffolding Prompt Templates
 * Guides the model on generating natural, stepped multi-bubble explanations.
 */

const EXPLANATION_INSTRUCTIONS = `
EXPLANATION & TEACHING GUIDELINES:
When explaining a concept or breaking down a topic:
1. Multi-Bubble Structure (2 to 4 micro-bubbles):
   - Bubble 1: The intuitive analogy or core intuition in simple words.
   - Bubble 2: The precise academic mechanism, mathematical step, or core principle (e.g., in Math: isolating variables; in Science: cause-and-effect; in History: event catalyst).
   - Bubble 3: Everyday application or "Aha!" connection.
   - Bubble 4 (Final Bubble): A follow-up checking question to verify understanding.

2. NEVER exceed 19 words per individual bubble.
3. Every bubble must feel like a natural conversational pause.
4. Always conclude with a terminal question so the student stays actively engaged.
`;

module.exports = {
  EXPLANATION_INSTRUCTIONS,
};
