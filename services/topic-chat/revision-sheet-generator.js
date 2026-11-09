
const { invokeModel } = require('../ai/deepseek-client');

/**
 * Generate an AI-powered personalized revision sheet from the student's actual session transcript
 * @param {Object} params
 * @param {Object} params.topic - Topic metadata with chapter, subject, grade, board
 * @param {Array} params.topicGoals - Array of goals
 * @param {Array} params.learningTurns - Array of graded learning turn records from this session
 * @param {Object} params.metricsData - Quantitative session metrics
 * @returns {Promise<Object>} Structured Revision Sheet data
 */
async function generateRevisionSheetWithAI({ topic, topicGoals = [], learningTurns = [], metricsData = {} }) {
  const topicTitle = topic.title || 'Topic Revision';
  const chapterTitle = topic.chapter?.title || '';
  const subjectName = topic.chapter?.subject?.name || 'Science';
  const grade = topic.chapter?.subject?.grade || '9';
  const board = topic.chapter?.subject?.board || 'CBSE';
  const textbookContent = (topic.content || topic.textbook_content || '').substring(0, 1500);

  // Summarize learning turns into clear readable student performance context
  let turnsText = '';
  if (Array.isArray(learningTurns) && learningTurns.length > 0) {
    turnsText = learningTurns.map((turn, idx) => {
      const q = turn.question_text || `Question ${idx + 1}`;
      const ans = turn.user_answer_raw || 'No answer';
      const status = turn.is_correct ? 'CORRECT' : 'INCORRECT';
      const score = turn.score_percent !== undefined && turn.score_percent !== null ? `${turn.score_percent}%` : '';
      const feedback = turn.feedback_text ? `\n   Tutor Feedback: "${turn.feedback_text}"` : '';
      const error = turn.error_type ? ` [Type: ${turn.error_type}]` : '';
      return `${idx + 1}. Q: "${q}"\n   Student Answer: "${ans}"\n   Verdict: ${status} ${score}${error}${feedback}`;
    }).join('\n\n');
  }

  const overallScore = metricsData.overall_score_percent ?? 70;
  const weakGoalsList = (metricsData.weak_goals || []).map(g => g.goal_title).join(', ');

  const systemPrompt = `You are an expert pedagogical revision tutor for K-12 students (${board}/NCERT curriculum).
Your task is to analyze the student's actual session transcript and generate a personalized, accurate, high-yield Revision Sheet JSON.

CRITICAL PEDAGOGICAL INSTRUCTIONS:
1. "key_concepts": 3 to 5 clear, comprehensive bullet points summarizing the core principles covered in this topic.
2. "definitions": 3 to 5 textbook-accurate definitions of essential scientific terms covered (e.g. key terms, particles, experiments, phenomena).
3. "quick_recall_tips": 2 to 4 personalized tips DIRECTLY TARGETING the student's actual mistakes and misconceptions from this chat session!
   - Look closely at what the student got wrong or struggled with in their answers.
   - Address their specific errors explicitly so they never repeat them.
   - Use memorable mnemonics or clear contrast rules where helpful.
4. "practice_next_time": 1 to 2 sentences of concrete, actionable advice based on what the student found difficult.
5. "recommended_video_queries": 1 to 2 targeted YouTube search queries for 5-10 minute concept animation videos (e.g., "${topicTitle} Class ${grade} animation", "Discovery of Electron Class ${grade}").

Return ONLY valid JSON matching this exact structure:
{
  "topic": "${topicTitle}",
  "key_concepts": ["concept 1", "concept 2", "concept 3"],
  "definitions": [{"term": "Term", "definition": "Textbook definition"}],
  "quick_recall_tips": ["tip 1 targeting student mistake", "tip 2"],
  "practice_next_time": "actionable advice",
  "recommended_video_queries": ["query 1", "query 2"]
}`;

  const userPrompt = `Topic: ${topicTitle}
Chapter: ${chapterTitle}
Subject: ${subjectName} (Grade: ${grade}, Board: ${board})
Overall Accuracy: ${overallScore}%
${weakGoalsList ? `Weak Areas to address: ${weakGoalsList}\n` : ''}
${textbookContent ? `Curriculum Reference:\n${textbookContent}\n` : ''}
Student Learning Turns from this Chat Session:
${turnsText || 'All questions completed successfully.'}

Generate the personalized Revision Sheet JSON now.`;

  try {
    console.log(`[revision-sheet-generator] 🧠 Invoking AI Revision Agent for "${topicTitle}" with ${learningTurns.length} student turns (fast-path)...`);
    const rawResponse = await invokeModel(systemPrompt, [{ role: 'user', content: userPrompt }], {
      model: 'deepseek-flash',
      reasoningEffort: 'low',
      subFeature: 'revision-generator',
      featureArea: 'tutor-core',
      temperature: 0.3,
      maxTokens: 2048,
      jsonFormat: true,
      timeoutMs: 12000
    });

    let parsed = null;
    if (typeof rawResponse === 'string') {
      try {
        parsed = JSON.parse(rawResponse);
      } catch (_) {
        const jsonMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[1]);
        }
      }
    } else if (typeof rawResponse === 'object' && rawResponse !== null) {
      parsed = rawResponse;
    }

    if (parsed && Array.isArray(parsed.key_concepts) && parsed.key_concepts.length > 0) {
      console.log(`[revision-sheet-generator] ✅ AI Revision Agent successfully generated personalized sheet with ${parsed.key_concepts.length} concepts, ${(parsed.definitions || []).length} definitions, ${(parsed.quick_recall_tips || []).length} recall tips.`);
      return {
        topic: topicTitle,
        key_concepts: parsed.key_concepts,
        definitions: Array.isArray(parsed.definitions) ? parsed.definitions : [],
        quick_recall_tips: Array.isArray(parsed.quick_recall_tips) ? parsed.quick_recall_tips : [],
        practice_next_time: parsed.practice_next_time || '',
        recommended_video_queries: Array.isArray(parsed.recommended_video_queries) ? parsed.recommended_video_queries : []
      };
    }
  } catch (err) {
    console.error('[revision-sheet-generator] ⚠️ AI generation failed:', err.message);
  }

  // Graceful fallback if AI call fails
  console.warn('[revision-sheet-generator] Using curriculum fallback for revision sheet');
  return {
    topic: topicTitle,
    key_concepts: topicGoals.map(g => `${g.title}: ${g.description || 'Core concept'}`),
    definitions: topicGoals.map(g => ({ term: g.title, definition: g.description || `Key concept in ${topicTitle}` })),
    quick_recall_tips: (metricsData.top_error_types || []).map(t => `Review common mistake: ${t.type}`),
    practice_next_time: `Review the core concepts in ${topicTitle} before taking the practice test.`,
    recommended_video_queries: [`${topicTitle} ${chapterTitle} Class ${grade} animation`]
  };
}

module.exports = {
  generateRevisionSheetWithAI
};
