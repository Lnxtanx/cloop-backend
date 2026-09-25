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
        track_preferences: track_preferences || {},
      },
    })

    return res.json({ profile })
  } catch (error) {
    console.error('[Profile API] Error updating profile:', error)
    return res.status(500).json({ error: 'Failed to update profile' })
  }
})

// ============================================================
// RESUME / CV IN-MEMORY PARSING & INTERVIEW CONTEXT ROUTES
// ============================================================

const multer = require('multer')
const { extractResumeText } = require('../../services/resume-parser')
const { structureResumeText } = require('../../services/resume-structurer')

// In-memory upload only: strictly NO saving to disk or S3
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 6 * 1024 * 1024, // 6 MB max file size
  },
  fileFilter: (req, file, cb) => {
    const nameLower = (file.originalname || '').toLowerCase()
    const mimeLower = (file.mimetype || '').toLowerCase()
    if (
      mimeLower.includes('pdf') ||
      mimeLower.includes('word') ||
      mimeLower.includes('text') ||
      nameLower.endsWith('.pdf') ||
      nameLower.endsWith('.docx') ||
      nameLower.endsWith('.txt')
    ) {
      cb(null, true)
    } else {
      cb(new Error('Unsupported file format. Please upload a PDF, DOCX, or TXT file.'))
    }
  },
})

/**
 * POST /api/learner-profile/resume
 * Upload & parse candidate CV in-memory, generate AI briefing, and store in learner profile.
 */
router.post('/resume', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Please select a resume file (PDF, DOCX, or TXT).' })
    }

    const { targetRole, targetCompany } = req.body || {}
    console.log(`📄 [Resume API] Parsing resume for user ${req.userId}: ${req.file.originalname} (${req.file.size} bytes)`)

    // 1. In-memory text extraction
    const rawText = await extractResumeText(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname
    )

    console.log(`📄 [Resume API] Extracted ${rawText.length} characters of clean text. Structuring with AI...`)

    // 2. AI Structuring (DeepSeek / Gemini fallback)
    const structuredData = await structureResumeText(rawText, {
      targetRole: (targetRole || '').trim(),
      targetCompany: (targetCompany || '').trim(),
      candidateName: req.userName,
      userId: req.userId,
    })

    console.log(`✅ [Resume API] Resume structured successfully. Primary role: ${structuredData.primary_role}`)

    // 3. Persist in learner_profiles.track_preferences (No raw file storage)
    let profile = await prisma.learner_profiles.findUnique({
      where: { user_id: req.userId },
    })

    let currentPreferences = profile?.track_preferences || {}
    if (typeof currentPreferences !== 'object' || Array.isArray(currentPreferences)) {
      currentPreferences = {}
    }

    const resumeRecord = {
      fileName: req.file.originalname,
      fileSize: req.file.size,
      uploadedAt: new Date().toISOString(),
      targetRole: (targetRole || '').trim() || structuredData.target_role || structuredData.primary_role,
      targetCompany: (targetCompany || '').trim() || structuredData.target_company || '',
      data: structuredData,
    }

    currentPreferences.interview_prep = {
      ...(currentPreferences.interview_prep || {}),
      resume: resumeRecord,
    }

    const updatedProfile = await prisma.learner_profiles.upsert({
      where: { user_id: req.userId },
      update: {
        track_preferences: currentPreferences,
        updated_at: new Date(),
      },
      create: {
        user_id: req.userId,
        native_language: 'Hindi',
        english_level: 'Beginner',
        track_preferences: currentPreferences,
      },
    })

    return res.json({
      success: true,
      message: 'Resume parsed and interview context prepared successfully!',
      resume: resumeRecord,
    })
  } catch (error) {
    console.error('❌ [Resume API] Error processing resume:', error)
    return res.status(500).json({
      error: error.message || 'Failed to process resume file.',
    })
  }
})

/**
 * GET /api/learner-profile/resume
 * Retrieve the user's active parsed resume profile (if any).
 */
router.get('/resume', async (req, res) => {
  try {
    const profile = await prisma.learner_profiles.findUnique({
      where: { user_id: req.userId },
    })

    const resume = profile?.track_preferences?.interview_prep?.resume || null
    return res.json({ resume })
  } catch (error) {
    console.error('[Resume API] Error fetching resume:', error)
    return res.status(500).json({ error: 'Failed to fetch resume profile' })
  }
})

/**
 * DELETE /api/learner-profile/resume
 * Clear the candidate's saved resume data.
 */
router.delete('/resume', async (req, res) => {
  try {
    const profile = await prisma.learner_profiles.findUnique({
      where: { user_id: req.userId },
    })

    if (profile && profile.track_preferences?.interview_prep?.resume) {
      const currentPreferences = { ...profile.track_preferences }
      if (currentPreferences.interview_prep) {
        delete currentPreferences.interview_prep.resume
      }

      await prisma.learner_profiles.update({
        where: { user_id: req.userId },
        data: {
          track_preferences: currentPreferences,
          updated_at: new Date(),
        },
      })
    }

    return res.json({ success: true, message: 'Saved resume cleared.' })
  } catch (error) {
    console.error('[Resume API] Error clearing resume:', error)
    return res.status(500).json({ error: 'Failed to clear resume' })
  }
})

module.exports = router

