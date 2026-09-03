const { invokeModel, extractJson } = require('../ai/deepseek-client');
const { gradeAnswer } = require('./answer-grader');
const {
  buildSystemPrompt,
  analyzeChatHistory,
  normalizeUserCorrectionOptions,
  generateTopicGreeting,
  generateTopicGoals,
  determinePhase
} = require('./topic-chat-helpers');

/**
 * Coerce a single message item to a well-formed bubble object.
 */
function normalizeMessageItem(item) {
  if (typeof item === 'string') {
    return item.trim() ? { message: item.trim(), message_type: 'text' } : null;
  }
  if (!item || typeof item !== 'object') return null;
  const text = String(item.message ?? item.content ?? item.text ?? '').trim();
  if (!text) return null; // drop empty bubbles (the "empty..." artifacts)
  return {
    message: text,
    message_type: String(item.message_type ?? item.type ?? 'text'),
    options: item.options ?? [],
    emoji: item.emoji ?? null,
    diff_html: item.diff_html ?? null,
    images: item.images ?? [],
    videos: item.videos ?? [],
    links: item.links ?? []
  };
}

/**
 * Guarantee the parsed model response exposes a usable `messages[]` array. The model
 * occasionally emits a stray top-level object/array that has no `messages` key (e.g. a
 * mermaid value, an options-only object, or an evaluation-only blob). That previously
 * returned a response with no question bubble. This recovers a sensible message from
 * any recognizable text, drops empty bubbles, and throws if nothing usable exists so
 * the retry loop can try again.
 */
function normalizeParsedResponse(parsed, userMessage) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Parsed response is not a JSON object');
  }

  // 1. Normalize the messages array.
  if (!Array.isArray(parsed.messages)) {
    parsed.messages = [];
  }
  parsed.messages = parsed.messages
    .map(normalizeMessageItem)
    .filter(Boolean);

  // 2. Recover a message from scattered top-level content if still empty.
  if (parsed.messages.length === 0) {
    const candidates = [parsed.message, parsed.content, parsed.text, parsed.question];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) {
        const m = normalizeMessageItem(c);
        if (m) { parsed.messages = [m]; break; }
      }
    }
  }

  // 3. If we STILL have no message, the response is unusable — let the retry loop run.
  if (parsed.messages.length === 0) {
    throw new Error('No usable message content in parsed response');
  }

  // 4. Pass through structured blocks as-is (cleaned), drop an empty evaluation.
  if (parsed.evaluation && typeof parsed.evaluation === 'object' && Object.keys(parsed.evaluation).length === 0) {
    delete parsed.evaluation;
  }

  return parsed;
}

/**
 * True if the given text looks like a genuine forward question (used to decide
 * whether to trust a free-text fallback instead of the deterministic banker).
 */
function isForwardQuestion(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  if (t.length < 8) return false;
  // Must actually ask something.
  if (!/\?/.test(t)) return false;
  return true;
}

/**
 * Deterministic, phase-appropriate next question. Used only as a last-resort so the
 * tutor NEVER dead-ends: it always keeps the conversation moving (re-ask, probe the
 * same goal differently, or advance toward the next goal) instead of handing the
 * student a blank message.
 */
function buildFallbackQuestion({ phase, currentGoal, topicTitle, lastQuestion, goalIndex, goalTotal, topicGoals = [], hookPrediction }) {
  const goalTitle = currentGoal?.title?.trim() || null;
  const topic = topicTitle?.trim() || 'this topic';

  // Prefer echoing the last real question — a repeated question is still a question
  // and keeps the arc alive (the student knows exactly what to answer).
  if (lastQuestion && lastQuestion.trim() && /[?。？]/.test(lastQuestion)) {
    return `Let's keep going. ${lastQuestion.trim().replace(/\s+$/g, '')}`;
  }

  // Phase-appropriate fallbacks so we always ADVANCE, not just stall.
  switch (phase) {
    case 'HOOK':
      return `Before we dive in — think of ${topic} and make a quick prediction. What do you expect will happen in a simple everyday example? Give it your best guess.`;
    case 'REVEAL':
      return `Here's the core idea for ${topic}. Tell me in your own words what the most important thing about it is.`;
    case 'LOCK':
      return `Quick check — can you explain ${goalTitle || topic} in one line, like you're teaching a younger student?`;
    case 'WRAP':
      return `We're at the end of this topic. Can you recap in your own words what we learned and where you'd still like a quick recap?`;
    case 'EXPLORE':
    default:
      if (goalTitle) {
        return `Let's keep exploring ${goalTitle}. In your own words, what's the key idea here, and can you give one example?`;
      }
      return `Nice progress. What's one thing about ${topic} that you now understand better, and one thing you'd still like to clear up?`;
  }
}

