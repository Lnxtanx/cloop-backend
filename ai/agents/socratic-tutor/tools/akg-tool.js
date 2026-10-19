/**
 * Socratic Tutor Academic Knowledge Graph (AKG) Tool
 * Queries prerequisite chains, concept boundaries, and common student misconceptions.
 */

let akgService = null;
try {
  akgService = require('../../../../services/academic-graph/akg-service');
} catch (_) {
  // Graceful fallback
}

const akgToolDefinition = Object.freeze({
  name: 'akg_intelligence_lookup',
  description: 'Query the Academic Knowledge Graph for prerequisite concepts, curriculum boundaries, and known misconceptions for a topic.',
  parameters: {
    type: 'object',
    properties: {
      topicId: {
        type: 'number',
        description: 'Database ID of the topic',
      },
      topicTitle: {
        type: 'string',
        description: 'Title of the topic',
      },
    },
    required: ['topicId'],
  },
});

/**
 * Execute AKG lookup
 *
 * @param {Object} args - { topicId, topicTitle }
 * @returns {Promise<Object>} { success, topicId, context }
 */
async function runAkgTool(args = {}) {
  const topicId = args.topicId || args.id;
  if (!topicId) {
    return { success: false, error: 'topicId is required' };
  }

  try {
    if (akgService?.resolveTopicIntelligence) {
      const context = await akgService.resolveTopicIntelligence(topicId);
      return {
        success: true,
        topicId,
        context,
      };
    }
    return { success: false, error: 'AKG service unavailable' };
  } catch (err) {
    return { success: false, topicId, error: err.message };
  }
}

module.exports = {
  definition: akgToolDefinition,
  execute: runAkgTool,
  runAkgTool,
};
