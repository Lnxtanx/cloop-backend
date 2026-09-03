const { invokeModel, extractJson } = require('../ai/deepseek-client');
const fs = require('fs');
const path = require('path');

/**
 * Topic Chat Helper Functions — v2 (Teaching Arc)
 * Phase detection, system prompt generation, greeting, goals
 */

const { calculateSessionMetrics, generateSessionSummaryMessage } = require('./topic_chat_metrics');

// ─── Archetype definitions ───────────────────────────────────────────
const ARCHETYPES = {
  Predict:          'Application',
  Contrast:         'Explanation',
  Representation:   'Representation',
  ErrorSpotting:    'Error Diagnosis',
  Transfer:         'Transfer',
  Numerical:        'Application',
  ExplainLikeIm5:   'Explanation',
  MisconceptionChk: 'Explanation',
  Recall:           'Identification'
};

// ─── Phase detection ─────────────────────────────────────────────────
/**
 * Determine the current teaching phase from chat history.
 * Called on every POST /:topicId/message to tell the AI where we are.
 */
function determinePhase(chatHistory, topicGoals, currentGoal, userMessage) {
  const goalIndex = topicGoals.findIndex(g => g.id === currentGoal?.id);
  const goalTotal = topicGoals.length;

  // Count AI messages and user messages for the current goal context
  const aiMessages = chatHistory.filter(m => m.sender === 'ai');
  const userMessages = chatHistory.filter(m => m.sender === 'user');

  // Check if all goals are completed
  const allCompleted = topicGoals.every(g => {
    const p = g.chat_goal_progress?.[0];
    return p?.is_completed;
  });
  if (allCompleted) {
    return { phase: 'WRAP', goalIndex, goalTotal };
  }

  if (!currentGoal) {
    return { phase: 'WRAP', goalIndex: goalTotal, goalTotal };
  }

  // Find the first AI message for this goal's context
  // We detect phase by looking at what has been sent so far
  const recentAiTypes = aiMessages.slice(-20).map(m => m.message_type || 'text');

  // Check for session_frame (FRAME phase marker)
  const hasFrame = recentAiTypes.includes('session_frame');

  // Count questions asked for this goal
  const questionsForGoal = chatHistory.filter(m =>
    m.sender === 'ai' && m.message && m.message.includes('?')
  ).length;

  // ── Per-goal scoping of the teaching markers ──────────────────────────────
  // exam_definition / concept_card cards are persisted once per GOAL but
  // deduped across the whole session, so a naive session-wide scan is wrong
  // (e.g. goal 1's definition makes `hasExamDef` true forever, which would skip
  // REVEAL for every later goal). Each completed goal consumes exactly one
  // concept_card, so the CURRENT goal has its own definition / concept card
  // only when the total count exceeds the number of already-completed goals.
  const defCount = aiMessages.filter(m => m.message_type === 'exam_definition').length;
  const cardCount = aiMessages.filter(m => m.message_type === 'concept_card').length;
  const completedGoals = topicGoals.filter(g => g.chat_goal_progress?.[0]?.is_completed).length;
  const hasExamDef = defCount > completedGoals;      // this goal's REVEAL delivered
  const hasConceptCard = cardCount > completedGoals; // this goal's LOCK delivered

  // Check for revision_sheet (WRAP happened)
  const hasRevisionSheet = aiMessages.some(m => m.message_type === 'revision_sheet');

  if (hasRevisionSheet) {
    return { phase: 'WRAP', goalIndex, goalTotal };
  }

  // Phase detection logic
  if (!hasFrame && !hasConceptCard && !hasExamDef) {
    // Only force FRAME at the true session/greeting start — i.e. before ANY
    // teaching content exists. Once REVEAL/EXPLORE content has been produced the
    // machine must be allowed to advance, even if the session_frame card is
    // missing (e.g. topics created before the greeting-card fix).
    return { phase: 'FRAME', goalIndex, goalTotal };
  }

  // HOOK vs REVEAL: if this goal hasn't had its definition yet, decide whether
  // we're waiting for the hook prediction (no student answer on current topic yet)
  // or resolving it into REVEAL (student just answered).
  const studentResponded = !!(userMessage && userMessage.trim() && userMessage !== '__SESSION_COMPLETE__');

  if (!hasExamDef) {
    if (hasConceptCard) {
      // Just finished a goal (concept card) and moved to the next → FRAME it.
      return { phase: 'FRAME', goalIndex, goalTotal };
    }
    if (hasFrame && studentResponded) {
      // The greeting/FRAME asked the hook question and the student answered →
      // resolve the hook now (REVEAL: teach definition + visual, then first EXPLORE q).
      return { phase: 'REVEAL', goalIndex, goalTotal };
    }
    if (hasFrame) {
      // Greeting/FRAME delivered but student hasn't answered the hook yet.
      return { phase: 'HOOK', goalIndex, goalTotal };
    }
    return { phase: 'FRAME', goalIndex, goalTotal };
  }

  if (!hasConceptCard) {
    // REVEAL done, concept card not yet → EXPLORE or LOCK.
    // ℹ️ PLAYLENGTH CONTROL: we cap each goal at ~2-3 practice questions so a whole
    // topic (4-5 goals) finishes in ~12-17 questions, not 20+. The HOOK prediction
    // answer happens BEFORE the exam_definition, so we only count user answers that
    // come AFTER the exam_definition — i.e. real EXPLORE practice, excluding HOOK.
    //   - After 2 EXPLORE answered, if ≥1 correct → LOCK (complete, frame next goal)
    //   - After 2 EXPLORE wrong                     → EXPLORE once (one re-teach q)
    //   - After 3 EXPLORE answered (hard cap)       → LOCK regardless
    let exploreAnswered = 0;
    let exploreCorrect = 0;
    let passedDef = false;
    for (const m of chatHistory) {
      const mType = m.message_type || m.type || (m.sender === 'ai' ? 'text' : '');
      if (mType === 'exam_definition' || (m.message && /exam?( definition|def)?/i.test(String(m.message)) && String(m.sender) === 'ai')) {
        passedDef = true;
        continue;
      }
      if (passedDef && String(m.sender) === 'user') {
        exploreAnswered++;
        const f = (m.feedback && m.feedback.is_correct) || (typeof m.is_correct === 'boolean' && m.is_correct);
        const score = (m.feedback && typeof m.feedback.score_percent === 'number') ? m.feedback.score_percent : (typeof m.score_percent === 'number' ? m.score_percent : 100);
        if (f === true && score >= 50) exploreCorrect++;
      }
    }
    const mastered = exploreCorrect >= 1;
    const readyToLock = (exploreAnswered >= 2 && mastered) || exploreAnswered >= 3;
    if (readyToLock) {
      return { phase: 'LOCK', goalIndex, goalTotal };
    }
    return { phase: 'EXPLORE', goalIndex, goalTotal };
  }

  if (hasConceptCard) {
    // Concept card emitted → next goal's FRAME or WRAP
    const nextGoal = topicGoals[goalIndex + 1];
    if (nextGoal) {
      const nextProgress = nextGoal.chat_goal_progress?.[0];
      if (!nextProgress || !nextProgress.is_completed) {
        return { phase: 'FRAME', goalIndex: goalIndex + 1, goalTotal };
      }
    }
    return { phase: 'WRAP', goalIndex, goalTotal };
  }

  // Default to EXPLORE
  return { phase: 'EXPLORE', goalIndex, goalTotal };
}