/**
 * Topic Chat Service v2 — Teaching Arc
 * FRAME → HOOK → REVEAL → EXPLORE → LOCK → WRAP
 */

async function generateTopicChatResponse({
  userMessage,
  topicTitle,
  topicContent,
  chatHistory = [],
  currentGoal = null,
  topicGoals = [],
  userId = null,
  topicId = null,
  user = null
}) {
  let lastQuestion = "";
  // Hoisted to function scope so the outer catch (free-text fallback) can reuse them
  // regardless of the nesting of the inner try blocks. Previously `systemPrompt` /
  // `messages` were declared inside the inner try and were NOT visible in the catch,
  // causing "systemPrompt is not defined" which killed the fallback on JSON failures.
  let systemPrompt = null;
  let messages = [];
  try {
    const analysis = analyzeChatHistory(chatHistory);
    lastQuestion = analysis.lastQuestion;

    // Count completed goals
    const completedGoalsCount = topicGoals.filter(g => {
      const progress = g.chat_goal_progress?.[0];
      return progress?.is_completed || false;
    }).length;
    const allGoalsCompleted = completedGoalsCount === topicGoals.length;

    // Determine current phase
    const { phase, goalIndex, goalTotal } = determinePhase(chatHistory, topicGoals, currentGoal, userMessage);

    // Calculate turns since last teaching beat
    let turnsSinceTeaching = analysis.turnsSinceTeaching || 0;

    // Get hook prediction from analysis
    const hookPrediction = analysis.hookPrediction || null;

    // Build completed concepts list
    const completedConcepts = topicGoals
      .filter(g => g.chat_goal_progress?.[0]?.is_completed)
      .map(g => g.title);

    // Build user info
    const board = user?.board || 'General';
    const classLevel = user?.grade_level || '8';

    // Objective pre-grade: when the student just answered a question with a real attempt
    // (not a WRAP sentinel / session-opener), compute the ground-truth verdict ONCE here so
    // the tutor always agrees with it — it must never praise a wrong/confused answer.
    const isQuestionTurn = analysis.hasAskedQuestion
      && userMessage && userMessage.trim()
      && userMessage !== '__SESSION_COMPLETE__'
      && phase !== 'WRAP';
    let evaluationVerdict = null;
    let preGradeResult = null; // Reused to avoid a second grader call in the grounded block.
    if (isQuestionTurn && lastQuestion) {
      try {
        const graded = await gradeAnswer({
          answer: userMessage,
          question: lastQuestion,
          topicTitle,
          topicContent
        });
        if (graded) {
          preGradeResult = graded;
          evaluationVerdict = {
            is_correct: graded.is_correct,
            error_type: graded.error_type,
            score_percent: graded.score_percent,
            correctness: graded.correctness,
            completeness: graded.completeness,
            complete_answer: graded.complete_answer
          };
          console.log(`[topic_chat] ⚖️ Ground-truth verdict for tutor: ${graded.is_correct ? 'CORRECT' : 'INCORRECT'} (${graded.error_type}, ${graded.score_percent}%)`);
        }
      } catch (gradeErr) {
        console.warn('[topic_chat] Pre-grade failed (tutor will grade itself):', gradeErr.message);
      }
    }

    // Build system prompt
    systemPrompt = buildSystemPrompt({
      topicTitle,
      topicContent,
      topicGoals,
      currentGoal,
      questionsAsked: analysis.questionsAsked,
      allQuestions: analysis.allQuestions,
      lastQuestion,
      userMessage,
      phase,
      goalIndex,
      goalTotal,
      archetypesUsed: analysis.archetypesUsed,
      turnsSinceTeaching,
      hookPrediction,
      completedConcepts,
      board,
      classLevel,
      misconceptions: null,
      evaluationVerdict
    });

    // Build messages for API
    messages = [];
    const recentHistory = chatHistory.slice(-8);
    for (const msg of recentHistory) {
      messages.push({
        role: msg.sender === 'user' ? 'user' : 'assistant',
        content: msg.message || ''
      });
    }

    // WRAP sentinel: the route signals "all goals complete — generate the end-of-session
    // revision artefact". Pass the model an explicit directive (an empty string invites the
    // model to re-teach / ask another question). The model must emit revision_sheet + summary.
    const isWrapTurn = phase === 'WRAP' && (userMessage === '__SESSION_COMPLETE__' || userMessage === '');
    const userTurn = isWrapTurn
      ? 'SESSION COMPLETE. All learning goals are done. Emit the revision_sheet covering EVERY concept studied in this session, plus session_metrics with the overall score breakdown. Do NOT ask any further question — this is the final turn.'
      : userMessage;
    messages.push({ role: 'user', content: userTurn });

    // Log
    console.log('\n========== AI INPUT (v2 Teaching Arc) ==========');
    console.log(`  Phase: ${phase}`);
    console.log(`  Goal: ${goalIndex + 1}/${goalTotal} — ${currentGoal?.title || 'All done'}`);
    console.log(`  Questions: ${analysis.questionsAsked}`);
    console.log(`  Archetypes used: ${analysis.archetypesUsed.join(', ') || 'None'}`);
    console.log(`  Turns since teaching: ${turnsSinceTeaching}`);
    console.log(`  Hook prediction: ${hookPrediction || 'None'}`);
    console.log(`  User message: ${userMessage}`);
    console.log('================================================\n');

    // Call DeepSeek with retry
    let parsed = {};
    let attempts = 0;
    const maxAttempts = 3;
    let lastError = null;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        console.log(`[topic_chat] Attempt ${attempts}/${maxAttempts} — Phase: ${phase}`);

        const responseText = await invokeModel(systemPrompt, messages, {
          temperature: 0.7,
          maxTokens: 2048,
          jsonFormat: true,
          userId,
          featureArea: 'topic_chat',
          subFeature: 'tutor_turn',
          metadata: { topicId, topicTitle, phase }
        });

        if (!responseText) {
          throw new Error('Empty response from DeepSeek API');
        }

        console.log(`[topic_chat] Raw (first 500): ${responseText.substring(0, 500)}`);

        parsed = extractJson(responseText);

        if (!parsed) {
          throw new Error('Failed to extract valid JSON from response');
        }

        // Robustness: guarantee a usable messages[] before proceeding. The model sometimes
        // returns a stray top-level object/array (e.g. a mermaid value, an options-only
        // object, or an evaluation-only blob) that has NO messages key — that previously
        // silently produced a turn with no question. Validate and recover, else retry.
        try {
          parsed = normalizeParsedResponse(parsed, userMessage);
        } catch (normErr) {
          lastError = normErr;
          console.warn(`[topic_chat] Response had no usable messages (attempt ${attempts}): ${normErr.message}`);
          if (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          throw lastError;
        }

        // WRAP validation: the final turn MUST produce a revision_sheet. If the model
        // dropped the structured JSON (emitted rambling text) or forgot the block,
        // retry with an explicit instruction before giving up.
        if (phase === 'WRAP' && (!parsed.revision_sheet || typeof parsed.revision_sheet !== 'object')) {
          lastError = new Error('WRAP response missing revision_sheet');
          console.warn(`[topic_chat] WRAP response missing revision_sheet (attempt ${attempts}), retrying with directive`);
          if (attempts < maxAttempts) {
            // Reinforce the directive with the goal titles so the model knows what to cover.
            const goalTitles = topicGoals.map((g, i) => `${i + 1}. ${g.title || (g.chat_goal_progress?.[0] && g.title) || g.title}`).join('\n');
            messages.push({
              role: 'user',
              content: `You did not emit the revision_sheet. This session is COMPLETE. Return valid JSON with a "revision_sheet" block (concepts_covered, definitions[], key_points[], common_mistakes[], one_minute_recall[]) covering ALL goals studied:\n${goalTitles}\nNo questions.`
            });
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          throw lastError;
        }

        console.log(`[topic_chat] Parsed JSON on attempt ${attempts}`);
        break;

      } catch (err) {
        lastError = err;
        console.warn(`[topic_chat] Attempt ${attempts} failed: ${err.message}`);
        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          throw lastError;
        }
      }
    }

    // Normalize single message response
    if (parsed.message && !parsed.messages) {
      parsed.messages = [{
        message: parsed.message,
        message_type: parsed.message_type || 'text',
        options: parsed.options,
        emoji: parsed.emoji,
        diff_html: parsed.diff_html
      }];
    }

    // Normalize user_correction
    parsed = normalizeUserCorrectionOptions(parsed);

    // Grounded evaluation: if question was asked and there's no user_correction, grade it.
    // Also grade when a model user_correction exists but lacks diff_html (the source of the
    // strikethrough) so we still produce <del>/<ins> markup instead of a plain red bubble.
    // The objective verdict was already computed in the pre-grade step above, so we reuse it
    // here instead of calling the grader a second time (saves tokens + latency per turn).
    const hasDiffMarkup = !!(parsed.user_correction?.diff_html && /<del>|<ins>/.test(parsed.user_correction.diff_html));
    if (analysis.hasAskedQuestion && !hasDiffMarkup && userMessage && userMessage.trim() !== '' && phase !== 'WRAP') {
      try {
        let graded = preGradeResult;
        if (!graded) {
          console.log('[topic_chat] Grading answer with grounded answer grader (temp 0)');
          graded = await gradeAnswer({
            answer: userMessage,
            question: lastQuestion,
            topicTitle,
            topicContent
          });
        } else {
          console.log('[topic_chat] Reusing objective pre-grade verdict');
        }

        if (graded) {
          // No genuine attempt (e.g. "I don't know"): suppress ANY correction bubble —
          // no diff_html, no complete_answer, no emoji. The re-teach bubble does the
          // teaching. We must not leak the model's reasoning as a "Corrections" block.
          const noRealCorrection = !graded.diff_html && !graded.complete_answer;
          if (noRealCorrection) {
            parsed.user_correction = null;
          } else if (!parsed.user_correction) {
            // No model correction: build a full grounded correction
            parsed.user_correction = {
              message_type: 'user_correction',
              diff_html: graded.diff_html,
              complete_answer: graded.complete_answer,
              emoji: graded.is_correct ? '😊' : (graded.score_percent >= 50 ? '😅' : '😓'),
              feedback: {
                is_correct: graded.is_correct,
                bubble_color: graded.is_correct ? 'green' : 'red',
                error_type: graded.error_type,
                score_percent: graded.score_percent
              }
            };
            console.log('[topic_chat] Obtained grounded user_correction');
          } else {
            // Model gave a correction but no strikethrough markup: backfill diff_html only,
            // keep the model's complete_answer, feedback, and emoji.
            parsed.user_correction.diff_html = graded.diff_html || null;
            if (!parsed.user_correction.complete_answer) {
              parsed.user_correction.complete_answer = graded.complete_answer;
            }
            console.log('[topic_chat] Backfilled diff_html from grounded grader');
          }
          parsed = normalizeUserCorrectionOptions(parsed);
        }
      } catch (retryErr) {
        console.error('[topic_chat] Grounded grader failed:', retryErr.message);
      }
    }

    // Attach phase to evaluation for frontend
    if (parsed.evaluation) {
      parsed.evaluation.phase = phase;
    } else {
      parsed.evaluation = { phase };
    }

    console.log(`✓ Topic chat response | Phase: ${phase} | Topic: ${topicTitle}`);

    return parsed;
  } catch (error) {
    console.error('Error generating topic chat response:', error);
    // Graceful fallback: try ONE free-form call (no response_format) — DeepSeek sometimes
    // fails under strict JSON mode but succeeds with plain text.
    let fallbackText = null;
    try {
      console.log('[topic_chat] Retrying once in free-text mode after JSON failures');
      const freeText = await invokeModel(systemPrompt || '', messages || [], {
        temperature: 0.6,
        maxTokens: 2048,
        jsonFormat: false,
        userId,
        featureArea: 'topic_chat',
        subFeature: 'tutor_turn_fallback'
      });
      if (freeText && freeText.trim()) {
        fallbackText = freeText.trim();
      }
    } catch (fallbackErr) {
      console.error('[topic_chat] Free-text fallback also failed:', fallbackErr.message);
    }

    // The tutor is a proactive Socratic tutor: every non-WRAP turn MUST end with a
    // question so the student always knows what to answer — never a dead-ended,
    // empty, or garbage message. If the free-text fallback didn't produce a real
    // question, emit a deterministic, forward-moving question for the current phase.
    const isWrapTurn = phase === 'WRAP';
    let q = buildFallbackQuestion({
      phase, currentGoal, topicTitle, lastQuestion,
      goalIndex, goalTotal, topicGoals, hookPrediction
    });

    if (fallbackText && !isWrapTurn && isForwardQuestion(fallbackText)) {
      // Use the model's free-text only if it is a genuine question we can trust.
      q = fallbackText;
      const wrapper = { messages: [{ message: fallbackText, message_type: 'text' }] };
      const recovered = normalizeParsedResponse(wrapper, userMessage);
      if (recovered?.messages?.length) {
        console.log('[topic_chat] Free-text fallback produced a usable message');
        return recovered;
      }
    }

    // WRAP always needs the revision artefact (question prohibited). If the free-text
    // fallback produced nothing for WRAP, hand back a graceful re-ask instead of a blank.
    if (isWrapTurn && fallbackText && fallbackText.trim()) {
      const wrapper = { messages: [{ message: fallbackText, message_type: 'text' }] };
      const recovered = normalizeParsedResponse(wrapper, userMessage);
      if (recovered?.messages?.length) {
        console.log('[topic_chat] Free-text fallback produced the WRAP message');
        return recovered;
      }
    }

    // Assemble the deterministic fallback turn. It always carries a question (or, on
    // WRAP, the "let's wrap up" prompt) so the conversation never dead-ends.
    const fallbackTurn = isWrapTurn
      ? { messages: [{ message: "Great — that was the whole topic. Can you recap in your own words what we learned and where you'd still like a quick recap?", message_type: "text" }] }
      : { messages: [{ message: q, message_type: "text" }] };
    console.log(`[topic_chat] Using deterministic fallback question: ${q}`);
    return fallbackTurn;
  }
}

module.exports = {
  generateTopicChatResponse,
  generateTopicGreeting,
  generateTopicGoals,
};
