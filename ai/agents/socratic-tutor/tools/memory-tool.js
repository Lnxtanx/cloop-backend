/**
 * Socratic Tutor Misconception Memory Tool
 * Tracks, recalls, and formats student misconceptions across goals within a session
 * to provide coherent, longitudinal Socratic coaching.
 */

const memoryToolDefinition = Object.freeze({
  name: 'misconception_memory_lookup',
  description: 'Retrieve previous errors and misconceptions demonstrated by the student in earlier goals during this session.',
  parameters: {
    type: 'object',
    properties: {
      currentGoalIndex: {
        type: 'number',
        description: 'Index of the current goal',
      },
    },
    required: ['currentGoalIndex'],
  },
});

/**
 * Extract and summarize previous misconceptions from session state
 *
 * @param {Object} state - The current agent state
 * @param {Array} goals - Array of topic goals
 * @returns {Array<Object>} List of past misconceptions and error types
 */
function getMisconceptionHistory(state = {}, goals = []) {
  if (!state || !Array.isArray(state.perGoal)) return [];

  const history = [];
  state.perGoal.forEach((goalState, idx) => {
    if (goalState && Array.isArray(goalState.errors) && goalState.errors.length > 0) {
      const goalTitle = goals[idx]?.title || `Goal ${idx + 1}`;
      goalState.errors.forEach(err => {
        history.push({
          goalIndex: idx,
          goalTitle,
          errorType: typeof err === 'string' ? err : err.type,
          count: typeof err === 'object' ? err.count : 1,
        });
      });
    }
  });

  return history;
}

/**
 * Format past misconceptions into an empathetic coaching prompt snippet
 *
 * @param {Array<Object>} history
 * @returns {string} Formatted coaching context
 */
function formatMisconceptionPromptContext(history = []) {
  if (!history.length) return '';

  const bulletPoints = history.map(h => `- On "${h.goalTitle}": struggled with ${h.errorType}`).join('\n');
  return `STUDENT PAST MISCONCEPTIONS THIS SESSION:
${bulletPoints}
Coaching rule: Connect new concepts to overcome these past confusions. If the student made a conceptual error earlier, reference the corrected intuition gently.`;
}

module.exports = {
  definition: memoryToolDefinition,
  getMisconceptionHistory,
  formatMisconceptionPromptContext,
};
