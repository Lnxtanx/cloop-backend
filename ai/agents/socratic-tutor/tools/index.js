/**
 * Socratic Tutor Tools Catalog & Dispatcher
 * Unifies all tools owned and executable by the Socratic Tutor Agent.
 */

const diagramTool = require('./diagram-tool');
const videoTool = require('./video-tool');
const searchTool = require('./search-tool');
const akgTool = require('./akg-tool');
const memoryTool = require('./memory-tool');

const definitions = Object.freeze([
  diagramTool.definition,
  videoTool.definition,
  searchTool.definition,
  akgTool.definition,
  memoryTool.definition,
]);

/**
 * Dynamically execute any Socratic Tutor tool by name
 *
 * @param {string} toolName - Name of the tool
 * @param {Object} args - Arguments passed by the model
 * @returns {Promise<Object>} Tool execution output
 */
async function executeTool(toolName, args = {}) {
  switch (toolName) {
    case 'generate_concept_diagram':
      return diagramTool.execute(args);
    case 'fetch_educational_video':
      return videoTool.execute(args);
    case 'curriculum_search':
      return searchTool.execute(args);
    case 'akg_intelligence_lookup':
      return akgTool.execute(args);
    case 'misconception_memory_lookup':
      return { success: true, history: memoryTool.getMisconceptionHistory(args.state, args.goals) };
    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}

module.exports = {
  // Modules
  diagramTool,
  videoTool,
  searchTool,
  akgTool,
  memoryTool,

  // Tool calling metadata
  definitions,
  executeTool,

  // Direct helper shortcuts
  getCachedDiagram: diagramTool.getCachedDiagram,
  searchYouTube: videoTool.runVideoTool,
  searchCurriculum: searchTool.runSearchTool,
};
