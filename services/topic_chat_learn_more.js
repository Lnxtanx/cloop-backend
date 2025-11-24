const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.API_KEY_OPENAI,
});

/**
 * Topic Chat Learn More Service
 * Handles "Learn More" mode after session completion
 * Analyzes user mistakes and asks targeted questions on weak topics
 * 
 * Features:
 * - Analyze mistake patterns from session
 * - Generate targeted questions for weak goals
 * - Focus on specific error types (conceptual, spelling, grammar)
 * - Provide deeper explanations for challenging concepts
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
  console.log('🎯 Weak Goals:', weakGoals.length);
  console.log('❌ Total Mistakes:', allMistakes.length);
  console.log('📊 Error Types:', Object.keys(errorTypeCounts).join(', '));

  // Categorize mistakes by error type - 12 error types reference
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

  // Bucket mistakes by type
  const errorBuckets = {};
  ERROR_TYPES.forEach(type => {
    errorBuckets[type] = allMistakes.filter(m => m.error_type === type);
  });

  // Convenience arrays for legacy logic
  const conceptualErrors = errorBuckets['Conceptual'] || [];
  const noAnswerErrors = errorBuckets['No Answer Provided'] || [];
  const spellingErrors = errorBuckets['Spelling'] || [];
  const grammarErrors = errorBuckets['Grammar'] || [];

  // Counts per error type (used in prompt)
  const errorTypeCountsFromData = {};
  ERROR_TYPES.forEach(type => {
    errorTypeCountsFromData[type] = (errorBuckets[type] || []).length;
  });

  // Determine primary focus area
  let primaryFocus = 'conceptual';
  let focusReason = 'understanding core concepts';
  
  if (conceptualErrors.length > allMistakes.length * 0.4) {
    primaryFocus = 'conceptual';
    focusReason = 'strengthening conceptual understanding';
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

  // Create focus areas with specific topics to review
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
  }).sort((a, b) => a.score_percent - b.score_percent); // Sort by lowest score first

  console.log('\n📋 Learning Plan:');
  console.log('  - Primary Focus:', primaryFocus);
  console.log('  - Reason:', focusReason);
  console.log('  - Focus Areas:', focusAreas.length);
  focusAreas.forEach((area, i) => {
    console.log(`    ${i + 1}. ${area.goal_title} (${area.score_percent}%, ${area.mistake_count} mistakes, ${area.priority} priority)`);
  });
  console.log('======================================================\n');

  return {
    primary_focus: primaryFocus,
    focus_reason: focusReason,
    focus_areas: focusAreas,
    total_weak_goals: weakGoals.length,
    conceptual_error_count: conceptualErrors.length,
    spelling_error_count: spellingErrors.length,
    grammar_error_count: grammarErrors.length,
    no_answer_count: noAnswerErrors.length,
    // full counts map for all recognized error types
    error_type_counts: errorTypeCountsFromData
  };
}

/**
 * Generate Learn More session prompt
 * Creates targeted questions based on user's mistakes
 */
function buildLearnMoreSystemPrompt(topicTitle, topicContent, learningPlan, currentFocusArea, questionsAskedInLearnMore, lastQuestion, hasAskedQuestion, userMessage) {
  const { focus_areas, primary_focus, focus_reason } = learningPlan;
  
  return `You are an expert tutor helping a student improve their understanding of "${topicTitle}".

🎯 LEARN MORE MODE ACTIVE 🎯

The student completed this topic but struggled with certain areas. Your goal is to help them strengthen their weak points through targeted practice.

📊 STUDENT'S WEAK AREAS:
${focus_areas.map((area, i) => 
  `${i + 1}. ${area.goal_title} (Score: ${area.score_percent}%, Priority: ${area.priority.toUpperCase()})
   - ${area.mistake_count} mistakes made
   - Needs focus on: ${area.mistake_topics.slice(0, 2).map(t => t.error_type).join(', ')}`
).join('\n')}

ERROR TYPE COUNTS:
${Object.keys(learningPlan.error_type_counts || {}).length > 0 ? Object.entries(learningPlan.error_type_counts).map(([k,v]) => `- ${k}: ${v}`).join('\n') : 'None recorded'}

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
   Correct answer: "${m.correct_answer}"
   Error type: ${m.error_type}`
).join('\n\n')}
` : 'Starting Learn More session'}

📝 QUESTIONS ASKED IN LEARN MORE MODE (DO NOT REPEAT):
${questionsAskedInLearnMore.length > 0 ? questionsAskedInLearnMore.map((q, i) => `${i + 1}. "${q}"`).join('\n') : 'None yet'}

⚡ YOUR TASK:
${hasAskedQuestion ? `
Student just answered: "${userMessage}"
Last question: "${lastQuestion}"

