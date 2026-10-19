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

function cleanConceptTitle(text) {
  return String(text || '')
    .replace(/^(?:Goal|Topic|Chapter)\s+\d+:\s*/i, '')
    .trim();
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
  const cleanGoal = cleanConceptTitle(goalTitle);
  const cleanTopic = cleanConceptTitle(topicTitle);
  const rootConcept = cleanGoal || cleanTopic || 'Core Concept';

  const facts = description.split(/;|\n/).map(s => s.trim()).filter(Boolean);

  let code;
  if (facts.length >= 2) {
    // Multi-tier connected conceptual flow
    code = `graph TD\n  A["${safeLabel(rootConcept)}"]`;
    for (let i = 0; i < facts.length; i++) {
      const factLabel = safeLabel(facts[i]);
      if (i === 0) {
        code += `\n  A --> F0["${factLabel}"]`;
      } else {
        code += `\n  F${i - 1} -->|relates to| F${i}["${factLabel}"]`;
      }
    }
  } else if (facts.length === 1) {
    code = `graph TD\n  A["${safeLabel(cleanTopic || 'Topic Concept')}"] -->|focus| B["${safeLabel(rootConcept)}"]\n  B -->|governing rule| F0["${safeLabel(facts[0])}"]`;
  } else {
    // Zero facts: Synthesize a 3-node conceptual pathway
    code = `graph TD\n  A["${safeLabel(cleanTopic || 'Syllabus Topic')}"] -->|focus| B["${safeLabel(rootConcept)}"]\n  B -->|scientific rule| C["Properties & Principles"]\n  C -->|real-world effect| D["Everyday Applications"]`;
  }

  const diagram = {
    title: `${cleanGoal || cleanTopic || 'Topic'} Concept Map`,
    code,
    trigger: 'teaching'
  };
  setCachedDiagram(topicTitle, goalTitle, diagram, description);
  return diagram;
}

module.exports = {
  getCachedDiagram,
  setCachedDiagram
};
