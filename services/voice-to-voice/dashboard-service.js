/**
 * Voice-to-Voice Fluency Dashboard Service
 * 
 * Aggregates voice practice session data, speech error logs, CEFR level progression,
 * streaks, and curriculum milestones into the exact FluencyDashboardModel format
 * expected by the frontend UI.
 */

const prisma = require('../../lib/prisma')
const { COURSE_CATALOG } = require('./voice-session-prompts')

/**
 * Human-friendly error titles and actionable fixes
 */
const ERROR_DISPLAY_MAP = {
  too_short: {
    title: 'Full sentences',
    subtitle: 'Answering in single words instead of complete sentences.',
    simpleFixText: 'Add a subject and verb to your answers. Instead of single words, make a complete thought.',
  },
  sound_swap: {
    title: 'Clear sound pronunciation',
    subtitle: 'Certain consonant sounds (like v/w or s/th) get swapped.',
    simpleFixText: 'Bite your lower lip gently for "v", and round your lips for "w". Take your time with key sounds.',
  },
  word_stress: {
    title: 'Word stress & rhythm',
    subtitle: 'Placing stress on the wrong syllable changes the word flow.',
    simpleFixText: 'Stress the root syllable clearly. E.g. PRE-sent (gift) vs pre-SENT (to show).',
  },
  grammar: {
    title: 'Sentence grammar',
    subtitle: 'Minor tense or subject-verb agreement slips.',
    simpleFixText: 'Keep past actions in simple past tense (e.g. "I graduated" rather than "I did my graduation").',
  },
  word_choice: {
    title: 'Natural word choice',
    subtitle: 'Using literal translations where English has a specific idiom.',
    simpleFixText: 'Use the most direct natural phrasing rather than literal word-for-word translation.',
  },
  sentence_shape: {
    title: 'Question & sentence order',
    subtitle: 'Inverted word order in questions or clauses.',
    simpleFixText: 'Put helping verbs before the subject in questions: "Why are you calling?" instead of "Why you are calling?".',
  },
  hesitation: {
    title: 'Conversational flow',
    subtitle: 'Pauses while searching for words.',
    simpleFixText: 'Take a calm breath before answering. A steady pause sounds much more confident than saying "actually actually".',
  },
  indian_english: {
    title: 'Global English phrasing',
    subtitle: 'Regional Indian-English idioms like "prepone" or "do the needful".',
    simpleFixText: 'Use globally recognized terms like "reschedule earlier" or "take care of this".',
  },
  unclear: {
    title: 'Sentence endings',
    subtitle: 'Voice trailing off or mumbling the last words of a sentence.',
    simpleFixText: 'Finish your sentence with the same volume and breath you started with.',
  },
}

/**
 * CEFR Level Metadata
 */
const LEVEL_METADATA = {
  A1: {
    code: 'A1',
    name: 'Beginner',
    subtitle: 'You are just getting started — that\'s perfectly okay.',
  },
  A2: {
    code: 'A2',
    name: 'Basic',
    subtitle: 'You can form everyday sentences and hold simple conversations.',
  },
  B1: {
    code: 'B1',
    name: 'Workplace ready',
    subtitle: 'You communicate clearly in professional and workplace situations.',
  },
  B2: {
    code: 'B2',
    name: 'Fluent',
    subtitle: 'You speak smoothly and express complex thoughts with natural ease.',
  },
}

/**
 * Determine learner CEFR level from completed voice sessions
 */
function evaluateLearnerLevel(totalSessions, totalMinutes, errorCount, avgWpm) {
  if (totalSessions >= 12 && (errorCount / Math.max(1, totalSessions)) <= 2.0 && avgWpm >= 115) {
    return 'B2'
  }
  if (totalSessions >= 6 && (errorCount / Math.max(1, totalSessions)) <= 4.0 && avgWpm >= 95) {
    return 'B1'
  }
  if (totalSessions >= 3 && (errorCount / Math.max(1, totalSessions)) <= 6.5) {
    return 'A2'
  }
  return 'A1'
}

/**
 * Calculate user consecutive-day streak from database
 */
async function getUserStreak(userId) {
  try {
    const streakRow = await prisma.user_streaks.findUnique({
      where: { user_id: userId },
    })

    if (streakRow && streakRow.current_streak > 0) {
      return streakRow.current_streak
    }

    // Fallback: check distinct days of completed voice sessions
    const sessions = await prisma.voice_sessions.findMany({
      where: { user_id: userId, status: 'COMPLETED' },
      select: { completed_at: true },
      orderBy: { completed_at: 'desc' },
      take: 30,
    })

    if (!sessions || sessions.length === 0) return 0

    const uniqueDates = new Set()
    for (const s of sessions) {
      if (s.completed_at) {
        uniqueDates.add(new Date(s.completed_at).toISOString().split('T')[0])
      }
    }

    return uniqueDates.size
  } catch (err) {
    console.error('[DashboardService] Error fetching streak:', err)
    return 0
  }
}

