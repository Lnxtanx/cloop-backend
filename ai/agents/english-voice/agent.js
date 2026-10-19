/**
 * English Voice-to-Voice Agent — runtime
 *
 * Owns the session state machine, prompt selection, tool handling, DB
 * persistence, audio upload and telemetry for Cloop's Gemini Live speaking
 * tutor AND the legacy Eva speaking assessment (same transport, different
 * prompt + tool).
 *
 * Transport (Gemini Live protocol) comes from ai/providers/gemini.
 * The app-side WebSocket server + auth + learner-profile fetch live in the
 * adapter (services/voice-live-proxy.js).
 *
 * Design:
 *   - `client` is a sink: { send(payload), close(code, reason) } — adapter maps
 *     it onto the browser WebSocket. The agent never touches `ws`.
 *   - All IO (prisma, s3, consolidator, telemetry) is injectable via `deps`
 *     for tests; production defaults are lazy-required.
 */

const { MODELS, createLiveSession } = require('../../providers/gemini')
const { buildSessionPrompt } = require('./prompts')
const { LOG_ERROR_TOOL } = require('./tools/voice-tools')
const { LEGACY_EVALUATION_TOOL } = require('./tools/legacy-assessment-tools')
const { uploadConversationAudio: defaultUploadConversationAudio } = require('./audio/upload')
const {
	createSessionState,
	sessionDurationSec,
	countUserWords,
	appendUserAudioChunk,
	appendAiAudioChunk,
	takeUserTurn,
	takeTutorTurn,
	canEndSession,
	estimateTokenUsage,
	USER_TURN_MIN_LENGTH,
	FLUSH_TURN_MIN_LENGTH,
} = require('./state/session-state')

const LEGACY_ASSESSMENT_PROMPT = 'You are Eva, a warm, professional English speaking assessment examiner. Conduct a 5-question interview and call submit_speaking_evaluation at the end.'

const CLOOP_GREETING = 'Hello! Please greet me warmly as Cloop AI in 1-2 short sentences and ask what topic, subject, or doubt I would like to explore today.'
const VOICE_GREETING = 'Hello! I am ready to practise. Please greet me warmly in 1-2 short sentences and start our practice.'
const ASSESSMENT_GREETING = 'Please start the assessment by greeting me warmly and asking your first question.'
const WRAP_UP_TRIGGER = 'We have finished practising for today! Please say a warm closing line and call the end_session function now.'

