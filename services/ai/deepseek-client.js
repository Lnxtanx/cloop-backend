/**
 * DeepSeek Client Facade
 * Seamlessly delegates all LLM invocations to the unified providers layer (`providers/`).
 * Guarantees DeepSeek-V4-Pro with Always-On Thinking and prefix prompt caching across all features.
 */

const { invokeModel, invokeReasoner, extractJson } = require('../../providers');

module.exports = {
  invokeModel,
  invokeReasoner,
  extractJson,
};
