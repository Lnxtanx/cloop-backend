/**
 * Google Gemini Provider Constants
 * Authoritative configuration for Gemini Live (duplex voice) and Gemini Flash (text analysis).
 */

const path = require('path');
const fs = require('fs');
const envPath = [
  path.join(__dirname, '../../../.env'),
  path.join(__dirname, '../../.env'),
  path.join(process.cwd(), '.env'),
].find(p => fs.existsSync(p));
if (envPath) require('dotenv').config({ path: envPath });

const MODELS = Object.freeze({
  // Realtime duplex voice model (Cloop English voice practice tutor)
  LIVE: process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview',
  // Text model for post-session analysis, consolidation and assessment
  FLASH: process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash',
});

const ENDPOINTS = Object.freeze({
  LIVE_WS: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent',
  REST_BASE: 'https://generativelanguage.googleapis.com/v1beta',
});

function generateContentUrl(model) {
  return `${ENDPOINTS.REST_BASE}/models/${model}:generateContent`;
}

const LIVE_CONFIG = Object.freeze({
  // Gemini prebuilt voice used by the Cloop tutor
  VOICE_NAME: process.env.GEMINI_LIVE_VOICE || 'Aoede',
  RESPONSE_MODALITIES: Object.freeze(['AUDIO']),
  // Audio contract: browser mic 16kHz PCM16 in, Gemini voice 24kHz PCM16 out
  INPUT_SAMPLE_RATE: 16000,
  OUTPUT_SAMPLE_RATE: 24000,
  INPUT_MIME_TYPE: 'audio/pcm;rate=16000',
  OUTPUT_MIME_TYPE: 'audio/pcm;rate=24000',
  AUTOMATIC_ACTIVITY_DETECTION: Object.freeze({ disabled: false }),
  INPUT_AUDIO_TRANSCRIPTION: true,
  OUTPUT_AUDIO_TRANSCRIPTION: true,
});

const TIMEOUTS = Object.freeze({
  REST_MS: 30000,
  LIVE_CONNECT_MS: 15000,
});

/**
 * Lazy API key accessor.
 * NOTE: GOOGLE_API_KEY is reserved for Google Custom Search — do NOT use it as a fallback here.
 */
function getApiKey() {
  return (process.env.GEMINI_API_KEY || '').trim();
}

module.exports = {
  MODELS,
  ENDPOINTS,
  LIVE_CONFIG,
  TIMEOUTS,
  generateContentUrl,
  getApiKey,
};
