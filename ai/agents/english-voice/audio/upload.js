/**
 * English Voice-to-Voice — conversation recording upload
 *
 * Mixes the session's stored PCM chunks into one track and uploads it to S3.
 * Idempotent per session state (audioUploaded flag).
 */

const { TARGET_RECORD_RATE, buildConversationPcm } = require('./pcm')

async function uploadConversationAudio(sessionState, { s3Storage } = {}) {
	if (sessionState.audioUploaded) return null
	if (!sessionState.audioChunks || sessionState.audioChunks.length === 0) return null

	sessionState.audioUploaded = true
	const storage = s3Storage || require('../../../services/english-voice/audio-storage')
	const userCount = sessionState.audioChunks.filter((c) => c.source === 'user').length
	const aiCount = sessionState.audioChunks.filter((c) => c.source === 'ai').length
	const fullPcmBuffer = buildConversationPcm(sessionState.audioChunks, TARGET_RECORD_RATE)
	if (fullPcmBuffer.length === 0) return null

	console.log(`📼 [Voice WS] Building full conversation recording for session ${sessionState.sessionId}: ${userCount} user + ${aiCount} AI chunks, ${(fullPcmBuffer.length / 1024).toFixed(1)} KB`)

	return storage.uploadSessionAudio({
		sessionId: sessionState.sessionId,
		userId: sessionState.userId,
		pcmBuffer: fullPcmBuffer,
		trackKey: sessionState.trackKey,
		chapterKey: sessionState.chapterKey,
	})
}

module.exports = { uploadConversationAudio }
