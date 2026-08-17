const { invokeModel, extractJson } = require('./deepseek-client');
const { searchCurriculumSyllabus, searchChapterTopics } = require('../tavily-search');

/**
 * Truncate content to save tokens while keeping essential info
 */
function truncateContent(content, maxLength = 200) {
    if (!content) return '';
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + '...';
}

/**
 * Post-processing validator to strip deleted/rationalized NCERT chapters
 * ensures AI never outputs dropped topics like 'Constructions' or 'Sources of Energy'
 */
function cleanAndValidateRationalizedChapters(chapters, gradeLevel, subject) {
    if (!Array.isArray(chapters)) return [];

    const normSubject = String(subject || '').toLowerCase();
    const normGrade = String(gradeLevel || '').trim();

    // List of deleted/rationalized NCERT chapters to strictly filter out
    const deletedChapterRegexes = [];

    if (normGrade === '10' || normGrade === 'X') {
        if (normSubject.includes('math')) {
            // Chapter 11 Constructions is DELETED from Class 10 Math NCERT
            deletedChapterRegexes.push(/construction/i);
        }
        if (normSubject.includes('sci') || normSubject.includes('phys') || normSubject.includes('chem') || normSubject.includes('bio')) {
            // Deleted from Class 10 Science NCERT: Periodic Classification, Sources of Energy, Management of Natural Resources
            deletedChapterRegexes.push(/sources\s+of\s+energy/i);
            deletedChapterRegexes.push(/periodic\s+classification/i);
            deletedChapterRegexes.push(/management\s+of\s+natural\s+resources/i);
        }
    }

    if (normGrade === '9' || normGrade === 'IX') {
        if (normSubject.includes('sci')) {
            // Deleted from Class 9 Science: Why Do We Fall Ill, Natural Resources, Diversity in Living Organisms
            deletedChapterRegexes.push(/why\s+do\s+we\s+fall\s+ill/i);
            deletedChapterRegexes.push(/natural\s+resources/i);
            deletedChapterRegexes.push(/diversity\s+in\s+living\s+organisms/i);
        }
    }

    // Filter out deleted chapters
    const filtered = chapters.filter(chap => {
        const title = String(chap.title || chap.name || '');
        const isDeleted = deletedChapterRegexes.some(rx => rx.test(title));
        if (isDeleted) {
            console.log(`[curriculum-validator] 🛡️ Filtered out deleted/rationalized NCERT chapter: "${title}"`);
        }
        return !isDeleted;
    });

    return filtered;
}

/**
 * Generate chapters for a specific subject, grade, and board using live 2026-27 web search
 */
