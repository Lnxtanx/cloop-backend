/**
 * Gemini Live WebSocket Proxy for English Speaking Assessment
 * 
 * Handles the realtime audio path:
 *   Browser Mic → WS → Backend Proxy → Gemini Live API → Audio response → WS → Browser Speaker
 * 
 * Conducts native multimodal in-session evaluation:
 * - Gemini Live conducts a 5-question interview
 * - Once question 5 is answered, Eva automatically concludes and invokes `submit_speaking_evaluation`
 * - Pronunciation & Fluency are evaluated from actual spoken audio
 * - Results are persisted to PostgreSQL and the browser is notified automatically
 */

const WebSocket = require('ws')
const url = require('url')
const jwt = require('jsonwebtoken')
const prisma = require('../lib/prisma')

const GEMINI_API_KEY = () => process.env.GEMINI_API_KEY
const GEMINI_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview'
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent`

// Active sessions map: sessionId -> { geminiWs, clientWs, sessionState }
const activeSessions = new Map()

// Tool declaration for native in-session evaluation
const EVALUATION_TOOL = {
	functionDeclarations: [
		{
			name: 'submit_speaking_evaluation',
			description: 'Submits the comprehensive English speaking assessment report evaluating the candidate across all 8 dimensions based on both spoken audio (pronunciation, phonetics, fluency, speech rate) and linguistic content (grammar, vocabulary, comprehension, coherence).',
			parameters: {
				type: 'OBJECT',
				properties: {
					overall_score: { type: 'INTEGER', description: 'Overall score from 0 to 100' },
					cefr_level: { type: 'STRING', enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'], description: 'CEFR proficiency level' },
					pronunciation_score: { type: 'INTEGER', description: 'Pronunciation score 0-100 based on spoken audio' },
					pronunciation_feedback: { type: 'STRING', description: 'Detailed phonetic observations, sound articulation, and word stress based on spoken audio' },
					fluency_score: { type: 'INTEGER', description: 'Fluency score 0-100 based on spoken audio' },
					fluency_feedback: { type: 'STRING', description: 'Detailed observations on rhythm, pauses, and speech rate' },
					grammar_score: { type: 'INTEGER', description: 'Grammar score 0-100' },
					grammar_feedback: { type: 'STRING', description: 'Grammar accuracy and range feedback' },
					vocabulary_score: { type: 'INTEGER', description: 'Vocabulary score 0-100' },
					vocabulary_feedback: { type: 'STRING', description: 'Lexical diversity and word choice feedback' },
					sentence_construction_score: { type: 'INTEGER', description: 'Sentence construction score 0-100' },
					comprehension_score: { type: 'INTEGER', description: 'Comprehension score 0-100' },
					coherence_score: { type: 'INTEGER', description: 'Coherence and organization score 0-100' },
					conversational_score: { type: 'INTEGER', description: 'Conversational interaction score 0-100' },
					strengths: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Top 3-4 strengths' },
					weaknesses: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Top 3-4 areas for improvement' },
					recommendations: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Top 3 actionable recommendations' },
					detected_errors: {
						type: 'ARRAY',
						items: {
							type: 'OBJECT',
							properties: {
								category: { type: 'STRING', description: 'grammar, pronunciation, vocabulary, or sentence' },
								severity: { type: 'STRING', description: 'low, medium, or high' },
								detectedText: { type: 'STRING', description: 'What the user said' },
								correction: { type: 'STRING', description: 'Correct English phrase' },
								explanation: { type: 'STRING', description: 'Explanation of the error' }
							}
						}
					}
				},
				required: [
					'overall_score',
					'cefr_level',
					'pronunciation_score',
					'pronunciation_feedback',
					'fluency_score',
					'fluency_feedback',
					'grammar_score',
					'vocabulary_score',
					'sentence_construction_score',
					'comprehension_score',
					'coherence_score',
					'conversational_score',
					'strengths',
					'weaknesses',
					'recommendations'
				]
			}
		}
	]
}

// System prompt for Eva
const INTERVIEWER_SYSTEM_PROMPT = `You are Eva, a warm, professional English speaking assessment examiner. You are conducting an interactive speaking assessment to evaluate the candidate's English proficiency.