EVALUATE their answer with user_correction format:
- Check for understanding improvement
- Provide encouraging feedback
- Show corrections if needed
- Include options: ["Got it", "Explain"]
` : `
ASK A TARGETED QUESTION about ${currentFocusArea.goal_title}:
1. Focus on the concept they struggled with
2. Ask in a DIFFERENT way than before
3. Make it slightly easier to build confidence
4. Keep it SHORT (one sentence, one concept)
5. NEVER repeat questions from the list above
`}

🎨 RESPONSE FORMAT (VALID JSON ONLY):

${hasAskedQuestion ? `
{
  "messages": [],
  "user_correction": {
    "message_type": "user_correction",
    "diff_html": "${userMessage}",
    "complete_answer": "Encouraging feedback acknowledging improvement or explaining the concept",
    "options": ["Got it", "Explain"],
    "emoji": "😊",
    "feedback": {
      "is_correct": true/false,
      "bubble_color": "green"/"red",
      "score_percent": 0-100,
      "error_type": "Conceptual"/"Spelling"/"Grammar"
    }
  }
}
` : `
{
  "messages": [
    { "message": "Let's work on ${currentFocusArea.goal_title}. [Ask targeted question]?", "message_type": "text" }
  ]
}
`}

🚨 CRITICAL RULES:
1. NEVER repeat questions - check the list above
2. Ask questions that address their SPECIFIC mistakes
3. If they struggled with conceptual understanding, ask concept-based questions
4. If they had spelling/grammar issues, focus on those aspects
5. Build confidence - start with slightly easier variations
6. Provide detailed explanations when they ask
7. After 3-4 questions per weak goal, suggest moving to next weak area or ending

💡 ENCOURAGEMENT:
- Acknowledge their effort to learn more
- Celebrate improvements
- Be patient and supportive
- Focus on growth, not just correctness`;
}

/**
 * Generate initial greeting for Learn More mode
 */
async function generateLearnMoreGreeting(topicTitle, learningPlan) {
  try {
    const { focus_areas, focus_reason } = learningPlan;
    const weakestGoal = focus_areas[0]; // Lowest scoring goal

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a supportive tutor starting a "Learn More" session for "${topicTitle}".

The student wants to improve on areas where they struggled:
- Weakest area: ${weakestGoal.goal_title} (${weakestGoal.score_percent}%)
- Focus: ${focus_reason}

Create a brief, encouraging message:
1. Welcome them back
2. Acknowledge their desire to improve
3. Mention what you'll focus on
4. Ask the first targeted question about their weakest area

Return VALID JSON:
{
  "messages": [
    { "message": "Great decision to keep learning! 💪", "message_type": "text" },
    { "message": "Let's strengthen your understanding of ${weakestGoal.goal_title}.", "message_type": "text" },
    { "message": "[First targeted question about ${weakestGoal.goal_title}]?", "message_type": "text" }
  ]
}`
        },
        {
          role: 'user',
          content: 'Generate Learn More greeting'
        }
      ],
      temperature: 0.8,
      max_tokens: 400,
      response_format: { type: "json_object" }
    });

    const content = response.choices[0].message.content.trim();
    return JSON.parse(content);
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
 * Similar to regular chat but focused on weak areas
 */
async function generateLearnMoreResponse(userMessage, topicTitle, topicContent, learningPlan, currentFocusArea, chatHistory = [], questionsAskedInLearnMore = []) {
  try {
    // Analyze chat history
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

    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    // Add recent history
    const recentHistory = chatHistory.slice(-6);
    for (const msg of recentHistory) {
      messages.push({
        role: msg.sender === 'user' ? 'user' : 'assistant',
        content: msg.message || ''
      });
    }

    messages.push({
      role: 'user',
      content: userMessage
    });

    console.log('\n========== LEARN MORE AI CALL ==========');
    console.log('📚 Focus Area:', currentFocusArea?.goal_title);
    console.log('💬 User Message:', userMessage);
    console.log('🔍 Questions Asked:', questionsAskedInLearnMore.length);
    console.log('=========================================\n');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      temperature: 0.2,
      max_tokens: 800,
      response_format: { type: "json_object" }
    });

    const rawContent = response.choices[0].message.content;
    let parsed = JSON.parse(rawContent.trim());

    // Normalize user_correction options
    if (parsed.user_correction && Array.isArray(parsed.user_correction.options)) {
      const opts = parsed.user_correction.options.map(opt => {
        if (!opt) return opt;
        if (/explain more/i.test(opt)) return 'Explain more';
        if (/confused|^explain$/i.test(opt)) return 'Explain';
        if (/got it|gotit|ok|confirm/i.test(opt)) return 'Got it';
        return opt;
      });

      const hasGot = opts.some(o => /got it/i.test(o));
      const hasExplain = opts.some(o => /explain/i.test(o));
      if (!hasGot || !hasExplain) {
        const hasExplainMore = opts.some(o => /explain more/i.test(o));
        parsed.user_correction.options = hasExplainMore ? ['Got it', 'Explain more'] : ['Got it', 'Explain'];
      }

      if (!parsed.user_correction.message_type) {
        parsed.user_correction.message_type = 'user_correction';
      }

      // Ensure feedback object
      if (!parsed.user_correction.feedback) {
        parsed.user_correction.feedback = { is_correct: false, bubble_color: 'red', score_percent: 0 };
      }

      // Add emoji if missing
      if (!parsed.user_correction.emoji) {
        const isCorrect = parsed.user_correction.feedback?.is_correct;
        parsed.user_correction.emoji = isCorrect ? '😊' : '🤔';
      }
    }

    console.log('✅ Learn More response generated');
    return parsed;
  } catch (error) {
    console.error('Error generating Learn More response:', error);
    return {
      messages: [
        { message: "Let's keep practicing! 💪", message_type: "text" },
        { message: "Could you try answering that again?", message_type: "text" }
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
