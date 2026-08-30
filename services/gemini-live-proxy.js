/**
 * Gemini Live WebSocket Proxy for Voice Practice & Speaking Assessment
 * 
 * Handles the realtime full-duplex audio path:
 *   Browser Mic (16kHz PCM16) → WS → Backend Proxy → Gemini Live API → Audio response (24kHz PCM) → WS → Browser Speaker
 * 
 * Supports:
 * 1. v2 Voice Practice Sessions (Track-aware, Ravi tutor, log_error real-time tool, AI-initiated completion)
 * 2. Legacy Speaking Assessment (Eva examiner, 5-question flow, submit_speaking_evaluation tool)
 */

const WebSocket = require('ws')
const url = require('url')
const jwt = require('jsonwebtoken')
const prisma = require('../lib/prisma')
const { buildSessionPrompt, LOG_ERROR_TOOL } = require('./voice-session-prompts')
const { consolidateSessionErrors } = require('./error-consolidator')

const GEMINI_API_KEY = () => process.env.GEMINI_API_KEY
const GEMINI_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview'
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent`

// Active sessions map: sessionId -> { geminiWs, clientWs, sessionState, isVoiceSession }
const activeSessions = new Map()

// Legacy Assessment evaluation tool definition
const LEGACY_EVALUATION_TOOL = {
	functionDeclarations: [
		{
			name: 'submit_speaking_evaluation',
			description: 'Submits the comprehensive English speaking assessment report evaluating the candidate across all 8 dimensions.',
			parameters: {
				type: 'OBJECT',
				properties: {
					overall_score: { type: 'INTEGER', description: 'Overall score from 0 to 100' },
					cefr_level: { type: 'STRING', enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] },
					pronunciation_score: { type: 'INTEGER' },
					pronunciation_feedback: { type: 'STRING' },
					fluency_score: { type: 'INTEGER' },
					fluency_feedback: { type: 'STRING' },
					grammar_score: { type: 'INTEGER' },
					vocabulary_score: { type: 'INTEGER' },
					sentence_construction_score: { type: 'INTEGER' },
					comprehension_score: { type: 'INTEGER' },
					coherence_score: { type: 'INTEGER' },
					conversational_score: { type: 'INTEGER' },
					strengths: { type: 'ARRAY', items: { type: 'STRING' } },
					weaknesses: { type: 'ARRAY', items: { type: 'STRING' } },
					recommendations: { type: 'ARRAY', items: { type: 'STRING' } },
					detected_errors: {
						type: 'ARRAY',
						items: {
							type: 'OBJECT',
							properties: {
								category: { type: 'STRING' },
								severity: { type: 'STRING' },
								detectedText: { type: 'STRING' },
								correction: { type: 'STRING' },
								explanation: { type: 'STRING' }
							}
						}
					}
				},
				required: [
					'overall_score', 'cefr_level', 'pronunciation_score', 'pronunciation_feedback',
					'fluency_score', 'fluency_feedback', 'grammar_score', 'vocabulary_score',
					'sentence_construction_score', 'comprehension_score', 'coherence_score',
					'conversational_score', 'strengths', 'weaknesses', 'recommendations'
				]
			}
		}
	]
}

/**
 * Handle WebSocket upgrade for /ws/assessment and /ws/voice
 */
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
			clientWs.send(JSON.stringify({ type: 'error', message: 'Authentication failed: ' + err.message }))
			clientWs.close(4001, 'Authentication failed')
			return
		}

		if (!sessionId || !userId) {
			console.error('❌ [Voice WS] Missing sessionId or userId')
			clientWs.send(JSON.stringify({ type: 'error', message: 'Missing sessionId or auth' }))
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
				learnerProfile = {
					name: userName,
					englishLevel: profile.english_level || 'Beginner',
					nativeLanguage: profile.native_language || 'Hindi',
					openErrors: Array.isArray(profile.open_errors) ? profile.open_errors : [],
				}
			}
		} catch (err) {
			console.error('[Voice WS] Error fetching learner profile:', err)
		}

		// Session state
		const sessionState = {
			sessionId: sid,
			userId,
			userName,
			isVoiceSession,
			trackKey: trackKey || 'interview_prep',
			chapterKey: chapterKey || 'telling_about_yourself',
			mode: mode || 'practice',
			turns: [],
			loggedErrors: [],
			currentAiText: '',
			currentUserText: '',
			turnSequence: 0,
			questionCount: 0,
			userAudioChunksCount: 0,
			aiAudioChunksCount: 0,
			startedAt: new Date(),
			sessionCompleted: false,
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
							track_key: sessionState.trackKey,
							chapter_key: sessionState.chapterKey,
							session_mode: sessionState.mode,
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

		// Connect to Gemini Live
		const apiKey = GEMINI_API_KEY()
		if (!apiKey) {
			console.error('❌ [Voice WS] GEMINI_API_KEY is missing in backend .env')
			clientWs.send(JSON.stringify({ type: 'error', message: 'Gemini API key not configured on server' }))
			clientWs.close(4500, 'API key missing')
			return
		}

		const geminiUrl = `${GEMINI_WS_URL}?key=${apiKey}`
		console.log(`🤖 [Voice WS] Connecting to Gemini Live (${GEMINI_MODEL}) at Google...`)
		let geminiWs = null

		try {
			geminiWs = new WebSocket(geminiUrl)
		} catch (err) {
			console.error('❌ [Voice WS] Failed to create Gemini WebSocket:', err)
			clientWs.send(JSON.stringify({ type: 'error', message: 'Failed to connect to Gemini Live' }))
			clientWs.close(4500, 'Connection failed')
			return
		}

		activeSessions.set(sid, { geminiWs, clientWs, sessionState, isVoiceSession })

		geminiWs.on('open', () => {
			console.log(`✅ [Voice WS] Connected to Gemini Live for session ${sid}! Preparing system prompt...`)

			// Build system prompt based on session type
			let systemInstructionText = ''
			let toolsDeclaration = []

			if (isVoiceSession) {
				systemInstructionText = buildSessionPrompt(
					sessionState.trackKey,
					sessionState.chapterKey,
					sessionState.mode,
					learnerProfile
				)
				toolsDeclaration = [LOG_ERROR_TOOL]
			} else {
				// Legacy assessment prompt
				systemInstructionText = `You are Eva, a warm, professional English speaking assessment examiner. Conduct a 5-question interview and call submit_speaking_evaluation at the end.`
				toolsDeclaration = [LEGACY_EVALUATION_TOOL]
			}

			// Send setup message
			const setupMsg = {
				setup: {
					model: `models/${GEMINI_MODEL}`,
					generationConfig: {
						responseModalities: ['AUDIO'],
						speechConfig: {
							voiceConfig: {
								prebuiltVoiceConfig: {
									voiceName: 'Aoede', // Natural conversational voice
								},
							},
						},
					},
					systemInstruction: {
						parts: [{ text: systemInstructionText }],
					},
					tools: toolsDeclaration,
				},
			}

			geminiWs.send(JSON.stringify(setupMsg))
		})

		geminiWs.on('message', async (data) => {
			try {
				const msg = JSON.parse(data.toString())

				// 1. Setup complete
				if (msg.setupComplete) {
					console.log(`🎉 [Voice WS] Setup complete from Gemini for session ${sid}! Tutor is ready.`)

					if (isVoiceSession) {
						prisma.voice_sessions.update({
							where: { id: sid },
							data: { status: 'IN_PROGRESS', started_at: new Date() },
						}).catch(() => {})
					} else {
						prisma.assessment_sessions.update({
							where: { id: sid },
							data: { status: 'IN_PROGRESS', started_at: new Date() },
						}).catch(() => {})
					}

					clientWs.send(JSON.stringify({ type: 'setup_complete' }))

					// Trigger initial greeting
					console.log(`📣 [Voice WS] Triggering tutor to begin session...`)
					const greetingPrompt = isVoiceSession
						? `Hello! I am ready to practise. Please greet me warmly in 1-2 short sentences and start our practice.`
						: `Please start the assessment by greeting me warmly and asking your first question.`

					const initialMsg = {
						clientContent: {
							turns: [
								{
									role: 'user',
									parts: [{ text: greetingPrompt }],
								},
							],
							turnComplete: true,
						},
					}
					geminiWs.send(JSON.stringify(initialMsg))
					return
				}

				// 2. Tool Call received from Gemini Live
				if (msg.toolCall) {
					console.log(`🎯 [Voice WS] Tool Call received for session ${sid}:`, JSON.stringify(msg.toolCall))
					await handleToolCalls(msg.toolCall, sessionState, clientWs, geminiWs)
					return
				}

				// 3. Server content (audio, functionCall, transcripts)
				if (msg.serverContent) {
					const content = msg.serverContent

					// Audio parts & inline function calls
					if (content.modelTurn && content.modelTurn.parts) {
						for (const part of content.modelTurn.parts) {
							if (part.inlineData) {
								sessionState.aiAudioChunksCount++
								clientWs.send(JSON.stringify({
									type: 'audio',
									data: part.inlineData.data,
									mimeType: part.inlineData.mimeType,
								}))
							}
							if (part.functionCall) {
								console.log(`🎯 [Voice WS] Function call in modelTurn for session ${sid}:`, part.functionCall.name)
								await handleToolCalls({ functionCalls: [part.functionCall] }, sessionState, clientWs, geminiWs)
								return
							}
							if (part.text) {
								sessionState.currentAiText = (sessionState.currentAiText || '') + part.text
							}
						}
					}

					// Live output transcription (Tutor speaking)
					if (content.outputTranscription?.text) {
						sessionState.currentAiText = (sessionState.currentAiText || '') + content.outputTranscription.text
						clientWs.send(JSON.stringify({
							type: 'ai_transcript',
							text: sessionState.currentAiText,
						}))
					}

					// Live input transcription (User speaking)
					if (content.inputTranscription?.text) {
						sessionState.currentUserText = (sessionState.currentUserText || '') + content.inputTranscription.text
						clientWs.send(JSON.stringify({
							type: 'user_live_transcript',
							text: sessionState.currentUserText,
						}))
					}

					// User turn finished
					if (sessionState.currentUserText && sessionState.currentUserText.trim().length > 3 && content.modelTurn) {
						sessionState.turnSequence++
						const userTurnText = sessionState.currentUserText.trim()
						console.log(`\n🗣️ [Learner Turn ${sessionState.turnSequence}]: "${userTurnText}"`)
						sessionState.turns.push({
							sequence: sessionState.turnSequence,
							speaker: 'user',
							content: userTurnText,
							timestamp: new Date(),
						})

						// Persist turn to DB
						if (isVoiceSession) {
							prisma.voice_session_turns.create({
								data: {
									session_id: sid,
									sequence: sessionState.turnSequence,
									speaker: 'user',
									content: userTurnText,
								},
							}).catch((err) => console.error('[Voice WS] Error persisting turn:', err))
						}

						sessionState.currentUserText = ''
					}

					// AI Turn complete
					if (content.turnComplete) {
						const turnContent = (sessionState.currentAiText || '').trim()
						if (turnContent) {
							sessionState.turnSequence++
							console.log(`\n💬 [Tutor Turn ${sessionState.turnSequence}]: "${turnContent}"`)

							sessionState.turns.push({
								sequence: sessionState.turnSequence,
								speaker: 'ai',
								content: turnContent,
								timestamp: new Date(),
							})

							if (turnContent.includes('?')) {
								sessionState.questionCount++
							}

							// Persist turn to DB
							if (isVoiceSession) {
								prisma.voice_session_turns.create({
									data: {
										session_id: sid,
										sequence: sessionState.turnSequence,
										speaker: 'tutor',
										content: turnContent,
									},
								}).catch((err) => console.error('[Voice WS] Error persisting turn:', err))
							}

							clientWs.send(JSON.stringify({
								type: 'turn_complete',
								speaker: 'ai',
								questionCount: sessionState.questionCount,
								text: turnContent,
							}))
						}
						sessionState.currentAiText = ''
					}

					// Interrupted
					if (content.interrupted) {
						console.log(`⚡ [Voice WS] Interruption detected from user speech`)
						clientWs.send(JSON.stringify({ type: 'interrupted' }))
						sessionState.currentAiText = ''
					}
				}

			} catch (err) {
				console.error('❌ [Voice WS] Error processing Gemini message:', err)
			}
		})

		geminiWs.on('error', (err) => {
			console.error(`❌ [Voice WS] Gemini Live connection error for session ${sid}:`, err.message)
			clientWs.send(JSON.stringify({ type: 'error', message: 'Gemini Live error: ' + err.message }))
		})

		geminiWs.on('close', (code, reason) => {
			console.log(`🔌 [Voice WS] Gemini Live disconnected for session ${sid}: code=${code}`)
			clientWs.send(JSON.stringify({ type: 'gemini_disconnected', code, reason: reason?.toString() }))
		})

		// Handle client messages (audio chunks, end_session trigger)
		clientWs.on('message', async (data) => {
			try {
				if (typeof data === 'string' || data instanceof Buffer) {
					let parsed
					try {
						parsed = JSON.parse(data.toString())
					} catch {
						return
					}

					// Audio chunk from browser microphone
					if (parsed.type === 'audio_chunk') {
						sessionState.userAudioChunksCount++
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
					} else if (parsed.type === 'end_session' || parsed.type === 'wrap_up') {
						console.log(`🛑 [Voice WS] User requested session wrap-up for session ${sid}`)
						if (geminiWs && geminiWs.readyState === WebSocket.OPEN && !sessionState.sessionCompleted) {
							const triggerMsg = {
								clientContent: {
									turns: [
										{
											role: 'user',
											parts: [{ text: 'We have finished practising for today! Please say a warm closing line and call the session_complete function now.' }],
										},
									],
									turnComplete: true,
								},
							}
							geminiWs.send(JSON.stringify(triggerMsg))
						}
					}
				}
			} catch (err) {
				console.error('[Voice WS] Error handling client message:', err)
			}
		})

		clientWs.on('close', async () => {
			console.log(`🔌 [Voice WS] Client WebSocket disconnected for session ${sid}`)
			if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
				geminiWs.close(1000, 'Client closed')
			}
			activeSessions.delete(sid)
		})
	})
}

/**
 * Handle tool calls from Gemini Live (log_error, session_complete, submit_speaking_evaluation)
 */
async function handleToolCalls(toolCall, sessionState, clientWs, geminiWs) {
	const calls = toolCall.functionCalls || []
	const responses = []

	for (const call of calls) {
		const { name, args, id } = call
		console.log(`🛠️ [Voice WS Tool Handler] Executing tool "${name}" (callId: ${id}) with args:`, JSON.stringify(args))

		if (name === 'log_error') {
			try {
				sessionState.loggedErrors.push(args)

				// Persist error to database
				const savedError = await prisma.session_errors.create({
					data: {
						session_id: sessionState.sessionId,
						error_type: args.type || 'grammar',
						said: args.said || '',
						correct: args.correct || '',
						target_word: args.target_word || null,
						detail: args.detail || null,
						severity: args.severity || 'sounds_non_native',
						confidence: args.confidence || 'medium',
						corrected_aloud: Boolean(args.corrected_aloud),
						learner_repeated_correctly: args.learner_repeated_correctly !== undefined ? Boolean(args.learner_repeated_correctly) : null,
					},
				})

				clientWs.send(JSON.stringify({
					type: 'error_logged',
					error: {
						id: savedError.id,
						type: args.type,
						said: args.said,
						correct: args.correct,
						corrected_aloud: args.corrected_aloud,
					},
				}))
			} catch (err) {
				console.error('❌ [Voice WS] Error saving logged error:', err)
			}

			responses.push({
				id: id || 'call_log_error',
				name: 'log_error',
				response: { output: { status: 'logged', count: sessionState.loggedErrors.length } },
			})
		} else if (name === 'session_complete') {
			sessionState.sessionCompleted = true
			const durationSec = Math.max(1, Math.round((new Date() - sessionState.startedAt) / 1000))

			console.log(`🏁 [Voice WS] session_complete called! Duration: ${durationSec}s, Questions: ${args.questions_asked}`)

			try {
				await prisma.voice_sessions.update({
					where: { id: sessionState.sessionId },
					data: {
						status: 'COMPLETED',
						completed_at: new Date(),
						duration_seconds: durationSec,
						questions_asked: args.questions_asked || sessionState.questionCount || 0,
						summary_text: args.summary || '',
						learner_did_well: args.learner_did_well || '',
						one_thing_to_fix: args.one_thing_to_fix || '',
					},
				})

				// Run post-session error consolidation
				consolidateSessionErrors(sessionState.sessionId).catch((err) => {
					console.error('[Voice WS] Error in error consolidation:', err)
				})

				clientWs.send(JSON.stringify({
					type: 'session_complete',
					sessionId: sessionState.sessionId,
					durationSeconds: durationSec,
					summary: args.summary || '',
					learnerDidWell: args.learner_did_well || '',
					oneThingToFix: args.one_thing_to_fix || '',
				}))
			} catch (err) {
				console.error('❌ [Voice WS] Error completing voice session in DB:', err)
			}

			responses.push({
				id: id || 'call_session_complete',
				name: 'session_complete',
				response: { output: { status: 'completed' } },
			})
		} else if (name === 'submit_speaking_evaluation') {
			// Legacy assessment handler
			sessionState.sessionCompleted = true
			const durationSec = Math.max(1, Math.round((new Date() - sessionState.startedAt) / 1000))

			try {
				await prisma.assessment_sessions.update({
					where: { id: sessionState.sessionId },
					data: {
						status: 'COMPLETED',
						assessment_status: 'READY',
						completed_at: new Date(),
						duration_seconds: durationSec,
						question_count: sessionState.questionCount || 5,
						overall_score: args.overall_score || 70,
					},
				})

				await prisma.assessment_results.upsert({
					where: { session_id: sessionState.sessionId },
					update: {
						overall_score: args.overall_score || 70,
						pronunciation_score: args.pronunciation_score || 70,
						fluency_score: args.fluency_score || 70,
						grammar_score: args.grammar_score || 70,
						vocabulary_score: args.vocabulary_score || 70,
						sentence_construction_score: args.sentence_construction_score || 70,
						comprehension_score: args.comprehension_score || 70,
						coherence_score: args.coherence_score || 70,
						conversational_score: args.conversational_score || 70,
						strengths: args.strengths || [],
						weaknesses: args.weaknesses || [],
						recommendations: args.recommendations || [],
						completed_at: new Date(),
					},
					create: {
						session_id: sessionState.sessionId,
						overall_score: args.overall_score || 70,
						pronunciation_score: args.pronunciation_score || 70,
						fluency_score: args.fluency_score || 70,
						grammar_score: args.grammar_score || 70,
						vocabulary_score: args.vocabulary_score || 70,
						sentence_construction_score: args.sentence_construction_score || 70,
						comprehension_score: args.comprehension_score || 70,
						coherence_score: args.coherence_score || 70,
						conversational_score: args.conversational_score || 70,
						strengths: args.strengths || [],
						weaknesses: args.weaknesses || [],
						recommendations: args.recommendations || [],
						completed_at: new Date(),
					},
				})

				clientWs.send(JSON.stringify({
					type: 'assessment_completed',
					sessionId: sessionState.sessionId,
					overallScore: args.overall_score,
					cefrLevel: args.cefr_level,
				}))
			} catch (err) {
				console.error('[Voice WS] Error saving legacy assessment:', err)
			}

			responses.push({
				id: id || 'call_submit_eval',
				name: 'submit_speaking_evaluation',
				response: { output: { status: 'success' } },
			})
		}
	}

	// Send tool response back to Gemini Live
	if (geminiWs && geminiWs.readyState === WebSocket.OPEN && responses.length > 0) {
		const toolResponseMsg = {
			toolResponse: {
				functionResponses: responses,
			},
		}
		geminiWs.send(JSON.stringify(toolResponseMsg))
	}
}

module.exports = {
	handleAssessmentWsUpgrade,
}
