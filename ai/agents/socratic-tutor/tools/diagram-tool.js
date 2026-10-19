/**
 * Socratic Tutor Diagram Tool
 * Generates and retrieves instant, source-grounded Mermaid diagrams for visual concept mapping.
 */

let diagramCache = null;
try {
  diagramCache = require('../../../../services/tutor-core/diagram-cache');
} catch (_) {
  // Graceful fallback
}

const diagramToolDefinition = Object.freeze({
  name: 'generate_concept_diagram',
  description: 'Retrieve or generate a visual Mermaid diagram structure showing scientific relationships, anatomy, or process flow for a topic goal.',
  parameters: {
    type: 'object',
    properties: {
      topicTitle: {
        type: 'string',
        description: 'The overall topic title (e.g., "Human Eye and the Colourful World")',
      },
      goalTitle: {
        type: 'string',
        description: 'Specific learning goal to diagram (e.g., "Power of Accommodation")',
      },
      diagramType: {
        type: 'string',
        enum: ['flowchart', 'process', 'hierarchy'],
        default: 'flowchart',
        description: 'Type of visual structure',
      },
    },
    required: ['topicTitle', 'goalTitle'],
  },
});

/**
 * Execute diagram tool for Socratic Tutor
 *
 * @param {Object} args - { topicTitle, goalTitle, goalRecord }
 * @returns {Object} { success, diagram: { title, code, trigger } }
 */
function runDiagramTool(args = {}) {
  const topicTitle = (args.topicTitle || '').trim();
  const goalTitle = (args.goalTitle || '').trim();

  if (!topicTitle || !goalTitle) {
    return { success: false, error: 'topicTitle and goalTitle are required' };
  }

  if (diagramCache?.getCachedDiagram) {
    const diagram = diagramCache.getCachedDiagram(topicTitle, goalTitle, args.goalRecord || null);
    if (diagram) {
      return {
        success: true,
        diagram,
      };
    }
  }

  // Fallback programmatic Mermaid diagram generator
  const cleanGoal = goalTitle.replace(/[^a-zA-Z0-9 ]/g, '');
  const cleanTopic = topicTitle.replace(/[^a-zA-Z0-9 ]/g, '');
  const fallbackCode = `graph TD\n  A["${cleanTopic}"] --> B["${cleanGoal}"]\n  B --> C["Core Mechanism"]\n  B --> D["Everyday Application"]`;

  return {
    success: true,
    diagram: {
      title: `${goalTitle} Diagram`,
      code: fallbackCode,
      trigger: 'visual_explanation',
    },
  };
}

module.exports = {
  definition: diagramToolDefinition,
  execute: runDiagramTool,
  runDiagramTool,
  getCachedDiagram: (topic, goal, rec) => diagramCache?.getCachedDiagram ? diagramCache.getCachedDiagram(topic, goal, rec) : null,
};
