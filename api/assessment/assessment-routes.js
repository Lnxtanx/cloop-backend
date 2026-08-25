/**
 * English Speaking Assessment API Routes
 * Completely independent from existing voice-chat routes
 */

const express = require('express')
const router = express.Router()
const prisma = require('../../lib/prisma')
const { authenticateToken } = require('../../middleware/auth')

// All routes require authentication
router.use(authenticateToken)

/**
 * POST /api/assessment/sessions
 * Create a new assessment session
 */
router.post('/sessions', async (req, res) => {
	const userId = req.user?.user_id || req.user?.id || req.user?.userId
	if (!userId) return res.status(401).json({ error: 'Authentication required' })

	try {
		const session = await prisma.assessment_sessions.create({
			data: {
				user_id: userId,
				status: 'NOT_STARTED',
				assessment_status: 'PENDING',
			},
			select: {
				id: true,
				status: true,
				assessment_status: true,
				created_at: true,
			},
		})

		console.log(`[Assessment] Session ${session.id} created for user ${userId}`)
		return res.status(201).json({ session })
	} catch (error) {
		console.error('[Assessment] Error creating session:', error)
		return res.status(500).json({ error: 'Failed to create assessment session' })
	}
})

/**
 * GET /api/assessment/sessions
 * List user's assessment sessions (most recent first)
 */
router.get('/sessions', async (req, res) => {
	const userId = req.user?.user_id || req.user?.id || req.user?.userId
	if (!userId) return res.status(401).json({ error: 'Authentication required' })

	const limit = Math.min(parseInt(req.query.limit) || 20, 50)

	try {
		const sessions = await prisma.assessment_sessions.findMany({
			where: { user_id: userId },
			orderBy: { created_at: 'desc' },
			take: limit,
			select: {
				id: true,
				status: true,
				assessment_status: true,
				started_at: true,
				completed_at: true,
				duration_seconds: true,
				question_count: true,
				overall_score: true,
				created_at: true,
			},
		})

		return res.json({ sessions })
	} catch (error) {
		console.error('[Assessment] Error listing sessions:', error)
		return res.status(500).json({ error: 'Failed to list assessment sessions' })
	}
})

/**
 * GET /api/assessment/sessions/:id
 * Get session state (ownership enforced)
 */
router.get('/sessions/:id', async (req, res) => {
	const userId = req.user?.user_id || req.user?.id || req.user?.userId
	if (!userId) return res.status(401).json({ error: 'Authentication required' })

	const sessionId = parseInt(req.params.id)
	if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' })

	try {
		const session = await prisma.assessment_sessions.findFirst({
			where: { id: sessionId, user_id: userId },
			select: {
				id: true,
				status: true,
				assessment_status: true,
				started_at: true,
				completed_at: true,
				duration_seconds: true,
				question_count: true,
				overall_score: true,
				created_at: true,
				updated_at: true,
			},
		})

		if (!session) return res.status(404).json({ error: 'Session not found' })
		return res.json({ session })
	} catch (error) {
		console.error('[Assessment] Error fetching session:', error)
		return res.status(500).json({ error: 'Failed to fetch session' })
	}
})

/**
 * POST /api/assessment/sessions/:id/complete
 * Mark session as completed and trigger async assessment processing
 */
