/**
 * English Voice-to-Voice — prompt surface
 *
 * Same export shape as the legacy services/voice-to-voice/voice-session-prompts.js
 * so existing consumers keep working through the forwarder shim.
 */

const { COURSE_CATALOG } = require('./course-catalog')
const { buildSessionPrompt, sanitizePrompt, paceForLevel } = require('./session-prompt')
const { LOG_ERROR_TOOL, ERROR_TYPES, ERROR_CATEGORIES } = require('../tools/voice-tools')

module.exports = {
  buildSessionPrompt,
  sanitizePrompt,
  paceForLevel,
  LOG_ERROR_TOOL,
  COURSE_CATALOG,
  ERROR_TYPES,
  ERROR_CATEGORIES,
}
