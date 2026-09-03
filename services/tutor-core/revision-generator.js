/**
 * Revision Sheet Generator
 *
 * Runs at session completion (WRAP phase) at temperature 0.3.
 * Creates a high-yield, scannable revision sheet students can screenshot,
 * bookmark, or download for exam review.
 */

const { invokeModel, extractJson } = require('../ai/deepseek-client');

/**
 * Deterministic fallback generator if the model call fails or times out
 */
function buildFallbackRevisionSheet({ topicTitle, goals, keyErrors }) {
  const goalsList = Array.isArray(goals) ? goals : [];
  const cleanTitle = topicTitle || 'Study Revision';

  return {
    topic: cleanTitle,
    key_concepts: goalsList.length > 0
      ? goalsList.slice(0, 4).map(g => {
          const title = typeof g === 'string' ? g : (g.title || 'Core Idea');
          const desc = typeof g === 'object' && g.description ? g.description : `Essential mechanism of ${title}.`;
          return `${title}: ${desc}`;
        })
      : [`Essential principles and scientific laws governing ${cleanTitle}.`],
    definitions: goalsList.slice(0, 4).map(g => {
      const term = typeof g === 'string' ? g : (g.title || 'Term');
      const def = typeof g === 'object' && g.description ? g.description : `Core definition and role in ${cleanTitle}.`;
      return { term, definition: def };
    }),
    quick_recall_tips: [
      `Recall the fundamental relationship between reactants/inputs and products/outputs in ${cleanTitle}.`,
      keyErrors && keyErrors.length > 0
        ? `Common mistake to avoid: watch out for ${keyErrors.map(e => e.type || e).join(', ')}.`
        : 'Common mistake to avoid: confusing similar sounding terms during quick recall.',
      `Think about: Can you explain ${goalsList[0]?.title || cleanTitle} in one sentence without notes?`
    ],
    practice_next_time: `Notice where ${cleanTitle} appears in real-world everyday technology or nature.`
  };
}

/**
 * Generate a concise, high-yield revision sheet for a student completing a topic session.
 *
 * @param {object} params
 * @param {string} params.topicTitle - Topic name
 * @param {Array} params.goals - List of topic goals
 * @param {Array} [params.keyErrors] - Specific mistakes from the student's mastery report
 * @param {string|number} [params.classLevel] - Student grade level (default 10)
 * @returns {Promise<object>} Structured revision sheet JSON
 */
async function generateRevisionSheet({ topicTitle, goals = [], keyErrors = [], classLevel = '10' }) {
  const goalsText = goals.map((g, idx) => `${idx + 1}. ${typeof g === 'string' ? g : (g.title || '')}`).join('\n');
  const errorsText = (keyErrors || []).length > 0
    ? keyErrors.map(e => `${e.type || e}: ${e.count || 1} mistake(s)`).join(', ')
    : 'None (clean session)';

  const systemPrompt = `You are Cloop's study guide assistant, creating a quick revision sheet for a Class ${classLevel} student who just completed a tutoring session.

Topic: "${topicTitle}"
Goals Covered:
${goalsText}
Common mistakes in this session: ${errorsText}

When a session reaches the WRAP phase and is about to close, generate a concise revision sheet for the student with this structure:

**Key Concepts**
- List 3-5 essential ideas from today's topic in simple language
- Each point should be 1-2 sentences
- Focus on what they will actually need to remember

**Definitions**
- Extract 4-6 key terms the student encountered
- Provide clear, beginner-friendly definitions (1 sentence each)
- Use examples if the term is abstract

**Quick Recall Tips**
- Provide 2-3 memory aids or mnemonics
- Include common mistakes to avoid
- Give one "think about" question they can use to self-check

**Practice Next Time**
- Suggest 1-2 real-world applications they've seen
- Connect to the topic they just learned

Format as a clean, scannable list. Keep the entire sheet to under 200 words so students can screenshot or bookmark it.

OUTPUT STRICT JSON ONLY:
{
  "topic": "${topicTitle}",
  "key_concepts": [
    "Essential idea 1 (1-2 sentences)",
    "Essential idea 2",
    "Essential idea 3"
  ],
  "definitions": [
    { "term": "Key Term 1", "definition": "1-sentence beginner-friendly definition" },
    { "term": "Key Term 2", "definition": "..." }
  ],
  "quick_recall_tips": [
    "Mnemonic or memory aid",
    "Common mistake to avoid: ...",
    "Think about: Self-check question?"
  ],
  "practice_next_time": "1-2 real-world applications (under 30 words)"
}`;

  const messages = [
    {
      role: 'user',
      content: `Create the revision sheet for "${topicTitle}".`
    }
  ];

  try {
    const rawOutput = await invokeModel(systemPrompt, messages, {
      temperature: 0.3, // Low temperature for factual accuracy
      maxTokens: 800,
      jsonFormat: true,
      featureArea: 'tutor-core',
      subFeature: 'revision-sheet'
    });

    const parsed = extractJson(typeof rawOutput === 'string' ? rawOutput : rawOutput?.text);

    if (parsed && (Array.isArray(parsed.key_concepts) || Array.isArray(parsed.definitions))) {
      return {
        topic: parsed.topic || topicTitle,
        key_concepts: Array.isArray(parsed.key_concepts) ? parsed.key_concepts : [],
        definitions: Array.isArray(parsed.definitions) ? parsed.definitions : [],
        quick_recall_tips: Array.isArray(parsed.quick_recall_tips) ? parsed.quick_recall_tips : (Array.isArray(parsed.memory_aids) ? parsed.memory_aids : []),
        practice_next_time: typeof parsed.practice_next_time === 'string' ? parsed.practice_next_time : (Array.isArray(parsed.practice_next_time) ? parsed.practice_next_time.join(' ') : ''),
        // Backward-compatibility aliases for existing UI consumers:
        key_points: Array.isArray(parsed.key_concepts) ? parsed.key_concepts : [],
        common_mistakes: (parsed.quick_recall_tips || []).filter(t => typeof t === 'string' && /mistake|avoid|caution/i.test(t))
      };
    }

    throw new Error('Invalid revision sheet JSON output');
  } catch (error) {
    console.warn('[Tutor-Core Revision] Using resilient fallback revision sheet:', error.message);
    return buildFallbackRevisionSheet({ topicTitle, goals, keyErrors });
  }
}

module.exports = {
  generateRevisionSheet,
  buildFallbackRevisionSheet
};
