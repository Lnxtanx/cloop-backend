/**
 * AI Agents Registry
 * Central catalog of specialized Cloop AI agents.
 */

const socraticTutor = require('./socratic-tutor');

module.exports = {
  socraticTutor,
  // Future agents:
  // voiceTutor: require('./voice-tutor'),
  // englishTutor: require('./english-tutor'),
};
