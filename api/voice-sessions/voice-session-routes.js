/**
 * REST API Routes for Voice Practice Sessions (v2)
 */

const express = require('express')
const router = express.Router()
const prisma = require('../../lib/prisma')
const { consolidateSessionErrors } = require('../../services/error-consolidator')

/**
 * Middleware: Verify user auth from Bearer token
 */
function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization token required' })
  }

  const token = authHeader.split(' ')[1]
  const jwt = require('jsonwebtoken')
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key')
    req.userId = decoded.userId || decoded.id || decoded.user_id
    req.userName = decoded.name || 'Learner'
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

router.use(authenticateUser)

/**
 * POST /api/voice-sessions
 * Create a new voice session
 */
router.post('/', async (req, res) => {
  try {
    const { trackKey, chapterKey, mode } = req.body || {}

    if (!trackKey) {
      return res.status(400).json({ error: 'trackKey is required' })
    }

    const session = await prisma.voice_sessions.create({
      data: {
        user_id: req.userId,
        track_key: trackKey,
        chapter_key: chapterKey || 'intro',
        session_mode: mode || 'practice',
        status: 'ACTIVE',
        started_at: new Date(),
      },
    })

    return res.json({ session })
  } catch (error) {
    console.error('[Voice API] Error creating voice session:', error)
    return res.status(500).json({ error: 'Failed to create voice session' })
  }
})

/**
 * GET /api/voice-sessions/:id
 * Get details of a single voice session
 */
router.get('/:id', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id)
    const session = await prisma.voice_sessions.findFirst({
      where: { id: sessionId, user_id: req.userId },
      include: {
        errors: true,
        turns: { orderBy: { sequence: 'asc' } },
      },
    })

    if (!session) {
      return res.status(404).json({ error: 'Voice session not found' })
    }

    return res.json({ session })
  } catch (error) {
    console.error('[Voice API] Error fetching voice session:', error)
    return res.status(500).json({ error: 'Failed to fetch voice session' })
  }
})

/**
 * GET /api/voice-sessions/:id/result
 * Get post-session report with consolidated 3-tier error list and spoken paragraph summary
 */
router.get('/:id/result', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id)
    const session = await prisma.voice_sessions.findFirst({
      where: { id: sessionId, user_id: req.userId },
    })

    if (!session) {
      return res.status(404).json({ error: 'Voice session not found' })
    }

    const consolidated = await consolidateSessionErrors(sessionId)
    return res.json({ result: consolidated, session })
  } catch (error) {
    console.error('[Voice API] Error fetching session result:', error)
    return res.status(500).json({ error: 'Failed to get session result' })
  }
})

/**
 * GET /api/voice-sessions/dashboard
 * Single aggregation endpoint powering the Home Dashboard (design doc Part 2 + 5)
 */
