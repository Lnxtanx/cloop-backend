const prisma = require('../../lib/prisma');
const { processTutorTurn } = require('../../services/tutor-core/orchestrator');
const { searchYouTube } = require('../../services/media-search');

/**
 * Convert model options into an array of strings for admin_chat.options String[] column
 */
function optionsToStrings(options) {
  if (!Array.isArray(options)) return [];
  return options.map(o => {
    if (typeof o === 'string') return o;
    if (o && (o.value !== undefined || o.text !== undefined)) {
      return JSON.stringify({ value: String(o.value ?? ''), text: String(o.text ?? o.value ?? '') });
    }
    if (o && typeof o === 'object') {
      const v = o.value ?? o.text;
      return v != null ? String(v) : '';
    }
    return String(o ?? '');
  }).filter(Boolean);
}

/**
 * Handle POST /api/topic-chats/:topicId/message using Tutor-Core V2 Pipeline
 */
async function handleTopicChatMessageV2(req, res) {
  const user_id = req.user?.user_id;
  const { topicId } = req.params;
  const { message, file_url, voice_enabled } = req.body;

  if (!user_id) {
    return res.status(401).json({ error: 'Authentication required - please login' });
  }

  if (!topicId || isNaN(parseInt(topicId))) {
    return res.status(400).json({ error: 'Valid topic ID is required' });
  }

  if (!message && !file_url) {
    return res.status(400).json({ error: 'Message or file is required' });
  }

  console.log('\n========== [TUTOR-CORE V2] NEW MESSAGE ==========');
  console.log('📱 User:', user_id);
  console.log('📚 Topic ID:', topicId);
  console.log('💬 User Message:', message ? message.substring(0, 100) : 'None');

  try {
    // 1. Fetch topic with chapter context
    const topic = await prisma.global_topics.findUnique({
      where: { id: parseInt(topicId) },
      include: {
        chapter: {
          select: {
            title: true,
            subject: {
              select: { name: true }
            }
          }
        }
      }
    });

    if (!topic) {
      return res.status(404).json({ error: 'Topic not found' });
    }

    // 2. Fetch topic goals with latest progress
    const topicGoals = await prisma.global_topic_goals.findMany({
      where: { topic_id: parseInt(topicId) },
      orderBy: { order: 'asc' },
      include: {
        chat_goal_progress: {
          where: { user_id },
          orderBy: { updated_at: 'desc' },
          take: 1
        }
      }
    });

    const goalIds = topicGoals.map(g => g.id);

    // 3. Fetch recent chat history from admin_chat
    const recentMessages = await prisma.admin_chat.findMany({
      where: {
        user_id,
        chat_goal_progress: {
          some: { goal_id: { in: goalIds } }
        }
      },
      orderBy: { created_at: 'desc' },
      take: 20,
      select: {
        id: true,
        sender: true,
        message: true,
        message_type: true
      }
    });

    const chatHistory = recentMessages.reverse();

    // 4. Load previous session state from latest chat_process feedback
    let previousState = null;
    try {
      const latestProcess = await prisma.chat_process.findFirst({
        where: {
          admin_chat: {
            user_id,
            chat_goal_progress: {
              some: { goal_id: { in: goalIds } }
            }
          }
        },
        orderBy: { created_at: 'desc' }
      });

      if (latestProcess?.feedback && typeof latestProcess.feedback === 'object') {
        previousState = latestProcess.feedback.session_state || null;
      }
    } catch (stateLoadErr) {
      console.warn('[Tutor-Core V2] Could not load previous state, starting fresh:', stateLoadErr.message);
    }

    // Determine currently active goal
    const activeGoalIndex = previousState ? Math.min(previousState.goalIndex, topicGoals.length - 1) : 0;
    const activeGoal = topicGoals[activeGoalIndex] || topicGoals[0];

    // 5. Create placeholder user message in admin_chat
    const userMessageRecord = await prisma.admin_chat.create({
      data: {
        user_id,
        sender: 'user',
        message: message || '',
        message_type: 'raw',
        diff_html: null,
        options: [],
        images: [],
        videos: [],
        links: []
      },
      select: {
        id: true,
        sender: true,
        message: true,
        message_type: true,
        options: true,
        diff_html: true,
        emoji: true,
        created_at: true
      }
    });

    // Link user message to active goal
    if (activeGoal) {
      await prisma.chat_goal_progress.create({
        data: {
          chat_id: userMessageRecord.id,
          goal_id: activeGoal.id,
          user_id
        }
      });
    }

    // 6. Fetch user profile
    const userProfile = await prisma.users.findUnique({
      where: { user_id },
      select: { board: true, grade_level: true, name: true }
    });

    // 7. Execute Orchestrator Pipeline (Steps 1 -> 2 -> 3 -> 4)
    const turnResult = await processTutorTurn({
      studentMessage: message || '',
      topic,
      goals: topicGoals,
      chatHistory,
      currentState: previousState,
      userProfile: userProfile || {}
    });

    // 8. Update user message record in admin_chat
    const updatedUserMsg = await prisma.admin_chat.update({
      where: { id: userMessageRecord.id },
      data: {
        message: message || '',
        message_type: turnResult.userCorrection ? 'user_correction' : 'text',
        diff_html: turnResult.userCorrection?.diff_html || null,
        emoji: turnResult.userCorrection?.emoji || (turnResult.evaluatorResult.is_correct ? '😊' : '😅')
      },
      select: {
        id: true,
        sender: true,
        message: true,
        message_type: true,
        options: true,
        diff_html: true,
        emoji: true,
        created_at: true
      }
    });

    // 9. Persist AI message bubbles
    const savedAiMessages = [];
    const currentGoalRecord = topicGoals[Math.min(turnResult.nextState.goalIndex, topicGoals.length - 1)] || activeGoal;

    for (const bubble of turnResult.messages) {
      if (!bubble || (!bubble.message?.trim() && !bubble.options?.length)) continue;

      const aiRecord = await prisma.admin_chat.create({
        data: {
          user_id,
          sender: 'ai',
          message: bubble.message,
          message_type: bubble.message_type || 'text',
          options: optionsToStrings(bubble.options),
          created_at: new Date()
        },
        select: {
          id: true,
          sender: true,
          message: true,
          message_type: true,
          options: true,
          diff_html: true,
          emoji: true,
          created_at: true
        }
      });

      if (currentGoalRecord) {
        await prisma.chat_goal_progress.create({
          data: {
            chat_id: aiRecord.id,
            goal_id: currentGoalRecord.id,
            user_id,
            is_completed: turnResult.nextState.questionsThisGoal >= turnResult.nextState.questionsPerGoal
          }
        });
      }

      savedAiMessages.push({
        ...aiRecord,
        options: bubble.options || []
      });
    }

    // 10. Record chat_process with session state in feedback
    await prisma.chat_process.create({
      data: {
        chat_id: userMessageRecord.id,
        user_message: message || '',
        corrected_message: turnResult.userCorrection?.complete_answer || null,
        ai_response: JSON.stringify(turnResult.messages),
        wrong_message: turnResult.evaluatorResult.is_correct === false ? message : null,
        feedback: {
          session_state: turnResult.nextState,
          evaluator_result: turnResult.evaluatorResult,
          state_instruction: turnResult.stateInstruction
        }
      }
    });

    // 11. Record learning_turns analytics for Mastery Engine
    if (turnResult.evaluatorResult.intent === 'ANSWER') {
      try {
        await prisma.learning_turns.create({
          data: {
            topic_id: parseInt(topicId),
            user_id,
            chat_id: userMessageRecord.id,
            is_correct: turnResult.evaluatorResult.is_correct || false,
            score_percent: turnResult.evaluatorResult.score_percent || 0,
            error_type: turnResult.evaluatorResult.error_type || null,
            corrected_answer: turnResult.evaluatorResult.complete_answer || null,
            diff_html: turnResult.userCorrection?.diff_html || null
          }
        });
      } catch (ltErr) {
        console.error('[Tutor-Core V2] Failed to record learning_turns:', ltErr.message);
      }
    }

    // 12. Asynchronous / On-Demand Media (YouTube)
    let fetchedVideos = [];
    const wantsVideo = /\b(video|watch|youtube|clip)\b/i.test(message || '');
    const isStruggling = turnResult.nextState.consecutiveWrong >= 2;

    if (wantsVideo || isStruggling) {
      try {
        fetchedVideos = await searchYouTube(`${topic.title} ${currentGoalRecord?.title || ''}`);
      } catch (ytErr) {
        console.warn('[Tutor-Core V2] YouTube search failed:', ytErr.message);
      }
    }

    // 13. Update user's chat count
    await prisma.users.update({
      where: { user_id },
      data: { num_chats: { increment: 1 } }
    });

    // Fetch updated goals for UI
    const updatedGoals = await prisma.global_topic_goals.findMany({
      where: { topic_id: parseInt(topicId) },
      orderBy: { order: 'asc' },
      include: {
        chat_goal_progress: {
          where: { user_id },
          orderBy: { updated_at: 'desc' },
          take: 1
        }
      }
    });

    console.log(`[Tutor-Core V2] ✅ Turn complete. Sent ${savedAiMessages.length} AI bubbles. Phase: ${turnResult.nextState.phase}`);

    // 14. Deliver SendMessageResponse to frontend
    return res.status(201).json({
      userMessage: updatedUserMsg,
      aiMessages: savedAiMessages,
      feedback: turnResult.userCorrection?.feedback || null,
      userCorrection: turnResult.userCorrection || null,
      all_goals_completed: turnResult.all_goals_completed,
      goals: updatedGoals,
      mermaid_diagram: turnResult.mermaid_diagram || null,
      youtube_video: fetchedVideos.length > 0 ? {
        title: fetchedVideos[0].title,
        search_query: `${topic.title} ${currentGoalRecord?.title || ''}`
      } : null,
      youtube_results: fetchedVideos
    });

  } catch (err) {
    console.error('[Tutor-Core V2] ❌ Unhandled error in message handler:', err);
    return res.status(500).json({
      error: 'Server error while processing message',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
}

module.exports = {
  handleTopicChatMessageV2
};
