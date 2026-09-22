const express = require('express');
const router = express.Router();
const prisma = require('../../lib/prisma');
const jwt = require('jsonwebtoken');
const { generateEnglishTopicChatResponse, generateEnglishTopicGreeting } = require('../../services/ai/english-topic-chat');
const { COURSE_CATALOG } = require('../../services/voice-to-voice/voice-session-prompts');

// Middleware to extract user from JWT token
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
      req.userId = decoded.userId || decoded.id || decoded.user_id;
    } catch {
      req.userId = null;
    }
  }
  next();
}

router.use(authMiddleware);

const MAX_TURNS = 10; // AI will wrap up after ~10 user turns

/**
 * Universal English Topic Resolver:
 * Supports:
 * 1. String slugs (e.g. "interview_prep_getting_ready", "everyday_english_saying_hello")
 * 2. Explicit trackKey & chapterKey (from query or body params)
 * 3. Numeric IDs (checking DB table english_topics)
 * 4. Graceful default fallback to ensure ZERO 404s for users
 */
async function resolveEnglishTopic({ topicId, trackKey, chapterKey }) {
  let track = trackKey || null;
  let chapter = chapterKey || null;
  const topicIdStr = topicId !== undefined && topicId !== null ? String(topicId).trim() : '';

  // Parse composite slug (e.g. "interview_prep_getting_ready")
  if ((!track || !chapter) && topicIdStr) {
    for (const catTrack of Object.keys(COURSE_CATALOG || {})) {
      if (topicIdStr === catTrack) {
        track = catTrack;
        chapter = Object.keys(COURSE_CATALOG[catTrack].chapters || {})[0];
        break;
      }
      if (topicIdStr.startsWith(catTrack + '_')) {
        track = catTrack;
        chapter = topicIdStr.slice(catTrack.length + 1);
        break;
      }
    }
  }

  // 1. Resolve from COURSE_CATALOG
  if (track && chapter && COURSE_CATALOG?.[track]?.chapters?.[chapter]) {
    const catalogTrack = COURSE_CATALOG[track];
    const catalogChapter = catalogTrack.chapters[chapter];

    const goals = (catalogChapter.prompts && catalogChapter.prompts.length > 0)
      ? catalogChapter.prompts.map((p, idx) => ({
          id: idx + 1,
          title: p,
          description: `Practice: ${p}`,
          order: idx + 1,
          is_completed: false
        }))
      : [
          { id: 1, title: 'Opening & Setting the Scene', description: 'Introduce the context clearly', order: 1, is_completed: false },
          { id: 2, title: 'Key Vocabulary & Expressions', description: 'Use topic-appropriate phrasing', order: 2, is_completed: false },
          { id: 3, title: 'Fluent Exchange & Closing', description: 'Maintain natural conversation flow', order: 3, is_completed: false }
        ];

    return {
      id: `${track}_${chapter}`,
      numericId: null,
      trackKey: track,
      chapterKey: chapter,
      title: catalogChapter.title,
      trackTitle: catalogTrack.name,
      description: `${catalogTrack.name} — ${catalogChapter.title}. Key targets: ${(catalogChapter.targetWords || []).slice(0, 4).join(', ')}`,
      goals,
      isDbEntity: false
    };
  }

  // 2. Check if topicId is a numeric ID from database (english_topics table)
  const numericTopicId = Number(topicIdStr);
  if (!isNaN(numericTopicId) && numericTopicId > 0) {
    try {
      const dbTopic = await prisma.english_topics.findUnique({
        where: { id: numericTopicId },
        include: {
          chapter: { include: { subject: true } },
          goals: { orderBy: { order: 'asc' } }
        }
      }).catch(() => null);

      if (dbTopic) {
        const goals = (dbTopic.goals || []).map(g => ({
          id: g.id,
          title: g.title,
          description: g.description,
          order: g.order,
          is_completed: false
        }));

        if (goals.length === 0) {
          goals.push(
            { id: 1, title: `${dbTopic.title} Opening`, description: 'Start the conversation', order: 1, is_completed: false },
            { id: 2, title: 'Expressing Ideas Clearly', description: 'Accurate vocabulary', order: 2, is_completed: false },
            { id: 3, title: 'Fluent Discussion', description: 'Natural dialogue', order: 3, is_completed: false }
          );
        }

        return {
          id: dbTopic.id,
          numericId: dbTopic.id,
          trackKey: null,
          chapterKey: null,
          title: dbTopic.title,
          trackTitle: dbTopic.chapter?.title || 'English Practice',
          description: dbTopic.description || `Practical conversation on ${dbTopic.title}`,
          goals,
          isDbEntity: true
        };
      }
    } catch (err) {
      console.warn('[EnglishChat] Database lookup failed for english_topics:', err.message);
    }
  }

  // 3. Fallback: match any chapter title by partial match from catalog
  if (topicIdStr) {
    for (const [tKey, tVal] of Object.entries(COURSE_CATALOG || {})) {
      for (const [cKey, cVal] of Object.entries(tVal.chapters || {})) {
        if (topicIdStr.toLowerCase().includes(cKey.toLowerCase()) || topicIdStr.toLowerCase().includes(cVal.title.toLowerCase())) {
          return resolveEnglishTopic({ trackKey: tKey, chapterKey: cKey });
        }
      }
    }
  }

  // 4. Guaranteed default topic fallback (Job Interview Prep -> Getting Ready)
  const fallbackTrack = COURSE_CATALOG?.interview_prep || Object.values(COURSE_CATALOG || {})[0];
  const fallbackChapter = fallbackTrack?.chapters?.getting_ready || Object.values(fallbackTrack?.chapters || {})[0];

  return {
    id: 'interview_prep_getting_ready',
    numericId: null,
    trackKey: 'interview_prep',
    chapterKey: 'getting_ready',
    title: fallbackChapter?.title || 'Getting Ready',
    trackTitle: fallbackTrack?.name || 'Practice for a Job Interview',
    description: 'Job Interview Practice — Getting Ready for your role and company',
    goals: [
      { id: 1, title: "Tell about the job and company you're applying for", order: 1, is_completed: false },
      { id: 2, title: "Say the company name and role clearly and confidently", order: 2, is_completed: false },
      { id: 3, title: "Express enthusiasm and ask a thoughtful question", order: 3, is_completed: false }
    ],
    isDbEntity: false
  };
}

