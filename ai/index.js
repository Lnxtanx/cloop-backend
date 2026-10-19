/**
 * Cloop Central AI Gateway
 *
 * Top-level entrypoint for AI Infrastructure:
 * - providers: LLM models (DeepSeek, Gemini Live voice + Flash text), Search, Caching, Telemetry
 * - tools: Reusable agent tools (Search, AKG Knowledge Graph, Diagram Fetcher)
 * - agents: Domain-specific AI Agents (Socratic Tutor, English Voice-to-Voice)
 */

const providers = require('./providers');
const agents = require('./agents');

module.exports = {
  // Pillars
  providers,
  tools: agents.socraticTutor.tools,
  agents,

  // Direct shortcuts for high-frequency access
  socraticTutor: agents.socraticTutor,
  gemini: providers.gemini,
  invokeModel: providers.invokeModel,
  invokeReasoner: providers.invokeReasoner,
  extractJson: providers.extractJson,
  executeSearch: providers.executeSearch,
  recordTokenUsage: providers.recordTokenUsage,
};
