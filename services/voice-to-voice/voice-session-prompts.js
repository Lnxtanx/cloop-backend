/**
 * Backward-compatibility forwarder.
 *
 * Prompt assembly, course catalog and Gemini Live tool declarations now live in
 * ai/agents/english-voice/prompts (data: course-catalog.js, prompt: session-prompt.js,
 * tools: ../tools/voice-tools.js).
 */

module.exports = require('../../ai/agents/english-voice/prompts')
