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
 * GET /api/voice-sessions/history
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
 * Get cumulative error patterns for the "My Mistakes" dashboard
 */
router.get('/errors/cumulative', async (req, res) => {
  try {
    const errors = await prisma.session_errors.findMany({
      where: {
        session: { user_id: req.userId },
      },
      orderBy: { created_at: 'desc' },
      take: 100,
      include: {
        session: { select: { track_key: true, chapter_key: true, created_at: true } },
      },
    })

    // Group errors by said->correct
    const grouped = new Map()
    for (const e of errors) {
      const key = `${e.error_type}:${(e.said || '').toLowerCase()}->${(e.correct || '').toLowerCase()}`
      if (grouped.has(key)) {
        const item = grouped.get(key)
        item.count++
        item.recentSessions.push(e.session.created_at)
      } else {
        grouped.set(key, {
          error_type: e.error_type,
          said: e.said,
          correct: e.correct,
          detail: e.detail,
          severity: e.severity,
          count: 1,
          recentSessions: [e.session.created_at],
        })
      }
    }

    return res.json({ mistakes: Array.from(grouped.values()) })
  } catch (error) {
    console.error('[Voice API] Error fetching cumulative errors:', error)
    return res.status(500).json({ error: 'Failed to fetch cumulative errors' })
  }
})

module.exports = router