/**
 * Construct full FluencyDashboardModel for a given user
 * 
 * @param {number} userId 
 * @returns {Promise<object>} FluencyDashboardModel matching frontend schema
 */
async function getFluencyDashboardData(userId) {
  const uid = parseInt(userId, 10)
  if (!uid) throw new Error('Invalid user ID')

  // 1. Fetch user info
  let user = null
  try {
    user = await prisma.users.findUnique({
      where: { user_id: uid },
      select: { user_id: true, name: true, email: true },
    })
  } catch (err) {
    console.warn('[DashboardService] Could not fetch user:', err.message)
  }
  const firstName = user?.name ? user.name.split(' ')[0] : 'Learner'

  // 2. Fetch or initialize learner profile
  let profile = null
  try {
    profile = await prisma.learner_profiles.findUnique({
      where: { user_id: uid },
    })

    if (!profile) {
      profile = await prisma.learner_profiles.create({
        data: {
          user_id: uid,
          native_language: 'Hindi',
          english_level: 'Beginner',
          cefr_estimate: 'A1',
          current_track: 'everyday_english',
          current_chapter: 'saying_hello',
          total_sessions: 0,
          total_minutes: 0,
        },
      }).catch(() => null)
    }
  } catch (err) {
    console.warn('[DashboardService] Could not fetch/create learner profile:', err.message)
  }

  // 3. Fetch completed voice sessions & error history
  let completedSessions = []
  try {
    completedSessions = await prisma.voice_sessions.findMany({
      where: { user_id: uid, status: 'COMPLETED' },
      orderBy: { completed_at: 'desc' },
      take: 20,
      include: {
        errors: {
          orderBy: { created_at: 'desc' },
          take: 10,
        },
      },
    })
  } catch (err) {
    console.warn('[DashboardService] Could not fetch completed sessions:', err.message)
  }

  const totalSessions = profile?.total_sessions || completedSessions.length
  const totalMinutes = profile?.total_minutes || Math.round(
    completedSessions.reduce((sum, s) => sum + (s.duration_seconds || 0), 0) / 60
  )
  const totalWordsSpoken = completedSessions.reduce((sum, s) => sum + (s.words_spoken || 0), 0)
  const avgWpm = totalMinutes > 0 ? Math.round(totalWordsSpoken / totalMinutes) : 85

  // 4. All recorded errors
  let allErrors = []
  try {
    allErrors = await prisma.session_errors.findMany({
      where: { session: { user_id: uid } },
      orderBy: { created_at: 'desc' },
      take: 100,
    })
  } catch (err) {
    console.warn('[DashboardService] Could not fetch session errors:', err.message)
  }

  // Sentences fixed / errors worked through
  const sentencesFixed = allErrors.length

  // 5. Streak
  const daysInARow = await getUserStreak(uid)

  // 6. Current CEFR Level Determination
  const evaluatedLevelCode = profile?.cefr_estimate || evaluateLearnerLevel(
    totalSessions,
    totalMinutes,
    allErrors.length,
    avgWpm
  )
  const levelInfo = LEVEL_METADATA[evaluatedLevelCode] || LEVEL_METADATA.A1

  // 7. Stages Timeline
  const stageOrder = ['A1', 'A2', 'B1', 'B2']
  const currentIndex = stageOrder.indexOf(evaluatedLevelCode)
  const stages = [
    {
      id: 'beginner',
      label: 'Beginner',
      isCurrent: evaluatedLevelCode === 'A1',
      isPassed: currentIndex > 0,
    },
    {
      id: 'basic',
      label: 'Basic',
      isCurrent: evaluatedLevelCode === 'A2',
      isPassed: currentIndex > 1,
    },
    {
      id: 'workplace',
      label: 'Workplace ready',
      isCurrent: evaluatedLevelCode === 'B1',
      isPassed: currentIndex > 2,
    },
    {
      id: 'fluent',
      label: 'Fluent',
      isCurrent: evaluatedLevelCode === 'B2',
      isPassed: false,
    },
  ]

  // 8. Focus Hero Card ("FOCUS ON THIS NOW")
  // Identify learner's most frequent recent error
  const errorTypeFrequency = {}
  for (const err of allErrors) {
    errorTypeFrequency[err.error_type] = (errorTypeFrequency[err.error_type] || 0) + 1
  }
  let topErrorType = Object.keys(errorTypeFrequency).sort((a, b) => errorTypeFrequency[b] - errorTypeFrequency[a])[0]
  if (!topErrorType) topErrorType = 'too_short'

  const heroErrorConfig = ERROR_DISPLAY_MAP[topErrorType] || ERROR_DISPLAY_MAP.too_short
  const activeTrackKey = profile?.current_track || 'everyday_english'
  const activeChapterKey = profile?.current_chapter || 'saying_hello'

  const focusHero = {
    tag: 'FOCUS ON THIS NOW',
    title: heroErrorConfig.title === 'Full sentences' ? 'Speaking in full sentences' : heroErrorConfig.title,
    description: topErrorType === 'too_short'
      ? "Right now you often answer in one or two words. We'll turn those into full sentences — one line at a time, no rush."
      : `You've made steady progress! Your main focus now is ${heroErrorConfig.subtitle.toLowerCase()} Let's practice it in your next session.`,
    ctaText: "Start today's practice →",
    ctaUrl: `/chapters`,
  }

  // 9. "What's Hard Right Now" (🧩)
  let hardRightNow = []
  const uniqueErrorMap = new Map()

  for (const err of allErrors) {
    if (err.said && err.correct && err.said !== err.correct) {
      const key = `${err.said.toLowerCase()}->${err.correct.toLowerCase()}`
      if (!uniqueErrorMap.has(key)) {
        uniqueErrorMap.set(key, err)
      }
    }
  }

  const distinctErrors = Array.from(uniqueErrorMap.values()).slice(0, 3)

  if (distinctErrors.length > 0) {
    hardRightNow = distinctErrors.map((err, idx) => {
      const config = ERROR_DISPLAY_MAP[err.error_type] || ERROR_DISPLAY_MAP.grammar
      return {
        id: `err-${err.id || idx}`,
        title: config.title,
        subtitle: err.detail || `You said "${err.said}" instead of "${err.correct}".`,
        statusBadge: err.tier === 'fixFirst' ? 'FOCUS' : (idx === 0 ? 'JUST STARTED' : 'IN PROGRESS'),
        simpleFixLabel: 'Simple fix:',
        simpleFixText: `When speaking, say "${err.correct}" instead of "${err.said}". ${config.simpleFixText}`,
      }
    })
  } else {
    hardRightNow = []
  }

  // 10. "What You're Already Good At" (🌟)
  let alreadyGoodAt = []
  if (Array.isArray(profile?.strengths) && profile.strengths.length > 0) {
    alreadyGoodAt = profile.strengths.slice(0, 3).map((st, i) => ({
      id: `str-${i}`,
      icon: i === 0 ? 'message' : (i === 1 ? 'lightbulb' : 'thumbsUp'),
      title: typeof st === 'string' ? st : (st.title || 'Conversational strength'),
      description: typeof st === 'object' && st.description ? st.description : 'You communicate your thoughts clearly and with confidence.',
    }))
  } else if (totalSessions > 0) {
    alreadyGoodAt = [
      {
        id: 'active-practice',
        icon: 'thumbsUp',
        title: 'Active Practice',
        description: `You have completed ${totalSessions} spoken session${totalSessions > 1 ? 's' : ''} (${totalMinutes} minutes total).`,
      },
      {
        id: 'conversational-intent',
        icon: 'message',
        title: 'Conversational Intent',
        description: 'You express thoughts and ideas with courage and persistence.',
      },
    ]
  } else {
    alreadyGoodAt = []
  }

  // 11. "Your Journey" (📖)
  const currentCatalogTrack = COURSE_CATALOG[activeTrackKey] || COURSE_CATALOG.everyday_english
  const chaptersList = Object.entries(currentCatalogTrack.chapters || {}).map(([key, val]) => ({
    key,
    title: val.title,
  }))

  const completedChapterKeys = new Set(
    completedSessions.map((s) => s.chapter_key).filter(Boolean)
  )

  let activeIndex = chaptersList.findIndex((ch) => ch.key === activeChapterKey)
  if (activeIndex === -1) activeIndex = 0

  const journey = chaptersList.slice(0, 4).map((ch, idx) => {
    let status = 'NEXT'
    if (completedChapterKeys.has(ch.key) || idx < activeIndex) {
      status = 'DONE'
    } else if (idx === activeIndex) {
      status = 'YOU_ARE_HERE'
    } else {
      status = 'NEXT'
    }

    return {
      id: `ch-${ch.key}`,
      stepNumber: status === 'NEXT' ? idx + 1 : undefined,
      title: ch.title,
      status,
    }
  })

  // Learner badge
  const learnerBadge = totalSessions > 0
    ? `LEVEL ${evaluatedLevelCode} LEARNER`
    : 'FOUNDATION LEARNER'

  return {
    learnerName: firstName,
    learnerBadge,
    subtitle: "Here's where your English is today — and the one thing to work on next.",
    stats: {
      daysInARow,
      sentencesFixed,
      currentLevelCode: evaluatedLevelCode,
      levelName: levelInfo.name,
      levelSubtitle: levelInfo.subtitle,
    },
    stages,
    focusHero,
    hardRightNow,
    alreadyGoodAt,
    journey,
  }
}

module.exports = {
  getFluencyDashboardData,
  evaluateLearnerLevel,
  LEVEL_METADATA,
}
