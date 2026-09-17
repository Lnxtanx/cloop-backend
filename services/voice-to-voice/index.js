/**
 * Voice-to-Voice Module for Cloop English
 * 
 * Consolidates all realtime voice practice, Gemini Live duplex streaming,
 * prompt orchestration, real-time error logging, post-session consolidation,
 * and assessment engine in one unified domain.
 */

const geminiLiveProxy = require('./gemini-live-proxy')
const voiceSessionPrompts = require('./voice-session-prompts')
const errorConsolidator = require('./error-consolidator')
const assessmentEngine = require('./assessment-engine')
const dashboardService = require('./dashboard-service')

module.exports = {
  // Gemini Live Realtime Proxy & Audio Handlers
  ...geminiLiveProxy,
  geminiLiveProxy,

  // Prompt Orchestration & Error Tooling
  ...voiceSessionPrompts,
  voiceSessionPrompts,

  // Post-Session Consolidator & AI Feedback
  ...errorConsolidator,
  errorConsolidator,

  // Assessment Engine & Rubric Scoring
  ...assessmentEngine,
  assessmentEngine,

  // Fluency Dashboard Aggregator
  ...dashboardService,
  dashboardService,
}
