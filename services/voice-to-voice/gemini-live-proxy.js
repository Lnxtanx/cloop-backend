/**
 * Gemini Live WebSocket adapter for Voice Practice & Speaking Assessment
 *
 * Maps the app-side browser WebSocket (/ws/assessment, /ws/voice) onto the
 * english-voice agent, which owns the Gemini Live duplex session.
 *
 *   Browser Mic (16kHz PCM16) → WS → this adapter → agent → Gemini Live
 *   Gemini audio (24kHz PCM) → agent → WS → Browser Speaker
 *
 * Transport mechanics live in ai/providers/gemini; session/prompt/tool/DB logic
 * lives in ai/agents/english-voice. This file only handles: upgrade routing,
 * JWT auth, learner-profile + session verification, and client wiring.
 */

const WebSocket = require('ws')
const url = require('url')
const jwt = require('jsonwebtoken')
const prisma = require('../../lib/prisma')
const { createEnglishVoiceAgent } = require('../../ai/agents/english-voice')
const {
	buildConversationPcm,
	parsePcmRate,
	resamplePcm16,
} = require('../../ai/agents/english-voice/audio/pcm')

// Active sessions map: sessionId -> agent
const activeSessions = new Map()

function sendJson(ws, payload) {
	try {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
	} catch (err) {
		console.error('[Voice WS] Error sending to client:', err.message)
	}
}

function handleAssessmentWsUpgrade(server) {
	const wss = new WebSocket.Server({ noServer: true })

	server.on('upgrade', (request, socket, head) => {
		const pathname = url.parse(request.url).pathname
		const isAssessmentWs = pathname === '/ws/assessment' || pathname === '/api/assessment/ws' || pathname.startsWith('/ws/assessment')
		const isVoiceWs = pathname === '/ws/voice' || pathname === '/api/voice/ws' || pathname.startsWith('/ws/voice')

		if (!isAssessmentWs && !isVoiceWs) return

		console.log(`\n======================================================`)
		console.log(`🌐 [Voice WS] Incoming Upgrade request: ${request.url}`)
		console.log(`======================================================`)

		wss.handleUpgrade(request, socket, head, (ws) => {
			wss.emit('connection', ws, request)
		})
	})

	wss.on('connection', async (clientWs, request) => {
		const query = url.parse(request.url, true).query
		const { sessionId, token, trackKey, chapterKey, mode } = query

		const isVoiceSession = Boolean(trackKey) || request.url.includes('/ws/voice')

		console.log(`🔌 [Voice WS] Client connection attempt. Session: ${sessionId}, Type: ${isVoiceSession ? 'Voice Practice' : 'Legacy Assessment'}, Token: ${Boolean(token)}`)

		// Authenticate
		let userId = null
		let userName = 'Learner'
		try {
			const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key')
			userId = decoded.userId || decoded.id || decoded.user_id
			userName = decoded.name || decoded.email || 'Learner'
			console.log(`🔑 [Voice WS] Auth successful. User ID: ${userId} (${userName})`)
		} catch (err) {
			console.error('❌ [Voice WS] Authentication failed:', err.message)
			sendJson(clientWs, { type: 'error', message: 'Authentication failed: ' + err.message })
			clientWs.close(4001, 'Authentication failed')
			return
		}

		if (!sessionId || !userId) {
			console.error('❌ [Voice WS] Missing sessionId or userId')
			sendJson(clientWs, { type: 'error', message: 'Missing sessionId or auth' })
			clientWs.close(4002, 'Missing parameters')
			return
		}

		const sid = parseInt(sessionId)

		// Fetch learner profile or session data
		let learnerProfile = { name: userName, englishLevel: 'Beginner', openErrors: [] }
		try {
			const profile = await prisma.learner_profiles.findUnique({
				where: { user_id: userId },
			})
			if (profile) {
				const resumeData = profile.track_preferences?.interview_prep?.resume || null
				learnerProfile = {
					name: userName,
					englishLevel: profile.english_level || 'Beginner',
					nativeLanguage: profile.native_language || 'Hindi',
					openErrors: Array.isArray(profile.open_errors) ? profile.open_errors : [],
					resumeData: resumeData,
				}
				if (resumeData) {
					console.log(`💼 [Voice WS] Resume context attached for user ${userId}: ${resumeData.targetRole || resumeData.data?.primary_role || resumeData.fileName}`)
				}
			}
		} catch (err) {
			console.error('[Voice WS] Error fetching learner profile:', err)
		}

		// Verify session in DB
		try {
			if (isVoiceSession) {
				let vs = await prisma.voice_sessions.findFirst({
					where: { id: sid, user_id: userId },
				})
				if (!vs) {
					// Auto-create or ensure session exists
					vs = await prisma.voice_sessions.upsert({
						where: { id: sid },
						update: { status: 'IN_PROGRESS', started_at: new Date() },
						create: {
							id: sid,
							user_id: userId,
							track_key: trackKey || 'interview_prep',
							chapter_key: chapterKey || 'telling_about_yourself',
							session_mode: mode || 'practice',
							status: 'IN_PROGRESS',
							started_at: new Date(),
						},
					})
				}
				console.log(`✅ [Voice WS] Voice session ${sid} verified in database. Status: ${vs.status}`)
			} else {
				const session = await prisma.assessment_sessions.findFirst({
					where: { id: sid, user_id: userId },
				})
				if (session) {
					console.log(`✅ [Voice WS] Assessment session ${sid} verified in database. Status: ${session.status}`)
				}
			}
		} catch (err) {
			console.error('❌ [Voice WS] DB verification error:', err)
		}

		// Create the agent and wire the client socket
		const agent = createEnglishVoiceAgent({
			session: {
				sessionId: sid,
				userId,
				userName,
				isVoiceSession,
				trackKey: trackKey || 'interview_prep',
				chapterKey: chapterKey || 'telling_about_yourself',
				mode: mode || 'practice',
			},
			learnerProfile,
			client: {
				send: (payload) => sendJson(clientWs, payload),
				close: (code, reason) => {
					try {
						clientWs.close(code, reason)
					} catch (_) {}
				},
			},
		})

		activeSessions.set(sid, agent)

		// Handle client messages (audio chunks, end_session trigger)
		clientWs.on('message', (data) => {
			let parsed
			try {
				parsed = JSON.parse(data.toString())
			} catch {
				return
			}
			agent.handleClientMessage(parsed).catch((err) => {
				console.error('[Voice WS] Error handling client message:', err)
			})
		})

		clientWs.on('close', () => {
			agent.handleClientClose().catch((err) => {
				console.error('[Voice WS] Error during client-close cleanup:', err)
			})
			activeSessions.delete(sid)
		})

		await agent.start()
	})
}

module.exports = {
	handleAssessmentWsUpgrade,
	buildConversationPcm,
	parsePcmRate,
	resamplePcm16,
}