router.get('/dashboard/summary', async (req, res) => {
  try {
    const userId = req.userId

    // 1. Get last completed session for "Continue where you left off"
    const lastSession = await prisma.voice_sessions.findFirst({
      where: { user_id: userId, status: { in: ['COMPLETED', 'ACTIVE'] } },
      orderBy: { created_at: 'desc' },
    })

    let continueSession = null
    if (lastSession) {
      continueSession = {
        trackKey: lastSession.track_key,
        chapterKey: lastSession.chapter_key,
        lastSessionAt: lastSession.completed_at || lastSession.created_at,
      }
    }

    // 2. Get recent sessions for sparkline + today stats
    const recentSessions = await prisma.voice_sessions.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: 10,
      select: { duration_seconds: true, created_at: true, completed_at: true },
    })

    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const todaySessions = recentSessions.filter(
      (s) => s.created_at && new Date(s.created_at) >= todayStart
    )
    const todayMinutes = Math.round(
      todaySessions.reduce((sum, s) => sum + (s.duration_seconds || 0), 0) / 60
    )

    // Last session minutes (the most recent completed session before today, or the previous one)
    const previousSessions = recentSessions.filter(
      (s) => s.created_at && new Date(s.created_at) < todayStart
    )
    const lastSessionMinutes = previousSessions.length > 0
      ? Math.round((previousSessions[0].duration_seconds || 0) / 60)
      : 0

    // Sparkline: last 6 sessions' duration in minutes
    const recentSessionMinutes = recentSessions
      .slice(0, 6)
      .reverse()
      .map((s) => Math.round((s.duration_seconds || 0) / 60))

    // 3. Totals from learner profile
    const profile = await prisma.learner_profiles.findUnique({
      where: { user_id: userId },
    }).catch(() => null)

    const totalSessions = profile?.total_sessions || recentSessions.length
    const totalMinutes = profile?.total_minutes || Math.round(
      recentSessions.reduce((sum, s) => sum + (s.duration_seconds || 0), 0) / 60
    )

    // 4. Latest completed session feedback paragraph and tiers
    const latestCompletedSession = await prisma.voice_sessions.findFirst({
      where: { user_id: userId, status: 'COMPLETED' },
      orderBy: { completed_at: 'desc' },
      include: {
        errors: true,
      },
    })

    const summaryParagraph = latestCompletedSession?.summary_text || (
      totalSessions > 0
        ? `You have completed ${totalSessions} speaking sessions totaling ${totalMinutes} minutes. Your consistency is building strong conversational fluency. Keep practicing daily!`
        : "Welcome to Cloop English! Start your first speaking practice session with Ravi to see your fluency insights, 4 core areas, and error tracking."
    )
    const learnerDidWell = latestCompletedSession?.learner_did_well || (totalSessions > 0 ? "You are speaking regularly and engaging with the tutor." : null)
    const oneThingToFix = latestCompletedSession?.one_thing_to_fix || null

    // 5. Compute the 4 Core Fluency Areas (Part 5.2 of Design Doc)
    // Levels: 'Getting Started' (1) -> 'Coming Along' (2) -> 'Mostly Clear' (3) -> 'Clear' (4)
    const allErrors = await prisma.session_errors.findMany({
      where: { session: { user_id: userId } },
      select: { error_type: true, severity: true, created_at: true },
      take: 200,
    })

    const soundErrors = allErrors.filter(e => ['sound_swap', 'word_stress', 'unclear'].includes(e.error_type)).length
    const smoothErrors = allErrors.filter(e => ['hesitation', 'speed'].includes(e.error_type)).length
    const grammarErrors = allErrors.filter(e => ['grammar', 'sentence_shape', 'word_choice', 'indian_english'].includes(e.error_type)).length
    const lengthErrors = allErrors.filter(e => e.error_type === 'too_short').length

    const getAreaLevel = (errCount, sessionCount) => {
      if (sessionCount === 0) return { level: 'Getting Started', step: 1, percent: 25 }
      const errPerSession = errCount / Math.max(1, sessionCount)
      if (errPerSession <= 0.5) return { level: 'Clear', step: 4, percent: 100 }
      if (errPerSession <= 1.5) return { level: 'Mostly Clear', step: 3, percent: 75 }
      if (errPerSession <= 3.0) return { level: 'Coming Along', step: 2, percent: 50 }
      return { level: 'Getting Started', step: 1, percent: 25 }
    }

    const fluencyAreas = {
      speakingClearly: {
        title: 'Speaking Clearly',
        question: 'Can people understand your words?',
        ...getAreaLevel(soundErrors, totalSessions),
      },
      speakingSmoothly: {
        title: 'Speaking Smoothly',
        question: 'Do you stop and search for words?',
        ...getAreaLevel(smoothErrors, totalSessions),
      },
      speakingCorrectly: {
        title: 'Speaking Correctly',
        question: 'Are your sentences right?',
        ...getAreaLevel(grammarErrors, totalSessions),
      },
      sayingEnough: {
        title: 'Saying Enough',
        question: 'Do you give full answers?',
        ...getAreaLevel(lengthErrors, totalSessions),
      },
    }

    // 6. Top mistakes this week
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const weekErrors = await prisma.session_errors.findMany({
      where: {
        session: { user_id: userId },
        created_at: { gte: weekAgo },
      },
      select: {
        error_type: true,
        said: true,
        correct: true,
        severity: true,
        detail: true,
      },
    })

    // Group and count
    const errorCounts = new Map()
    for (const e of weekErrors) {
      const key = `${(e.said || '').toLowerCase().trim()}->${(e.correct || '').toLowerCase().trim()}`
      if (!key || key === '->') continue
      if (errorCounts.has(key)) {
        errorCounts.get(key).countThisWeek++
      } else {
        errorCounts.set(key, {
          error_type: e.error_type,
          said: e.said,
          correct: e.correct,
          severity: e.severity,
          detail: e.detail,
          countThisWeek: 1,
        })
      }
    }

    const rankedErrors = Array.from(errorCounts.values()).sort((a, b) => b.countThisWeek - a.countThisWeek)
    const topMistakes = rankedErrors.slice(0, 3)

    // 3-Tier Recent Error Lists
    const fixFirst = rankedErrors.filter(e => e.severity === 'blocks_understanding' || e.error_type === 'sentence_shape').slice(0, 3)
    const soundsOff = rankedErrors.filter(e => e.severity === 'sounds_non_native' && !fixFirst.includes(e))
    const smallThings = rankedErrors.filter(e => e.severity === 'minor' || e.error_type === 'indian_english')

    return res.json({
      continueSession,
      todayMinutes,
      lastSessionMinutes,
      recentSessionMinutes,
      totalSessions,
      totalMinutes,
      summaryParagraph,
      learnerDidWell,
      oneThingToFix,
      fluencyAreas,
      topMistakes,
      topMistakeCount: errorCounts.size,
      tiers: {
        fixFirst,
        soundsOff,
        smallThings,
        totalCount: errorCounts.size,
      },
    })
  } catch (error) {
    console.error('[Voice API] Error fetching dashboard:', error)
    return res.status(500).json({ error: 'Failed to fetch dashboard data' })
  }
})

/**
 * GET /api/voice-sessions/history/all
 * List user's recent voice practice sessions
 */
