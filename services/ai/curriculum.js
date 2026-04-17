const { invokeModel, extractJson } = require('./bedrock-client');

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
 * Generate chapters for a specific subject, grade, and board
 */
async function generateChapters(gradeLevel, board, subject) {
    const systemPrompt = 'You are an expert educational content generator that creates structured curriculum content. Always respond with valid JSON only. Output a JSON object with a "chapters" array.';
    
    const userPrompt = `You are an educational content expert. Generate a comprehensive list of chapters for the following:
- Grade/Class: ${gradeLevel}
- Board: ${board}
- Subject: ${subject}

Please provide a JSON object with a "chapters" array, where each chapter has:
- "title": "Chapter title"
- "content": "Brief description of what this chapter covers"

Make sure the chapters follow the official ${board} curriculum for ${gradeLevel} ${subject}.
Return ONLY valid JSON.`;

    try {
        const responseText = await invokeModel(systemPrompt, [{ role: 'user', content: userPrompt }], {
            temperature: 0.3 // Lower temperature for more deterministic JSON
        });

        const parsed = extractJson(responseText);
        if (!parsed) {
            throw new Error('Failed to extract valid JSON from Bedrock response');
        }

        // Handle both array and { chapters: [...] } formats
        let chapters = Array.isArray(parsed) ? parsed : (parsed.chapters || parsed.data || []);

        if (!Array.isArray(chapters) || chapters.length === 0) {
            throw new Error('Generated chapters is not a valid array or empty');
        }

        console.log(`✓ Chapters generated | Count: ${chapters.length}`);
        return chapters;
    } catch (error) {
        console.error('❌ Error generating chapters:', error.message);
        throw new Error(`Failed to generate chapters: ${error.message}`);
    }
}

/**
 * Generate topics/exercises for a specific chapter
 */
async function generateTopics(gradeLevel, board, subject, chapterTitle, chapterContent) {
    const chapterSummary = truncateContent(chapterContent, 150);
    const systemPrompt = 'You are an expert educational content generator that creates structured curriculum content. Always respond with valid JSON only. Output a JSON object with a "topics" array.';

    const userPrompt = `You are an educational content expert. Generate a comprehensive list of topics and exercises for the following chapter:
- Grade/Class: ${gradeLevel}
- Board: ${board}
- Subject: ${subject}
- Chapter: ${chapterTitle}
- Chapter Summary: ${chapterSummary}

Please provide a JSON object with a "topics" array, where each topic has:
- "title": "Topic/Exercise title"
- "content": "Brief description of the topic (2-3 sentences)"

Make sure the topics follow the official ${board} curriculum and cover all important aspects of this chapter.
Return ONLY valid JSON.`;

    try {
        const responseText = await invokeModel(systemPrompt, [{ role: 'user', content: userPrompt }], {
            temperature: 0.3
        });

        const parsed = extractJson(responseText);
        if (!parsed) {
            throw new Error('Failed to extract valid JSON from Bedrock response');
        }

        // Handle both array and { topics: [...] } formats
        let topics = Array.isArray(parsed) ? parsed : (parsed.topics || parsed.data || []);

        if (!Array.isArray(topics) || topics.length === 0) {
            throw new Error('Generated topics is not a valid array or empty');
        }

        console.log(`✓ Topics generated | Count: ${topics.length}`);
        return topics;
    } catch (error) {
        console.error('❌ Error generating topics:', error.message);
        throw new Error(`Failed to generate topics: ${error.message}`);
    }
}

/**
 * Generate clear, measurable learning goals for a topic
 */
async function generateTopicGoals(topicTitle, topicContent) {
    const topicSummary = truncateContent(topicContent, 250);
    const systemPrompt = 'You are an expert educational content generator that creates clear, measurable learning objectives. Always respond with valid JSON only.';

    const userPrompt = `You are an expert curriculum designer. For the following topic, generate a list of clear, measurable learning goals (minimum 4). Use specific action verbs (e.g., identify, describe, analyze, demonstrate). Provide the response as a JSON object with the shape:
{ "goals": [ { "title": "Goal title (short)", "description": "One-sentence measurable description" }, ... ] }

Topic: ${topicTitle}
Summary: ${topicSummary}

Return ONLY valid JSON.`;

    try {
        const responseText = await invokeModel(systemPrompt, [{ role: 'user', content: userPrompt }], {
            temperature: 0.3
        });

        const parsed = extractJson(responseText);
        if (!parsed) {
            throw new Error('Failed to extract valid JSON from Bedrock response');
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