router.post('/sessions/:id/complete', async (req, res) => {
	const userId = req.user?.user_id || req.user?.id || req.user?.userId
	if (!userId) return res.status(401).json({ error: 'Authentication required' })

	const sessionId = parseInt(req.params.id)
	if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' })

	try {
		// Verify ownership and current status
		const session = await prisma.assessment_sessions.findFirst({
			where: { id: sessionId, user_id: userId },
		})

		if (!session) return res.status(404).json({ error: 'Session not found' })
		if (session.status === 'COMPLETED') {
			return res.status(400).json({ error: 'Session already completed' })
		}

		const { questionCount, durationSeconds } = req.body || {}

		// Mark session as completed
		const updated = await prisma.assessment_sessions.update({
			where: { id: sessionId },
			data: {
				status: 'COMPLETED',
				assessment_status: 'PROCESSING',
				completed_at: new Date(),
				duration_seconds: durationSeconds || session.duration_seconds || 0,
				question_count: questionCount || session.question_count || 0,
				updated_at: new Date(),
			},
			select: {
				id: true,
				status: true,
				assessment_status: true,
				completed_at: true,
				duration_seconds: true,
				question_count: true,
			},
		})

		// Flush in-memory turns to database
		const { flushSessionTurns } = require('../../services/gemini-live-proxy')
		if (flushSessionTurns) {
			await flushSessionTurns(sessionId).catch((err) => {
				console.error(`[Assessment] Error flushing turns for session ${sessionId}:`, err)
			})
		}

		// Check if session was already evaluated natively by Gemini Live in-session tool
		const latestSession = await prisma.assessment_sessions.findUnique({
			where: { id: sessionId },
		})

		if (latestSession && latestSession.assessment_status === 'READY') {
			console.log(`✅ [Assessment] Session ${sessionId} was already evaluated natively by Gemini Live tool!`)
			return res.json({ session: latestSession, message: 'Assessment ready' })
		}

		console.log(`[Assessment] Session ${sessionId} triggering fallback evaluation engine`)

		// Trigger async assessment processing (fallback)
		const { processAssessment } = require('../../services/assessment-engine')
		setImmediate(() => {
			processAssessment(sessionId).catch((err) => {
				console.error(`[Assessment] Background processing failed for session ${sessionId}:`, err)
			})
		})

		return res.json({ session: updated, message: 'Assessment processing started' })
	} catch (error) {
		console.error('[Assessment] Error completing session:', error)
		return res.status(500).json({ error: 'Failed to complete session' })
	}
})

/**
 * GET /api/assessment/sessions/:id/result
 * Get the completed assessment result (ownership enforced)
 */
router.get('/sessions/:id/result', async (req, res) => {
	const userId = req.user?.user_id || req.user?.id || req.user?.userId
	if (!userId) return res.status(401).json({ error: 'Authentication required' })

	const sessionId = parseInt(req.params.id)
	if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' })

	try {
		// Verify ownership
		const session = await prisma.assessment_sessions.findFirst({
			where: { id: sessionId, user_id: userId },
			select: {
				id: true,
				status: true,
				assessment_status: true,
				duration_seconds: true,
				question_count: true,
				started_at: true,
				completed_at: true,
			},
		})

		if (!session) return res.status(404).json({ error: 'Session not found' })

		if (session.assessment_status !== 'READY') {
			return res.json({
				session,
				result: null,
				metrics: [],
				errors: [],
				message: session.assessment_status === 'PROCESSING'
					? 'Assessment is still being analyzed'
					: session.assessment_status === 'FAILED'
						? 'Assessment processing failed'
						: 'Assessment not yet started',
			})
		}

		const [result, metrics, errors] = await Promise.all([
			prisma.assessment_results.findUnique({
				where: { session_id: sessionId },
			}),
			prisma.assessment_metrics.findMany({
				where: { session_id: sessionId },
				orderBy: { dimension: 'asc' },
			}),
			prisma.assessment_errors.findMany({
				where: { session_id: sessionId },
				orderBy: { created_at: 'asc' },
			}),
		])

		return res.json({ session, result, metrics, errors })
	} catch (error) {
		console.error('[Assessment] Error fetching result:', error)
		return res.status(500).json({ error: 'Failed to fetch assessment result' })
	}
})

/**
 * GET /api/assessment/sessions/:id/turns
 * Get session turns/transcript (ownership enforced)
 */
router.get('/sessions/:id/turns', async (req, res) => {
	const userId = req.user?.user_id || req.user?.id || req.user?.userId
	if (!userId) return res.status(401).json({ error: 'Authentication required' })

	const sessionId = parseInt(req.params.id)
	if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' })

	try {
		const session = await prisma.assessment_sessions.findFirst({
			where: { id: sessionId, user_id: userId },
			select: { id: true },
		})

		if (!session) return res.status(404).json({ error: 'Session not found' })

		const turns = await prisma.assessment_turns.findMany({
			where: { session_id: sessionId },
			orderBy: { sequence: 'asc' },
			select: {
				id: true,
				sequence: true,
				speaker: true,
				content: true,
				start_time: true,
				end_time: true,
				duration_ms: true,
				created_at: true,
			},
		})

		return res.json({ turns })
	} catch (error) {
		console.error('[Assessment] Error fetching turns:', error)
		return res.status(500).json({ error: 'Failed to fetch session turns' })
	}
})

module.exports = router
