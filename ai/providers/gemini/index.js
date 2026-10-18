/**
 * Google Gemini Provider
 *
 * Realtime (Live duplex voice) + text (Flash analysis) access for Cloop.
 *
 * Usage:
 *   const { gemini } = require('../providers');
 *   const session = gemini.createLiveSession({ systemInstruction, tools, callbacks });
 *   const { parsed } = await gemini.generateJson({ prompt, featureArea: 'voice_session' });
 */

const {
  MODELS,
  ENDPOINTS,
  LIVE_CONFIG,
  TIMEOUTS,
  generateContentUrl,
  getApiKey,
} = require('./constants');

const {
  buildSetupMessage,
  parseLiveMessage,
  dispatchLiveMessage,
  createLiveSession,
} = require('./live');

const {
  generateText,
  generateJson,
  parseJsonLoose,
} = require('./text');

module.exports = {
  // Constants
  MODELS,
  ENDPOINTS,
  LIVE_CONFIG,
  TIMEOUTS,
  generateContentUrl,
  getApiKey,

  // Live duplex (voice)
  buildSetupMessage,
  parseLiveMessage,
  dispatchLiveMessage,
  createLiveSession,

  // Text (Flash)
  generateText,
  generateJson,
  parseJsonLoose,

  // Namespaced
  live: {
    buildSetupMessage,
    parseLiveMessage,
    dispatchLiveMessage,
    createLiveSession,
  },
  text: {
    generateText,
    generateJson,
    parseJsonLoose,
  },
};
