/**
 * Gemini Live WebSocket Proxy for English Speaking Assessment
 * 
 * Handles the realtime audio path:
 *   Browser Mic → WS → Backend Proxy → Gemini Live API → Audio response → WS → Browser Speaker
 * 
 * Completely separate from existing voice-chat routes.
 * The Gemini API key stays server-side.
 */

const WebSocket = require('ws')
const url = require('url')
const jwt = require('jsonwebtoken')
const prisma = require('../lib/prisma')

const GEMINI_API_KEY = () => process.env.GEMINI_API_KEY
const GEMINI_MODEL = 'gemini-3.1-flash-live-preview'
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`

// Active sessions map: sessionId -> { geminiWs, clientWs, turns, ... }
const activeSessions = new Map()

// System prompt for the English interview assessor
const INTERVIEWER_SYSTEM_PROMPT = `You are Eva, a warm, professional English speaking assessment interviewer. You are conducting a natural English conversation to evaluate the speaker's English proficiency.

IMPORTANT RULES:
- Speak naturally and warmly, like a real human interviewer
- Do NOT mention that you are AI, a language model, or that you are evaluating them
- Do NOT give scores, corrections, or feedback during the conversation
- Ask clear, open-ended questions and listen attentively
- Ask follow-up questions based on the user's actual responses
- Keep your responses concise (2-3 sentences max) so the user speaks more than you
- Be encouraging but not excessively so
- If the user's response is unclear, politely ask them to elaborate

INTERVIEW STRUCTURE (follow this order, adapting based on responses):

Question 1 — Introduction:
Start with a warm greeting, then ask "Tell me a bit about yourself."

Question 2 — Background:
Ask about what they are currently studying or working on.

Question 3 — Experience:
Ask them to describe a project, achievement, or experience they are proud of.

Question 4 — Reasoning:
Ask about a challenge they faced and how they solved it.

Question 5 — Adaptive Follow-up:
Based on their previous answer, ask a deeper follow-up question that tests their ability to explain complex ideas.

After completing at least 5 questions (and any necessary follow-ups), say: "Thank you so much for this conversation! It was great speaking with you. That concludes our session."

