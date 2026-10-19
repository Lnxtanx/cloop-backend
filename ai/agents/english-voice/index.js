/**
 * English Voice-to-Voice Agent
 *
 * Cloop's spoken-English tutor over Gemini Live duplex audio:
 *   - Track/chapter scene practices with real-time error logging
 *   - Post-session wrap-up report, conversation recording, telemetry
 *   - Legacy Eva speaking assessment (same transport, 5-question flow)
 *
 * Usage:
 *   const { createEnglishVoiceAgent } = require('../agents/english-voice')
 *   const agent = createEnglishVoiceAgent({ session, learnerProfile, client })
 *   await agent.start()
 *   agent.handleClientMessage(parsed)
 *   agent.handleClientClose()
 */

const { createEnglishVoiceAgent, LEGACY_ASSESSMENT_PROMPT } = require('./agent')
const { buildSessionPrompt, sanitizePrompt, paceForLevel, COURSE_CATALOG } = require('./prompts')
const { LOG_ERROR_TOOL, ERROR_TYPES, ERROR_CATEGORIES } = require('./tools/voice-tools')
const { LEGACY_EVALUATION_TOOL } = require('./tools/legacy-assessment-tools')
const pcm = require('./audio/pcm')
const { uploadConversationAudio } = require('./audio/upload')
const sessionState = require('./state/session-state')
const { consolidateSessionErrors, processAssessment, DIMENSION_WEIGHTS, DIMENSIONS } = require('./evaluation')

module.exports = {
	createEnglishVoiceAgent,
	LEGACY_ASSESSMENT_PROMPT,

	// Prompts & course data
	buildSessionPrompt,
	sanitizePrompt,
	paceForLevel,
	COURSE_CATALOG,

	// Tool declarations
	LOG_ERROR_TOOL,
	ERROR_TYPES,
	ERROR_CATEGORIES,
	LEGACY_EVALUATION_TOOL,

	// Audio + state helpers
	pcm,
	uploadConversationAudio,
	sessionState,

	// Post-session evaluation
	consolidateSessionErrors,
	processAssessment,
	DIMENSION_WEIGHTS,
	DIMENSIONS,
}
