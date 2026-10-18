/**
 * English Voice-to-Voice — session state machine
 *
 * Pure helpers over the in-memory session object. No IO: DB persistence,
 * client messaging and audio uploads are handled by ../agent.js.
 *
 * Turn-taking rules mirror the original proxy exactly:
 *   - User speech is flushed as a turn when the model starts speaking
 *     (text must be > 3 chars), and force-flushed when the session ends
 *     (text must be > 1 char).
 *   - Tutor text is flushed on turnComplete; any '?' bumps questionCount.
 */

const { parsePcmRate } = require('../audio/pcm')

const USER_TURN_MIN_LENGTH = 4
const FLUSH_TURN_MIN_LENGTH = 2
const MIN_COMPLETION_SECONDS = 270

// Audio seconds ≈ chunks × 0.128 (≈128 ms per delivered chunk)
const AUDIO_SEC_PER_CHUNK = 0.128

// Token estimate presets — kept from the legacy proxy for billing continuity.
const TOKEN_ESTIMATE_PRESETS = {
	client_closed: { minPromptTokens: 100, minCompletionTokens: 50, tokensPerTurn: 15 },
	completed: { minPromptTokens: 200, minCompletionTokens: 100, tokensPerTurn: 20 },
}

function createSessionState({
	sessionId,
	userId,
	userName,
	isVoiceSession,
	trackKey,
	chapterKey,
	mode,
	startedAt,
}) {
	return {
		sessionId,
		userId,
		userName,
		isVoiceSession: Boolean(isVoiceSession),
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
		audioChunks: [],
		audioUploaded: false,
		startedAt: startedAt || new Date(),
		sessionCompleted: false,
		userRequestedEnd: false,
		tokensLogged: false,
	}
}

function sessionDurationSec(state, now = Date.now()) {
	return Math.max(1, Math.round((now - state.startedAt) / 1000))
}

function countUserWords(state) {
	return state.turns
		.filter((t) => t.speaker === 'user' && t.content)
		.reduce((acc, t) => acc + t.content.trim().split(/\s+/).filter(Boolean).length, 0)
}

function pushAudioChunk(state, { source, data, mimeType, fallbackRate }) {
	const chunk = {
		source,
		data: Buffer.from(data, 'base64'),
		rate: parsePcmRate(mimeType, fallbackRate),
		ts: Date.now(),
		seq: state.audioChunks.length,
	}
	state.audioChunks.push(chunk)
	return chunk
}

function appendUserAudioChunk(state, { data, mimeType } = {}) {
	state.userAudioChunksCount++
	if (!data) return null
	return pushAudioChunk(state, { source: 'user', data, mimeType, fallbackRate: 16000 })
}

function appendAiAudioChunk(state, { data, mimeType } = {}) {
	state.aiAudioChunksCount++
	if (!data) return null
	return pushAudioChunk(state, { source: 'ai', data, mimeType, fallbackRate: 24000 })
}

/**
 * Flush pending learner speech into a turn. Returns the turn, or null when the
 * buffer is empty/too short (buffer is kept in that case, matching the legacy
 * behaviour of only clearing on a successful flush).
 */
function takeUserTurn(state, minLength = USER_TURN_MIN_LENGTH) {
	const text = (state.currentUserText || '').trim()
	if (!text || text.length < minLength) return null
	state.turnSequence++
	const turn = {
		sequence: state.turnSequence,
		speaker: 'user',
		content: text,
		timestamp: new Date(),
	}
	state.turns.push(turn)
	state.currentUserText = ''
	return turn
}

/**
 * Flush pending tutor speech into a turn on turnComplete. Returns the turn or
 * null when empty. questionCount increments when the flushed text has a '?'.
 */
function takeTutorTurn(state) {
	const text = (state.currentAiText || '').trim()
	if (!text) {
		state.currentAiText = ''
		return null
	}
	state.turnSequence++
	const turn = {
		sequence: state.turnSequence,
		speaker: 'ai',
		content: text,
		timestamp: new Date(),
	}
	state.turns.push(turn)
	if (text.includes('?')) state.questionCount++
	state.currentAiText = ''
	return turn
}

/**
 * Mandatory 5-minute minimum for spoken practice: wrap-up is blocked unless the
 * learner explicitly asked to stop or at least 270s (4.5m) elapsed.
 */
function canEndSession(state, reason, now = Date.now()) {
	const durationSec = sessionDurationSec(state, now)
	const isUserRequested = state.userRequestedEnd || reason === 'user_requested'
	return {
		allowed: isUserRequested || durationSec >= MIN_COMPLETION_SECONDS,
		durationSec,
		isUserRequested,
	}
}

/**
 * Estimate Gemini Live token usage from audio chunk counts + transcript turns.
 * Presets match the legacy proxy formulas exactly ('client_closed' fallback
 * path and the accepted 'completed' path).
 */
function estimateTokenUsage(state, preset = 'completed') {
	const { minPromptTokens, minCompletionTokens, tokensPerTurn } =
		TOKEN_ESTIMATE_PRESETS[preset] || TOKEN_ESTIMATE_PRESETS.completed
	const inputAudioSec = Math.round(state.userAudioChunksCount * AUDIO_SEC_PER_CHUNK)
	const outputAudioSec = Math.round(state.aiAudioChunksCount * AUDIO_SEC_PER_CHUNK)
	const promptTokens = Math.max(minPromptTokens, inputAudioSec * 25 + state.turns.length * tokensPerTurn)
	const completionTokens = Math.max(minCompletionTokens, outputAudioSec * 32)
	return {
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
		inputAudioSec,
		outputAudioSec,
	}
}

module.exports = {
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
	MIN_COMPLETION_SECONDS,
	TOKEN_ESTIMATE_PRESETS,
}
