/**
 * DeepSeek Provider Constants
 * Authoritative configurations for DeepSeek API (https://api.deepseek.com)
 */

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

const MODELS = Object.freeze({
  // Flagship reasoning & agent model (DeepSeek-V4-Pro, 1M context, highest reasoning depth) - ALWAYS DEFAULT & BEST
  PRO: 'deepseek-v4-pro',
  // High-throughput fast model (DeepSeek-V4.1-Flash, 1M context, multimodal text+vision)
  FLASH: 'deepseek-flash',
  // Default model across Cloop: ALWAYS DeepSeek-V4-Pro
  DEFAULT: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
  // Legacy aliases mapped automatically to PRO so legacy callers are auto-upgraded to best model
  LEGACY_MAP: Object.freeze({
    'deepseek-chat': 'deepseek-v4-pro',
    'deepseek-reasoner': 'deepseek-v4-pro',
    'deepseek-v3': 'deepseek-v4-pro',
    'deepseek-v4': 'deepseek-v4-pro',
    'deepseek-v4-flash': 'deepseek-v4-pro',
  }),
});

const ENDPOINTS = Object.freeze({
  CHAT_COMPLETIONS: `${DEEPSEEK_BASE_URL}/chat/completions`,
  MODELS: `${DEEPSEEK_BASE_URL}/models`,
  SEARCH: `${DEEPSEEK_BASE_URL}/v1/tools/search`,
  FETCH: `${DEEPSEEK_BASE_URL}/v1/tools/fetch`,
});

const THINKING_CONFIG = Object.freeze({
  DEFAULT_STATUS: 'enabled', // Thinking always-on
  EFFORT_LEVELS: Object.freeze({
    LOW: 'low',
    HIGH: 'high',
    MAX: 'max',
  }),
  DEFAULT_EFFORT: 'high',
});

const TIMEOUTS = Object.freeze({
  DEFAULT_CHAT_MS: 45000, // 45s accommodates thinking generation
  SEARCH_MS: 15000,
  FETCH_MS: 15000,
});

module.exports = {
  DEEPSEEK_BASE_URL,
  MODELS,
  ENDPOINTS,
  THINKING_CONFIG,
  TIMEOUTS,
};
