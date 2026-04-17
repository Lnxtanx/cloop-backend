const { invokeModel, extractJson } = require('./bedrock-client');

/**
 * Topic Chat Learn More Service
 * Handles "Learn More" mode after session completion
 * Analyzes user mistakes and asks targeted questions on weak topics
 */

/**
 * Analyze mistakes and generate targeted learning plan
 * @param {Array} weakGoals - Goals with score < 70%
 * @param {Array} allMistakes - All mistakes made during session
 * @param {Object} errorTypeCounts - Count of each error type
 * @returns {Object} Learning plan with focus areas and question strategy
 */
function analyzeMistakesForLearnMore(weakGoals, allMistakes, errorTypeCounts) {
  console.log('\n========== ANALYZING MISTAKES FOR LEARN MORE ==========');
  
  const ERROR_TYPES = [
    "No Answer Provided",
    "Confused Response",
    "Conceptual",
    "Application",
    "Logical Reasoning",
    "Calculation",
    "Spelling",
    "Grammar",
    "Vocabulary Misuse",
    "Incomplete Answer",
    "Misinterpreted Question",
    "Partially Correct"
  ];

  const errorBuckets = {};
  ERROR_TYPES.forEach(type => {
    errorBuckets[type] = allMistakes.filter(m => m.error_type === type);
  });

  const conceptualErrors = errorBuckets['Conceptual'] || [];
  const noAnswerErrors = errorBuckets['No Answer Provided'] || [];
  const spellingErrors = errorBuckets['Spelling'] || [];
  const grammarErrors = errorBuckets['Grammar'] || [];

  const errorTypeCountsFromData = {};
  ERROR_TYPES.forEach(type => {
    errorTypeCountsFromData[type] = (errorBuckets[type] || []).length;
  });

  let primaryFocus = 'conceptual';
  let focusReason = 'strengthening conceptual understanding';
  
  if (conceptualErrors.length > allMistakes.length * 0.4) {
    primaryFocus = 'conceptual';
  } else if (noAnswerErrors.length > allMistakes.length * 0.3) {
    primaryFocus = 'knowledge_gaps';
    focusReason = 'filling knowledge gaps';
  } else if (spellingErrors.length > grammarErrors.length) {
    primaryFocus = 'spelling';
    focusReason = 'improving spelling accuracy';
  } else if (grammarErrors.length > 0) {
    primaryFocus = 'grammar';
    focusReason = 'refining grammar and sentence structure';
  }

  const focusAreas = weakGoals.map(goal => {
    const goalMistakes = allMistakes.filter(m => m.goal_id === goal.goal_id);
    const mistakeTopics = goalMistakes.map(m => ({
      question: m.question,
      user_answer: m.user_answer,
      correct_answer: m.correct_answer,
      error_type: m.error_type,
      needs_deep_review: m.explain_loop_count > 1 || m.error_type === 'Conceptual'
    }));

    return {
      goal_id: goal.goal_id,
      goal_title: goal.goal_title,
      goal_description: goal.goal_description,
      score_percent: goal.score_percent,
      mistake_count: goalMistakes.length,
      mistake_topics: mistakeTopics,
      priority: goal.score_percent < 50 ? 'high' : 'medium'
    };
  }).sort((a, b) => a.score_percent - b.score_percent);

  return {
    primary_focus: primaryFocus,
    focus_reason: focusReason,
    focus_areas: focusAreas,
    total_weak_goals: weakGoals.length,
    conceptual_error_count: conceptualErrors.length,
    spelling_error_count: spellingErrors.length,
    grammar_error_count: grammarErrors.length,
    no_answer_count: noAnswerErrors.length,
    error_type_counts: errorTypeCountsFromData
  };
}

/**
 * Generate Learn More session prompt
 */
