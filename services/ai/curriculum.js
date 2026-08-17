const { invokeModel, extractJson } = require('./deepseek-client');
const { searchCurriculumSyllabus, searchChapterTopics } = require('../tavily-search');

/**
 * Truncate content to save tokens while keeping essential info
 * @param {string} content - Full content text
 * @param {number} maxLength - Maximum character length (default: 200)
 * @returns {string} Truncated content
 */
function truncateContent(content, maxLength = 200) {
    if (!content) return '';
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + '...';
}

/**
 * Generate chapters for a specific subject, grade, and board using live 2026 web search
 */
async function generateChapters(gradeLevel, board, subject, userId = null) {
    console.log(`🔍 [curriculum-gen] Fetching live 2026 curriculum web search for ${board} Class ${gradeLevel} ${subject}...`);
    
    // 1. Fetch live web search results from Tavily Search API
    let webSearchContext = null;
    try {
        webSearchContext = await searchCurriculumSyllabus({ gradeLevel, board, subject });
    } catch (searchErr) {
        console.warn('⚠️ Web search fallback triggered for chapter generation:', searchErr.message);
    }

    const systemPrompt = 'You are an expert educational curriculum designer specializing in NCERT, CBSE, ICSE, and Indian State Board updated curricula. Always respond with valid JSON only. Output a JSON object with a "chapters" array.';

    let userPrompt = `You are an educational content expert. Generate a comprehensive and 100% accurate list of chapters for the following:
- Grade/Class: ${gradeLevel}
- Board: ${board}
- Subject: ${subject}
`;

    if (webSearchContext) {
        userPrompt += `
====================================================
LATEST OFFICIAL 2026 CURRICULUM WEB SEARCH DATA:
====================================================
${webSearchContext}
====================================================

STRICT INSTRUCTION: Use the live 2026 official web search data above to ensure the chapter titles, order, and sequence strictly reflect the latest updated NCERT / ${board} textbook for Grade ${gradeLevel} ${subject}.
`;
    } else {
        userPrompt += `\nMake sure the chapters follow the official ${board} curriculum for ${gradeLevel} ${subject}.\n`;
    }

    userPrompt += `
Please provide a JSON object with a "chapters" array, where each chapter has:
- "title": "Chapter title"
- "content": "Brief description of what this chapter covers according to the latest 2026 syllabus"

Return ONLY valid JSON.`;

    try {
        const responseText = await invokeModel(systemPrompt, [{ role: 'user', content: userPrompt }], {
            temperature: 0.2,
            userId,
            featureArea: 'curriculum_generation',
            subFeature: 'chapter_gen',
            metadata: { gradeLevel, board, subject, hasWebSearch: !!webSearchContext }
        });

        const parsed = extractJson(responseText);
        if (!parsed) {
            throw new Error('Failed to extract valid JSON from DeepSeek response');
        }

        // Handle both array and { chapters: [...] } formats
        let chapters = Array.isArray(parsed) ? parsed : (parsed.chapters || parsed.data || []);

        if (!Array.isArray(chapters) || chapters.length === 0) {
            throw new Error('Generated chapters is not a valid array or empty');
        }

        console.log(`✓ Chapters generated (Web Search: ${webSearchContext ? 'LIVE 2026' : 'LLM Fallback'}) | Count: ${chapters.length}`);
        return chapters;
    } catch (error) {
        console.error('❌ Error generating chapters:', error.message);
        throw new Error(`Failed to generate chapters: ${error.message}`);
    }
}

/**
 * Generate topics/exercises for a specific chapter using live web search
 */