router.get('/history/all', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10
    const sessions = await prisma.voice_sessions.findMany({
      where: { user_id: req.userId },
      orderBy: { created_at: 'desc' },
      take: limit,
      include: {
        _count: { select: { errors: true } },
      },
    })

    return res.json({ sessions })
  } catch (error) {
    console.error('[Voice API] Error fetching session history:', error)
    return res.status(500).json({ error: 'Failed to fetch history' })
  }
})

/**
 * GET /api/voice-sessions/errors/cumulative
 * Enhanced cumulative error view for "My Mistakes" page (design doc Part 5A.5)
 * Returns errors grouped by category (SOUNDS, SENTENCES, SPEAKING) with
 * weekly counts, session trends, 5-dot confidence, and fixed-error detection.
 */
router.get('/errors/cumulative', async (req, res) => {
  try {
    const userId = req.userId

    // Fetch all errors with their session info (last 200 for performance)
    const errors = await prisma.session_errors.findMany({
      where: {
        session: { user_id: userId },
      },
      orderBy: { created_at: 'desc' },
      take: 200,
      include: {
        session: {
          select: {
            id: true,
            track_key: true,
            chapter_key: true,
            duration_seconds: true,
            created_at: true,
          },
        },
      },
    })

    // Get distinct session IDs in order (most recent first) for trend calculation
    const sessionOrder = []
    const sessionSeen = new Set()
    for (const e of errors) {
      if (!sessionSeen.has(e.session.id)) {
        sessionSeen.add(e.session.id)
        sessionOrder.push(e.session.id)
      }
    }
    const last5Sessions = sessionOrder.slice(0, 5)

    const now = new Date()
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

    // Group errors by unique said->correct key
    const grouped = new Map()
    for (const e of errors) {
      const key = `${e.error_type}:${(e.said || '').toLowerCase().trim()}->${(e.correct || '').toLowerCase().trim()}`
      if (!key || key.endsWith(':->')) continue

      if (grouped.has(key)) {
        const item = grouped.get(key)
        item.totalCount++
        if (e.created_at && new Date(e.created_at) >= weekAgo) {
          item.countThisWeek++
        }
        // Track per-session counts for trend
        const sid = e.session.id
        item.sessionCounts[sid] = (item.sessionCounts[sid] || 0) + 1
      } else {
        const sid = e.session.id
        const sessionCounts = {}
        sessionCounts[sid] = 1

        grouped.set(key, {
          error_type: e.error_type,
          said: e.said,
          correct: e.correct,
          detail: e.detail,
          severity: e.severity,
          totalCount: 1,
          countThisWeek: (e.created_at && new Date(e.created_at) >= weekAgo) ? 1 : 0,
          sessionCounts,
        })
      }
    }

    // Build final output with trends and confidence dots
    const mistakes = []
    for (const [, item] of grouped) {
      // Trend: count per session for last 5 sessions (oldest first)
      const trend = last5Sessions
        .slice()
        .reverse()
        .map((sid) => item.sessionCounts[sid] || 0)

      // Confidence dots (0-5): based on recent trend improvement
      // 5 = fixed (0 in last 3), 4 = nearly there, 3 = improving, 2 = stable, 1 = worsening, 0 = new
      const recentCounts = last5Sessions.map((sid) => item.sessionCounts[sid] || 0)
      let confidenceDots = 0
      const last3 = recentCounts.slice(0, 3)

      if (last3.every((c) => c === 0) && item.totalCount > 0) {
        confidenceDots = 5 // Fixed
      } else if (last3.filter((c) => c === 0).length >= 2) {
        confidenceDots = 4 // Nearly there
      } else if (recentCounts.length >= 2 && recentCounts[0] < recentCounts[recentCounts.length - 1]) {
        confidenceDots = 3 // Improving
      } else if (recentCounts.length >= 2 && recentCounts[0] === recentCounts[recentCounts.length - 1]) {
        confidenceDots = 2 // Stable
      } else {
        confidenceDots = 1 // Needs work
      }

      const isFixed = confidenceDots === 5

      // Assign category: SOUNDS, SENTENCES, or SPEAKING
      let category = 'SENTENCES'
      if (['sound_swap', 'word_stress'].includes(item.error_type)) {
        category = 'SOUNDS'
      } else if (['hesitation', 'speed', 'too_short', 'unclear'].includes(item.error_type)) {
        category = 'SPEAKING'
      }

      mistakes.push({
        error_type: item.error_type,
        said: item.said,
        correct: item.correct,
        detail: item.detail,
        severity: item.severity,
        totalCount: item.totalCount,
        countThisWeek: item.countThisWeek,
        trend,
        confidenceDots,
        isFixed,
        category,
      })
    }

    // Sort: fixed items last, then by countThisWeek desc
    mistakes.sort((a, b) => {
      if (a.isFixed !== b.isFixed) return a.isFixed ? 1 : -1
      return b.countThisWeek - a.countThisWeek
    })

    return res.json({ mistakes })
  } catch (error) {
    console.error('[Voice API] Error fetching cumulative errors:', error)
    return res.status(500).json({ error: 'Failed to fetch cumulative errors' })
  }
})

module.exports = router