// ─── Build system prompt (v2) ────────────────────────────────────────
function buildSystemPrompt({
  topicTitle,
  topicContent,
  topicGoals,
  currentGoal,
  questionsAsked,
  allQuestions,
  lastQuestion,
  userMessage,
  phase,
  goalIndex,
  goalTotal,
  archetypesUsed,
  turnsSinceTeaching,
  hookPrediction,
  completedConcepts,
  board,
  classLevel,
  misconceptions,
  evaluationVerdict = null
}) {
  const promptPath = path.join(__dirname, 'prompts', 'system_prompt.txt');
  let promptTemplate = fs.readFileSync(promptPath, 'utf8');

  // Objective grading verdict (ground truth) for the current student answer, if available.
  const evaluationVerdictStr = evaluationVerdict
    ? `The student's answer to the last question was objectively ${evaluationVerdict.is_correct ? 'CORRECT' : 'INCORRECT'} (${evaluationVerdict.error_type || 'Unknown'}, score ${evaluationVerdict.score_percent}%).`
    : 'Not yet evaluated (no student answer to grade).';

  // Build learning goals progress string
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

  const allQuestionsStr = allQuestions.length > 0
    ? allQuestions.map((q, i) => `${i + 1}. "${q}"`).join('\n')
    : 'None yet';

  const archetypesUsedStr = archetypesUsed.length > 0
    ? archetypesUsed.join(', ')
    : 'None yet';

  const state = phase === 'WRAP'
    ? 'SESSION COMPLETE'
    : phase === 'EXPLORE' || phase === 'LOCK'
      ? 'Awaiting answer evaluation'
      : 'Delivering phase content';

  const activeGoal = currentGoal
    ? `"${currentGoal.title}"`
    : 'All goals done';

  // Replace all placeholders
  let prompt = promptTemplate
    .replace(/\{\{topicTitle\}\}/g, topicTitle || '')
    .replace(/\{\{phase\}\}/g, phase || 'EXPLORE')
    .replace(/\{\{state\}\}/g, state)
    .replace(/\{\{activeGoal\}\}/g, activeGoal)
    .replace(/\{\{goalIndex\}\}/g, String((goalIndex || 0) + 1))
    .replace(/\{\{goalTotal\}\}/g, String(goalTotal || topicGoals.length))
    .replace(/\{\{questionsAsked\}\}/g, String(questionsAsked || 0))
    .replace(/\{\{archetypesUsed\}\}/g, archetypesUsedStr)
    .replace(/\{\{turnsSinceTeaching\}\}/g, String(turnsSinceTeaching || 0))
    .replace(/\{\{hookPrediction\}\}/g, hookPrediction || 'None yet')
    .replace(/\{\{completedConcepts\}\}/g, completedConcepts.length > 0 ? completedConcepts.join(', ') : 'None yet')
    .replace(/\{\{userMessage\}\}/g, userMessage || '')
    .replace(/\{\{lastQuestion\}\}/g, lastQuestion || 'None yet')
    .replace(/\{\{board\}\}/g, board || 'General')
    .replace(/\{\{classLevel\}\}/g, classLevel || '8')
    .replace(/\{\{misconceptions\}\}/g, misconceptions || 'None known')
    .replace(/\{\{evaluationVerdict\}\}/g, evaluationVerdictStr)
    .replace(/\{\{learningGoals\}\}/g, learningGoals)
    .replace(/\{\{allQuestions\}\}/g, allQuestionsStr);

  prompt += '\n\nIMPORTANT: ALWAYS respond with a single valid JSON object. Do NOT include any markdown formatting, preamble, or commentary outside the JSON.';

  return prompt;
}

