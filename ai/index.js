/**
 * Cloop Central AI Gateway
 *
 * Top-level entrypoint for AI Infrastructure:
 * - providers: LLM models, DeepSeek Always-On Thinking, Prefix Caching, Telemetry
 * - tools: Reusable agent tools (Search, AKG Knowledge Graph, Diagram Fetcher)
 * - agents: Domain-specific AI Agents (Socratic Tutor)
 */

const providers = require('./providers');
const tools = require('./tools');
const agents = require('./agents');

module.exports = {
  // Pillars
  providers,
  tools,
  agents,

  // Direct shortcuts for high-frequency access
  socraticTutor: agents.socraticTutor,
  invokeModel: providers.invokeModel,
  invokeReasoner: providers.invokeReasoner,
  extractJson: providers.extractJson,
  executeSearch: providers.executeSearch,
  recordTokenUsage: providers.recordTokenUsage,
};