async function generateChapters(gradeLevel, board, subject, userId = null) {
    console.log(`🔍 [curriculum-gen] Fetching live 2026-27 rationalized curriculum web search for ${board} Class ${gradeLevel} ${subject}...`);
    
    // 1. Fetch live web search results from Tavily Search API (Domain-Restricted)
    let webSearchContext = null;
    try {
        webSearchContext = await searchCurriculumSyllabus({ gradeLevel, board, subject });
    } catch (searchErr) {
        console.warn('⚠️ Web search fallback triggered for chapter generation:', searchErr.message);
    }

    const systemPrompt = `You are an expert NCERT, CBSE, ICSE, and Indian State Board curriculum authority. 
STRICT RULE: Output ONLY the official 2026-27 RATIONALIZED NCERT syllabus chapters. 
DO NOT include old deleted/removed chapters (e.g. Class 10 Math has 14 chapters total — Constructions is DELETED; Class 10 Science has 13 chapters total — Sources of Energy & Periodic Classification are DELETED).
Always respond with valid JSON only. Output a JSON object with a "chapters" array.`;

    let userPrompt = `You are an official curriculum expert for ${board} Class ${gradeLevel} ${subject}.
Generate the EXACT, official list of 2026-27 chapters for:
- Grade/Class: ${gradeLevel}
- Board: ${board}
- Subject: ${subject}
`;

    if (webSearchContext) {
        userPrompt += `
====================================================
OFFICIAL 2026-27 RATIONALIZED CURRICULUM WEB SEARCH DATA:
====================================================
${webSearchContext}
====================================================

CRITICAL INSTRUCTIONS:
1. Follow the live 2026-27 official curriculum web search data above STRICTLY.
2. DO NOT include any dropped/rationalized chapters that were removed by NCERT.
3. For Class 10 Mathematics: Output EXACTLY 14 chapters (Chapter Constructions MUST NOT BE INCLUDED).
4. For Class 10 Science: Output EXACTLY 13 chapters (Sources of Energy & Periodic Classification MUST NOT BE INCLUDED. Our Environment MUST BE INCLUDED).
`;
    } else {
        userPrompt += `\nMake sure the chapters strictly follow the latest 2026-27 rationalized ${board} / NCERT curriculum for Class ${gradeLevel} ${subject}.\n`;
    }

    userPrompt += `
Please provide a JSON object with a "chapters" array, where each chapter has:
- "title": "Chapter title"
- "content": "Brief description of what this chapter covers according to the latest 2026-27 syllabus"

Return ONLY valid JSON.`;

    try {
        const responseText = await invokeModel(systemPrompt, [{ role: 'user', content: userPrompt }], {
            temperature: 0.1, // Low temperature for high factual precision
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

        // Apply strict post-processing rationalization filter
        chapters = cleanAndValidateRationalizedChapters(chapters, gradeLevel, subject);

        console.log(`✓ Chapters generated & validated (Web Search: ${webSearchContext ? 'LIVE 2026-27' : 'LLM Fallback'}) | Final Rationalized Count: ${chapters.length}`);
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

    const systemPrompt = 'You are an expert educational content generator that creates structured curriculum content according to the 2026-27 NCERT/Board rationalized syllabus. Always respond with valid JSON only. Output a JSON object with a "topics" array.';

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
LATEST OFFICIAL CHAPTER TOPICS WEB SEARCH DATA (2026-27):
====================================================
${webSearchContext}
====================================================

STRICT INSTRUCTION: Ensure all topics and subtopics reflect the live 2026-27 NCERT / ${board} rationalized syllabus web search data above. Do NOT include deleted topics.
`;
    } else {
        userPrompt += `\nMake sure the topics follow the official 2026-27 ${board} curriculum and cover all active topics of this chapter.\n`;
    }

    userPrompt += `
Please provide a JSON object with a "topics" array, where each topic has:
- "title": "Topic/Exercise title"
- "content": "Brief description of the topic (2-3 sentences)"

Return ONLY valid JSON.`;

    try {
        const responseText = await invokeModel(systemPrompt, [{ role: 'user', content: userPrompt }], {
            temperature: 0.1,
            userId,
            featureArea: 'curriculum_generation',
            subFeature: 'topic_gen',
            metadata: { gradeLevel, board, subject, chapterTitle, hasWebSearch: !!webSearchContext }
        });

        const parsed = extractJson(responseText);
        if (!parsed) {
            throw new Error('Failed to extract valid JSON from DeepSeek response');
        }

        let topics = Array.isArray(parsed) ? parsed : (parsed.topics || parsed.data || []);

        if (!Array.isArray(topics) || topics.length === 0) {
            throw new Error('Generated topics is not a valid array or empty');
        }

        console.log(`✓ Topics generated (Web Search: ${webSearchContext ? 'LIVE 2026-27' : 'LLM Fallback'}) | Count: ${topics.length}`);
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

        let goalsArray = [];
        if (Array.isArray(parsed)) {
            goalsArray = parsed;
        } else if (parsed && Array.isArray(parsed.goals)) {
            goalsArray = parsed.goals;
        } else if (parsed && parsed.items && Array.isArray(parsed.items)) {
            goalsArray = parsed.items;
        }

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
    cleanAndValidateRationalizedChapters,
};