function buildLearnMoreSystemPrompt(topicTitle, topicContent, learningPlan, currentFocusArea, questionsAskedInLearnMore, lastQuestion, hasAskedQuestion, userMessage) {
  const { focus_areas, primary_focus, focus_reason } = learningPlan;
  
  return `You are an expert tutor helping a student improve their understanding of "${topicTitle}".

🎯 LEARN MORE MODE ACTIVE 🎯

📊 STUDENT'S WEAK AREAS:
${focus_areas.map((area, i) => 
  `${i + 1}. ${area.goal_title} (Score: ${area.score_percent}%, Priority: ${area.priority.toUpperCase()})
   - ${area.mistake_count} mistakes made`
).join('\n')}

🎓 PRIMARY FOCUS: ${primary_focus.toUpperCase()}
Reason: ${focus_reason}

📚 CURRENT FOCUS AREA:
${currentFocusArea ? `
Goal: ${currentFocusArea.goal_title}
Description: ${currentFocusArea.goal_description}
Previous Mistakes: ${currentFocusArea.mistake_count}

Student's Previous Errors in this area:
${currentFocusArea.mistake_topics.slice(0, 3).map((m, i) => 
  `${i + 1}. Question: "${m.question}"
   Student answered: "${m.user_answer || 'No answer'}"
   Correct answer: "${m.correct_answer}"`
).join('\n\n')}
` : 'Starting Learn More session'}

📝 QUESTIONS ASKED IN LEARN MORE MODE (DO NOT REPEAT):
${questionsAskedInLearnMore.length > 0 ? questionsAskedInLearnMore.map((q, i) => `${i + 1}. "${q}"`).join('\n') : 'None yet'}

⚡ YOUR TASK:
${hasAskedQuestion ? `
Student just answered: "${userMessage}"
Last question: "${lastQuestion}"
EVALUATE their answer with user_correction.` : `ASK A TARGETED QUESTION about ${currentFocusArea.goal_title}:`}

ALWAYS respond with valid JSON only. Do NOT include markdown or any commentary outside the JSON.`;
}

/**
 * Generate initial greeting for Learn More mode
 */
async function generateLearnMoreGreeting(topicTitle, learningPlan) {
  try {
    const { focus_areas, focus_reason } = learningPlan;
    const weakestGoal = focus_areas[0];

    const systemPrompt = `You are a supportive tutor starting a "Learn More" session for "${topicTitle}".
The student wants to improve on areas where they struggled:
- Weakest area: ${weakestGoal.goal_title} (${weakestGoal.score_percent}%)
- Focus: ${focus_reason}

Create a brief, encouraging greeting and ask the first targeted question.
Return VALID JSON ONLY.`;

    const userPrompt = 'Generate Learn More greeting and first question.';

    const responseText = await invokeModel(systemPrompt, [{ role: 'user', content: userPrompt }]);
    const parsed = extractJson(responseText);

    if (!parsed) throw new Error('Failed to parse greeting JSON');
    return parsed;
  } catch (error) {
    console.error('Error generating Learn More greeting:', error);
    return {
      messages: [
        { message: "Great choice to keep learning! 💪", message_type: "text" },
        { message: `Let's strengthen your understanding of ${topicTitle}.`, message_type: "text" }
      ]
    };
  }
}

/**
 * Generate Learn More chat response
 */
async function generateLearnMoreResponse(userMessage, topicTitle, topicContent, learningPlan, currentFocusArea, chatHistory = [], questionsAskedInLearnMore = []) {
  try {
    const aiMessages = chatHistory.filter(m => m.sender === 'ai' && m.message_type === 'text');
    const allQuestions = aiMessages
      .filter(m => m.message && m.message.includes('?'))
      .map(m => m.message);
    
    const lastAIMessage = aiMessages.length > 0 ? aiMessages[aiMessages.length - 1] : null;
    const lastQuestion = allQuestions.length > 0 ? allQuestions[allQuestions.length - 1] : null;
    const hasAskedQuestion = lastAIMessage && lastAIMessage.message && lastAIMessage.message.includes('?');

    const systemPrompt = buildLearnMoreSystemPrompt(
      topicTitle,
      topicContent,
      learningPlan,
      currentFocusArea,
      questionsAskedInLearnMore,
      lastQuestion,
      hasAskedQuestion,
      userMessage
    );

    const messages = [];
    const recentHistory = chatHistory.slice(-6);
    for (const msg of recentHistory) {
      messages.push({
        role: msg.sender === 'user' ? 'user' : 'assistant',
        content: msg.message || ''
      });
    }

    messages.push({ role: 'user', content: userMessage });

    const responseText = await invokeModel(systemPrompt, messages);
    let parsed = extractJson(responseText);

    if (!parsed) throw new Error('Failed to parse response JSON');

    if (parsed.user_correction) {
      if (parsed.user_correction.options) delete parsed.user_correction.options;
      if (!parsed.user_correction.message_type) parsed.user_correction.message_type = 'user_correction';
      if (!parsed.user_correction.feedback) {
        parsed.user_correction.feedback = { is_correct: false, bubble_color: 'red', score_percent: 0 };
      }
      if (!parsed.user_correction.emoji) {
        const isCorrect = parsed.user_correction.feedback?.is_correct;
        parsed.user_correction.emoji = isCorrect ? '😊' : '🤔';
      }
    }

    return parsed;
  } catch (error) {
    console.error('Error generating Learn More response:', error);
    return {
      messages: [
        { message: "Let's keep practicing! 💪", message_type: "text" }
      ]
    };
  }
}

module.exports = {
  analyzeMistakesForLearnMore,
  buildLearnMoreSystemPrompt,
  generateLearnMoreGreeting,
  generateLearnMoreResponse
};