CONVERSATIONAL GUIDELINES:
- Progressively test: basic communication → description → narrative → vocabulary → reasoning → complex explanation
- Maintain context from previous answers to make follow-up questions natural
- If the user gives very short answers, gently encourage elaboration
- Keep the conversation flowing naturally`

/**
 * Handle WebSocket upgrade for /ws/assessment
 */
function handleAssessmentWsUpgrade(server) {
	const wss = new WebSocket.Server({ noServer: true })

	server.on('upgrade', (request, socket, head) => {
		const pathname = url.parse(request.url).pathname
		if (pathname !== '/ws/assessment') return

		wss.handleUpgrade(request, socket, head, (ws) => {
			wss.emit('connection', ws, request)
		})
	})

	wss.on('connection', async (clientWs, request) => {
		const query = url.parse(request.url, true).query
		const { sessionId, token } = query

		// Authenticate
		let userId = null
		try {
			const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key')
			userId = decoded.userId || decoded.id || decoded.user_id
		} catch (err) {
			console.error('[Gemini WS] Auth failed:', err.message)
			clientWs.send(JSON.stringify({ type: 'error', message: 'Authentication failed' }))
			clientWs.close(4001, 'Authentication failed')
			return
		}

		if (!sessionId || !userId) {
			clientWs.send(JSON.stringify({ type: 'error', message: 'Missing sessionId or auth' }))
			clientWs.close(4002, 'Missing parameters')
			return
		}

		const sid = parseInt(sessionId)

		// Verify session ownership
		try {
			const session = await prisma.assessment_sessions.findFirst({
				where: { id: sid, user_id: userId },
			})
			if (!session) {
				clientWs.send(JSON.stringify({ type: 'error', message: 'Session not found' }))
				clientWs.close(4004, 'Session not found')
				return
			}
		} catch (err) {
			console.error('[Gemini WS] DB error:', err)
			clientWs.close(4500, 'Server error')
			return
		}

		console.log(`[Gemini WS] Client connected: session=${sid}, user=${userId}`)

		// Session state
		const sessionState = {
			sessionId: sid,
			userId,
			turns: [],
			currentTurnText: '',
			currentSpeaker: null,
			turnSequence: 0,
			questionCount: 0,
			startedAt: new Date(),
		}

		// Connect to Gemini Live
		const apiKey = GEMINI_API_KEY()
		if (!apiKey) {
			clientWs.send(JSON.stringify({ type: 'error', message: 'Gemini API key not configured' }))
			clientWs.close(4500, 'API key missing')
			return
		}

		const geminiUrl = `${GEMINI_WS_URL}?key=${apiKey}`
		let geminiWs = null

		try {
			geminiWs = new WebSocket(geminiUrl)
		} catch (err) {
			console.error('[Gemini WS] Failed to create Gemini connection:', err)
			clientWs.send(JSON.stringify({ type: 'error', message: 'Failed to connect to Gemini' }))
			clientWs.close(4500, 'Connection failed')
			return
		}

		activeSessions.set(sid, { geminiWs, clientWs, sessionState })

		geminiWs.on('open', () => {
			console.log(`[Gemini WS] Connected to Gemini Live for session ${sid}`)

			// Send setup message
			const setupMsg = {
				setup: {
					model: `models/${GEMINI_MODEL}`,
					generationConfig: {
						responseModalities: ['AUDIO'],
						speechConfig: {
							voiceConfig: {
								prebuiltVoiceConfig: {
									voiceName: 'Aoede',
								},
							},
						},
					},
					systemInstruction: {
						parts: [{ text: INTERVIEWER_SYSTEM_PROMPT }],
					},
				},
			}

			geminiWs.send(JSON.stringify(setupMsg))
		})

		geminiWs.on('message', (data) => {
			try {
				const msg = JSON.parse(data.toString())

				// Setup complete
				if (msg.setupComplete) {
					console.log(`[Gemini WS] Setup complete for session ${sid}`)

					// Update session status
					prisma.assessment_sessions.update({
						where: { id: sid },
						data: { status: 'IN_PROGRESS', started_at: new Date(), updated_at: new Date() },
					}).catch(err => console.error('[Gemini WS] DB update error:', err))

					clientWs.send(JSON.stringify({ type: 'setup_complete' }))

					// Send initial prompt to start conversation
					const initialMsg = {
						clientContent: {
							turns: [
								{
									role: 'user',
									parts: [{ text: 'Please start the interview by greeting me warmly and asking your first question.' }],
								},
							],
							turnComplete: true,
						},
					}
					geminiWs.send(JSON.stringify(initialMsg))
					return
				}

				// Server content (audio/text from Gemini)
				if (msg.serverContent) {
					const content = msg.serverContent

					// Extract text parts for transcript
					if (content.modelTurn && content.modelTurn.parts) {
						for (const part of content.modelTurn.parts) {
							// Audio data — relay to client
							if (part.inlineData) {
								clientWs.send(JSON.stringify({
									type: 'audio',
									data: part.inlineData.data,
									mimeType: part.inlineData.mimeType,
								}))
							}
							// Text transcript from Gemini
							if (part.text) {
								sessionState.currentSpeaker = 'ai'
								sessionState.currentTurnText += part.text
							}
						}
					}

					// Turn complete — save the AI turn
					if (content.turnComplete) {
						if (sessionState.currentTurnText && sessionState.currentSpeaker === 'ai') {
							sessionState.turnSequence++
							sessionState.turns.push({
								sequence: sessionState.turnSequence,
								speaker: 'ai',
								content: sessionState.currentTurnText.trim(),
								timestamp: new Date(),
							})

							// Count AI questions (rough heuristic: AI turns with ? mark)
							if (sessionState.currentTurnText.includes('?')) {
								sessionState.questionCount++
							}

							clientWs.send(JSON.stringify({
								type: 'turn_complete',
								speaker: 'ai',
								questionCount: sessionState.questionCount,
							}))
						}
						sessionState.currentTurnText = ''
						sessionState.currentSpeaker = null
					}

					// Interrupted
					if (content.interrupted) {
						clientWs.send(JSON.stringify({ type: 'interrupted' }))
						sessionState.currentTurnText = ''
					}
				}

				// Tool calls if any (forward to client for handling)
				if (msg.toolCall) {
					clientWs.send(JSON.stringify({ type: 'tool_call', data: msg.toolCall }))
				}

			} catch (err) {
				console.error('[Gemini WS] Error processing Gemini message:', err)
			}
		})

		geminiWs.on('error', (err) => {
			console.error(`[Gemini WS] Gemini connection error for session ${sid}:`, err.message)
			clientWs.send(JSON.stringify({ type: 'error', message: 'Gemini connection error' }))
		})

		geminiWs.on('close', (code, reason) => {
			console.log(`[Gemini WS] Gemini disconnected for session ${sid}: ${code} ${reason}`)
			clientWs.send(JSON.stringify({ type: 'gemini_disconnected', code }))
		})

		// Handle client messages (audio from microphone)
		clientWs.on('message', (data) => {
			try {
				// Check if it's a binary audio message or JSON control message
				if (typeof data === 'string' || data instanceof Buffer) {
					let parsed
					try {
						parsed = JSON.parse(data.toString())
					} catch {
						// Binary audio data — should not happen with our protocol
						return
					}

					// Control messages from client
					if (parsed.type === 'audio_chunk') {
						// User audio chunk — forward to Gemini
						if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
							const realtimeMsg = {
								realtimeInput: {
									mediaChunks: [
										{
											mimeType: parsed.mimeType || 'audio/pcm;rate=16000',
											data: parsed.data,
										},
									],
								},
							}
							geminiWs.send(JSON.stringify(realtimeMsg))
						}
					} else if (parsed.type === 'user_transcript') {
						// User text/transcript for record-keeping
						sessionState.turnSequence++
						sessionState.turns.push({
							sequence: sessionState.turnSequence,
							speaker: 'user',
							content: parsed.text || '',
							timestamp: new Date(),
						})
					} else if (parsed.type === 'end_session') {
						// Client requested session end
						console.log(`[Gemini WS] Client ending session ${sid}`)
						if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
							geminiWs.close(1000, 'Session ended by user')
						}
						persistSessionData(sessionState)
					}
				}
			} catch (err) {
				console.error('[Gemini WS] Error handling client message:', err)
			}
		})

		clientWs.on('close', () => {
			console.log(`[Gemini WS] Client disconnected for session ${sid}`)
			if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
				geminiWs.close(1000, 'Client disconnected')
			}
			persistSessionData(sessionState)
			activeSessions.delete(sid)
		})

		clientWs.on('error', (err) => {
			console.error(`[Gemini WS] Client WS error for session ${sid}:`, err.message)
		})
	})

	return wss
}

/**
 * Persist accumulated session data (turns) to database
 */
async function persistSessionData(sessionState) {
	const { sessionId, turns, questionCount, startedAt } = sessionState

	try {
		// Save all turns
		if (turns.length > 0) {
			const turnData = turns.map((t) => ({
				session_id: sessionId,
				sequence: t.sequence,
				speaker: t.speaker,
				content: t.content,
				start_time: t.timestamp,
				duration_ms: 0,
			}))

			await prisma.assessment_turns.createMany({
				data: turnData,
				skipDuplicates: true,
			})
		}

		// Update session metadata
		const durationSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000)
		await prisma.assessment_sessions.update({
			where: { id: sessionId },
			data: {
				question_count: questionCount,
				duration_seconds: durationSeconds,
				updated_at: new Date(),
			},
		})

		console.log(`[Gemini WS] Persisted ${turns.length} turns for session ${sessionId}`)
	} catch (err) {
		console.error(`[Gemini WS] Error persisting session data for ${sessionId}:`, err)
	}
}

module.exports = { handleAssessmentWsUpgrade }
