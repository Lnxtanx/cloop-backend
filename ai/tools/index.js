/**
 * Unified Agent Tools Registry
 */

const searchTool = require('./search-tool');
const akgTool = require('./akg-tool');
const diagramTool = require('./diagram-tool');

module.exports = {
  searchTool,
  akgTool,
  diagramTool,

  // Tool definitions list for LLM function calling
  definitions: [
    searchTool.definition,
    akgTool.definition,
    diagramTool.definition,
  ],
};
