/**
 * English Voice-to-Voice — post-session evaluation
 *
 * - consolidator: transcript + live-error analysis for voice practice sessions
 * - assessment-engine: 8-dimension scoring for legacy speaking assessments
 */

const { consolidateSessionErrors } = require('./consolidator')
const { processAssessment, DIMENSION_WEIGHTS, DIMENSIONS } = require('./assessment-engine')

module.exports = {
	consolidateSessionErrors,
	processAssessment,
	DIMENSION_WEIGHTS,
	DIMENSIONS,
}
