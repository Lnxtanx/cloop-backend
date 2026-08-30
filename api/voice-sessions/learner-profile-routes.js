/**
 * REST API Routes for Learner Profile
 */

const express = require('express')
const router = express.Router()
const prisma = require('../../lib/prisma')

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
 * GET /api/learner-profile
 * Get the current learner's profile
 */
router.get('/', async (req, res) => {
  try {
    let profile = await prisma.learner_profiles.findUnique({
      where: { user_id: req.userId },
    })

    if (!profile) {
      // Create initial default profile
      profile = await prisma.learner_profiles.create({
        data: {
          user_id: req.userId,
          native_language: 'Hindi',
          english_level: 'Beginner',
          total_sessions: 0,
          total_minutes: 0,
        },
      })
    }

    return res.json({ profile })
  } catch (error) {
    console.error('[Profile API] Error fetching profile:', error)
    return res.status(500).json({ error: 'Failed to fetch profile' })
  }
})

/**
 * PUT /api/learner-profile
 * Update learner's profile preferences
 */
router.put('/', async (req, res) => {
  try {
    const { native_language, english_level, track_preferences } = req.body || {}

    const profile = await prisma.learner_profiles.upsert({
      where: { user_id: req.userId },
      update: {
        native_language: native_language !== undefined ? native_language : undefined,
        english_level: english_level !== undefined ? english_level : undefined,
        track_preferences: track_preferences !== undefined ? track_preferences : undefined,
        updated_at: new Date(),
      },
      create: {
        user_id: req.userId,
        native_language: native_language || 'Hindi',
        english_level: english_level || 'Beginner',
        track_preferences: track_preferences || [],
      },
    })

    return res.json({ profile })
  } catch (error) {
    console.error('[Profile API] Error updating profile:', error)
    return res.status(500).json({ error: 'Failed to update profile' })
  }
})

module.exports = router
