/**
 * English Voice — backend service glue
 *
 * Everything that supports the voice feature but is NOT part of the agent or
 * Gemini transport lives here:
 *
 *   - live-proxy      Browser WebSocket → english-voice agent adapter
 *   - resume-parser   PDF/DOCX/TXT resume text extraction (interview prep)
 *   - resume-structurer  Resume text → structured JSON profile
 *   - audio-storage   Full-conversation WAV upload / presigned playback (S3)
 */

const liveProxy = require('./live-proxy')
const resumeParser = require('./resume-parser')
const resumeStructurer = require('./resume-structurer')
const audioStorage = require('./audio-storage')

module.exports = {
  ...liveProxy,
  ...resumeParser,
  ...resumeStructurer,
  ...audioStorage,

  liveProxy,
  resumeParser,
  resumeStructurer,
  audioStorage,
}
