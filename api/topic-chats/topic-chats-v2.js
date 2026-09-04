const prisma = require('../../lib/prisma');
const { processTutorTurn } = require('../../services/tutor-core/orchestrator');
const { resolveOptionAnswer } = require('../../services/tutor-core/evaluator');
const { searchYouTube } = require('../../services/media-search');
const { getCachedDiagram } = require('../../services/tutor-core/diagram-cache');

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
 * Convert database admin_chat.options strings back into option objects
 */
function optionsFromDb(options) {
  if (!Array.isArray(options)) return [];
  return options.map(o => {
    if (typeof o !== 'string') {
      return typeof o?.value !== 'undefined' || typeof o?.text !== 'undefined'
        ? { value: String(o.value ?? ''), text: String(o.text ?? o.value ?? '') }
        : { value: 'x', text: 'x' };
    }
    const trimmed = o.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && (parsed.value !== undefined || parsed.text !== undefined)) {
          return { value: String(parsed.value ?? ''), text: String(parsed.text ?? parsed.value ?? '') };
        }
      } catch {}
    }
    return { value: o, text: o };
  });
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
        message_type: true,
        options: true
      }
    });

    const parsedRecentMessages = recentMessages.map(m => ({
      ...m,
      options: optionsFromDb(m.options)
    }));

    // Resolve letter/number option (e.g. "A", "B", "1") to the full answer text if recent AI message had options
    const prevAiMsg = parsedRecentMessages.find(m => m.sender === 'ai' && Array.isArray(m.options) && m.options.length > 0);
    let effectiveMessage = (message || '').trim();
    if (prevAiMsg && effectiveMessage) {
      const resolved = resolveOptionAnswer(effectiveMessage, prevAiMsg.options);
      if (resolved.isOption && resolved.resolvedText) {
        effectiveMessage = resolved.resolvedText;
      }
    }

    const chatHistory = [...parsedRecentMessages].reverse();

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
        message: effectiveMessage || '',
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

    // 6. Fetch user profile
    const userProfile = await prisma.users.findUnique({
      where: { user_id },
      select: { board: true, grade_level: true, name: true }
    });

    // 6b. Detect video requests with typo tolerance
    const wantsVideo = /\b(video|vidoe|vedio|vids?|youtube|yt|watch|clip|animation)\b/i.test(effectiveMessage || '');

    // 7. Execute Orchestrator Pipeline (Steps 1 -> 2 -> 3 -> 4)
    const turnResult = await processTutorTurn({
      studentMessage: effectiveMessage || '',
      topic,
      goals: topicGoals,
      chatHistory,
      currentState: previousState,
      userProfile: userProfile || {},
      wantsVideo
    });

    const nextGoalIndex = turnResult.nextState.goalIndex;
    const isSessionWrapping = turnResult.nextState.phase === 'WRAP' || turnResult.nextState.phase === 'DONE';

    // 8. Update user message record in admin_chat
    const updatedUserMsg = await prisma.admin_chat.update({
      where: { id: userMessageRecord.id },
      data: {
        message: effectiveMessage || '',
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

    // Link user message to goal progress
    if (activeGoal) {
      const isGoalDone = activeGoalIndex < nextGoalIndex || isSessionWrapping;
      const stats = turnResult.nextState.perGoal?.[activeGoalIndex] || { total: 0, correct: 0 };
      await prisma.chat_goal_progress.create({
        data: {
          chat_id: userMessageRecord.id,
          goal_id: activeGoal.id,
          user_id,
          num_questions: stats.total,
          num_correct: stats.correct,
          num_incorrect: Math.max(0, stats.total - stats.correct),
          is_completed: isGoalDone
        }
      });
    }

    // 9. Persist AI message bubbles
    const savedAiMessages = [];
    const currentGoalRecord = topicGoals[Math.min(nextGoalIndex, topicGoals.length - 1)] || activeGoal;

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
        const isGoalDone = nextGoalIndex < nextGoalIndex || isSessionWrapping;
        const stats = turnResult.nextState.perGoal?.[nextGoalIndex] || { total: 0, correct: 0 };
        await prisma.chat_goal_progress.create({
          data: {
            chat_id: aiRecord.id,
            goal_id: currentGoalRecord.id,
            user_id,
            num_questions: stats.total,
            num_correct: stats.correct,
            num_incorrect: Math.max(0, stats.total - stats.correct),
            is_completed: isGoalDone
          }
        });
      }

      savedAiMessages.push({
        ...aiRecord,
        options: bubble.options || []
      });
    }

    // 9b. If Session is wrapping or done, persist Session Summary & Revision Sheet cards
    if (isSessionWrapping && turnResult.masteryReport) {
      const summaryPayload = {
        score_percent: turnResult.masteryReport.score_percent,
        overall_score_percent: turnResult.masteryReport.overall_score_percent,
        star_rating: turnResult.masteryReport.star_rating,
        performance_level: turnResult.masteryReport.performance_level,
        total_questions: turnResult.masteryReport.total_questions,
        correct_answers: turnResult.masteryReport.correct_answers,
        incorrect_answers: turnResult.masteryReport.incorrect_answers,
        top_error_types: turnResult.masteryReport.top_error_types,
        weak_goals: turnResult.masteryReport.weak_goals,
        has_weak_areas: turnResult.masteryReport.has_weak_areas,
        goal_performance: turnResult.masteryReport.goal_performance
      };

      const summaryRecord = await prisma.admin_chat.create({
        data: {
          user_id,
          sender: 'ai',
          message: 'Session Summary',
          message_type: 'session_summary',
          diff_html: JSON.stringify(summaryPayload),
          options: [],
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

      // Helper to link supplementary records to goal progress so they persist on refresh
      const linkToGoal = async (chatId) => {
        if (!currentGoalRecord) return;
        try {
          await prisma.chat_goal_progress.create({
            data: {
              chat_id: chatId,
              goal_id: currentGoalRecord.id,
              user_id,
              num_questions: 0,
              num_correct: 0,
              num_incorrect: 0,
              is_completed: isSessionWrapping
            }
          });
        } catch (e) {}
      };

      await linkToGoal(summaryRecord.id);

      savedAiMessages.push({
        ...summaryRecord,
        session_summary: summaryPayload,
        options: []
      });

      const revisionPayload = turnResult.revisionSheet || {
        topic: topic.title,
        key_concepts: topicGoals.map(g => `${g.title}: ${g.description || 'Core concept mastered.'}`),
        definitions: topicGoals.map(g => ({ term: g.title, definition: g.description || `Key concept in ${topic.title}` })),
        quick_recall_tips: (turnResult.masteryReport?.key_errors || []).map(e => `Common mistake to avoid: ${e.type}`),
        practice_next_time: `Notice how ${topic.title} applies in everyday technology and science.`,
        key_points: topicGoals.map(g => `${g.title}: ${g.description || 'Core concept mastered.'}`),
        common_mistakes: (turnResult.masteryReport?.key_errors || []).map(e => `${e.type} (${e.count}x)`),
        your_weak_spots: (turnResult.masteryReport?.areas_to_improve || []).map(a => a.goal)
      };

      const revisionRecord = await prisma.admin_chat.create({
        data: {
          user_id,
          sender: 'ai',
          message: 'Revision Sheet',
          message_type: 'revision_sheet',
          diff_html: JSON.stringify(revisionPayload),
          options: [],
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

      await linkToGoal(revisionRecord.id);

      savedAiMessages.push({
        ...revisionRecord,
        revision_sheet: revisionPayload,
        options: []
      });

      // Save user topic report record
      try {
        await prisma.user_topic_reports.upsert({
          where: {
            user_id_topic_id: {
              user_id,
              topic_id: parseInt(topicId)
            }
          },
          create: {
            user_id,
            topic_id: parseInt(topicId),
            total_questions: turnResult.masteryReport.total_questions,
            correct_answers: turnResult.masteryReport.correct_answers,
            incorrect_answers: turnResult.masteryReport.incorrect_answers,
            score_percent: turnResult.masteryReport.score_percent,
            star_rating: turnResult.masteryReport.star_rating,
            performance_level: turnResult.masteryReport.performance_level,
            metrics_json: summaryPayload
          },
          update: {
            total_questions: turnResult.masteryReport.total_questions,
            correct_answers: turnResult.masteryReport.correct_answers,
            incorrect_answers: turnResult.masteryReport.incorrect_answers,
            score_percent: turnResult.masteryReport.score_percent,
            star_rating: turnResult.masteryReport.star_rating,
            performance_level: turnResult.masteryReport.performance_level,
            metrics_json: summaryPayload,
            updated_at: new Date()
          }
        });
      } catch (utrErr) {
        console.warn('[Tutor-Core V2] Could not upsert user_topic_reports:', utrErr.message);
      }
    }

    // 10. Sync goal progress in database for all completed goals
    for (let i = 0; i < topicGoals.length; i++) {
      const g = topicGoals[i];
      const isGoalDone = i < nextGoalIndex || isSessionWrapping;
      const stats = turnResult.nextState.perGoal?.[i] || { total: 0, correct: 0 };

      if (isGoalDone) {
        await prisma.chat_goal_progress.updateMany({
          where: { user_id, goal_id: g.id },
          data: {
            is_completed: true,
            num_questions: stats.total,
            num_correct: stats.correct,
            num_incorrect: Math.max(0, stats.total - stats.correct),
            updated_at: new Date()
          }
        });
      }
    }

    // Sync user_topic_progress for the overall topic
    const isTopicCompleted = isSessionWrapping || turnResult.all_goals_completed || nextGoalIndex >= topicGoals.length;
    const completedGoalsCount = isTopicCompleted ? topicGoals.length : Math.min(nextGoalIndex, topicGoals.length);
    const completionPercent = topicGoals.length > 0
      ? (isTopicCompleted ? 100 : Math.round((completedGoalsCount / topicGoals.length) * 100))
      : 100;

    await prisma.user_topic_progress.upsert({
      where: {
        user_id_topic_id: {
          user_id,
          topic_id: parseInt(topicId)
        }
      },
      update: {
        is_completed: isTopicCompleted,
        completion_percent: completionPercent,
        last_accessed_at: new Date()
      },
      create: {
        user_id,
        topic_id: parseInt(topicId),
        is_completed: isTopicCompleted,
        completion_percent: completionPercent,
        last_accessed_at: new Date()
      }
    });

    if (isTopicCompleted) {
      try {
        await prisma.study_sessions.updateMany({
          where: {
            user_id,
            topic_id: parseInt(topicId),
            end_time: null
          },
          data: {
            end_time: new Date()
          }
        });
      } catch (sessErr) {
        console.warn('[Tutor-Core V2] Could not close study_sessions:', sessErr.message);
      }
    }

    // 11. Record chat_process with session state in feedback
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
          state_instruction: turnResult.stateInstruction,
          mastery_report: turnResult.masteryReport || null
        }
      }
    });

    // 12. Record learning_turns analytics for Mastery Engine
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

    // 13. Asynchronous / On-Demand Media (YouTube & Diagrams)
    let fetchedVideos = [];
    const isStruggling = turnResult.nextState.consecutiveWrong >= 1 || turnResult.nextState.stuckStreak >= 1;
    const wantsDiagram = /\b(diagram|drawing|chart|flowchart|mermaid|visual)\b/i.test(message || '');

    const linkMediaToGoal = async (chatId) => {
      if (!currentGoalRecord) return;
      try {
        await prisma.chat_goal_progress.create({
          data: {
            chat_id: chatId,
            goal_id: currentGoalRecord.id,
            user_id,
            num_questions: 0,
            num_correct: 0,
            num_incorrect: 0,
            is_completed: isSessionWrapping
          }
        });
      } catch (e) {}
    };

    if (wantsVideo || isStruggling || turnResult.attachments?.includes('video')) {
      try {
        fetchedVideos = await searchYouTube(`${topic.title} ${currentGoalRecord?.title || ''}`);
      } catch (ytErr) {
        console.warn('[Tutor-Core V2] YouTube search failed:', ytErr.message);
      }
    }

    // Attach Mermaid diagram whenever student is struggling ("I don't know"), asked for a diagram/video, or turn carries it
    let mermaidDiagram = turnResult.mermaid_diagram;
    if (!mermaidDiagram && (isStruggling || wantsDiagram || wantsVideo || turnResult.attachments?.includes('diagram'))) {
      mermaidDiagram = getCachedDiagram(topic.title, currentGoalRecord?.title || topic.title, currentGoalRecord);
    }

    // Persist Mermaid diagram as turn attachment if present
    if (mermaidDiagram && mermaidDiagram.code) {
      try {
        const diagram = mermaidDiagram;
        const diagramRecord = await prisma.admin_chat.create({
          data: {
            user_id,
            sender: 'ai',
            message: diagram.title || 'Concept Diagram',
            message_type: 'mermaid_diagram',
            diff_html: JSON.stringify({ code: diagram.code, title: diagram.title, trigger: diagram.trigger || 'teaching' }),
            options: [],
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
        await linkMediaToGoal(diagramRecord.id);
        savedAiMessages.push({
          ...diagramRecord,
          mermaid_diagram: diagram,
          options: []
        });
        if (savedAiMessages[0]) {
          savedAiMessages[0].mermaid_diagram = diagram;
        }
      } catch (diagramErr) {
        console.error('[Tutor-Core V2] Error saving mermaid diagram:', diagramErr.message);
      }
    }

    // Persist YouTube video as turn attachment if present
    if (fetchedVideos && fetchedVideos.length > 0) {
      try {
        for (const video of fetchedVideos.slice(0, 1)) {
          const videoRecord = await prisma.admin_chat.create({
            data: {
              user_id,
              sender: 'ai',
              message: video.title || 'YouTube Video',
              message_type: 'youtube_video',
              diff_html: JSON.stringify({
                video_id: video.id,
                thumbnail: video.thumbnail,
                url: video.url,
                embedUrl: video.embedUrl,
                channel: video.channel,
                duration: video.duration,
                viewCount: video.viewCount,
                trigger: 'teaching',
                search_query: `${topic.title} ${currentGoalRecord?.title || ''}`
              }),
              videos: [video.url],
              options: [],
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
          await linkMediaToGoal(videoRecord.id);
          savedAiMessages.push({
            ...videoRecord,
            youtube_video: {
              title: video.title,
              url: video.url,
              embedUrl: video.embedUrl,
              thumbnail: video.thumbnail,
              channel: video.channel,
              duration: video.duration
            },
            videos: [video],
            options: []
          });
          if (savedAiMessages[0]) {
            savedAiMessages[0].youtube_video = {
              title: video.title,
              url: video.url,
              embedUrl: video.embedUrl,
              thumbnail: video.thumbnail,
              channel: video.channel,
              duration: video.duration
            };
          }
        }
      } catch (videoErr) {
        console.error('[Tutor-Core V2] Error saving youtube video:', videoErr.message);
      }
    }

    // 14. Update user's chat count
    await prisma.users.update({
      where: { user_id },
      data: { num_chats: { increment: 1 } }
    });

    // 15. Fetch updated goals for UI with synchronized progress
    const rawUpdatedGoals = await prisma.global_topic_goals.findMany({
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

    const updatedGoals = rawUpdatedGoals.map((g, idx) => {
      const isDone = idx < nextGoalIndex || isSessionWrapping;
      const existingProgress = g.chat_goal_progress?.[0];
      const goalStats = turnResult.nextState.perGoal?.[idx] || { total: 0, correct: 0 };
      return {
        ...g,
        is_completed: isDone || existingProgress?.is_completed || false,
        chat_goal_progress: [
          {
            id: existingProgress?.id || 0,
            goal_id: g.id,
            user_id,
            is_completed: isDone || existingProgress?.is_completed || false,
            num_questions: existingProgress?.num_questions ?? goalStats.total,
            num_correct: existingProgress?.num_correct ?? goalStats.correct,
            num_incorrect: existingProgress?.num_incorrect ?? Math.max(0, goalStats.total - goalStats.correct),
            score_percent: goalStats.total > 0
              ? Math.round((goalStats.correct / goalStats.total) * 100)
              : (existingProgress?.score_percent || 0),
            updated_at: new Date()
          }
        ]
      };
    });

    console.log(`[Tutor-Core V2] ✅ Turn complete. Sent ${savedAiMessages.length} AI items. Phase: ${turnResult.nextState.phase}, Goal: ${nextGoalIndex + 1}/${topicGoals.length}`);

    // 16. Deliver SendMessageResponse to frontend
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