async function generateTopics(gradeLevel, board, subject, chapterTitle, chapterContent, userId = null) {
    const chapterSummary = truncateContent(chapterContent, 150);
    
    // 1. Fetch live web search results for chapter topics from Tavily Search API
    let webSearchContext = null;
    try {
        webSearchContext = await searchChapterTopics({ gradeLevel, board, subject, chapterTitle });
    } catch (searchErr) {
        console.warn('⚠️ Web search fallback triggered for topic generation:', searchErr.message);
    }

    const systemPrompt = 'You are an expert educational content generator that creates structured curriculum content. Always respond with valid JSON only. Output a JSON object with a "topics" array.';

    let userPrompt = `You are an educational content expert. Generate a comprehensive list of topics and exercises for the following chapter:
- Grade/Class: ${gradeLevel}
- Board: ${board}
- Subject: ${subject}
- Chapter: ${chapterTitle}
- Chapter Summary: ${chapterSummary}
`;

    if (webSearchContext) {
        userPrompt += `
====================================================
LATEST OFFICIAL CHAPTER TOPICS WEB SEARCH DATA (2026):
====================================================
${webSearchContext}
====================================================

STRICT INSTRUCTION: Ensure all topics and subtopics reflect the live 2026 NCERT / ${board} curriculum web search data above.
`;
    } else {
        userPrompt += `\nMake sure the topics follow the official ${board} curriculum and cover all important aspects of this chapter.\n`;
    }

    userPrompt += `
Please provide a JSON object with a "topics" array, where each topic has:
- "title": "Topic/Exercise title"
- "content": "Brief description of the topic (2-3 sentences)"

Return ONLY valid JSON.`;

    try {
        const responseText = await invokeModel(systemPrompt, [{ role: 'user', content: userPrompt }], {
            temperature: 0.2,
            userId,
            featureArea: 'curriculum_generation',
            subFeature: 'topic_gen',
            metadata: { gradeLevel, board, subject, chapterTitle, hasWebSearch: !!webSearchContext }
        });

        const parsed = extractJson(responseText);
        if (!parsed) {
            throw new Error('Failed to extract valid JSON from DeepSeek response');
        }

        // Handle both array and { topics: [...] } formats
        let topics = Array.isArray(parsed) ? parsed : (parsed.topics || parsed.data || []);

        if (!Array.isArray(topics) || topics.length === 0) {
            throw new Error('Generated topics is not a valid array or empty');
        }

        console.log(`✓ Topics generated (Web Search: ${webSearchContext ? 'LIVE 2026' : 'LLM Fallback'}) | Count: ${topics.length}`);
        return topics;
    } catch (error) {
        console.error('❌ Error generating topics:', error.message);
        throw new Error(`Failed to generate topics: ${error.message}`);
    }
}

/**
 * Generate clear, measurable learning goals for a topic
 */
async function generateTopicGoals(topicTitle, topicContent, userId = null) {
    const topicSummary = truncateContent(topicContent, 250);
    const systemPrompt = 'You are an expert educational content generator that creates clear, measurable learning objectives. Always respond with valid JSON only.';

    const userPrompt = `You are an expert curriculum designer. For the following topic, generate a list of clear, measurable learning goals (minimum 4). Use specific action verbs (e.g., identify, describe, analyze, demonstrate). Provide the response as a JSON object with the shape:
{ "goals": [ { "title": "Goal title (short)", "description": "One-sentence measurable description" }, ... ] }

Topic: ${topicTitle}
Summary: ${topicSummary}

Return ONLY valid JSON.`;

    try {
        const responseText = await invokeModel(systemPrompt, [{ role: 'user', content: userPrompt }], {
            temperature: 0.3,
            userId,
            featureArea: 'curriculum_generation',
            subFeature: 'goal_gen',
            metadata: { topicTitle }
        });

        const parsed = extractJson(responseText);
        if (!parsed) {
            throw new Error('Failed to extract valid JSON from DeepSeek response');
        }

        // Normalise to { goals: [...] }
        let goalsArray = [];
        if (Array.isArray(parsed)) {
            goalsArray = parsed;
        } else if (parsed && Array.isArray(parsed.goals)) {
            goalsArray = parsed.goals;
        } else if (parsed && parsed.items && Array.isArray(parsed.items)) {
            goalsArray = parsed.items;
        }

        // Ensure each goal has title & description
        goalsArray = goalsArray.map(g => ({
            title: (g.title || g.name || '').toString().trim(),
            description: (g.description || g.desc || '').toString().trim(),
        })).filter(g => g.title || g.description);

        if (goalsArray.length === 0) {
            throw new Error('No valid goals extracted from response');
        }

        console.log(`✓ Goals generated | Count: ${goalsArray.length}`);
        return { goals: goalsArray };
    } catch (error) {
        console.error('❌ Error generating topic goals:', error.message);
        throw new Error(`Failed to generate topic goals: ${error.message}`);
    }
}

module.exports = {
    generateChapters,
    generateTopics,
    generateTopicGoals,
};
