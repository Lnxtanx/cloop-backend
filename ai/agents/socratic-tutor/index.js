/**
 * Socratic Tutor Agent Public Interface
 *
 * Usage:
 *   const { socraticTutor } = require('../../ai');
 *   // or
 *   const { processTurn, initialState } = require('../../ai/agents/socratic-tutor');
 *
 *   const result = await processTurn({
 *     studentMessage: 'the lens changes focal length',
 *     topic: { title: 'Human Eye' },
 *     goals: [...],
 *     currentState: sessionState,
 *     userId: user.id
 *   });
 */

const agent = require('./agent');
const {
  initialState,
  buildGoalMap,
  scoredGoalIndex,
  computeTeachingCoverage,
  computeChecksCompleted,
} = require('./state/state-machine');
const { detectRequestKind, detectFastIntent } = require('./evaluators/intent-evaluator');

module.exports = {
  // Core agent interface
  processTurn: agent.processTurn,
  processTutorTurn: agent.processTurn, // Parity alias for orchestrator

  // State initialization & progress
  initialState,
  buildGoalMap,
  scoredGoalIndex,
  computeTeachingCoverage,
  computeChecksCompleted,

  // Intent classification
  detectRequestKind,
  detectFastIntent,

  // Conversational helpers
  findLastQuestion: agent.findLastQuestion,
  findLastQuestionOptions: agent.findLastQuestionOptions,
  closingMessage: agent.closingMessage,

  // Tools & Prompts
  tools: require('./tools'),
  prompts: require('./prompts'),
};