IMPORTANT CONVERSATIONAL RULES:
- Speak naturally and warmly, like a real human interviewer.
- Keep your conversational responses concise (2-3 sentences max) so the candidate speaks more than you.
- Ask clear, open-ended questions and listen attentively to what the candidate actually says.
- Do NOT reveal scores or critique errors during the conversation.

INTERVIEW STRUCTURE (Conduct exactly 5 progressive questions):
Question 1 — Introduction:
Start with a warm greeting: "Hello! Welcome to your speaking assessment. Tell me a bit about yourself."

Question 2 — Background / Daily Life:
Follow up naturally based on their answer and ask about what they are currently studying or working on.

Question 3 — Past Experience / Story:
Ask them to describe a project, achievement, or memorable experience they are proud of.

Question 4 — Problem Solving / Challenge:
Ask about a challenge or difficult situation they encountered and how they handled it.

Question 5 — Opinions & Future Goals:
Ask an adaptive question about their future aspirations or their thoughts on a relevant topic.

AUTOMATIC SESSION CONCLUSION & EVALUATION TRIGGER:
- After the candidate finishes answering Question 5 (or after 5 full conversational turns), say your final closing sentence warmly:
  "Thank you so much! That completes your speaking assessment. I am compiling your detailed evaluation report right now."