function createEnglishVoiceAgent({ session, learnerProfile = {}, client, deps = {} }) {
	const state = createSessionState(session)

	const uploadConversationAudio = deps.uploadConversationAudio || defaultUploadConversationAudio
	const createLiveSessionImpl = deps.createLiveSession || createLiveSession
	let geminiSession = deps.geminiSession || null

	function getPrisma() {
		return deps.prisma || require('../../../lib/prisma')
	}

	function recordTokenUsage(params) {
		const record = deps.recordTokenUsage || require('../../providers/telemetry/token-logger').recordTokenUsage
		return record({ ...params, prismaClient: deps.prisma || undefined })
	}

	function consolidateSessionErrorsFn(sessionId) {
		const consolidate = deps.consolidateSessionErrors ||
			require('./evaluation/consolidator').consolidateSessionErrors
		return consolidate(sessionId)
	}

	function modelName() {
		return deps.model || MODELS.LIVE
	}

	function sendToClient(payload) {
		try {
			client.send(payload)
		} catch (err) {
			console.error('[EnglishVoice] Error sending to client:', err.message)
		}
	}

	function persistTurn(turn, speaker) {
		const prisma = getPrisma()
		if (state.isVoiceSession) {
			prisma.voice_session_turns.create({
				data: {
					session_id: state.sessionId,
					sequence: turn.sequence,
					speaker,
					content: turn.content,
				},
			}).catch((err) => console.error('[EnglishVoice] Error persisting turn:', err))
		} else {
			// Legacy assessment transcripts (GET /sessions/:id/turns + fallback engine).
			// assessment_turns uses 'ai' for the examiner, 'user' for the candidate.
			prisma.assessment_turns.create({
				data: {
					session_id: state.sessionId,
					sequence: turn.sequence,
					speaker: speaker === 'tutor' ? 'ai' : 'user',
					content: turn.content,
				},
			}).catch((err) => console.error('[EnglishVoice] Error persisting assessment turn:', err))
		}
	}

	function pickGreetingPrompt() {
		if (state.mode === 'cloop_ai' || state.trackKey === 'cloop_tutor' || state.trackKey === 'general_tutor') {
			return CLOOP_GREETING
		}
		return state.isVoiceSession ? VOICE_GREETING : ASSESSMENT_GREETING
	}

	// 8-minute check-in promised by the session prompt ("[time check]" note)
	const TIME_CHECK_MS = deps.timeCheckMs !== undefined ? deps.timeCheckMs : 480_000
	let timeCheckTimer = null

	function scheduleTimeCheck() {
		// Only the voice-practice prompt (buildSessionPrompt) knows the "[time check]" note.
		if (!state.isVoiceSession || timeCheckTimer || TIME_CHECK_MS <= 0) return
		timeCheckTimer = setTimeout(() => {
			timeCheckTimer = null
			if (state.sessionCompleted || !geminiSession || !geminiSession.isOpen()) return
			console.log('⏰ [EnglishVoice] 8-minute check-in triggered')
			geminiSession.sendClientContent('[time check] We have been practising for about 8 minutes. Warmly ask the learner if they want to keep going, or if they would like to stop here.')
		}, TIME_CHECK_MS)
		if (timeCheckTimer.unref) timeCheckTimer.unref()
	}

	function clearTimeCheck() {
		if (timeCheckTimer) {
			clearTimeout(timeCheckTimer)
			timeCheckTimer = null
		}
	}

	// ----------------------------------------------------------
	// Gemini Live callbacks
	// ----------------------------------------------------------

	async function onSetupComplete() {
		console.log(`🎉 [EnglishVoice] Setup complete from Gemini for session ${state.sessionId}. Tutor is ready.`)

		const prisma = getPrisma()
		if (state.isVoiceSession) {
			prisma.voice_sessions.update({
				where: { id: state.sessionId },
				data: { status: 'IN_PROGRESS', started_at: new Date() },
			}).catch(() => {})
		} else {
			prisma.assessment_sessions.update({
				where: { id: state.sessionId },
				data: { status: 'IN_PROGRESS', started_at: new Date() },
			}).catch(() => {})
		}

		sendToClient({ type: 'setup_complete' })

		console.log(`📣 [EnglishVoice] Triggering tutor to begin session...`)
		if (geminiSession) geminiSession.sendClientContent(pickGreetingPrompt())
	}

	async function onToolCall(toolCall) {
		console.log(`🎯 [EnglishVoice] Tool Call received for session ${state.sessionId}:`, JSON.stringify(toolCall))
		await handleToolCalls(toolCall)
		return false // stop processing the remainder of this message (legacy early return)
	}

	async function onAudio({ data, mimeType }) {
		appendAiAudioChunk(state, { data, mimeType })
		sendToClient({ type: 'audio', data, mimeType })
	}

	async function onModelText(text) {
		state.currentAiText = (state.currentAiText || '') + text
	}

	async function onOutputTranscription(text) {
		state.currentAiText = (state.currentAiText || '') + text
		sendToClient({ type: 'ai_transcript', text: state.currentAiText })
	}

	async function onInputTranscription(text) {
		state.currentUserText = (state.currentUserText || '') + text
		sendToClient({ type: 'user_live_transcript', text: state.currentUserText })
	}

	async function onModelTurn() {
		const turn = takeUserTurn(state, USER_TURN_MIN_LENGTH)
		if (turn) {
			console.log(`\n🗣️ [Learner Turn ${turn.sequence}]: "${turn.content}"`)
			persistTurn(turn, 'user')
		}
	}

	async function onTurnComplete() {
		const turn = takeTutorTurn(state)
		if (turn) {
			console.log(`\n💬 [Tutor Turn ${turn.sequence}]: "${turn.content}"`)
			persistTurn(turn, 'tutor')
			sendToClient({
				type: 'turn_complete',
				speaker: 'ai',
				questionCount: state.questionCount,
				text: turn.content,
			})
		}
	}

	async function onInterrupted() {
		console.log('⚡ [EnglishVoice] Interruption detected from user speech')
		sendToClient({ type: 'interrupted' })
		state.currentAiText = ''
	}

	function onError(err) {
		console.error(`❌ [EnglishVoice] Gemini Live connection error for session ${state.sessionId}:`, err.message)
		sendToClient({ type: 'error', message: 'Gemini Live error: ' + err.message })
	}

	function onClose(code, reasonText) {
		clearTimeCheck()
		console.log(`🔌 [EnglishVoice] Gemini Live disconnected for session ${state.sessionId}: code=${code}${reasonText ? ` reason=${reasonText}` : ''}`)
		sendToClient({ type: 'gemini_disconnected', code, reason: reasonText || '' })
	}

	const callbacks = {
		onSetupComplete,
		onToolCall,
		onAudio,
		onModelText,
		onOutputTranscription,
		onInputTranscription,
		onModelTurn,
		onTurnComplete,
		onInterrupted,
		onError,
		onClose,
		onCallbackError: (err) => console.error('❌ [EnglishVoice] Error processing Gemini message:', err),
	}

	// ----------------------------------------------------------
	// Lifecycle
	// ----------------------------------------------------------

	async function start() {
		try {
			if (!geminiSession) {
				geminiSession = createLiveSessionImpl({
					model: modelName(),
					systemInstruction: state.isVoiceSession
						? buildSessionPrompt(state.trackKey, state.chapterKey, state.mode, learnerProfile)
						: LEGACY_ASSESSMENT_PROMPT,
					tools: state.isVoiceSession ? [LOG_ERROR_TOOL] : [LEGACY_EVALUATION_TOOL],
					callbacks,
				})
			}
			await geminiSession.connect()
			scheduleTimeCheck()
			return true
		} catch (err) {
			console.error('❌ [EnglishVoice] Failed to connect to Gemini Live:', err.message)
			if (/GEMINI_API_KEY/.test(err.message)) {
				sendToClient({ type: 'error', message: 'Gemini API key not configured on server' })
				client.close(4500, 'API key missing')
			} else {
				sendToClient({ type: 'error', message: 'Failed to connect to Gemini Live' })
				client.close(4500, 'Connection failed')
			}
			return false
		}
	}

	async function handleClientMessage(parsed) {
		if (!parsed || typeof parsed !== 'object') return
		try {
			if (parsed.type === 'audio_chunk') {
				appendUserAudioChunk(state, { data: parsed.data, mimeType: parsed.mimeType })
				if (geminiSession && geminiSession.isOpen()) {
					geminiSession.sendAudio({
						data: parsed.data,
						mimeType: parsed.mimeType || 'audio/pcm;rate=16000',
					})
				}
			} else if (parsed.type === 'end_session' || parsed.type === 'wrap_up') {
				console.log(`🛑 [EnglishVoice] User requested session wrap-up for session ${state.sessionId}`)
				state.userRequestedEnd = true
				if (geminiSession && geminiSession.isOpen() && !state.sessionCompleted) {
					geminiSession.sendClientContent(WRAP_UP_TRIGGER)
				}
			}
		} catch (err) {
			console.error('[EnglishVoice] Error handling client message:', err)
		}
	}

	async function handleClientClose() {
		console.log(`🔌 [EnglishVoice] Client WebSocket disconnected for session ${state.sessionId}`)
		clearTimeCheck()
		if (geminiSession && geminiSession.isOpen()) {
			geminiSession.close(1000, 'Client closed')
		}

		// If tokens were not yet logged and session was active, save fallback metrics & token logs
		if (!state.tokensLogged && state.isVoiceSession && state.sessionId) {
			state.tokensLogged = true
			const prisma = getPrisma()
			const durationSec = sessionDurationSec(state)
			const userWords = countUserWords(state)

			prisma.voice_sessions.update({
				where: { id: state.sessionId },
				data: {
					duration_seconds: durationSec,
					words_spoken: userWords,
				},
			}).catch(() => {})

			// Fallback full-conversation upload to S3 if not yet uploaded
			if (!state.audioUploaded && state.audioChunks.length > 0) {
				uploadConversationAudio(state).then((s3Url) => {
					if (s3Url) {
						prisma.voice_sessions.update({
							where: { id: state.sessionId },
							data: { audio_url: s3Url },
						}).catch(() => {})
					}
				}).catch(() => {})
			}

			const durationMinutes = Math.max(1, Math.round(durationSec / 60))
			prisma.learner_profiles.upsert({
				where: { user_id: state.userId },
				update: {
					total_sessions: { increment: 1 },
					total_minutes: { increment: durationMinutes },
					current_track: state.trackKey,
					current_chapter: state.chapterKey,
					updated_at: new Date(),
				},
				create: {
					user_id: state.userId,
					native_language: 'Hindi',
					english_level: 'Beginner',
					total_sessions: 1,
					total_minutes: durationMinutes,
					current_track: state.trackKey,
					current_chapter: state.chapterKey,
				},
			}).catch(() => {})

			const { promptTokens, completionTokens, totalTokens } = estimateTokenUsage(state, 'client_closed')
			recordTokenUsage({
				userId: state.userId,
				featureArea: 'voice_session',
				subFeature: 'live_audio',
				provider: 'google',
				modelName: modelName(),
				promptTokens,
				completionTokens,
				totalTokens,
				requestDurationMs: durationSec * 1000,
				status: 'success',
				metadata: { sessionId: state.sessionId, durationSeconds: durationSec, wordsSpoken: userWords, exitReason: 'client_closed' },
			})
		}
	}

	// ----------------------------------------------------------
	// Tool handling (log_error / end_session / session_complete / submit_speaking_evaluation)
	// ----------------------------------------------------------

	async function handleToolCalls(toolCall) {
		const calls = toolCall.functionCalls || []
		const responses = []

		for (const call of calls) {
			const { name, args, id } = call
			console.log(`🛠️ [EnglishVoice Tool Handler] Executing tool "${name}" (callId: ${id}) with args:`, JSON.stringify(args))

			if (name === 'log_error') {
				try {
					state.loggedErrors.push(args)

					// Persist error to database
					const savedError = await getPrisma().session_errors.create({
						data: {
							session_id: state.sessionId,
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

					sendToClient({
						type: 'error_logged',
						error: {
							id: savedError.id,
							type: args.type,
							said: args.said,
							correct: args.correct,
							corrected_aloud: args.corrected_aloud,
						},
					})
				} catch (err) {
					console.error('❌ [EnglishVoice] Error saving logged error:', err)
				}

				responses.push({
					id: id || 'call_log_error',
					name: 'log_error',
					response: { output: { status: 'logged', count: state.loggedErrors.length } },
				})
			} else if (name === 'end_session' || name === 'session_complete') {
				const { allowed, durationSec } = canEndSession(state, args.reason)
				const totalExchanges = state.turns.length
				const isUserRequested = state.userRequestedEnd || args.reason === 'user_requested'

				// Enforce mandatory 5-minute minimum duration (300 seconds) for spoken English practice
				// Allow wrap-up only if learner explicitly requested it OR if at least 270 seconds (4.5m) have elapsed
				if (!allowed) {
					console.log(`⏳ [EnglishVoice] Premature ${name} call blocked! Duration: ${durationSec}s (< 270s / 4.5m). Instructing Gemini Live to continue practice...`)
					responses.push({
						id: id || `call_${name}`,
						name: name,
						response: {
							output: {
								status: 'continue_practice',
								instruction: `CRITICAL RULE: The session has only run for ${durationSec} seconds. Every spoken English practice session MUST last at least 5 minutes (300 seconds). Do NOT end the session yet! Continue the conversation by asking a natural follow-up question or roleplaying another realistic scenario for this topic right now.`
							}
						}
					})
					continue
				}

				state.sessionCompleted = true
				clearTimeCheck()
				console.log(`🏁 [EnglishVoice] ${name} accepted! Reason: ${args.reason || (isUserRequested ? 'user_requested' : 'completed')}, Duration: ${durationSec}s, Exchanges: ${totalExchanges}, Questions: ${args.questions_asked || state.questionCount}`)

				// Flush any pending user speech to turns
				const pendingTurn = takeUserTurn(state, FLUSH_TURN_MIN_LENGTH)
				if (pendingTurn) persistTurn(pendingTurn, 'user')

				// Calculate total user words
				const userWords = countUserWords(state)

				try {
					const prisma = getPrisma()

					// Upload full conversation (user + AI) audio to S3 if chunks exist
					let uploadedAudioUrl = null
					if (!state.audioUploaded && state.audioChunks.length > 0) {
						uploadedAudioUrl = await uploadConversationAudio(state).catch((err) => {
							console.error('[EnglishVoice] Error uploading audio to S3:', err)
							return null
						})
					}

					await prisma.voice_sessions.update({
						where: { id: state.sessionId },
						data: {
							status: 'COMPLETED',
							completed_at: new Date(),
							duration_seconds: durationSec,
							words_spoken: userWords,
							questions_asked: args.questions_asked || state.questionCount || 0,
							summary_text: args.summary || '',
							learner_did_well: args.learner_did_well || '',
							one_thing_to_fix: args.one_thing_to_fix || '',
							...(uploadedAudioUrl ? { audio_url: uploadedAudioUrl } : {}),
						},
					})

					// Update learner profile: total_sessions & total_minutes
					const durationMinutes = Math.max(1, Math.round(durationSec / 60))
					prisma.learner_profiles.upsert({
						where: { user_id: state.userId },
						update: {
							total_sessions: { increment: 1 },
							total_minutes: { increment: durationMinutes },
							current_track: state.trackKey,
							current_chapter: state.chapterKey,
							updated_at: new Date(),
						},
						create: {
							user_id: state.userId,
							native_language: 'Hindi',
							english_level: 'Beginner',
							total_sessions: 1,
							total_minutes: durationMinutes,
							current_track: state.trackKey,
							current_chapter: state.chapterKey,
						}
					}).catch(err => console.error('[EnglishVoice] Error updating learner profile:', err))

					// Log Token Usage for Live Voice Audio
					if (!state.tokensLogged) {
						state.tokensLogged = true
						const { promptTokens, completionTokens, totalTokens } = estimateTokenUsage(state, 'completed')

						recordTokenUsage({
							userId: state.userId,
							featureArea: 'voice_session',
							subFeature: 'live_audio',
							provider: 'google',
							modelName: modelName(),
							promptTokens,
							completionTokens,
							totalTokens,
							requestDurationMs: durationSec * 1000,
							status: 'success',
							metadata: {
								sessionId: state.sessionId,
								trackKey: state.trackKey,
								chapterKey: state.chapterKey,
								durationSeconds: durationSec,
								questionsAsked: args.questions_asked || state.questionCount,
								wordsSpoken: userWords,
								audioUrl: uploadedAudioUrl,
							}
						})
					}

					// Run post-session error consolidation
					consolidateSessionErrorsFn(state.sessionId).catch((err) => {
						console.error('[EnglishVoice] Error in error consolidation:', err)
					})

					// Inform client with waitForAudioDrain flag and audioUrl
					sendToClient({
						type: 'session_complete',
						sessionId: state.sessionId,
						durationSeconds: durationSec,
						wordsSpoken: userWords,
						summary: args.summary || '',
						learnerDidWell: args.learner_did_well || '',
						oneThingToFix: args.one_thing_to_fix || '',
						audioUrl: uploadedAudioUrl || null,
						waitForAudioDrain: true,
					})
				} catch (err) {
					console.error('❌ [EnglishVoice] Error completing voice session in DB:', err)
				}

				responses.push({
					id: id || `call_${name}`,
					name: name,
					response: { output: { status: 'completed' } },
				})
			} else if (name === 'submit_speaking_evaluation') {
				// Legacy assessment handler
				state.sessionCompleted = true
				const durationSec = sessionDurationSec(state)

				try {
					const prisma = getPrisma()
					await prisma.assessment_sessions.update({
						where: { id: state.sessionId },
						data: {
							status: 'COMPLETED',
							assessment_status: 'READY',
							completed_at: new Date(),
							duration_seconds: durationSec,
							question_count: state.questionCount || 5,
							overall_score: args.overall_score || 70,
						},
					})

					await prisma.assessment_results.upsert({
						where: { session_id: state.sessionId },
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
							session_id: state.sessionId,
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

					sendToClient({
						type: 'assessment_completed',
						sessionId: state.sessionId,
						overallScore: args.overall_score,
						cefrLevel: args.cefr_level,
					})
				} catch (err) {
					console.error('[EnglishVoice] Error saving legacy assessment:', err)
				}

				responses.push({
					id: id || 'call_submit_eval',
					name: 'submit_speaking_evaluation',
					response: { output: { status: 'success' } },
				})
			}
		}

		// Send tool response back to Gemini Live
		if (geminiSession && geminiSession.isOpen() && responses.length > 0) {
			geminiSession.sendToolResponse(responses)
		}
	}

	return {
		state,
		start,
		handleClientMessage,
		handleClientClose,
		handleToolCalls,
		get geminiSession() {
			return geminiSession
		},
		get completed() {
			return state.sessionCompleted
		},
	}
}

module.exports = {
	createEnglishVoiceAgent,
	LEGACY_ASSESSMENT_PROMPT,
}
