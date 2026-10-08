const prisma = require('../../lib/prisma');
const { processTutorTurn } = require('../../services/tutor-core/orchestrator');
const { scoredGoalIndex, goalCompletion } = require('../../services/tutor-core/state');
const { searchYouTube } = require('../../services/media-search');
const { getCachedDiagram } = require('../../services/tutor-core/diagram-cache');
const { recordTurnLog, recordErrorIfWrong, updateDailyStudyStats, endChatSession, updateCurriculumSummary } = require('../../services/analytics/topic-data-collector');
const { resolveTopicIntelligence } = require('../../services/academic-graph/akg-service');

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

function goalIndexFor(state, goals) {
  return Math.max(0, Math.min(state ? scoredGoalIndex(state) || 0 : 0, goals.length - 1));
}

function incorrectFor(stats) {
  const assistedCorrect = Object.values(stats.assessments || {})
    .filter((slot) => slot.assessed && slot.first_correct === true && slot.outcome !== 'correct').length;
  return Math.max(0, stats.total - stats.correct - assistedCorrect);
}

/** Student feedback never exposes a per-answer score or private evaluator rationale. */
function correctionForStudent(turnResult) {
  const correction = turnResult.userCorrection;
  if (!correction) return null;
  const verdict = turnResult.evaluatorResult?.is_correct;
  if (typeof verdict !== 'boolean') return null;
  return {
    message_type: 'user_correction',
    diff_html: correction.diff_html || null,
    complete_answer: correction.complete_answer || null,
    emoji: verdict === true ? '😊' : verdict === false ? '😅' : null,
    feedback: {
      is_correct: typeof verdict === 'boolean' ? verdict : null,
      error_type: correction.feedback?.error_type || null,
      explanation: correction.feedback?.explanation || turnResult.evaluatorResult?.feedback || null
    }
  };
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
            id: true,
            subject_id: true,
            title: true,
            subject: {
              select: { id: true, name: true }
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

    // Keep the student's answer intact. Only the evaluator may resolve an
    // option against the current question, never an older MCQ in history.
    const effectiveMessage = (message || '').trim();
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
    const activeGoalIndex = goalIndexFor(previousState, topicGoals);
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

    // 6c. Resolve Academic Knowledge Graph context (JIT cached)
    let akgContext = null;
    try {
      akgContext = await resolveTopicIntelligence(topic, prisma, { userProfile: userProfile || {} });
    } catch (akgErr) {
      console.warn('[Tutor-Core V2] AKG resolution non-fatal:', akgErr.message);
    }

    // 7. Execute Orchestrator Pipeline (Steps 1 -> 2 -> 3 -> 4)
    const turnResult = await processTutorTurn({
      studentMessage: effectiveMessage || '',
      topic,
      goals: topicGoals,
      chatHistory,
      currentState: previousState,
      userProfile: userProfile || {},
      wantsVideo,
      akgContext
    });

    const nextGoalIndex = turnResult.nextState.goalIndex;
    const isSessionWrapping = turnResult.nextState.phase === 'WRAP' || turnResult.nextState.phase === 'DONE';
    const currentGoalIndex = isSessionWrapping ? activeGoalIndex : goalIndexFor(turnResult.nextState, topicGoals);
    const publicCorrection = correctionForStudent(turnResult);
    const allGoalsCompleted = topicGoals.length > 0 && topicGoals.every((_, i) => goalCompletion(turnResult.nextState, i));
    const sessionCompleted = isSessionWrapping && (turnResult.session_completed === true ||
      turnResult.masteryReport?.session_completed === true || turnResult.nextState.endedReason === 'complete');
    const allGoalsCovered = sessionCompleted && allGoalsCompleted && turnResult.masteryReport?.recall_completed === true &&
      turnResult.masteryReport?.goals_completed === topicGoals.length;
    const sessionClosed = !!turnResult.masteryReport;
    const masteryConfirmed = isSessionWrapping && turnResult.masteryReport?.mastery_confirmed === true;
    const closingAlreadyPersisted = previousState?.phase === 'WRAP' || previousState?.phase === 'DONE';

    // 8. Update user message record in admin_chat
    const updatedUserMsg = await prisma.admin_chat.update({
      where: { id: userMessageRecord.id },
      data: {
        message: effectiveMessage || '',
        message_type: publicCorrection ? 'user_correction' : 'text',
        diff_html: publicCorrection?.diff_html || null,
        emoji: publicCorrection?.emoji || null
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
      const isGoalDone = goalCompletion(turnResult.nextState, activeGoalIndex);
      const stats = turnResult.nextState.perGoal?.[activeGoalIndex] || { total: 0, correct: 0 };
      await prisma.chat_goal_progress.create({
        data: {
          chat_id: userMessageRecord.id,
          goal_id: activeGoal.id,
          user_id,
          num_questions: stats.total,
          num_correct: stats.correct,
          num_incorrect: incorrectFor(stats),
          is_completed: isGoalDone
        }
      });
    }

    // 9. Persist AI message bubbles
    const savedAiMessages = [];
    const currentGoalRecord = topicGoals[currentGoalIndex] || activeGoal;

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
        const isGoalDone = goalCompletion(turnResult.nextState, currentGoalIndex);
        const stats = turnResult.nextState.perGoal?.[currentGoalIndex] || { total: 0, correct: 0 };
        await prisma.chat_goal_progress.create({
          data: {
            chat_id: aiRecord.id,
            goal_id: currentGoalRecord.id,
            user_id,
            num_questions: stats.total,
            num_correct: stats.correct,
            num_incorrect: incorrectFor(stats),
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
    if (isSessionWrapping && turnResult.masteryReport && !closingAlreadyPersisted) {
      // Preserve coverage, incomplete recall and assisted evidence on refresh.
      const summaryPayload = {
        ...turnResult.masteryReport,
        session_completed: sessionCompleted,
        session_closed: sessionClosed,
        mastery_confirmed: masteryConfirmed
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
              is_completed: goalCompletion(turnResult.nextState, currentGoalIndex)
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
        key_concepts: topicGoals.map(g => `${g.title}: ${g.description || 'Key concept to revise.'}`),
        definitions: topicGoals.map(g => ({ term: g.title, definition: g.description || `Key concept in ${topic.title}` })),
        quick_recall_tips: (turnResult.masteryReport?.key_errors || []).map(e => `Common mistake to avoid: ${e.type}`),
        practice_next_time: `Notice how ${topic.title} applies in everyday technology and science.`,
        key_points: topicGoals.map(g => `${g.title}: ${g.description || 'Key concept to revise.'}`),
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

    // 10. Sync completion from assessment evidence, including incomplete exits.
    for (let i = 0; i < topicGoals.length; i++) {
      const g = topicGoals[i];
      const isGoalDone = goalCompletion(turnResult.nextState, i);
      const stats = turnResult.nextState.perGoal?.[i] || { total: 0, correct: 0 };

      await prisma.chat_goal_progress.updateMany({
        where: { user_id, goal_id: g.id },
        data: {
          is_completed: isGoalDone,
          num_questions: stats.total,
          num_correct: stats.correct,
          num_incorrect: incorrectFor(stats),
          updated_at: new Date()
        }
      });
    }

    // Sync user_topic_progress for the overall topic
    const isTopicCompleted = allGoalsCovered;
    const completedGoalsCount = topicGoals.filter((_, i) => goalCompletion(turnResult.nextState, i)).length;
    const completionPercent = topicGoals.length > 0
      ? Math.round((completedGoalsCount / topicGoals.length) * 100)
      : 0;

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

    // Early termination still closes time tracking, without completing the topic.
    if (isSessionWrapping && !closingAlreadyPersisted) {
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

      // End topic chat session and update curriculum summary
      try {
        await endChatSession(user_id, parseInt(topicId), turnResult);
        const subjectId = topic.chapter?.subject_id || topic.subject_id || null;
        if (subjectId) {
          await updateCurriculumSummary(user_id, subjectId);
        }
      } catch (csErr) {
        console.warn('[Tutor-Core V2] topic-data-collector session/curriculum non-fatal:', csErr.message);
      }
    }

    // 11. Record chat_process with session state in feedback
    await prisma.chat_process.create({
      data: {
        chat_id: userMessageRecord.id,
        user_message: message || '',
        corrected_message: publicCorrection?.complete_answer || null,
        ai_response: JSON.stringify(turnResult.messages),
        wrong_message: turnResult.evaluatorResult.is_correct === false ? message : null,
        feedback: {
          session_state: turnResult.nextState,
          evaluator_result: turnResult.evaluatorResult,
          user_correction: publicCorrection,
          state_instruction: turnResult.stateInstruction,
          mastery_report: turnResult.masteryReport || null
        }
      }
    });

    // 12. Record learning_turns analytics for Mastery Engine
    if (turnResult.gradedThisTurn && typeof turnResult.evaluatorResult.is_correct === 'boolean') {
      try {
        await prisma.learning_turns.create({
          data: {
            topic_id: parseInt(topicId),
            user_id,
            chat_id: userMessageRecord.id,
            goal_id: activeGoal?.id || null,
            question_text: previousState?.lastQuestionText || null,
            user_answer_raw: effectiveMessage,
            is_correct: turnResult.evaluatorResult.is_correct,
            score_percent: turnResult.evaluatorResult.score_percent ?? null,
            error_type: turnResult.evaluatorResult.error_type || null,
            corrected_answer: turnResult.evaluatorResult.complete_answer || null,
            diff_html: publicCorrection?.diff_html || null,
            feedback_text: publicCorrection?.feedback.explanation || null,
            feedback_json: publicCorrection?.feedback || null
          }
        });
      } catch (ltErr) {
        console.error('[Tutor-Core V2] Failed to record learning_turns:', ltErr.message);
      }
    }

    // 12b. Record full pipeline data to tutor_turn_logs + error detection + daily stats
    try {
      const turnLogContext = {
        userId: user_id,
        topicId: parseInt(topicId),
        chapterId: topic.chapter?.id || null,
        subjectId: topic.chapter?.subject_id || topic.subject_id || null,
        goalId: activeGoal?.id || null,
        goalIndex: activeGoalIndex,
        chatId: userMessageRecord.id,
        userMessage: effectiveMessage
      };

      const turnLogId = await recordTurnLog(turnResult, turnLogContext);

      // Find the last question from chat history for error context
      const lastQ = [...chatHistory].reverse().find(m => m.sender === 'ai' && m.message && /[?？]/.test(m.message));

      await recordErrorIfWrong(turnResult, {
        ...turnLogContext,
        lastQuestionText: previousState?.lastQuestionText || lastQ?.message || null
      }, turnLogId);

      await updateDailyStudyStats(user_id, turnResult, parseInt(topicId));
    } catch (collectorErr) {
      console.warn('[Tutor-Core V2] topic-data-collector non-fatal:', collectorErr.message);
    }

    // 13. Asynchronous / On-Demand Media (YouTube & Diagrams)
    let fetchedVideos = [];
    // Media follows the state machine's attachment plan. A request or a wrong
    // answer cannot bypass assessment-only ROUNDUP or a terminal phase.
    const mediaAllowed = !['ROUNDUP', 'WRAP', 'DONE'].includes(turnResult.nextState.phase);

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
            is_completed: goalCompletion(turnResult.nextState, currentGoalIndex)
          }
        });
      } catch (e) {}
    };

    if (mediaAllowed && turnResult.attachments?.includes('video')) {
      try {
        fetchedVideos = await searchYouTube(`${topic.title} ${currentGoalRecord?.title || ''}`);
      } catch (ytErr) {
        console.warn('[Tutor-Core V2] YouTube search failed:', ytErr.message);
      }
    }

    let mermaidDiagram = mediaAllowed && turnResult.attachments?.includes('diagram') ? turnResult.mermaid_diagram : null;
    if (!mermaidDiagram && mediaAllowed && turnResult.attachments?.includes('diagram')) {
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
      const isDone = goalCompletion(turnResult.nextState, idx);
      const existingProgress = g.chat_goal_progress?.[0];
      const goalStats = turnResult.nextState.perGoal?.[idx] || { total: 0, correct: 0 };
      return {
        ...g,
        is_completed: isDone,
        chat_goal_progress: [
          {
            id: existingProgress?.id || 0,
            goal_id: g.id,
            user_id,
            is_completed: isDone,
            num_questions: goalStats.total,
            num_correct: goalStats.correct,
            num_incorrect: incorrectFor(goalStats),
            ...(isSessionWrapping ? { score_percent: goalStats.total > 0
              ? Math.round((goalStats.correct / goalStats.total) * 100)
              : null } : {}),
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
      feedback: publicCorrection?.feedback || null,
      userCorrection: publicCorrection,
      all_goals_completed: allGoalsCovered,
      session_completed: sessionCompleted,
      session_closed: sessionClosed,
      mastery_confirmed: masteryConfirmed,
      ...(sessionClosed ? { masteryReport: turnResult.masteryReport, revisionSheet: turnResult.revisionSheet || null } : {}),
      goals: updatedGoals,
      mermaid_diagram: mermaidDiagram || null,
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