- IMMEDIATELY after concluding, you MUST call the tool function "submit_speaking_evaluation" with the comprehensive assessment report based on both the spoken audio (pronunciation, phonetics, rhythm, speech rate) and conversation content.`

/**
 * Handle WebSocket upgrade for /ws/assessment
 */
function handleAssessmentWsUpgrade(server) {
	const wss = new WebSocket.Server({ noServer: true })

	server.on('upgrade', (request, socket, head) => {
		const pathname = url.parse(request.url).pathname
		if (pathname !== '/ws/assessment' && pathname !== '/api/assessment/ws' && !pathname.startsWith('/ws/assessment')) return

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
			currentAiText: '',
			currentUserText: '',
			turnSequence: 0,
			questionCount: 0,
			userAudioChunksCount: 0,
			aiAudioChunksCount: 0,
			startedAt: new Date(),
			evaluationReceived: false,
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
			console.log(`✅ [Assessment WS] Connected to Gemini Live for session ${sid}! Sending initial setup with evaluation tools...`)

			// Send setup message with native evaluation tool declaration
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
					tools: [EVALUATION_TOOL],
				},
			}

			geminiWs.send(JSON.stringify(setupMsg))
		})

		geminiWs.on('message', async (data) => {
			try {
				const msg = JSON.parse(data.toString())

				// 1. Setup complete
				if (msg.setupComplete) {
					console.log(`🎉 [Assessment WS] Setup complete from Gemini for session ${sid}! Eva is ready.`)

					prisma.assessment_sessions.update({
						where: { id: sid },
						data: { status: 'IN_PROGRESS', started_at: new Date(), updated_at: new Date() },
					}).catch(err => console.error('[Assessment WS] DB update error:', err))

					clientWs.send(JSON.stringify({ type: 'setup_complete' }))

					// Send initial prompt to trigger Eva's opening greeting
					console.log(`📣 [Assessment WS] Triggering Eva to begin greeting and first question...`)
					const initialMsg = {
						clientContent: {
							turns: [
								{
									role: 'user',
									parts: [{ text: 'Please start the assessment by greeting me warmly and asking your first question.' }],
								},
							],
							turnComplete: true,
						},
					}
					geminiWs.send(JSON.stringify(initialMsg))
					return
				}

				// 2. Tool Call received from Gemini Live (Native In-Session Evaluation)
				if (msg.toolCall) {
					console.log(`🎯 [Assessment WS] Tool Call received from Eva for session ${sid}!`)
					await handleEvaluationToolCall(msg.toolCall, sessionState, clientWs, geminiWs)
					return
				}

				// 3. Server content (audio, text, functionCall from Gemini)
				if (msg.serverContent) {
					const content = msg.serverContent

					// Audio & inline function calls
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
							if (part.functionCall) {
								console.log(`🎯 [Assessment WS] Function call in modelTurn for session ${sid}!`)
								await handleEvaluationToolCall({ functionCalls: [part.functionCall] }, sessionState, clientWs, geminiWs)
								return
							}
							if (part.text) {
								sessionState.currentAiText = (sessionState.currentAiText || '') + part.text
							}
						}
					}

					// Live transcripts
					if (content.outputTranscription?.text) {
						sessionState.currentAiText = (sessionState.currentAiText || '') + content.outputTranscription.text
					}

					if (content.inputTranscription?.text) {
						sessionState.currentUserText = (sessionState.currentUserText || '') + content.inputTranscription.text
					}

					// User turn finished
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

					// AI Turn complete
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

					// Interrupted
					if (content.interrupted) {
						console.log(`⚡ [Assessment WS] Interruption detected from user speech`)
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

		// Handle client messages (audio from microphone or completion trigger)
		clientWs.on('message', async (data) => {
			try {
				if (typeof data === 'string' || data instanceof Buffer) {
					let parsed
					try {
						parsed = JSON.parse(data.toString())
					} catch {
						return
					}

					// User audio chunk
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
					} else if (parsed.type === 'trigger_evaluation' || parsed.type === 'end_session') {
						console.log(`🛑 [Assessment WS] User requested early session completion for session ${sid}`)
						if (geminiWs && geminiWs.readyState === WebSocket.OPEN && !sessionState.evaluationReceived) {
							const triggerMsg = {
								clientContent: {
									turns: [
										{
											role: 'user',
											parts: [{ text: 'The interview is now completed. Please call the submit_speaking_evaluation function now to produce the complete speaking assessment report.' }],
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
 * Handle evaluation tool call generated natively by Gemini Live
 */
async function handleEvaluationToolCall(toolCall, sessionState, clientWs, geminiWs) {
	const { sessionId, startedAt } = sessionState
	const functionCall = toolCall.functionCalls?.[0] || toolCall

	if (!functionCall || functionCall.name !== 'submit_speaking_evaluation') return

	const args = functionCall.args || {}
	console.log(`\n======================================================`)
	console.log(`🎉 [Assessment WS] IN-SESSION EVALUATION RECEIVED FOR SESSION ${sessionId}!`)
	console.log(`   Overall Score: ${args.overall_score}/100 | CEFR: ${args.cefr_level}`)
	console.log(`   Pronunciation: ${args.pronunciation_score}/100 | Feedback: ${args.pronunciation_feedback?.substring(0, 60)}...`)
	console.log(`   Fluency: ${args.fluency_score}/100 | Feedback: ${args.fluency_feedback?.substring(0, 60)}...`)
	console.log(`======================================================\n`)

	sessionState.evaluationReceived = true

	// Respond to tool call to complete Gemini protocol
	if (geminiWs && geminiWs.readyState === WebSocket.OPEN && functionCall.id) {
		const toolResponse = {
			toolResponse: {
				functionResponses: [
					{
						response: { output: { status: 'success', message: 'Evaluation recorded' } },
						id: functionCall.id,
					},
				],
			},
		}
		geminiWs.send(JSON.stringify(toolResponse))
	}

	try {
		// 1. Save turns to DB
		await persistSessionData(sessionState)

		// 2. Persist comprehensive results
		const durationSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000)

		// Upsert assessment_results
		await prisma.assessment_results.upsert({
			where: { session_id: sessionId },
			update: {
				overall_score: args.overall_score || 75,
				cefr_level: args.cefr_level || 'B2',
				strengths: args.strengths || ['Good conversational flow'],
				weaknesses: args.weaknesses || ['Slight pronunciation variations'],
				recommendations: args.recommendations || ['Continue conversational practice'],
				pronunciation_score: args.pronunciation_score || 75,
				fluency_score: args.fluency_score || 75,
				grammar_score: args.grammar_score || 75,
				vocabulary_score: args.vocabulary_score || 75,
				sentence_construction_score: args.sentence_construction_score || 75,
				comprehension_score: args.comprehension_score || 75,
				coherence_score: args.coherence_score || 75,
				conversational_score: args.conversational_score || 75,
				updated_at: new Date(),
			},
			create: {
				session_id: sessionId,
				overall_score: args.overall_score || 75,
				cefr_level: args.cefr_level || 'B2',
				strengths: args.strengths || ['Good conversational flow'],
				weaknesses: args.weaknesses || ['Slight pronunciation variations'],
				recommendations: args.recommendations || ['Continue conversational practice'],
				pronunciation_score: args.pronunciation_score || 75,
				fluency_score: args.fluency_score || 75,
				grammar_score: args.grammar_score || 75,
				vocabulary_score: args.vocabulary_score || 75,
				sentence_construction_score: args.sentence_construction_score || 75,
				comprehension_score: args.comprehension_score || 75,
				coherence_score: args.coherence_score || 75,
				conversational_score: args.conversational_score || 75,
			},
		})

		// Upsert 8 assessment_metrics
		const dimensions = [
			{ name: 'pronunciation', score: args.pronunciation_score || 75, evidence: [args.pronunciation_feedback || 'Audio pronunciation analysis'] },
			{ name: 'fluency', score: args.fluency_score || 75, evidence: [args.fluency_feedback || 'Speech rhythm and pacing analysis'] },
			{ name: 'grammar', score: args.grammar_score || 75, evidence: [args.grammar_feedback || 'Grammar usage'] },
			{ name: 'vocabulary', score: args.vocabulary_score || 75, evidence: [args.vocabulary_feedback || 'Vocabulary range'] },
			{ name: 'sentence_construction', score: args.sentence_construction_score || 75, evidence: ['Sentence complexity'] },
			{ name: 'comprehension', score: args.comprehension_score || 75, evidence: ['Understanding of questions'] },
			{ name: 'coherence', score: args.coherence_score || 75, evidence: ['Topic flow and organization'] },
			{ name: 'conversational', score: args.conversational_score || 75, evidence: ['Turn-taking and natural interaction'] },
		]

		for (const dim of dimensions) {
			await prisma.assessment_metrics.upsert({
				where: {
					session_id_dimension: {
						session_id: sessionId,
						dimension: dim.name,
					},
				},
				update: {
					score: dim.score,
					confidence: 0.95,
					evidence: dim.evidence,
					updated_at: new Date(),
				},
				create: {
					session_id: sessionId,
					dimension: dim.name,
					score: dim.score,
					confidence: 0.95,
					evidence: dim.evidence,
				},
			})
		}

		// Insert detected errors if any
		if (args.detected_errors && args.detected_errors.length > 0) {
			await prisma.assessment_errors.createMany({
				data: args.detected_errors.map((e) => ({
					session_id: sessionId,
					category: e.category || 'grammar',
					severity: e.severity || 'low',
					detected_text: e.detectedText || '',
					correction: e.correction || '',
					explanation: e.explanation || '',
				})),
				skipDuplicates: true,
			})
		}

		// 3. Mark session COMPLETED & READY
		await prisma.assessment_sessions.update({
			where: { id: sessionId },
			data: {
				status: 'COMPLETED',
				assessment_status: 'READY',
				overall_score: args.overall_score || 75,
				duration_seconds: durationSeconds,
				completed_at: new Date(),
				updated_at: new Date(),
			},
		})

		// 4. Notify client WebSocket for instant transition
		clientWs.send(JSON.stringify({
			type: 'assessment_completed',
			sessionId,
			overallScore: args.overall_score,
			cefrLevel: args.cefr_level,
		}))

		console.log(`✅ [Assessment WS] Session ${sessionId} assessment finalized and persisted! Client notified.`)

	} catch (err) {
		console.error(`❌ [Assessment WS] Error persisting in-session evaluation for ${sessionId}:`, err)
	}
}

/**
 * Persist accumulated session data (turns) to database
 */
async function persistSessionData(sessionState) {
	const { sessionId, turns, questionCount, startedAt } = sessionState

	try {
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
