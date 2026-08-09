const express = require('express');
const router = express.Router();
const prisma = require('../../lib/prisma');
const jwt = require('jsonwebtoken');
const { generateEnglishTopicChatResponse, generateEnglishTopicGreeting } = require('../../services/ai/english-topic-chat');

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
 * GET /api/english/chat/messages
 * Fetches messages, goals, and session progress for an English scenario topic
 */
router.get('/messages', async (req, res) => {
  const { topicId } = req.query;
  const userId = req.userId || 1;

  if (!topicId) {
    return res.status(400).json({ error: 'topicId query parameter is required' });
  }

  try {
    const numericTopicId = Number(topicId);

    // 1. Fetch topic from english_topics
    let topic = null;
    if (!isNaN(numericTopicId)) {
      topic = await prisma.english_topics.findUnique({
        where: { id: numericTopicId },
        include: {
          chapter: { include: { subject: true } },
          goals: { orderBy: { order: 'asc' } }
        }
      }).catch(() => null);
    }

    if (!topic) {
      return res.status(404).json({ error: 'English topic not found' });
    }

    // 2. Check completion status from user_english_progress
    const progress = await prisma.user_english_progress.findUnique({
      where: {
        user_id_topic_id: { user_id: userId, topic_id: numericTopicId }
      }
    }).catch(() => null);

    const isCompleted = progress?.is_completed || false;
    const timeSpent = progress?.time_spent_seconds || 0;

    // 3. Fetch user profile
    const userProfile = await prisma.users.findUnique({
      where: { user_id: userId }
    }).catch(() => null);

    // 4. Format goals from DB
    const topicGoals = (topic.goals || []).map(g => ({
      id: g.id,
      title: g.title,
      description: g.description,
      order: g.order,
      is_completed: false // Will be updated based on chat analysis
    }));

    // Fallback dynamic goals if DB has none
    if (topicGoals.length === 0) {
      topicGoals.push(
        { id: 1, title: `Scenario Context & Professional Opening`, description: `Open the conversation for ${topic.title}`, order: 1, is_completed: false },
        { id: 2, title: `Target Vocabulary & Key Expressions`, description: `Use relevant topic phrasing`, order: 2, is_completed: false },
        { id: 3, title: `Fluent Exchange & Closing`, description: `Maintain natural flow`, order: 3, is_completed: false }
      );
    }

    // 5. Fetch existing chat history STRICTLY for this English topic
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
      // Reconstruct message timeline properly
      for (const turn of learningTurns) {
        // AI message (question_text) — only add if it has content and no user_answer_raw
        // OR if it's a greeting (no user answer in same row)
        if (turn.question_text && !turn.user_answer_raw) {
          // Pure AI message row (greeting or AI-only turn)
          messages.push({
            id: `ai_${turn.id}`,
            sender: 'ai',
            message: turn.question_text,
            message_type: 'text',
            created_at: turn.created_at
          });
        } else if (turn.user_answer_raw) {
          // User turn row — contains user answer and potentially the AI follow-up
          userTurnCount++;

          // Add user message
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

          // Add AI follow-up response (stored in question_text of the same row)
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
        // Create admin_chat to get valid chat_id
        const adminChat = await prisma.admin_chat.create({
          data: {
            user_id: userId,
            sender: 'ai',
            message: aiMsg.message,
            message_type: aiMsg.message_type || 'text'
          }
        }).catch((err) => {
          console.error("Error creating admin_chat for greeting:", err.message);
          return null;
        });

        const chatIdToUse = adminChat?.id || Date.now();

        // Save as AI-only learning_turn (no user_answer_raw)
        await prisma.learning_turns.create({
          data: {
            user_id: userId,
            chat_id: chatIdToUse,
            topic_id: topic.id,
            topic_title: topic.title,
            subject_name: 'English',
            question_text: aiMsg.message,
            user_name: userProfile?.name || 'Learner'
          }
        }).catch((err) => {
          console.error("Error creating learning_turns for greeting:", err.message);
        });

        messages.push({
          id: adminChat?.id || Date.now() + Math.random(),
          sender: 'ai',
          message: aiMsg.message,
          message_type: aiMsg.message_type || 'text',
          created_at: new Date()
        });
      }

      // Create initial progress entry
      await prisma.user_english_progress.upsert({
        where: { user_id_topic_id: { user_id: userId, topic_id: topic.id } },
        create: {
          user_id: userId,
          topic_id: topic.id,
          is_completed: false,
          completion_percent: 0,
          time_spent_seconds: 0
        },
        update: {}
      }).catch(() => null);
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
  const { topicId, message: userMessage, session_time_seconds } = req.body;
  const userId = req.userId || 1;

  if (!topicId || !userMessage || !userMessage.trim()) {
    return res.status(400).json({ error: 'topicId and non-empty message are required' });
  }

  try {
    const numericTopicId = Number(topicId);

    let topic = await prisma.english_topics.findUnique({
      where: { id: numericTopicId },
      include: {
        chapter: { include: { subject: true } },
        goals: { orderBy: { order: 'asc' } }
      }
    }).catch(() => null);

    if (!topic) {
      return res.status(404).json({ error: 'English topic not found' });
    }

    const userProfile = await prisma.users.findUnique({
      where: { user_id: userId }
    }).catch(() => null);

    // Get topic goals from DB
    const topicGoals = (topic.goals || []).map(g => ({
      id: g.id,
      title: g.title,
      description: g.description,
      is_completed: false
    }));

    if (topicGoals.length === 0) {
      topicGoals.push(
        { id: 1, title: `Scenario Context & Opening`, is_completed: false },
        { id: 2, title: `Vocabulary & Expressions`, is_completed: false },
        { id: 3, title: `Fluent Exchange & Closing`, is_completed: false }
      );
    }

    // Count existing user turns to determine turnNumber
    const existingUserTurns = await prisma.learning_turns.count({
      where: {
        user_id: userId,
        subject_name: 'English',
        topic_title: topic.title,
        user_answer_raw: { not: null }
      }
    }).catch(() => 0);

    const turnNumber = existingUserTurns + 1;

    // Fetch recent chat history for context
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

    // Call AI Tutor Engine
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
    const feedback = corr.feedback || { is_correct: true, score_percent: 100 };
    const firstAiMsg = aiResponse.messages?.[0]?.message || "";
    const sessionEnded = aiResponse.session_ended || false;

    // Save user message + AI response as a single learning_turn row
    const userAdminChat = await prisma.admin_chat.create({
      data: {
        user_id: userId,
        sender: 'user',
        message: userMessage,
        message_type: 'text'
      }
    }).catch((err) => {
      console.error("Error creating user admin_chat:", err.message);
      return null;
    });

    const chatIdToUse = userAdminChat?.id || Date.now();

    // Save user turn + AI follow-up in one row
    await prisma.learning_turns.create({
      data: {
        user_id: userId,
        chat_id: chatIdToUse,
        topic_id: topic.id,
        topic_title: topic.title,
        subject_name: 'English',
        question_text: firstAiMsg, // AI follow-up response
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
    }).catch((err) => {
      console.error("Error creating learning_turns turn:", err.message);
    });

    // Save AI response to admin_chat
    const aiMessagesToReturn = [];
    if (aiResponse.messages && Array.isArray(aiResponse.messages)) {
      for (const aiMsg of aiResponse.messages) {
        const createdAiChat = await prisma.admin_chat.create({
          data: {
            user_id: userId,
            sender: 'ai',
            message: aiMsg.message,
            message_type: aiMsg.message_type || 'text'
          }
        }).catch(() => null);

        aiMessagesToReturn.push({
          id: createdAiChat?.id || Date.now() + Math.random(),
          sender: 'ai',
          message: aiMsg.message,
          message_type: aiMsg.message_type || 'text',
          created_at: new Date()
        });
      }
    }

    // Update user_english_progress
    const completionPercent = Math.min(100, Math.round((turnNumber / MAX_TURNS) * 100));
    await prisma.user_english_progress.upsert({
      where: { user_id_topic_id: { user_id: userId, topic_id: topic.id } },
      create: {
        user_id: userId,
        topic_id: topic.id,
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
    }).catch((err) => {
      console.error("Error updating user_english_progress:", err.message);
    });

    // Update goal completion status based on AI response
    const completedGoalTitles = aiResponse.goal_status?.goals_completed || [];
    for (const goalTitle of completedGoalTitles) {
      const matchedGoal = topicGoals.find(g =>
        g.title.toLowerCase().includes(goalTitle.toLowerCase()) ||
        goalTitle.toLowerCase().includes(g.title.toLowerCase())
      );
      if (matchedGoal) {
        matchedGoal.is_completed = true;
      }
    }

    return res.json({
      userMessage: {
        id: userAdminChat?.id || Date.now(),
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
      all_goals_completed: sessionEnded,
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
 * Non-blocking general freeform AI tutor endpoint
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

module.exports = router;
