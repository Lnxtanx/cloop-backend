/**
 * AI Agents Registry
 * Central catalog of specialized Cloop AI agents.
 */

const socraticTutor = require('./socratic-tutor');
const englishVoice = require('./english-voice');

module.exports = {
  socraticTutor,
  englishVoice,
  // Future agents:
  // englishTutor: require('./english-tutor'),
};
