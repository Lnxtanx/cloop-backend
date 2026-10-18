/**
 * English Voice-to-Voice — Legacy Speaking Assessment tool
 *
 * `submit_speaking_evaluation` is called by the Eva examiner at the end of the
 * legacy 5-question speaking assessment flow. The runtime resolver lives in
 * ../agent.js (handleToolCalls).
 */

const LEGACY_EVALUATION_TOOL = {
	functionDeclarations: [
		{
			name: 'submit_speaking_evaluation',
			description: 'Submits the comprehensive English speaking assessment report evaluating the candidate across all 8 dimensions.',
			parameters: {
				type: 'OBJECT',
				properties: {
					overall_score: { type: 'INTEGER', description: 'Overall score from 0 to 100' },
					cefr_level: { type: 'STRING', enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] },
					pronunciation_score: { type: 'INTEGER' },
					pronunciation_feedback: { type: 'STRING' },
					fluency_score: { type: 'INTEGER' },
					fluency_feedback: { type: 'STRING' },
					grammar_score: { type: 'INTEGER' },
					vocabulary_score: { type: 'INTEGER' },
					sentence_construction_score: { type: 'INTEGER' },
					comprehension_score: { type: 'INTEGER' },
					coherence_score: { type: 'INTEGER' },
					conversational_score: { type: 'INTEGER' },
					strengths: { type: 'ARRAY', items: { type: 'STRING' } },
					weaknesses: { type: 'ARRAY', items: { type: 'STRING' } },
					recommendations: { type: 'ARRAY', items: { type: 'STRING' } },
					detected_errors: {
						type: 'ARRAY',
						items: {
							type: 'OBJECT',
							properties: {
								category: { type: 'STRING' },
								severity: { type: 'STRING' },
								detectedText: { type: 'STRING' },
								correction: { type: 'STRING' },
								explanation: { type: 'STRING' }
							}
						}
					}
				},
				required: [
					'overall_score', 'cefr_level', 'pronunciation_score', 'pronunciation_feedback',
					'fluency_score', 'fluency_feedback', 'grammar_score', 'vocabulary_score',
					'sentence_construction_score', 'comprehension_score', 'coherence_score',
					'conversational_score', 'strengths', 'weaknesses', 'recommendations'
				]
			}
		}
	]
}

module.exports = { LEGACY_EVALUATION_TOOL }
