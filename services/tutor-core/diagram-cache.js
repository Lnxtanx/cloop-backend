/**
 * Diagram Cache & Loader
 *
 * Keeps Mermaid diagram retrieval completely off the critical path (0ms).
 * Caches diagrams by topic and goal title so the student never waits 2-3s
 * for a diagram generation LLM call during a dialogue turn.
 */

const memoryCache = new Map();

/**
 * Generate a cache key
 */
function getCacheKey(topicTitle, goalTitle) {
  return `${(topicTitle || '').trim().toLowerCase()}:::${(goalTitle || '').trim().toLowerCase()}`;
}

/**
 * Store a diagram in cache
 */
function setCachedDiagram(topicTitle, goalTitle, diagramData) {
  if (!topicTitle || !goalTitle || !diagramData) return;
  memoryCache.set(getCacheKey(topicTitle, goalTitle), diagramData);
}

/**
 * Get a cached diagram (0ms)
 *
 * @param {string} topicTitle
 * @param {string} goalTitle
 * @param {object} [goalRecord] - Optional DB record containing metadata
 * @returns {object|null} { title, code, trigger }
 */
function getCachedDiagram(topicTitle, goalTitle, goalRecord = null) {
  // 1. Check in-memory cache
  const key = getCacheKey(topicTitle, goalTitle);
  if (memoryCache.has(key)) {
    return memoryCache.get(key);
  }

  // 2. Check DB metadata on goal record if present
  if (goalRecord?.metadata) {
    try {
      const meta = typeof goalRecord.metadata === 'string' ? JSON.parse(goalRecord.metadata) : goalRecord.metadata;
      if (meta?.mermaid_diagram) {
        setCachedDiagram(topicTitle, goalTitle, meta.mermaid_diagram);
        return meta.mermaid_diagram;
      }
    } catch (e) {
      // ignore parse error
    }
  }

  return null;
}

module.exports = {
  getCachedDiagram,
  setCachedDiagram
};
