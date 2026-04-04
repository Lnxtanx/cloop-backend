const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const openai = new OpenAI({
  apiKey: process.env.API_KEY_OPENAI,
  timeout: parseInt(process.env.OPENAI_TIMEOUT_MS || '30000', 10),
});

/**
 * Topic Chat Helper Functions
 * Contains system prompt generation, greeting generation, and goal generation
 */

// Import metrics helper for session completion
const { calculateSessionMetrics, generateSessionSummaryMessage } = require('./topic_chat_metrics');

/**
 * Build the comprehensive system prompt for the AI tutor
 */
function buildSystemPrompt(topicTitle, topicContent, topicGoals, currentGoal, completedGoalsCount, totalQuestionsTarget, questionsAsked, userResponses, allQuestions, lastQuestion, hasAskedQuestion, shouldEndSession, isFirstMessage, userMessage, lastAIMessage, sessionMetrics = null) {
  // 🔥 ABSOLUTE FORCE: When all goals are completed, IMMEDIATELY show session summary
  if (shouldEndSession) {
    // Ensure we have at least empty metrics if none provided to prevent crash
    const safeMetrics = sessionMetrics || {
      total_questions: 0,
      correct_answers: 0,
      incorrect_answers: 0,
      overall_score_percent: 0,
      star_rating: 0,
      performance_level: 'Completed'
    };

    const formattedSummary = sessionMetrics
      ? generateSessionSummaryMessage(topicTitle, sessionMetrics)
      : `You have completed all goals for ${topicTitle}! Great job!`;

    return `🎉 ALL ${topicGoals.length} LEARNING GOALS COMPLETED! 🎉

Return ONLY a session_summary message.

JSON FORMAT:
{
  "messages": [
    {
      "message": "session_complete",
      "message_type": "session_summary",
      "session_metrics": ${JSON.stringify(safeMetrics)},
      "formatted_summary": "${formattedSummary}"
    }
  ]
}

- Do NOT evaluate the last answer
- Do NOT ask more questions
- Valid JSON only`;
  }

  // Read the prompt template
  const promptPath = path.join(__dirname, 'prompts', 'system_prompt.txt');
  let promptTemplate = fs.readFileSync(promptPath, 'utf8');

  // Prepare variables for replacement
  const state = shouldEndSession ? 'SESSION COMPLETE' : hasAskedQuestion ? 'Awaiting answer evaluation' : 'Ask the next question';
  const topicGoalsLength = topicGoals.length;
  const allQuestionsStr = allQuestions.length > 0 ? allQuestions.map((q, i) => `${i + 1}. "${q}"`).join('\n') : 'None yet';
  const learningGoals = topicGoals.map((g, i) => {
    const progress = g.chat_goal_progress?.[0];
    const isCompleted = progress?.is_completed || false;
    const accuracy = progress && progress.num_questions > 0
      ? Math.round((progress.num_correct / progress.num_questions) * 100)
      : 0;
    const status = isCompleted
      ? '✅ COMPLETED'
      : progress
        ? `⏳ IN PROGRESS (${accuracy}% accuracy, ${progress.num_questions} questions)`
        : '⭕ NOT STARTED';
    return `${i + 1}. ${g.title} [${status}]`;
  }).join('\n');
  // Detect current phase using allQuestions (array of question strings available in scope)
  const examKeywords = /^(define|state|name|what is|which of|fill in|write the formula|list)/i;
  const conceptKeywords = /if |why|how is|what would|when|which friction|does.*more|does.*less/i;
  let detectedPhase = 'CONCEPT_UNDERSTANDING';
  if (allQuestions.length >= 2) {
    const lastFew = allQuestions.slice(-3);
    const examCount = lastFew.filter(q => examKeywords.test(q.trim())).length;
    const conceptCount = lastFew.filter(q => conceptKeywords.test(q.trim())).length;
    if (examCount > conceptCount) detectedPhase = 'EXAM_READINESS';
  }
  const numQuestionsForCurrentGoal = currentGoal?.chat_goal_progress?.[0]?.num_questions || 0;
  const shouldForcePredictScore = numQuestionsForCurrentGoal >= 5;
  const activeGoal = currentGoal
    ? `"${currentGoal.title}" | Phase: ${detectedPhase} | Questions answered for this goal: ${numQuestionsForCurrentGoal}${shouldForcePredictScore ? ' ← MANDATORY: student has answered enough — you MUST return next_step_type="predict_score" NOW' : ''}`
    : 'All goals done';

  // Replace placeholders
  const prompt = promptTemplate
    .replace(/\{\{topicTitle\}\}/g, topicTitle)
    .replace(/\{\{state\}\}/g, state)
    .replace(/\{\{questionsAsked\}\}/g, questionsAsked)
    .replace(/\{\{totalQuestionsTarget\}\}/g, totalQuestionsTarget)
    .replace(/\{\{userMessage\}\}/g, userMessage)
    .replace(/\{\{lastQuestion\}\}/g, lastQuestion || 'None yet')
    .replace(/\{\{topicGoalsLength\}\}/g, topicGoalsLength)
    .replace(/\{\{allQuestions\}\}/g, allQuestionsStr)
    .replace(/\{\{learningGoals\}\}/g, learningGoals)
    .replace(/\{\{activeGoal\}\}/g, activeGoal);

  return prompt;
}

