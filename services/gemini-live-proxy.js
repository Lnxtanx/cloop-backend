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
const GEMINI_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview'
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent`

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

		console.log(`\n======================================================`)
		console.log(`🌐 [Assessment WS] Incoming Upgrade request: ${request.url}`)
		console.log(`======================================================`)

		wss.handleUpgrade(request, socket, head, (ws) => {
			wss.emit('connection', ws, request)
		})
	})

	wss.on('connection', async (clientWs, request) => {
		const query = url.parse(request.url, true).query
		const { sessionId, token } = query

		console.log(`🔌 [Assessment WS] Client connection attempt. Session: ${sessionId}, Token present: ${Boolean(token)}`)

		// Authenticate
		let userId = null
		try {
			const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key')
			userId = decoded.userId || decoded.id || decoded.user_id
			console.log(`🔑 [Assessment WS] Auth successful. User ID: ${userId} (${decoded.name || decoded.email || 'guest'})`)
		} catch (err) {
			console.error('❌ [Assessment WS] Authentication failed:', err.message)
			clientWs.send(JSON.stringify({ type: 'error', message: 'Authentication failed: ' + err.message }))
			clientWs.close(4001, 'Authentication failed')
			return
		}

		if (!sessionId || !userId) {
			console.error('❌ [Assessment WS] Missing sessionId or userId')
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
				console.error(`❌ [Assessment WS] Session ${sid} not found for user ${userId}`)
				clientWs.send(JSON.stringify({ type: 'error', message: 'Session not found' }))
				clientWs.close(4004, 'Session not found')
				return
			}
			console.log(`✅ [Assessment WS] Session ${sid} verified in database. Status: ${session.status}`)
		} catch (err) {
			console.error('❌ [Assessment WS] DB verification error:', err)
			clientWs.close(4500, 'Server error')
			return
		}

		// Session state
		const sessionState = {
			sessionId: sid,
			userId,
			turns: [],
			currentTurnText: '',
			currentSpeaker: null,
			turnSequence: 0,
			questionCount: 0,
			userAudioChunksCount: 0,
			aiAudioChunksCount: 0,
			startedAt: new Date(),
		}

		// Connect to Gemini Live
		const apiKey = GEMINI_API_KEY()
		if (!apiKey) {
			console.error('❌ [Assessment WS] GEMINI_API_KEY is missing in backend .env')
			clientWs.send(JSON.stringify({ type: 'error', message: 'Gemini API key not configured on server' }))
			clientWs.close(4500, 'API key missing')
			return
		}

		const geminiUrl = `${GEMINI_WS_URL}?key=${apiKey}`
		console.log(`🤖 [Assessment WS] Connecting to Gemini Live (${GEMINI_MODEL}) at Google...`)
		let geminiWs = null

		try {
			geminiWs = new WebSocket(geminiUrl)
		} catch (err) {
			console.error('❌ [Assessment WS] Failed to create Gemini WebSocket:', err)
			clientWs.send(JSON.stringify({ type: 'error', message: 'Failed to connect to Gemini Live' }))
			clientWs.close(4500, 'Connection failed')
			return
		}

		activeSessions.set(sid, { geminiWs, clientWs, sessionState })

		geminiWs.on('open', () => {
			console.log(`✅ [Assessment WS] Connected to Gemini Live for session ${sid}! Sending initial setup...`)

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
					console.log(`🎉 [Assessment WS] Setup complete from Gemini for session ${sid}! Eva is ready.`)

					// Update session status
					prisma.assessment_sessions.update({
						where: { id: sid },
						data: { status: 'IN_PROGRESS', started_at: new Date(), updated_at: new Date() },
					}).catch(err => console.error('[Assessment WS] DB update error:', err))

					clientWs.send(JSON.stringify({ type: 'setup_complete' }))

					// Send initial prompt to start conversation
					console.log(`📣 [Assessment WS] Triggering Eva to begin greeting and first question...`)
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

					// 1. Audio data from Gemini
					if (content.modelTurn && content.modelTurn.parts) {
						for (const part of content.modelTurn.parts) {
							if (part.inlineData) {
								sessionState.aiAudioChunksCount++
								if (sessionState.aiAudioChunksCount % 20 === 1) {
									console.log(`🔊 [Assessment WS] Eva speaking... (Relayed ${sessionState.aiAudioChunksCount} audio chunks to user)`)
								}
								clientWs.send(JSON.stringify({
									type: 'audio',
									data: part.inlineData.data,
									mimeType: part.inlineData.mimeType,
								}))
							}
							if (part.text) {
								sessionState.currentAiText = (sessionState.currentAiText || '') + part.text
							}
						}
					}

					// 2. Real-time transcriptions from Gemini Live
					if (content.outputTranscription?.text) {
						sessionState.currentAiText = (sessionState.currentAiText || '') + content.outputTranscription.text
					}

					if (content.inputTranscription?.text) {
						sessionState.currentUserText = (sessionState.currentUserText || '') + content.inputTranscription.text
					}

					// 3. User turn finished (when user stops speaking)
					if (sessionState.currentUserText && sessionState.currentUserText.trim().length > 3 && content.modelTurn) {
						sessionState.turnSequence++
						const userTurnText = sessionState.currentUserText.trim()
						console.log(`\n🗣️ [Candidate Transcript Turn ${sessionState.turnSequence}]: "${userTurnText}"`)
						sessionState.turns.push({
							sequence: sessionState.turnSequence,
							speaker: 'user',
							content: userTurnText,
							timestamp: new Date(),
						})
						sessionState.currentUserText = ''
					}

					// 4. AI Turn complete — save the AI turn
					if (content.turnComplete) {
						const turnContent = (sessionState.currentAiText || '').trim()
						if (turnContent) {
							sessionState.turnSequence++
							console.log(`\n💬 [Eva Transcript Turn ${sessionState.turnSequence}]: "${turnContent}"`)

							sessionState.turns.push({
								sequence: sessionState.turnSequence,
								speaker: 'ai',
								content: turnContent,
								timestamp: new Date(),
							})

							if (turnContent.includes('?')) {
								sessionState.questionCount++
								console.log(`❓ [Assessment WS] Question count: ${sessionState.questionCount}`)
							}

							clientWs.send(JSON.stringify({
								type: 'turn_complete',
								speaker: 'ai',
								questionCount: sessionState.questionCount,
							}))
						}
						sessionState.currentAiText = ''
					}

					// 5. Interrupted
					if (content.interrupted) {
						console.log(`⚡ [Assessment WS] Interruption detected from user speech`)
						// If Eva had spoken something, keep it recorded before clearing
						if (sessionState.currentAiText && sessionState.currentAiText.trim().length > 5) {
							sessionState.turnSequence++
							sessionState.turns.push({
								sequence: sessionState.turnSequence,
								speaker: 'ai',
								content: sessionState.currentAiText.trim() + ' [interrupted]',
								timestamp: new Date(),
							})
						}
						clientWs.send(JSON.stringify({ type: 'interrupted' }))
						sessionState.currentAiText = ''
					}
				}

				// Tool calls if any
				if (msg.toolCall) {
					clientWs.send(JSON.stringify({ type: 'tool_call', data: msg.toolCall }))
				}

			} catch (err) {
				console.error('❌ [Assessment WS] Error processing Gemini message:', err)
			}
		})

		geminiWs.on('error', (err) => {
			console.error(`❌ [Assessment WS] Gemini Live connection error for session ${sid}:`, err.message)
			clientWs.send(JSON.stringify({ type: 'error', message: 'Gemini Live error: ' + err.message }))
		})

		geminiWs.on('close', (code, reason) => {
			console.log(`🔌 [Assessment WS] Gemini Live disconnected for session ${sid}: code=${code}, reason=${reason?.toString() || 'normal'}`)
			clientWs.send(JSON.stringify({ type: 'gemini_disconnected', code, reason: reason?.toString() }))
		})

		// Handle client messages (audio from microphone)
		clientWs.on('message', (data) => {
			try {
				if (typeof data === 'string' || data instanceof Buffer) {
					let parsed
					try {
						parsed = JSON.parse(data.toString())
					} catch {
						return
					}

					// User audio chunk — forward to Gemini
					if (parsed.type === 'audio_chunk') {
						sessionState.userAudioChunksCount++
						if (sessionState.userAudioChunksCount % 20 === 1) {
							console.log(`🎤 [Assessment WS] Streaming microphone audio to Gemini (Chunk #${sessionState.userAudioChunksCount})`)
						}
						if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
							const realtimeMsg = {
								realtimeInput: {
									audio: {
										mimeType: parsed.mimeType || 'audio/pcm;rate=16000',
										data: parsed.data,
									},
								},
							}
							geminiWs.send(JSON.stringify(realtimeMsg))
						}
					} else if (parsed.type === 'user_transcript') {
						sessionState.turnSequence++
						console.log(`🗣️ [User Transcript Turn ${sessionState.turnSequence}]: "${parsed.text}"`)
						sessionState.turns.push({
							sequence: sessionState.turnSequence,
							speaker: 'user',
							content: parsed.text || '',
							timestamp: new Date(),
						})
					} else if (parsed.type === 'end_session') {
						console.log(`🛑 [Assessment WS] User requested session end for session ${sid}`)
						if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
							geminiWs.close(1000, 'Session ended by user')
						}
						persistSessionData(sessionState)
					}
				}
			} catch (err) {
				console.error('❌ [Assessment WS] Error handling client message:', err)
			}
		})

		clientWs.on('close', (code, reason) => {
			console.log(`🔌 [Assessment WS] Client browser disconnected for session ${sid} (code=${code})`)
			if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
				geminiWs.close(1000, 'Client disconnected')
			}
			persistSessionData(sessionState)
			activeSessions.delete(sid)
		})

		clientWs.on('error', (err) => {
			console.error(`❌ [Assessment WS] Client WS connection error for session ${sid}:`, err.message)
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

/**
 * Flush active in-memory turns for a session to DB immediately
 */
async function flushSessionTurns(sessionId) {
	const active = activeSessions.get(sessionId)
	if (active && active.sessionState) {
		await persistSessionData(active.sessionState)
	}
}

module.exports = { handleAssessmentWsUpgrade, flushSessionTurns }
