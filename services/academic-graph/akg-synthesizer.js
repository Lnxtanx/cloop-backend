const { invokeModel, extractJson } = require('../ai/deepseek-client');

function buildFallbackIntelligence({ topic, chapter, precedingTopic, succeedingTopic, classLevel }) {
  const topicTitle = topic?.title || 'Core Topic';
  return {
    preceding_anchor: precedingTopic?.title
      ? `Earlier understanding of ${precedingTopic.title}.`
      : 'Prior everyday observations and intuitive foundation.',
    succeeding_teaser: succeedingTopic?.title
      ? `Coming up next: ${succeedingTopic.title}.`
      : 'Further real-world applications in upcoming chapters.',
    in_scope_concepts: [topicTitle],
    out_of_scope_boundaries: [
      'Advanced mathematical derivations',
      'Higher-grade formal laws and vector equations',
    ],
    common_misconceptions: [],
  };
}

function buildSynthesisPrompt({ topic, chapter, precedingTopic, succeedingTopic, classLevel = 'Class 10', board = 'CBSE' }) {
  const chapterContext = chapter?.title ? `Chapter: "${chapter.title}"` : '';
  const precContext = precedingTopic?.title
    ? `Preceding Topic in sequence: "${precedingTopic.title}"`
    : 'This is the opening topic of the chapter/sequence.';
  const succContext = succeedingTopic?.title
    ? `Succeeding Topic in sequence: "${succeedingTopic.title}"`
    : 'This is the final topic of the chapter/sequence.';

  return `You are Cloop's Academic Knowledge Graph Synthesizer for Indian school curriculum (${board}, ${classLevel}).
Analyze this curriculum node and establish strict pedagogical boundaries:

TARGET TOPIC: "${topic.title}"
${chapterContext}
${precContext}
${succContext}
TOPIC SYLLABUS:
${String(topic.content || '').substring(0, 1000)}

YOUR TASK:
Determine the exact pedagogical perimeter for ${classLevel}:
1. preceding_anchor: 1 sentence (< 25 words) anchoring what prior concept/observation the student brings in.
2. succeeding_teaser: 1 sentence (< 25 words) teasing the next topic in the learning trajectory.
3. in_scope_concepts: 3 to 6 key concept names that STRICTLY belong to this topic at ${classLevel}.
4. out_of_scope_boundaries: 3 to 6 concepts, formulas, or laws that belong to higher grades or subsequent chapters and MUST NOT be introduced or expected here (e.g. for Class 6 Force, do not introduce Newton's laws, inertia, or vector math).
5. common_misconceptions: 2 to 4 objects with { "misconception": "...", "correction_angle": "..." } capturing common Indian student misconceptions for this topic.

Return STRICT JSON matching this schema:
{
  "preceding_anchor": "string",
  "succeeding_teaser": "string",
  "in_scope_concepts": ["concept 1", "concept 2"],
  "out_of_scope_boundaries": ["boundary 1", "boundary 2"],
  "common_misconceptions": [
    { "misconception": "string", "correction_angle": "string" }
  ]
}`;
}

async function synthesizeTopicIntelligence(params) {
  const { topic, chapter, precedingTopic, succeedingTopic, classLevel = 'Class 10', board = 'CBSE' } = params;

  try {
    const prompt = buildSynthesisPrompt({ topic, chapter, precedingTopic, succeedingTopic, classLevel, board });
    const raw = await invokeModel(
      prompt,
      [{ role: 'user', content: `Generate academic boundaries and misconceptions for: ${topic.title}` }],
      {
        temperature: 0.2,
        maxTokens: 600,
        jsonFormat: true,
        featureArea: 'academic-graph',
        subFeature: 'synthesizer',
      }
    );

    const parsed = extractJson(typeof raw === 'string' ? raw : raw?.text);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid JSON from AKG synthesizer');
    }

    if (!Array.isArray(parsed.in_scope_concepts) || !Array.isArray(parsed.out_of_scope_boundaries)) {
      throw new Error('Missing concept or boundary arrays in synthesizer output');
    }

    return {
      preceding_anchor: typeof parsed.preceding_anchor === 'string' ? parsed.preceding_anchor.trim() : null,
      succeeding_teaser: typeof parsed.succeeding_teaser === 'string' ? parsed.succeeding_teaser.trim() : null,
      in_scope_concepts: parsed.in_scope_concepts.map(s => String(s).trim()).filter(Boolean),
      out_of_scope_boundaries: parsed.out_of_scope_boundaries.map(s => String(s).trim()).filter(Boolean),
      common_misconceptions: Array.isArray(parsed.common_misconceptions)
        ? parsed.common_misconceptions
            .map(m => (m && typeof m === 'object' ? {
                misconception: String(m.misconception || '').trim(),
                correction_angle: String(m.correction_angle || '').trim()
              } : null))
            .filter(m => m && m.misconception)
        : [],
    };
  } catch (err) {
    console.warn(`[AKG Synthesizer] Fallback used for "${topic?.title}":`, err.message);
    return buildFallbackIntelligence(params);
  }
}

module.exports = {
  synthesizeTopicIntelligence,
  buildSynthesisPrompt,
  buildFallbackIntelligence,
};
