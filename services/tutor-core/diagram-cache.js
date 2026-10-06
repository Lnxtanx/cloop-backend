/**
 * Source-grounded Diagram Cache
 *
 * Keeps Mermaid diagram retrieval completely off the critical path (0ms).
 * Caches diagrams by topic and goal title. When a student is confused,
 * requests visual aid, this renders the stored goal facts as a Mermaid map.
 */

const memoryCache = new Map();

/**
 * Generate a cache key
 */
function getCacheKey(topicTitle, goalTitle, description = '') {
  return `${(topicTitle || '').trim().toLowerCase()}:::${(goalTitle || '').trim().toLowerCase()}:::${description}`;
}

/**
 * Store a diagram in cache
 */
function setCachedDiagram(topicTitle, goalTitle, diagramData, description = '') {
  if (!topicTitle || !goalTitle || !diagramData) return;
  memoryCache.set(getCacheKey(topicTitle, goalTitle, description), diagramData);
}

/**
 * Get a cached or synthesized diagram (0ms)
 *
 * @param {string} topicTitle
 * @param {string} goalTitle
 * @param {object} [goalRecord] - Optional DB record containing metadata
 * @returns {object} { title, code, trigger }
 */
function getCachedDiagram(topicTitle, goalTitle, goalRecord = null) {
  // 1. Check in-memory cache
  const description = String(goalRecord?.description || '').trim();
  const key = getCacheKey(topicTitle, goalTitle, description);
  if (memoryCache.has(key)) {
    return memoryCache.get(key);
  }

  // 2. Check DB metadata on goal record if present
  if (goalRecord?.metadata) {
    try {
      const meta = typeof goalRecord.metadata === 'string' ? JSON.parse(goalRecord.metadata) : goalRecord.metadata;
      if (meta?.mermaid_diagram && meta.mermaid_diagram.code) {
        setCachedDiagram(topicTitle, goalTitle, meta.mermaid_diagram, description);
        return meta.mermaid_diagram;
      }
    } catch (e) {
      // ignore parse error
    }
  }

  // Stored goal facts take precedence over broad chapter templates. Those
  // templates can introduce advanced or unrelated science for a narrow goal.
  const safeLabel = value => String(value).replace(/[<>"&\r\n]/g, ' ').trim();
  const facts = description.split(/;|\n/).map(s => s.trim()).filter(Boolean);
  const diagram = {
    title: `${goalTitle || 'Topic'} Concept Map`,
    code: `graph TD\n  A["${safeLabel(goalTitle || topicTitle || 'Topic')}"]` +
      facts.map((fact, i) => `\n  A --> F${i}["${safeLabel(fact)}"]`).join(''),
    trigger: 'teaching'
  };
  setCachedDiagram(topicTitle, goalTitle, diagram, description);
  return diagram;
}

module.exports = {
  getCachedDiagram,
  setCachedDiagram
};
