/**
 * Academic Knowledge Graph (AKG) Agent Tool
 * Provides concept dependency mapping, prerequisite checking, and curriculum boundary enforcement.
 */

let akgService = null;
try {
  akgService = require('../../services/academic-graph/akg-service');
} catch (_) {
  // Graceful fallback if module is isolated
}

const akgToolDefinition = Object.freeze({
  name: 'akg_lookup',
  description: 'Lookup Academic Knowledge Graph intelligence for a topic, including prerequisites, concept boundaries, and common misconceptions.',
  parameters: {
    type: 'object',
    properties: {
      topicId: {
        type: 'number',
        description: 'Database ID of the topic',
      },
      topicTitle: {
        type: 'string',
        description: 'Title of the academic topic',
      },
    },
    required: ['topicId'],
  },
});

/**
 * Execute AKG lookup tool
 *
 * @param {Object} args - { topicId, topicTitle }
 * @returns {Promise<Object>} AKG context or null
 */
async function runAkgTool(args = {}) {
  const topicId = args.topicId || args.id;
  if (!topicId) {
    return { error: 'topicId parameter is required' };
  }

  try {
    if (!akgService?.resolveTopicIntelligence) {
      return { success: false, error: 'AKG service unavailable' };
    }

    const context = await akgService.resolveTopicIntelligence(topicId);
    return {
      success: true,
      topicId,
      context,
    };
  } catch (error) {
    return {
      success: false,
      topicId,
      error: error.message,
    };
  }
}

module.exports = {
  definition: akgToolDefinition,
  execute: runAkgTool,
  runAkgTool,
};
