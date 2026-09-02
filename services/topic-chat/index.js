/**
 * Topic Chat Module — consolidated entry point.
 *
 * Fronts the topic-chat feature's business logic and services.
 * Shared cross-feature dependencies (DeepSeek client, learning-turn tracker,
 * media search) intentionally remain at their original locations — see README.md.
 */
const {
  generateTopicChatResponse
} = require('./topic-chat');

const {
  buildSystemPrompt,
  analyzeChatHistory,
  determinePhase,
  generateTopicGreeting,
  generateTopicGoals,
  normalizeUserCorrectionOptions
} = require('./topic-chat-helpers');

const { gradeAnswer } = require('./answer-grader');

const { calculateSessionMetrics, generateSessionSummaryMessage } = require('./topic_chat_metrics');

const {
  analyzeMistakesForLearnMore,
  generateLearnMoreGreeting,
  generateLearnMoreResponse
} = require('./learn-more');

module.exports = {
  // Orchestrator
  generateTopicChatResponse,
  // Helpers
  buildSystemPrompt,
  analyzeChatHistory,
  determinePhase,
  generateTopicGreeting,
  generateTopicGoals,
  normalizeUserCorrectionOptions,
  // Grading
  gradeAnswer,
  // Metrics
  calculateSessionMetrics,
  generateSessionSummaryMessage,
  // Learn More
  analyzeMistakesForLearnMore,
  generateLearnMoreGreeting,
  generateLearnMoreResponse
};