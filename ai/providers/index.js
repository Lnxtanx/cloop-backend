/**
 * Cloop Unified AI Providers Layer
 * Centralized gateway for LLM models (DeepSeek with Always-On Thinking), Gemini (Live voice + Flash text), Web Search, Prompt Caching, and Telemetry.
 *
 * Usage:
 *   const { invokeReasoner, executeSearch, recordTokenUsage } = require('../providers');
 *   // or
 *   const { deepseek, gemini, search, telemetry, cache } = require('../providers');
 */

const { invokeModel } = require('./deepseek/client');
const { invokeReasoner, extractJson } = require('./deepseek/reasoner');
const { executeSearch, fetchWebPage, searchCurriculumSyllabus } = require('./deepseek/search');
const { MODELS, ENDPOINTS, THINKING_CONFIG, TIMEOUTS } = require('./deepseek/constants');
const { recordTokenUsage } = require('./telemetry/token-logger');
const { assembleCachedPrompt, computeCacheMetrics } = require('./cache/prompt-cache');
const gemini = require('./gemini');

module.exports = {
  // Top-level direct helpers
  invokeModel,
  invokeReasoner,
  extractJson,
  executeSearch,
  fetchWebPage,
  searchCurriculumSyllabus,
  recordTokenUsage,
  assembleCachedPrompt,
  computeCacheMetrics,

  // Gemini shortcuts (Live duplex voice + Flash text)
  createGeminiLiveSession: gemini.createLiveSession,
  generateGeminiText: gemini.generateText,
  generateGeminiJson: gemini.generateJson,

  // Namespaced modules
  deepseek: {
    invokeModel,
    invokeReasoner,
    extractJson,
    MODELS,
    ENDPOINTS,
    THINKING_CONFIG,
    TIMEOUTS,
  },
  gemini,
  search: {
    executeSearch,
    fetchWebPage,
    searchCurriculumSyllabus,
  },
  telemetry: {
    recordTokenUsage,
  },
  cache: {
    assembleCachedPrompt,
    computeCacheMetrics,
  },
};