/**
 * Detect whether an AI message is a question/prompt the student should answer.
 * Covers both '?' questions and imperative exam forms like "Define X." / "Name two X."
 */
function isAIQuestion(message) {
  if (!message || typeof message !== 'string') return false;
  if (message.includes('?')) return true;
  // Imperative exam prompts that don't use '?'
  return /^(define|state|name|list|write|give|mention|identify|explain|describe|fill in|calculate|compare)\b/i.test(message.trim());
}

/**
 * Analyze chat history to extract questions and determine session state
 */
function analyzeChatHistory(chatHistory) {
  const aiMessages = chatHistory.filter(m => m.sender === 'ai' && m.message_type === 'text');
  const userResponses = chatHistory.filter(m => m.sender === 'user' && m.message_type !== 'user_correction');

  // Extract questions — includes '?' questions AND imperative forms ("Define X.", "Name two X.")
  const allQuestions = aiMessages
    .filter(m => isAIQuestion(m.message))
    .map(m => m.message);

  const questionsAsked = allQuestions.length;
  const lastAIMessage = aiMessages.length > 0 ? aiMessages[aiMessages.length - 1] : null;
  const lastQuestion = allQuestions.length > 0 ? allQuestions[allQuestions.length - 1] : null;

  // Check if the last AI message was a question (user should be responding to it)
  const hasAskedQuestion = lastAIMessage && isAIQuestion(lastAIMessage.message);

  return {
    aiMessages,
    userResponses,
    allQuestions,
    questionsAsked,
    lastAIMessage,
    lastQuestion,
    hasAskedQuestion: !!hasAskedQuestion
  };
}

/**
 * Normalize and validate user_correction options
 */
function normalizeUserCorrectionOptions(parsed) {
  if (parsed.user_correction) {
    // Remove quick-reply options entirely (free-text flow now)
    if (parsed.user_correction.options) {
      delete parsed.user_correction.options;
    }

    // Ensure message_type is set
    if (!parsed.user_correction.message_type) {
      parsed.user_correction.message_type = 'user_correction';
    }

    // Ensure feedback object exists and has minimal expected fields
    if (!parsed.user_correction.feedback || typeof parsed.user_correction.feedback !== 'object') {
      parsed.user_correction.feedback = { is_correct: false, bubble_color: 'red', score_percent: 10 };
    } else {
      parsed.user_correction.feedback.is_correct = !!parsed.user_correction.feedback.is_correct;
      parsed.user_correction.feedback.bubble_color = parsed.user_correction.feedback.bubble_color || (parsed.user_correction.feedback.is_correct ? 'green' : 'red');
      if (typeof parsed.user_correction.feedback.score_percent === 'number') {
        if (parsed.user_correction.feedback.score_percent === 0 && !parsed.user_correction.feedback.is_correct) {
          parsed.user_correction.feedback.score_percent = 10;
        }
      } else {
        parsed.user_correction.feedback.score_percent = parsed.user_correction.feedback.is_correct ? 100 : 10;
      }
      if (!parsed.user_correction.feedback.error_type && parsed.user_correction.feedback.is_correct === false) {
        parsed.user_correction.feedback.error_type = 'Conceptual';
      }
    }

    // 😊 EMOJI ASSIGNMENT: Add appropriate emoji based on feedback
    if (!parsed.user_correction.emoji) {
      const isCorrect = parsed.user_correction.feedback?.is_correct;
      const scorePercent = parsed.user_correction.feedback?.score_percent || 0;
      const errorType = parsed.user_correction.feedback?.error_type;

      if (isCorrect) {
        parsed.user_correction.emoji = '😊';
      } else if (scorePercent <= 10) {
        parsed.user_correction.emoji = '😓';
      } else if (scorePercent < 50) {
        parsed.user_correction.emoji = '😢';
      } else if (errorType === 'Spelling' || errorType === 'Grammar') {
        parsed.user_correction.emoji = '😅';
      } else {
        parsed.user_correction.emoji = '😔';
      }
    }
  }

  return parsed;
}

