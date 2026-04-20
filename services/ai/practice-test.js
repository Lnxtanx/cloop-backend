const { invokeModel, extractJson } = require('./bedrock-client');

/**
 * Generate a practice test with 15 MCQs for a specific exam type and subject
 * @param {string} examType - 'NEET', 'IIT-JEE', etc.
 * @param {string} subject - 'Biology', 'Physics', 'Chemistry', 'Mathematics'
 * @param {Array<string>} chapters - Optional list of chapter titles to focus on
 * @returns {Promise<Array>} - Array of 15 question objects
 */
async function generatePracticeQuestions(examType, subject, chapters = []) {
    const chapterContext = chapters && chapters.length > 0 
        ? `Focus strictly on the following chapters: ${chapters.join(', ')}.`
        : `Cover the entire syllabus for ${subject}.`;

    const systemPrompt = `You are an expert exam paper setter for ${examType}. 
    Your task is to generate exactly 15 high-quality Multiple Choice Questions (MCQs) for the subject: ${subject}.
    
    Context: ${chapterContext}
    
    Rules:
    1. The difficulty level must match the actual ${examType} standards.
    2. Each question must have exactly 4 options.
    3. There must be exactly one correct answer.
    4. Provide a clear, concise explanation for the correct answer.
    5. Respond ONLY with a valid JSON object containing a "questions" array.
    
    JSON Structure for each question:
    {
        "question_text": "The actual question goes here?",
        "options": ["Option A", "Option B", "Option C", "Option D"],
        "correct_answer": "Option A",
        "explanation": "Brief explanation of why Option A is correct."
    }`;

    const userPrompt = `Generate 15 ${examType} practice MCQs for ${subject}. ${chapters && chapters.length > 0 ? 'Focus on specified chapters.' : ''}`;

    try {
        console.log(`[PracticeTest] 🚀 Generating 15 questions for ${examType} - ${subject}`);
        const responseText = await invokeModel(systemPrompt, [{ role: 'user', content: userPrompt }], {
            temperature: 0.7,
            maxTokens: 4096
        });

        const parsed = extractJson(responseText);
        if (!parsed || !Array.isArray(parsed.questions)) {
            throw new Error('Invalid response format from AI');
        }

        if (parsed.questions.length < 1) {
            throw new Error('AI generated 0 questions');
        }

        console.log(`[PracticeTest] ✅ Successfully generated ${parsed.questions.length} questions`);
        return parsed.questions;
    } catch (error) {
        console.error('[PracticeTest] ❌ Generation error:', error.message);
        throw error;
    }
}

module.exports = {
    generatePracticeQuestions
};