// ─── Analyze chat history ────────────────────────────────────────────
function analyzeChatHistory(chatHistory) {
  const aiMessages = chatHistory.filter(m => m.sender === 'ai' && (m.message_type === 'text' || !m.message_type));
  const userResponses = chatHistory.filter(m => m.sender === 'user' && m.message_type !== 'user_correction');

  const allQuestions = aiMessages
    .filter(m => isAIQuestion(m.message))
    .map(m => m.message);

  const questionsAsked = allQuestions.length;
  const lastAIMessage = aiMessages.length > 0 ? aiMessages[aiMessages.length - 1] : null;
  const lastQuestion = allQuestions.length > 0 ? allQuestions[allQuestions.length - 1] : null;
  const hasAskedQuestion = lastAIMessage && isAIQuestion(lastAIMessage.message);

  // Detect archetypes used from AI messages (look for evaluation blocks in message_type or patterns)
  const archetypesUsed = [];
  const recentAiTexts = aiMessages.slice(-15).map(m => m.message || '');

  // Simple heuristic: detect archetype patterns in recent questions
  for (const text of recentAiTexts) {
    const lower = text.toLowerCase();
    if (lower.includes('which one') || lower.includes('which is') || lower.includes('compare')) {
      archetypesUsed.push('Contrast');
    } else if (lower.includes('increase or decrease') || lower.includes('more or less') || lower.includes('will it')) {
      archetypesUsed.push('Predict');
    } else if (lower.includes('diagram') || lower.includes('figure') || lower.includes('sketch') || lower.includes('look at')) {
      archetypesUsed.push('Representation');
    } else if (lower.includes('mistake') || lower.includes('wrong') || lower.includes('catch me') || lower.includes('find the error')) {
      archetypesUsed.push('ErrorSpotting');
    } else if (lower.includes('new situation') || lower.includes('what if') || lower.includes('apply') || lower.includes('ball bearing') || lower.includes('real life')) {
      archetypesUsed.push('Transfer');
    } else if (lower.includes('calculate') || lower.includes('compute') || lower.includes('solve')) {
      archetypesUsed.push('Numerical');
    } else if (lower.includes('explain') || lower.includes('in your own words') || lower.includes('younger student') || lower.includes('class 5')) {
      archetypesUsed.push('ExplainLikeIm5');
    } else if (lower.includes('is it true') || lower.includes('some people say') || lower.includes('catch me out')) {
      archetypesUsed.push('MisconceptionChk');
    } else if (lower.includes('define') || lower.includes('state') || lower.includes('name') || lower.includes('list')) {
      archetypesUsed.push('Recall');
    }
  }

  // Count turns since last teaching beat (consolidation bubble)
  let turnsSinceTeaching = 0;
  for (let i = aiMessages.length - 1; i >= 0; i--) {
    const msg = aiMessages[i];
    const text = (msg.message || '').toLowerCase();
    // Teaching beat indicators
    if (text.includes('so the rule is') || text.includes('remember this') ||
        text.includes('key point') || text.includes('write this down') ||
        text.includes('the trick') || text.includes('here\'s the key')) {
      break;
    }
    turnsSinceTeaching++;
  }

  // Detect hook prediction from chat history
  let hookPrediction = null;
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    const msg = chatHistory[i];
    if (msg.sender === 'ai' && msg.message && msg.message.toLowerCase().includes('hold that thought')) {
      // The next user message is the prediction
      const nextUser = chatHistory.slice(i + 1).find(m => m.sender === 'user');
      if (nextUser) {
        hookPrediction = nextUser.message;
      }
      break;
    }
  }

  return {
    aiMessages,
    userResponses,
    allQuestions,
    questionsAsked,
    lastAIMessage,
    lastQuestion,
    hasAskedQuestion: !!hasAskedQuestion,
    archetypesUsed: [...new Set(archetypesUsed)], // deduplicate
    turnsSinceTeaching,
    hookPrediction
  };
}

