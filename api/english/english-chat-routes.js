const express = require('express');
const router = express.Router();
const prisma = require('../../lib/prisma');
const jwt = require('jsonwebtoken');
const { generateEnglishTopicChatResponse, generateEnglishTopicGreeting } = require('../../services/ai/english-topic-chat');

// Middleware to extract user from JWT token (optional fallback for guest IDs)
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

// Helper to generate dynamic fallback goals when no DB goal table exists
function getDynamicTopicGoals(topicTitle) {
  return [
    {
      id: 1,
      title: `Scenario Context & Professional Opening`,
      description: `Establish setting and open the conversation for ${topicTitle}`,
      order: 1,
      is_completed: false
    },
    {
      id: 2,
      title: `Target Vocabulary & Key Expressions`,
      description: `Use natural sentence structures and relevant topic phrasing`,
      order: 2,
      is_completed: false
    },
    {
      id: 3,
      title: `Fluent Exchange & Closing`,
      description: `Maintain natural flow and respond effectively`,
      order: 3,
      is_completed: false
    }
  ];
}

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
    let topic = null;

    // Fetch from english_topics safely (without requesting non-existent goals table)
    if (!isNaN(numericTopicId)) {
      topic = await prisma.english_topics.findUnique({
        where: { id: numericTopicId },
        include: {
          chapter: { include: { subject: true } }
        }
      }).catch(() => null);
    }

    if (!topic) {
      // Fallback lookup in standard topics table
      const stdTopic = await prisma.topics.findFirst({
        where: { id: isNaN(numericTopicId) ? undefined : numericTopicId },
        include: {
          chapters: { include: { subjects: true } }
        }
      }).catch(() => null);

      if (stdTopic) {
        topic = {
          id: stdTopic.id,
          title: stdTopic.title,
          description: stdTopic.content || "",
          chapterTitle: stdTopic.chapters?.title,
          subjectTitle: stdTopic.chapters?.subjects?.name
        };
      }
    }

    if (!topic) {
      // Create lightweight fallback topic object
      topic = {
        id: numericTopicId || 1,
        title: `Topic ${topicId}`,
        description: "English conversational roleplay"
      };
    }

    // Fetch user profile info
    const userProfile = await prisma.users.findUnique({
      where: { user_id: userId }
    }).catch(() => null);

    // Generate dynamic scenario goals
    const goalsWithProgress = getDynamicTopicGoals(topic.title);

    // Fetch existing chat history for this user from admin_chat
    const rawChats = await prisma.admin_chat.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'asc' },
      take: 50,
      include: {
        chat_process: true
      }
    }).catch(() => []);

    let messages = [];

    for (const chat of rawChats) {
      if (chat.sender === 'user') {
        const proc = chat.chat_process?.[0];
        messages.push({
          id: chat.id,
          sender: 'user',
          message: chat.message,
          message_type: proc?.corrected_message ? 'user_correction' : 'text',
          diff_html: proc?.diff_html || null,
          emoji: chat.emoji || null,
          feedback: proc?.feedback || null,
          created_at: chat.created_at
        });
      } else {
        messages.push({
          id: chat.id,
          sender: 'ai',
          message: chat.message,
          message_type: chat.message_type || 'text',
          options: (chat.options || []).map(opt => ({ text: opt, value: opt })),
          created_at: chat.created_at
        });
      }
    }

    // If no messages exist yet, generate initial scenario greeting & opening question!
    if (messages.length === 0) {
      const greeting = await generateEnglishTopicGreeting(
        topic.title,
        topic.description || "",
        goalsWithProgress,
        userProfile
      );

      const initMsgs = greeting.messages && greeting.messages.length > 0 ? greeting.messages : [
        { message: `Let's start ${topic.title}! 📚`, message_type: "text" },
        { message: `Welcome to "${topic.title}"! I'm your AI roleplay partner. Could you introduce yourself and tell me what brings you here today?`, message_type: "text" }
      ];

      for (const aiMsg of initMsgs) {
        const createdChat = await prisma.admin_chat.create({
          data: {
            user_id: userId,
            sender: 'ai',
            message: aiMsg.message,
            message_type: aiMsg.message_type || 'text',
            options: (aiMsg.options || []).map(o => o.text || o.value || String(o))
          }
        }).catch(() => ({
          id: Date.now() + Math.random(),
          message: aiMsg.message,
          message_type: aiMsg.message_type,
          created_at: new Date()
        }));

        messages.push({
          id: createdChat.id,
          sender: 'ai',
          message: createdChat.message,
          message_type: createdChat.message_type,
          options: (aiMsg.options || []).map(o => ({ text: o.text || o.value || String(o), value: o.value || o.text || String(o) })),
          created_at: createdChat.created_at
        });
      }
    }

    return res.json({
      topic: {
        id: topic.id,
        title: topic.title,
        description: topic.description,
        is_completed: false,
        time_spent_seconds: 0
      },
      goals: goalsWithProgress,
      messages: messages,
      aiMessages: messages.filter(m => m.sender === 'ai')
    });
  } catch (err) {
    console.error('Error fetching English chat messages:', err);
    return res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

/**
 * POST /api/english/chat/message
 * Handles user response turn: evaluates grammar/vocabulary error corrections and returns AI tutor response
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
        chapter: { include: { subject: true } }
      }
    }).catch(() => null);

    if (!topic) {
      const stdTopic = await prisma.topics.findFirst({
        where: { id: isNaN(numericTopicId) ? undefined : numericTopicId },
        include: {
          chapters: { include: { subjects: true } }
        }
      }).catch(() => null);

      if (stdTopic) {
        topic = {
          id: stdTopic.id,
          title: stdTopic.title,
          description: stdTopic.content || ""
        };
      }
    }

    if (!topic) {
      topic = {
        id: numericTopicId || 1,
        title: `Topic ${topicId}`,
        description: "English conversational roleplay"
      };
    }

    const userProfile = await prisma.users.findUnique({
      where: { user_id: userId }
    }).catch(() => null);

    const goalsWithProgress = getDynamicTopicGoals(topic.title);
    const currentGoal = goalsWithProgress[0];

    // Save User Message in admin_chat safely
    const userChatRecord = await prisma.admin_chat.create({
      data: {
        user_id: userId,
        sender: 'user',
        message: userMessage,
        message_type: 'text'
      }
    }).catch(() => ({ id: Date.now() }));

    // Fetch recent chat history
    const rawChats = await prisma.admin_chat.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'asc' },
      take: 20
    }).catch(() => []);

    const chatHistory = rawChats.map(c => ({
      sender: c.sender,
      message: c.message,
      message_type: c.message_type
    }));

    // Call AI Tutor Engine for Evaluation & Roleplay Response
    const aiResponse = await generateEnglishTopicChatResponse({
      userMessage,
      topicTitle: topic.title,
      topicDescription: topic.description || "",
      chatHistory,
      currentGoal,
      topicGoals: goalsWithProgress,
      userId,
      topicId: topic.id,
      userProfile
    });

    const corr = aiResponse.user_correction || {};
    const feedback = corr.feedback || { is_correct: true, score_percent: 100 };

    // Save in chat_process table safely
    if (userChatRecord.id && typeof userChatRecord.id === 'number') {
      await prisma.chat_process.create({
        data: {
          chat_id: userChatRecord.id,
          user_message: userMessage,
          corrected_message: corr.complete_answer || userMessage,
          ai_response: aiResponse.messages?.[0]?.message || "",
          wrong_message: userMessage,
          feedback: {
            is_correct: feedback.is_correct,
            score_percent: feedback.score_percent,
            error_type: feedback.error_type || 'Grammar',
            explanation: feedback.explanation || ''
          }
        }
      }).catch(() => null);
    }

    // Save AI Messages to admin_chat
    const aiMessagesToReturn = [];
    if (aiResponse.messages && Array.isArray(aiResponse.messages)) {
      for (const aiMsg of aiResponse.messages) {
        const createdAiChat = await prisma.admin_chat.create({
          data: {
            user_id: userId,
            sender: 'ai',
            message: aiMsg.message,
            message_type: aiMsg.message_type || 'text',
            options: (aiMsg.options || []).map(o => o.text || o.value || String(o))
          }
        }).catch(() => ({
          id: Date.now() + Math.random(),
          message: aiMsg.message,
          message_type: aiMsg.message_type,
          created_at: new Date()
        }));

        aiMessagesToReturn.push({
          id: createdAiChat.id,
          sender: 'ai',
          message: createdAiChat.message,
          message_type: createdAiChat.message_type,
          options: aiMsg.options || [],
          created_at: createdAiChat.created_at
        });
      }
    }

    return res.json({
      userMessage: {
        id: userChatRecord.id,
        sender: 'user',
        message: userMessage
      },
      userCorrection: {
        diff_html: corr.diff_html || userMessage,
        complete_answer: corr.complete_answer || userMessage,
        emoji: corr.emoji || '😊',
        feedback: feedback
      },
      goals: goalsWithProgress,
      all_goals_completed: false,
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

    const systemPrompt = `You are Cloop AI, an enthusiastic, friendly, and expert English Language Tutor & Assistant.
Your goal is to help ${userProfile?.name || 'the user'} improve English speaking, grammar, writing, and vocabulary.
- Answer questions clearly and concisely.
- Offer polite corrections or alternative phrasing if the user makes a grammar error in their query.
- Use markdown formatting with bullet points where helpful.`;

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
      aiMessage: { sender: 'ai', message: "That's an interesting question! How else can I help you practice your English today?" }
    });
  }
});

module.exports = router;

