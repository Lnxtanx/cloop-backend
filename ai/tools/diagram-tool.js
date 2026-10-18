/**
 * Concept Diagram Agent Tool
 * Provides instant (0ms) source-grounded Mermaid diagrams for visual learners.
 */

let diagramCache = null;
try {
  diagramCache = require('../../services/tutor-core/diagram-cache');
} catch (_) {
  // Graceful fallback
}

const diagramToolDefinition = Object.freeze({
  name: 'get_concept_diagram',
  description: 'Retrieve a structured visual Mermaid diagram for a topic or learning goal.',
  parameters: {
    type: 'object',
    properties: {
      topicTitle: {
        type: 'string',
        description: 'Title of the topic (e.g., "Human Eye")',
      },
      goalTitle: {
        type: 'string',
        description: 'Specific learning goal title (e.g., "Power of Accommodation")',
      },
    },
    required: ['topicTitle', 'goalTitle'],
  },
});

/**
 * Execute diagram tool
 *
 * @param {Object} args - { topicTitle, goalTitle, goalRecord }
 * @returns {Object} { success, diagram }
 */
function runDiagramTool(args = {}) {
  const topicTitle = (args.topicTitle || '').trim();
  const goalTitle = (args.goalTitle || '').trim();

  if (!topicTitle || !goalTitle) {
    return { success: false, error: 'topicTitle and goalTitle are required' };
  }

  if (diagramCache?.getCachedDiagram) {
    const diagram = diagramCache.getCachedDiagram(topicTitle, goalTitle, args.goalRecord || null);
    return {
      success: !!diagram,
      diagram,
    };
  }

  return { success: false, error: 'Diagram cache unavailable' };
}

module.exports = {
  definition: diagramToolDefinition,
  execute: runDiagramTool,
  runDiagramTool,
  getCachedDiagram: (topicTitle, goalTitle, goalRecord) => diagramCache?.getCachedDiagram ? diagramCache.getCachedDiagram(topicTitle, goalTitle, goalRecord) : null,
};
