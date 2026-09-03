/**
 * Diagram Cache & Synthesizer
 *
 * Keeps Mermaid diagram retrieval completely off the critical path (0ms).
 * Caches diagrams by topic and goal title. When a student is confused,
 * asks "I don't know", or requests visual aid, this returns a crystal-clear,
 * scientifically accurate Mermaid flowchart.
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
 * Tailored diagrams for standard NCERT / CBSE Science concepts
 */
function getCurriculumDiagram(topicTitle, goalTitle) {
  const combined = `${topicTitle || ''} ${goalTitle || ''}`.toLowerCase();

  // 1. Metals and Non-metals / Ionic Reactions
  if (combined.includes('metal') && combined.includes('react') || combined.includes('ionic')) {
    return {
      title: 'Ionic Bonding in Metals & Non-metals',
      code: `graph TD
  A[Metal Atom: Sodium Na] -->|Loses 1 Valence Electron| B[Na+ Positive Cation]
  C[Non-metal Atom: Chlorine Cl] -->|Gains Electron| D[Cl- Negative Anion]
  B ---|Strong Electrostatic Attraction| D
  D --> E[Solid Ionic Compound: NaCl Salt]`,
      trigger: 'teaching'
    };
  }

  // 2. Reactivity Series
  if (combined.includes('reactivity series') || combined.includes('displacement')) {
    return {
      title: 'Reactivity Series of Metals',
      code: `graph TD
  A[K Potassium - Most Reactive] --> B[Na Sodium]
  B --> C[Ca Calcium]
  C --> D[Mg Magnesium]
  D --> E[Al Aluminium]
  E --> F[Zn Zinc]
  F --> G[Fe Iron]
  G --> H[Cu Copper - Least Reactive]`,
      trigger: 'teaching'
    };
  }

  // 3. Life Processes / Respiration & Photosynthesis
  if (combined.includes('life process') || combined.includes('respiration') || combined.includes('photosynthesis')) {
    return {
      title: 'Energy Flow: Photosynthesis & Respiration',
      code: `graph LR
  subgraph Plant Chloroplast
    A[Sunlight + CO2 + Water] -->|Photosynthesis| B[Glucose + O2 Oxygen]
  end
  subgraph Cell Mitochondria
    B -->|Aerobic Respiration| C[ATP Energy Currency]
    C --> D[CO2 + Water Released]
  end
  D -.->|Recycled| A`,
      trigger: 'teaching'
    };
  }

  // 4. Carbon and its Compounds / Catenation
  if (combined.includes('carbon') || combined.includes('catenation') || combined.includes('versatile')) {
    return {
      title: 'Versatility of Carbon (Tetravalency & Catenation)',
      code: `graph TD
  A[Carbon Atom: 4 Valence Electrons] --> B[Tetravalency: 4 Covalent Bonds]
  A --> C[Catenation: Links to Itself]
  C --> D[Straight Chains]
  C --> E[Branched Chains]
  C --> F[Ring Structures & Isomers]
  D --> G[Millions of Organic Compounds]
  E --> G
  F --> G`,
      trigger: 'teaching'
    };
  }

  // 5. Acids, Bases & Salts
  if (combined.includes('acid') || combined.includes('base') || combined.includes('salt') || combined.includes('neutral')) {
    return {
      title: 'Acid-Base Neutralisation Reaction',
      code: `graph LR
  A[Acid: Releases H+ Ions] + B[Base: Releases OH- Ions] --> C[Salt]
  A + B --> D[Water H2O]
  C & D --> E[Neutral Solution pH 7]`,
      trigger: 'teaching'
    };
  }

  // 6. Electricity & Circuits
  if (combined.includes('electric') || combined.includes('current') || combined.includes('ohm') || combined.includes('circuit')) {
    return {
      title: "Ohm's Law: Voltage, Current & Resistance",
      code: `graph TD
  A[Potential Difference V Volts] -->|Drives Current| B[Current I Amperes]
  C[Resistance R Ohms] -->|Opposes Flow| B
  A -->|V = I x R| D[Circuit Operation]`,
      trigger: 'teaching'
    };
  }

  // 7. Light: Reflection & Refraction
  if (combined.includes('light') || combined.includes('reflection') || combined.includes('refraction')) {
    return {
      title: 'Laws of Light: Reflection & Refraction',
      code: `graph TD
  A[Incident Ray] -->|Strikes Surface| B[Normal Line]
  B --> C[Angle of Incidence i = Angle of Reflection r]
  A -->|Passes into Denser Medium| D[Refraction: Bends Towards Normal]`,
      trigger: 'teaching'
    };
  }

  // 8. General Concept Flowchart Synthesis
  const topicLabel = (topicTitle || 'Core Topic').replace(/['"()]/g, '').trim();
  const goalLabel = (goalTitle || 'Key Concept').replace(/['"()]/g, '').trim();

  return {
    title: `${goalLabel} Concept Map`,
    code: `graph TD
  A["${topicLabel}"] --> B["${goalLabel}"]
  B --> C["Scientific Mechanism"]
  B --> D["Real-World Application"]
  C --> E["Mastery Outcome"]
  D --> E`,
    trigger: 'teaching'
  };
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
  const key = getCacheKey(topicTitle, goalTitle);
  if (memoryCache.has(key)) {
    return memoryCache.get(key);
  }

  // 2. Check DB metadata on goal record if present
  if (goalRecord?.metadata) {
    try {
      const meta = typeof goalRecord.metadata === 'string' ? JSON.parse(goalRecord.metadata) : goalRecord.metadata;
      if (meta?.mermaid_diagram && meta.mermaid_diagram.code) {
        setCachedDiagram(topicTitle, goalTitle, meta.mermaid_diagram);
        return meta.mermaid_diagram;
      }
    } catch (e) {
      // ignore parse error
    }
  }

  // 3. Synthesize scientifically accurate curriculum diagram
  const diagram = getCurriculumDiagram(topicTitle, goalTitle);
  setCachedDiagram(topicTitle, goalTitle, diagram);
  return diagram;
}

module.exports = {
  getCachedDiagram,
  setCachedDiagram
};