// ─── Detect if AI message is a question ──────────────────────────────
function isAIQuestion(message) {
  if (!message || typeof message !== 'string') return false;
  if (message.includes('?')) return true;
  return /^(define|state|name|list|write|give|mention|identify|explain|describe|fill in|calculate|compare)\b/i.test(message.trim());
}

// ─── Normalize user_correction options ───────────────────────────────
function normalizeUserCorrectionOptions(parsed) {
  if (parsed.user_correction) {
    if (parsed.user_correction.options) {
      delete parsed.user_correction.options;
    }

    if (!parsed.user_correction.message_type) {
      parsed.user_correction.message_type = 'user_correction';
    }

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

// ─── Generate greeting (FRAME + HOOK) ───────────────────────────────
async function generateTopicGreeting(topicTitle, topicContent, topicGoals = [], user = null) {
  try {
    const goalsOverview = topicGoals.length > 0
      ? topicGoals.map((g, i) => `${i + 1}. ${g.title}`).join('\n')
      : 'We\'ll explore this topic together';

    const topicSummary = topicContent ? topicContent.substring(0, 300) + '...' : 'General introduction';

    const board = user?.board || 'General';
    const classLevel = user?.grade_level || '8';

    const systemPrompt = `You are Cloop — a mastery-driven AI tutor starting a session on "${topicTitle}".

This is a FRAME + HOOK turn. You must do TWO things in order:

PART 1 — FRAME (2 concise bubbles):
1. The concept in plain words + why it matters / where students meet it in real life, combined in ONE bubble (2 short sentences).
2. "By the end you'll be able to: (a)..., (b)..., (c)..." (3 objectives based on the goals below) in ONE bubble.

DO NOT give the definition here. Name the destination, not the answer.

PART 2 — HOOK (1 question after the FRAME):
Ask ONE everyday scenario question. The student must COMMIT to a prediction.
End with: "Hold that thought — we'll come back to it."

GOALS TO COVER:
${goalsOverview}

TOPIC CONTENT:
${topicSummary}

BOARD/CLASS: ${board} Class ${classLevel}

Return VALID JSON:
{
  "messages": [
    { "message": "[FRAME bubble 1: concept in plain words + why it matters]", "message_type": "text" },
    { "message": "[FRAME bubble 2: by the end you'll be able to...]", "message_type": "text" },
    { "message": "[HOOK question + Hold that thought]", "message_type": "text" }
  ],
  "session_frame": {
    "concept": "${topicTitle}",
    "why_it_matters": "[1 sentence]",
    "objectives": ["(a)...", "(b)...", "(c)..."]
  },
  "hook_prediction": {
    "scenario": "[the scenario described in the hook question]",
    "student_prediction": null,
    "resolve_in_reveal": true
  }
}`;

    const responseText = await invokeModel(systemPrompt, [
      { role: 'user', content: `Generate FRAME + HOOK for: ${topicTitle}` }
    ], { temperature: 0.7, maxTokens: 1024, jsonFormat: true });

    const parsed = extractJson(responseText);

    if (!parsed || !parsed.messages || parsed.messages.length < 3) {
      throw new Error('Failed to extract valid JSON greeting');
    }

    return parsed;
  } catch (error) {
    console.error('Error generating greeting:', error);
    return {
      messages: [
        { message: `Let's start learning about ${topicTitle}: it's how living things are connected and why it matters.`, message_type: "text" },
        { message: `By the end, you'll be able to understand the key ideas and apply them.`, message_type: "text" },
        { message: `Quick question first — what do you already know about ${topicTitle}?`, message_type: "text" }
      ]
    };
  }
}

// ─── Generate topic goals ────────────────────────────────────────────
async function generateTopicGoals(topicTitle, topicContent) {
  const topicSummary = topicContent && topicContent.length > 150
    ? topicContent.substring(0, 150) + '...'
    : topicContent || 'General introduction to the topic';

  try {
    const promptPath = path.join(__dirname, 'prompts', 'goals_prompt.txt');
    let promptTemplate = fs.readFileSync(promptPath, 'utf8');

    const systemPrompt = promptTemplate.replace(/\{\{topicTitle\}\}/g, topicTitle);

    const responseText = await invokeModel(systemPrompt, [
      { role: 'user', content: `Topic: ${topicTitle}\nContent Summary: ${topicSummary}` }
    ]);
    const parsed = extractJson(responseText);

    if (!parsed || !parsed.goals || parsed.goals.length < 2) {
      throw new Error('Invalid or insufficient goals generated');
    }

    return parsed;
  } catch (error) {
    console.error('Error generating goals for', topicTitle, ':', error.message);
    return {
      goals: [
        { title: `Understand what ${topicTitle} is`, description: `Define and explain the core concept of ${topicTitle}`, order: 1 },
        { title: `Apply ${topicTitle} to real scenarios`, description: `Use understanding of ${topicTitle} to solve practical examples`, order: 2 },
        { title: `Analyze and evaluate ${topicTitle}`, description: `Critique and connect ${topicTitle} to related ideas`, order: 3 }
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
  determinePhase,
  calculateSessionMetrics,
  generateSessionSummaryMessage,
  ARCHETYPES
};
