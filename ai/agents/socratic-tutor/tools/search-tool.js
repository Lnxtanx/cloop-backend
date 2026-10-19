/**
 * Socratic Tutor Curriculum Search Tool
 * Directly connects to DeepSeek Native Search API for NCERT/CBSE fact verification and analogy search.
 */

const { executeSearch, searchCurriculumSyllabus } = require('../../../providers/deepseek/search');

const searchToolDefinition = Object.freeze({
  name: 'curriculum_search',
  description: 'Search official school science curriculum syllabi, verified definitions, and scientific facts.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Specific scientific question or topic to search (e.g., "Friction definition and factors affecting")',
      },
      classLevel: {
        type: 'string',
        description: 'Academic class level (default: "8")',
        default: '8',
      },
      board: {
        type: 'string',
        description: 'Board curriculum (default: "CBSE")',
        default: 'CBSE',
      },
    },
    required: ['query'],
  },
});

/**
 * Execute curriculum search
 *
 * @param {Object} args - { query, classLevel, board }
 * @returns {Promise<Object>} { success, query, results, count }
 */
async function runSearchTool(args = {}) {
  const query = (args.query || '').trim();
  if (!query) {
    return { success: false, error: 'Query is required', results: [] };
  }

  const classLevel = args.classLevel || '10';
  const board = args.board || 'CBSE';

  try {
    const results = await searchCurriculumSyllabus(query, {
      classLevel,
      board,
      maxResults: 3,
    });

    return {
      success: true,
      query,
      results,
      count: results.length,
    };
  } catch (error) {
    return {
      success: false,
      query,
      error: error.message,
      results: [],
    };
  }
}

module.exports = {
  definition: searchToolDefinition,
  execute: runSearchTool,
  runSearchTool,
  searchCurriculumSyllabus,
  executeSearch,
};
