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

    // Fetch from english_topics safely
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
      topic = {
        id: numericTopicId || 1,
        title: `Scenario ${topicId}`,
        description: "English conversational roleplay"
      };
    }

    // Fetch user profile info
    const userProfile = await prisma.users.findUnique({
      where: { user_id: userId }
    }).catch(() => null);

    // Generate dynamic scenario goals
    const goalsWithProgress = getDynamicTopicGoals(topic.title);

    // Fetch existing chat history STRICTLY FOR THIS SPECIFIC ENGLISH TOPIC TITLE ONLY
    const learningTurns = await prisma.learning_turns.findMany({
      where: {
        user_id: userId,
        subject_name: 'English',
        topic_title: topic.title
      },
      orderBy: { created_at: 'asc' },
      take: 50
    }).catch(() => []);

    let messages = [];

    if (learningTurns.length > 0) {
      for (const turn of learningTurns) {
        if (turn.question_text) {
          messages.push({
            id: `ai_${turn.id}`,
            sender: 'ai',
            message: turn.question_text,
            message_type: 'text',
            created_at: turn.created_at
          });
        }
        if (turn.user_answer_raw) {
          messages.push({
            id: `user_${turn.id}`,
            sender: 'user',
            message: turn.user_answer_raw,
            message_type: turn.diff_html ? 'user_correction' : 'text',
            diff_html: turn.diff_html || null,
            feedback: turn.feedback_json || null,
            created_at: turn.created_at
          });
        }
      }
    }

    // If no messages exist for this exact English topic title, generate initial scenario greeting & opening question!
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
        // Step 1: Create admin_chat record to get valid chat_id
        const adminChat = await prisma.admin_chat.create({
          data: {
            user_id: userId,
            sender: 'ai',
            message: aiMsg.message,
            message_type: aiMsg.message_type || 'text',
            options: (aiMsg.options || []).map(o => o.text || o.value || String(o))
          }
        }).catch((err) => {
          console.error("Error creating admin_chat for greeting:", err.message);
          return null;
        });

        const chatIdToUse = adminChat?.id || Date.now();

        // Step 2: Save initial AI prompt to learning_turns table with chat_id
        await prisma.learning_turns.create({
          data: {
            user_id: userId,
            chat_id: chatIdToUse, // REQUIRED BY PRISMA SCHEMA
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
          options: (aiMsg.options || []).map(o => ({ text: o.text || o.value || String(o), value: o.value || o.text || String(o) })),
          created_at: new Date()
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
        title: `Scenario ${topicId}`,
        description: "English conversational roleplay"
      };
    }

    const userProfile = await prisma.users.findUnique({
      where: { user_id: userId }
    }).catch(() => null);

    const goalsWithProgress = getDynamicTopicGoals(topic.title);
    const currentGoal = goalsWithProgress[0];

    // Fetch recent chat history STRICTLY FOR THIS EXACT ENGLISH TOPIC TITLE
    const recentTurns = await prisma.learning_turns.findMany({
      where: {
        user_id: userId,
        subject_name: 'English',
        topic_title: topic.title
      },
      orderBy: { created_at: 'asc' },
      take: 20
    }).catch(() => []);

    const chatHistory = [];
    for (const turn of recentTurns) {
      if (turn.question_text) chatHistory.push({ sender: 'ai', message: turn.question_text, message_type: 'text' });
      if (turn.user_answer_raw) chatHistory.push({ sender: 'user', message: turn.user_answer_raw, message_type: 'text' });
    }

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
    const firstAiMsg = aiResponse.messages?.[0]?.message || "";

    // Step 1: Create user message in admin_chat to get valid chat_id
    const userAdminChat = await prisma.admin_chat.create({
      data: {
        user_id: userId,
        sender: 'user',
        message: userMessage,
        message_type: 'text',
        emoji: corr.emoji || undefined
      }
    }).catch((err) => {
      console.error("Error creating user admin_chat:", err.message);
      return null;
    });

    const chatIdToUse = userAdminChat?.id || Date.now();

    // Step 2: Save turn into learning_turns table with chat_id
    await prisma.learning_turns.create({
      data: {
        user_id: userId,
        chat_id: chatIdToUse, // REQUIRED BY PRISMA SCHEMA
        topic_id: topic.id,
        topic_title: topic.title,
        subject_name: 'English',
        question_text: firstAiMsg,
        user_answer_raw: userMessage,
        corrected_answer: corr.complete_answer || userMessage,
        diff_html: corr.diff_html || userMessage,
        feedback_text: feedback.explanation || '',
        feedback_json: feedback,
        error_type: feedback.error_type || 'Grammar',
        is_correct: feedback.is_correct,
        score_percent: Number(feedback.score_percent) || 0,
        mastery_score: Number(feedback.score_percent) || 0,
        user_name: userProfile?.name || 'Learner'
      }
    }).catch((err) => {
      console.error("Error creating learning_turns turn:", err.message);
    });

    const aiMessagesToReturn = [];
    if (aiResponse.messages && Array.isArray(aiResponse.messages)) {
      for (const aiMsg of aiResponse.messages) {
        // Save AI response to admin_chat as well
        const createdAiChat = await prisma.admin_chat.create({
          data: {
            user_id: userId,
            sender: 'ai',
            message: aiMsg.message,
            message_type: aiMsg.message_type || 'text',
            options: (aiMsg.options || []).map(o => o.text || o.value || String(o))
          }
        }).catch(() => null);

        aiMessagesToReturn.push({
          id: createdAiChat?.id || Date.now() + Math.random(),
          sender: 'ai',
          message: aiMsg.message,
          message_type: aiMsg.message_type || 'text',
          options: aiMsg.options || [],
          created_at: new Date()
        });
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