/**
 * Generate initial greeting and introduce the questioning session
 * Sets expectations for micro-assessment approach
 */
async function generateTopicGreeting(topicTitle, topicContent, topicGoals = []) {
  try {
    console.log('\n========== GREETING GENERATION START ==========');
    console.log('📚 Topic:', topicTitle);
    console.log('🎯 Goals count:', topicGoals.length);

    const goalsOverview = topicGoals.length > 0
      ? topicGoals.map((g, i) => `${i + 1}. ${g.title}`).join('\n')
      : 'We\'ll test your knowledge through questions';

    console.log('\n📋 Goals Overview:');
    console.log(goalsOverview);
    console.log('\n💬 Sending greeting request to AI...');

    // Read the prompt template
    const promptPath = path.join(__dirname, 'prompts', 'greeting_prompt.txt');
    let promptTemplate = fs.readFileSync(promptPath, 'utf8');

    // Prepare variables
    const topicSummary = topicContent ? topicContent.substring(0, 200) + '...' : 'General introduction';

    // Replace placeholders
    const systemPrompt = promptTemplate
      .replace(/\{\{topicTitle\}\}/g, topicTitle)
      .replace(/\{\{goalsOverview\}\}/g, goalsOverview)
      .replace(/\{\{topicSummary\}\}/g, topicSummary);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: `Generate greeting for: ${topicTitle}`
        }
      ],
      temperature: 0.8,
      max_tokens: 400,
      response_format: { type: "json_object" }
    });

    const content = response.choices[0].message.content.trim();
    const parsed = JSON.parse(content);

    console.log('\n✅ Greeting Generated Successfully!');
    console.log('\n🎉 Greeting Messages:');
    if (parsed.messages) {
      parsed.messages.forEach((msg, i) => {
        console.log(`  ${i + 1}. [${msg.message_type}]: ${msg.message}`);
      });
    }
    console.log('\n🔢 Token Usage:');
    console.log('  - Input tokens:', response.usage.prompt_tokens);
    console.log('  - Output tokens:', response.usage.completion_tokens);
    console.log('  - Total tokens:', response.usage.total_tokens);
    console.log('===============================================\n');

    return parsed;
  } catch (error) {
    console.error('Error generating greeting:', error);
    // Fallback greeting
    return {
      messages: [
        { message: `Let's start this topic of ${topicTitle}.`, message_type: "text" }
      ]
    };
  }
}

/**
 * Generate topic goals for learning progression
 * Creates measurable, sequential learning objectives
 */
async function generateTopicGoals(topicTitle, topicContent) {
  // Truncate topic content to essential info for token efficiency
  const topicSummary = topicContent && topicContent.length > 150
    ? topicContent.substring(0, 150) + '...'
    : topicContent || 'General introduction to the topic';

  try {
    // Read the prompt template
    const promptPath = path.join(__dirname, 'prompts', 'goals_prompt.txt');
    let promptTemplate = fs.readFileSync(promptPath, 'utf8');

    // Replace placeholders
    const systemPrompt = promptTemplate.replace(/\{\{topicTitle\}\}/g, topicTitle);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: `Topic: ${topicTitle}\nContent Summary: ${topicSummary}`
        }
      ],
      temperature: 0.8,
      max_tokens: 600,
      response_format: { type: "json_object" }
    });

    const content = response.choices[0].message.content.trim();
    const parsed = JSON.parse(content);

    // Validate and ensure we have at least 3 goals
    if (!parsed.goals || parsed.goals.length < 3) {
      throw new Error('Generated less than 3 goals');
    }

    console.log(`✓ Topic goals generated | Topic: ${topicTitle} | Goals: ${parsed.goals.length}`);

    return parsed;
  } catch (error) {
    console.error('Error generating goals for', topicTitle, ':', error.message);
    // Fallback goals
    return {
      goals: [
        { title: "Analyze the core concept", description: `Examine what ${topicTitle} means in different contexts`, order: 1 },
        { title: "Evaluate key characteristics", description: "Assess and critique important properties and their impact", order: 2 },
        { title: "Apply knowledge to scenarios", description: "Use understanding to solve practical, real-world examples", order: 3 },
        { title: "Connect and critique concepts", description: "Critique how this topic connects to related ideas", order: 4 }
      ]
    };
  }
}

module.exports = {
  buildSystemPrompt,
  analyzeChatHistory,
  normalizeUserCorrectionOptions,
  generateTopicGreeting,
  generateTopicGoals,
  openai,
  calculateSessionMetrics,
  generateSessionSummaryMessage
};
