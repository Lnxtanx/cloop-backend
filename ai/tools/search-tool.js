/**
 * DeepSeek Native Search Agent Tool
 * Enables agents to query verified curriculum syllabi, definitions, and academic facts.
 */

const { executeSearch, searchCurriculumSyllabus } = require('../providers/deepseek/search');

/**
 * Tool definition for LLM tool calling / agent execution
 */
const searchToolDefinition = Object.freeze({
  name: 'curriculum_search',
  description: 'Search official CBSE curriculum syllabi, NCERT definitions, and scientific facts.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query (e.g., "Class 10 CBSE Accommodation of eye definition")',
      },
      classLevel: {
        type: 'string',
        description: 'Academic class level (e.g., "10")',
        default: '10',
      },
      board: {
        type: 'string',
        description: 'Educational board (e.g., "CBSE")',
        default: 'CBSE',
      },
    },
    required: ['query'],
  },
});

/**
 * Execute curriculum search tool
 *
 * @param {Object} args - { query, classLevel, board }
 * @returns {Promise<Object>} { query, results, summary }
 */
async function runSearchTool(args = {}) {
  const query = (args.query || '').trim();
  if (!query) {
    return { error: 'Query parameter is required' };
  }

  const classLevel = args.classLevel || '10';
  const board = args.board || 'CBSE';

  try {
    const results = await searchCurriculumSyllabus(query, {
      classLevel,
      board,
      maxResults: 4,
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