/**
 * GET /api/english/chat/messages
 * Fetches messages, goals, and session progress for an English scenario topic
 */
router.get('/messages', async (req, res) => {
  const { topicId, track, trackKey, chapter, chapterKey } = req.query;
  const userId = req.userId || 1;

  try {
    // 1. Universal Topic Resolution
    const topic = await resolveEnglishTopic({
      topicId,
      trackKey: trackKey || track,
      chapterKey: chapterKey || chapter
    });

    // 2. Check completion status from user_english_progress (only if valid numeric DB entity)
    let isCompleted = false;
    let timeSpent = 0;

    if (topic.isDbEntity && topic.numericId) {
      const progress = await prisma.user_english_progress.findUnique({
        where: {
          user_id_topic_id: { user_id: userId, topic_id: topic.numericId }
        }
      }).catch(() => null);

      isCompleted = progress?.is_completed || false;
      timeSpent = progress?.time_spent_seconds || 0;
    }

    // 3. Fetch user profile defensively
    const userProfile = await prisma.users.findUnique({
      where: { user_id: userId }
    }).catch(() => null);

    // 4. Format goals
    const topicGoals = topic.goals.map((g, idx) => ({
      id: g.id || idx + 1,
      title: g.title,
      description: g.description || g.title,
      order: g.order || idx + 1,
      is_completed: false
    }));

    // 5. Fetch existing chat history for this English topic by title and user
    const learningTurns = await prisma.learning_turns.findMany({
      where: {
        user_id: userId,
        subject_name: 'English',
        topic_title: topic.title
      },
      orderBy: { created_at: 'asc' },
      take: 100
    }).catch(() => []);

    let messages = [];
    let userTurnCount = 0;

    if (learningTurns.length > 0) {
      for (const turn of learningTurns) {
        if (turn.question_text && !turn.user_answer_raw) {
          // Greeting or AI-only turn
          messages.push({
            id: `ai_${turn.id}`,
            sender: 'ai',
            message: turn.question_text,
            message_type: 'text',
            created_at: turn.created_at
          });
        } else if (turn.user_answer_raw) {
          userTurnCount++;

          // User turn
          messages.push({
            id: `user_${turn.id}`,
            sender: 'user',
            message: turn.user_answer_raw,
            message_type: turn.diff_html && turn.diff_html !== turn.user_answer_raw ? 'user_correction' : 'text',
            diff_html: turn.diff_html || null,
            feedback: turn.feedback_json || null,
            score_percent: turn.score_percent || null,
            created_at: turn.created_at
          });

          // AI response to user turn
          if (turn.question_text) {
            messages.push({
              id: `ai_resp_${turn.id}`,
              sender: 'ai',
              message: turn.question_text,
              message_type: 'text',
              created_at: turn.created_at
            });
          }
        }
      }
    }

    // 6. If no messages yet (fresh topic), generate AI greeting
    if (messages.length === 0 && !isCompleted) {
      const greeting = await generateEnglishTopicGreeting(
        topic.title,
        topic.description || "",
        topicGoals,
        userProfile
      );

      const initMsgs = greeting.messages && greeting.messages.length > 0 ? greeting.messages : [
        { message: `Let's start ${topic.title}! 📚`, message_type: "text" },
        { message: `Welcome to "${topic.title}"! How would you like to begin?`, message_type: "text" }
      ];

      for (const aiMsg of initMsgs) {
        let chatIdToUse = Date.now();

        // Safely record in admin_chat if DB is available
        try {
          const adminChat = await prisma.admin_chat.create({
            data: {
              user_id: userId,
              sender: 'ai',
              message: aiMsg.message,
              message_type: aiMsg.message_type || 'text'
            }
          }).catch(() => null);

          if (adminChat?.id) chatIdToUse = adminChat.id;

          // Save AI greeting learning_turn
          await prisma.learning_turns.create({
            data: {
              user_id: userId,
              chat_id: chatIdToUse,
              topic_id: topic.numericId, // Null for catalog slugs
              topic_title: topic.title,
              subject_name: 'English',
              question_text: aiMsg.message,
              user_name: userProfile?.name || 'Learner'
            }
          }).catch(() => null);
        } catch (dbErr) {
          console.warn('[EnglishChat] Non-blocking DB write skip for greeting:', dbErr.message);
        }

        messages.push({
          id: chatIdToUse,
          sender: 'ai',
          message: aiMsg.message,
          message_type: aiMsg.message_type || 'text',
          created_at: new Date()
        });
      }

      // Initial progress entry for DB-backed topics
      if (topic.isDbEntity && topic.numericId) {
        await prisma.user_english_progress.upsert({
          where: { user_id_topic_id: { user_id: userId, topic_id: topic.numericId } },
          create: {
            user_id: userId,
            topic_id: topic.numericId,
            is_completed: false,
            completion_percent: 0,
            time_spent_seconds: 0
          },
          update: {}
        }).catch(() => null);
      }
    }

    return res.json({
      topic: {
        id: topic.id,
        title: topic.title,
        description: topic.description,
        is_completed: isCompleted,
        time_spent_seconds: timeSpent
      },
      goals: topicGoals,
      messages: messages,
      turnNumber: userTurnCount,
      totalTurns: MAX_TURNS,
      session_ended: isCompleted
    });
  } catch (err) {
    console.error('Error fetching English chat messages:', err);
    return res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

/**
 * POST /api/english/chat/message
 * Handles user response turn: evaluates grammar/vocabulary and returns AI tutor response
 */
router.post('/message', async (req, res) => {
  const { topicId, trackKey, chapterKey, message: userMessage, session_time_seconds } = req.body;
  const userId = req.userId || 1;

  if (!userMessage || !userMessage.trim()) {
    return res.status(400).json({ error: 'Non-empty message is required' });
  }

  try {
    // 1. Universal Topic Resolution
    const topic = await resolveEnglishTopic({
      topicId,
      trackKey,
      chapterKey
    });

    const userProfile = await prisma.users.findUnique({
      where: { user_id: userId }
    }).catch(() => null);

    const topicGoals = topic.goals.map((g, idx) => ({
      id: g.id || idx + 1,
      title: g.title,
      description: g.description || g.title,
      is_completed: false
    }));

    // 2. Count existing user turns to determine turnNumber
    const existingUserTurns = await prisma.learning_turns.count({
      where: {
        user_id: userId,
        subject_name: 'English',
        topic_title: topic.title,
        user_answer_raw: { not: null }
      }
    }).catch(() => 0);

    const turnNumber = existingUserTurns + 1;

    // 3. Fetch recent chat history for context
    const recentTurns = await prisma.learning_turns.findMany({
      where: {
        user_id: userId,
        subject_name: 'English',
        topic_title: topic.title
      },
      orderBy: { created_at: 'asc' },
      take: 30
    }).catch(() => []);

    const chatHistory = [];
    for (const turn of recentTurns) {
      if (turn.question_text && !turn.user_answer_raw) {
        chatHistory.push({ sender: 'ai', message: turn.question_text });
      } else if (turn.user_answer_raw) {
        chatHistory.push({ sender: 'user', message: turn.user_answer_raw });
        if (turn.question_text) {
          chatHistory.push({ sender: 'ai', message: turn.question_text });
        }
      }
    }

    // 4. Call AI Tutor Engine (DeepSeek)
    const aiResponse = await generateEnglishTopicChatResponse({
      userMessage,
      topicTitle: topic.title,
      topicDescription: topic.description || "",
      chatHistory,
      topicGoals,
      turnNumber,
      totalTurns: MAX_TURNS,
      userId,
      topicId: topic.id,
      userProfile
    });

    const corr = aiResponse.user_correction || {};
    const feedback = corr.feedback || { is_correct: true, score_percent: 100, error_type: 'None', explanation: 'Good job!' };
    const firstAiMsg = aiResponse.messages?.[0]?.message || "That's great! Let's continue.";
    let sessionEnded = aiResponse.session_ended || (turnNumber >= MAX_TURNS);

    // 5. Safely persist user message + AI response in DB
    let chatIdToUse = Date.now();
    try {
      const userAdminChat = await prisma.admin_chat.create({
        data: {
          user_id: userId,
          sender: 'user',
          message: userMessage,
          message_type: 'text'
        }
      }).catch(() => null);

      if (userAdminChat?.id) chatIdToUse = userAdminChat.id;

      await prisma.learning_turns.create({
        data: {
          user_id: userId,
          chat_id: chatIdToUse,
          topic_id: topic.numericId, // Null for catalog slugs to prevent schema type crashes
          topic_title: topic.title,
          subject_name: 'English',
          question_text: firstAiMsg,
          user_answer_raw: userMessage,
          corrected_answer: corr.complete_answer || userMessage,
          diff_html: corr.diff_html || userMessage,
          feedback_text: feedback.explanation || '',
          feedback_json: feedback,
          error_type: feedback.error_type || 'None',
          is_correct: feedback.is_correct,
          score_percent: Number(feedback.score_percent) || 0,
          mastery_score: Number(feedback.score_percent) || 0,
          user_name: userProfile?.name || 'Learner'
        }
      }).catch(() => null);
    } catch (dbErr) {
      console.warn('[EnglishChat] Non-blocking DB write skip for turn:', dbErr.message);
    }

    // 6. Save AI responses to admin_chat and prepare return array
    const aiMessagesToReturn = [];
    if (aiResponse.messages && Array.isArray(aiResponse.messages)) {
      for (const aiMsg of aiResponse.messages) {
        let aiChatId = Date.now() + Math.random();
        try {
          const createdAiChat = await prisma.admin_chat.create({
            data: {
              user_id: userId,
              sender: 'ai',
              message: aiMsg.message,
              message_type: aiMsg.message_type || 'text'
            }
          }).catch(() => null);
          if (createdAiChat?.id) aiChatId = createdAiChat.id;
        } catch (_) {}

        aiMessagesToReturn.push({
          id: aiChatId,
          sender: 'ai',
          message: aiMsg.message,
          message_type: aiMsg.message_type || 'text',
          created_at: new Date()
        });
      }
    }

    // 7. Update progress if DB topic
    const completionPercent = Math.min(100, Math.round((turnNumber / MAX_TURNS) * 100));
    if (topic.isDbEntity && topic.numericId) {
      await prisma.user_english_progress.upsert({
        where: { user_id_topic_id: { user_id: userId, topic_id: topic.numericId } },
        create: {
          user_id: userId,
          topic_id: topic.numericId,
          is_completed: sessionEnded,
          completion_percent: sessionEnded ? 100 : completionPercent,
          time_spent_seconds: session_time_seconds || 0
        },
        update: {
          is_completed: sessionEnded ? true : undefined,
          completion_percent: sessionEnded ? 100 : completionPercent,
          time_spent_seconds: session_time_seconds || 0,
          last_practiced_at: new Date()
        }
      }).catch(() => null);
    }

    // 8. Goal completion matching (by ID or title substring)
    const completedGoalIds = aiResponse.goal_status?.completed_goal_ids || [];
    const completedGoalTitles = aiResponse.goal_status?.goals_completed || [];

    for (const goal of topicGoals) {
      if (completedGoalIds.includes(goal.id) || completedGoalIds.includes(goal.order)) {
        goal.is_completed = true;
      } else if (completedGoalTitles.some(t =>
        typeof t === 'string' && (
          goal.title.toLowerCase().includes(t.toLowerCase()) ||
          t.toLowerCase().includes(goal.title.toLowerCase())
        )
      )) {
        goal.is_completed = true;
      }
    }

    const allGoalsDone = topicGoals.every(g => g.is_completed);
    if (allGoalsDone) sessionEnded = true;

    return res.json({
      userMessage: {
        id: chatIdToUse,
        sender: 'user',
        message: userMessage
      },
      userCorrection: {
        diff_html: corr.diff_html || userMessage,
        complete_answer: corr.complete_answer || userMessage,
        emoji: corr.emoji || '😊',
        feedback: feedback
      },
      goals: topicGoals,
      all_goals_completed: allGoalsDone,
      session_ended: sessionEnded,
      turnNumber: turnNumber,
      totalTurns: MAX_TURNS,
      messages: aiMessagesToReturn,
      aiMessages: aiMessagesToReturn
    });
  } catch (err) {
    console.error('Error handling English chat message:', err);
    return res.status(500).json({ error: 'Failed to process message turn' });
  }
});

/**
 * POST /api/english/chat/general
 * Freeform English AI tutor powered by DeepSeek
 */
router.post('/general', async (req, res) => {
  const { message: userMessage } = req.body;
  const userId = req.userId || 1;

  if (!userMessage || !userMessage.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    const userProfile = await prisma.users.findUnique({
      where: { user_id: userId }
    }).catch(() => null);

    const systemPrompt = `You are Cloop AI, a friendly English Language Tutor.
Help ${userProfile?.name || 'the user'} improve English speaking, grammar, writing, and vocabulary.
- Answer clearly and concisely (2-3 sentences max).
- Offer polite corrections if the user makes a grammar error.
- Use markdown bullet points where helpful.`;

    const { invokeModel } = require('../../services/ai/deepseek-client');

    const aiResponseText = await invokeModel(
      systemPrompt,
      [{ role: 'user', content: userMessage }],
      {
        modelId: 'deepseek-chat',
        temperature: 0.7,
        userId,
        featureArea: 'general_english_tutor'
      }
    ).catch(() => "I'm here to help you practice English! Ask me anything about grammar, vocabulary, or conversation practice.");

    return res.json({
      userMessage: { sender: 'user', message: userMessage },
      aiMessage: { sender: 'ai', message: aiResponseText }
    });
  } catch (err) {
    console.error('Error in general English tutor chat:', err);
    return res.json({
      userMessage: { sender: 'user', message: userMessage },
      aiMessage: { sender: 'ai', message: "That's an interesting question! How else can I help you practice?" }
    });
  }
});

/**
 * POST /api/english/chat/translate
 * Translates an English tutor message into the learner's preferred language (e.g. Hindi, Spanish)
 */
router.post('/translate', async (req, res) => {
  const { text, targetLanguage = 'Hindi' } = req.body || {};

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Text to translate is required' });
  }

  try {
    const { invokeModel } = require('../../services/ai/deepseek-client');

    const prompt = `You are an expert translator. Translate the following English conversational tutor message into natural, warm, and accurate ${targetLanguage}.
Provide ONLY the direct translation in ${targetLanguage}.
Do NOT output any intro, explanations, pronunciation keys, or surrounding quotes.

English message:
${text}`;

    const translated = await invokeModel(
      prompt,
      [{ role: 'user', content: 'Translate now.' }],
      {
        modelId: 'deepseek-chat',
        temperature: 0.3,
        featureArea: 'chat_translation'
      }
    );

    const cleanTranslation = String(translated || '').trim().replace(/^["']|["']$/g, '');

    return res.json({
      translatedText: cleanTranslation,
      targetLanguage
    });
  } catch (err) {
    console.error('Translation error in /translate:', err);
    return res.status(500).json({ error: 'Translation failed' });
  }
});

module.exports = router;

