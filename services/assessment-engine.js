/**
 * Assessment Engine & Scoring Engine
 * 
 * Runs asynchronously AFTER the realtime conversation ends.
 * Analyzes transcripts, scores 8 dimensions, generates report.
 * 
 * ARCHITECTURE:
 *   Assessment Engine → analyzes transcript via Gemini (non-Live, text API)
 *   Scoring Engine → applies configurable weights, persists results
 */

const prisma = require('../lib/prisma')

// ============================================================
// CONFIGURABLE DIMENSION WEIGHTS
// These can later be calibrated against human-rated benchmark data
// ============================================================
const DIMENSION_WEIGHTS = {
	pronunciation: 0.20,
	fluency: 0.20,
	grammar: 0.20,
	vocabulary: 0.15,
	sentence_construction: 0.10,
	comprehension: 0.05,
	coherence: 0.05,
	conversational: 0.05,
}

const DIMENSIONS = Object.keys(DIMENSION_WEIGHTS)

// ============================================================
// ASSESSMENT ENGINE — Analyzes completed session
// ============================================================

/**
 * Main entry point: process a completed assessment session
 * Called asynchronously via setImmediate from the complete endpoint
 */
async function processAssessment(sessionId) {
	console.log(`[Assessment Engine] Starting assessment for session ${sessionId}`)
	const startTime = Date.now()

	try {
		// 1. Fetch session and turns
		const session = await prisma.assessment_sessions.findUnique({
			where: { id: sessionId },
			include: { turns: { orderBy: { sequence: 'asc' } } },
		})

		if (!session) {
			throw new Error(`Session ${sessionId} not found`)
		}

		if (session.turns.length === 0) {
			console.warn(`[Assessment Engine] Session ${sessionId} has no turns, marking as FAILED`)
			await markSessionFailed(sessionId, 'No conversation turns recorded')
			return
		}

		// 2. Build transcript for analysis
		const transcript = buildTranscript(session.turns)

		// 3. Run assessment analysis via Gemini
		const assessmentData = await analyzeWithGemini(transcript, session)

		// 4. Apply scoring engine
		const scoredResult = applyScoring(assessmentData)

		// 5. Persist everything to database
		await persistAssessmentResults(sessionId, scoredResult, assessmentData)

		// 6. Mark session as READY
		await prisma.assessment_sessions.update({
			where: { id: sessionId },
			data: {
				assessment_status: 'READY',
				overall_score: scoredResult.overallScore,
				updated_at: new Date(),
			},
		})

		const processingDuration = Date.now() - startTime
		console.log(`[Assessment Engine] Session ${sessionId} assessment complete in ${processingDuration}ms. Score: ${scoredResult.overallScore}`)

	} catch (error) {
		console.error(`[Assessment Engine] Failed for session ${sessionId}:`, error)
		await markSessionFailed(sessionId, error.message)
	}
}

/**
 * Build a readable transcript from turns
 */
function buildTranscript(turns) {
	return turns
		.filter(t => t.content && t.content.trim())
		.map(t => `${t.speaker === 'ai' ? 'Interviewer' : 'Candidate'}: ${t.content}`)
		.join('\n\n')
}

/**
 * Analyze transcript using Gemini API (standard text, NOT Live)
 */
async function analyzeWithGemini(transcript, session) {
	const apiKey = process.env.GEMINI_API_KEY
	if (!apiKey) {
		console.warn('[Assessment Engine] No GEMINI_API_KEY, using fallback analysis')
		return generateFallbackAssessment(transcript, session)
	}

	const analysisPrompt = `You are an expert English language assessment evaluator. Analyze the following English speaking interview transcript and provide a detailed assessment.

TRANSCRIPT:
---
${transcript}
---

SESSION INFO:
- Duration: ${session.duration_seconds || 0} seconds
- Number of turns: ${session.turns?.length || 0}

Evaluate the CANDIDATE's (not the interviewer's) English proficiency across these 8 dimensions. For each dimension, provide:
1. A score from 0 to 100
2. A confidence level from 0.0 to 1.0
3. Specific evidence from the transcript
4. Detected errors (if any)

DIMENSIONS TO EVALUATE:

1. PRONUNCIATION (based on transcript evidence of spelling-as-spoken, unusual word choices that suggest pronunciation difficulties, self-corrections)
2. FLUENCY (response length, sentence completeness, restarts, filler indicators, response consistency)
3. GRAMMAR (subject-verb agreement, tenses, articles, prepositions, word order, sentence correctness, grammatical range and complexity)
4. VOCABULARY (lexical diversity, word repetition, contextual appropriateness, collocations, ability to express abstract concepts)
5. SENTENCE_CONSTRUCTION (sentence completeness, variety of simple/compound/complex structures, clause relationships, logical construction)
6. COMPREHENSION (relevance of answers to questions, ability to follow follow-up questions, understanding of rephrased questions)
7. COHERENCE (organization of ideas, logical progression, topic maintenance, structured communication like context→problem→action→result)
8. CONVERSATIONAL (turn-taking, ability to elaborate, follow-up handling, context retention, natural interaction)

Also identify:
- Top 3 STRENGTHS
- Top 3 WEAKNESSES
- Top 3 RECOMMENDATIONS for improvement
- Specific ERRORS with category, severity (low/medium/high), detected text, correction, and explanation

Respond ONLY with valid JSON in this exact format:
{
  "dimensions": {
    "pronunciation": { "score": 75, "confidence": 0.6, "evidence": ["evidence1", "evidence2"] },
    "fluency": { "score": 80, "confidence": 0.8, "evidence": ["evidence1"] },
    "grammar": { "score": 70, "confidence": 0.9, "evidence": ["evidence1", "evidence2"] },
    "vocabulary": { "score": 78, "confidence": 0.8, "evidence": ["evidence1"] },
    "sentence_construction": { "score": 72, "confidence": 0.7, "evidence": ["evidence1"] },
    "comprehension": { "score": 85, "confidence": 0.9, "evidence": ["evidence1"] },
    "coherence": { "score": 76, "confidence": 0.7, "evidence": ["evidence1"] },
    "conversational": { "score": 80, "confidence": 0.8, "evidence": ["evidence1"] }
  },
  "strengths": ["strength1", "strength2", "strength3"],
  "weaknesses": ["weakness1", "weakness2", "weakness3"],
  "recommendations": ["recommendation1", "recommendation2", "recommendation3"],
  "errors": [
    { "category": "grammar", "severity": "medium", "detectedText": "...", "correction": "...", "explanation": "..." }
  ]
}`

	try {
		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					contents: [{ parts: [{ text: analysisPrompt }] }],
					generationConfig: {
						temperature: 0.3,
						maxOutputTokens: 4096,
						responseMimeType: 'application/json',
					},
				}),
			}
		)

		if (!response.ok) {
			const errorText = await response.text()
			console.error('[Assessment Engine] Gemini API error:', response.status, errorText)
			return generateFallbackAssessment(transcript, session)
		}

		const data = await response.json()
		const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text

		if (!textContent) {
			console.error('[Assessment Engine] No text in Gemini response')
			return generateFallbackAssessment(transcript, session)
		}

		// Parse JSON response
		const parsed = JSON.parse(textContent)
		console.log('[Assessment Engine] Gemini analysis received successfully')
		return parsed

	} catch (error) {
		console.error('[Assessment Engine] Gemini analysis failed:', error)
		return generateFallbackAssessment(transcript, session)
	}
}

/**
 * Fallback assessment when Gemini API is unavailable
 * Provides basic heuristic-based scoring from transcript analysis
 */
function generateFallbackAssessment(transcript, session) {
	console.log('[Assessment Engine] Using fallback heuristic assessment')

	const userTurns = (session.turns || []).filter(t => t.speaker === 'user')
	const allUserText = userTurns.map(t => t.content || '').join(' ')
	const words = allUserText.split(/\s+/).filter(Boolean)
	const wordCount = words.length
	const uniqueWords = new Set(words.map(w => w.toLowerCase()))
	const lexicalDiversity = wordCount > 0 ? Math.min(100, Math.round((uniqueWords.size / wordCount) * 100 * 1.5)) : 50
	const avgResponseLength = userTurns.length > 0 ? Math.round(wordCount / userTurns.length) : 0
	const sentenceCount = allUserText.split(/[.!?]+/).filter(s => s.trim()).length

	// Heuristic scores
	const baseScore = Math.min(85, Math.max(40, 50 + avgResponseLength * 0.8))
	const fluencyScore = Math.min(90, Math.max(35, baseScore + (sentenceCount > 5 ? 10 : 0)))
	const grammarScore = Math.min(85, Math.max(40, baseScore - 5))
	const vocabScore = Math.min(90, Math.max(35, lexicalDiversity))
	const comprehensionScore = Math.min(90, Math.max(50, userTurns.length >= 5 ? baseScore + 10 : baseScore))

	return {
		dimensions: {
			pronunciation: { score: Math.round(baseScore), confidence: 0.3, evidence: ['Pronunciation analysis requires audio data — transcript-only fallback used'] },
			fluency: { score: Math.round(fluencyScore), confidence: 0.5, evidence: [`${wordCount} total words across ${userTurns.length} responses`, `Average response length: ${avgResponseLength} words`] },
			grammar: { score: Math.round(grammarScore), confidence: 0.4, evidence: ['Heuristic grammar analysis based on text patterns'] },
			vocabulary: { score: Math.round(vocabScore), confidence: 0.6, evidence: [`Lexical diversity: ${uniqueWords.size} unique words out of ${wordCount}`, `Diversity ratio: ${(uniqueWords.size / Math.max(wordCount, 1) * 100).toFixed(1)}%`] },
			sentence_construction: { score: Math.round(baseScore - 2), confidence: 0.4, evidence: [`${sentenceCount} sentences detected`] },
			comprehension: { score: Math.round(comprehensionScore), confidence: 0.6, evidence: [`Responded to ${userTurns.length} questions`] },
			coherence: { score: Math.round(baseScore - 3), confidence: 0.4, evidence: ['Coherence analysis based on response relevance'] },
			conversational: { score: Math.round(baseScore + 2), confidence: 0.5, evidence: [`${userTurns.length} conversational turns completed`] },
		},
		strengths: [
			wordCount > 50 ? 'Good response volume demonstrating willingness to communicate' : 'Attempted all questions',
			userTurns.length >= 5 ? 'Completed full interview with all questions answered' : 'Participated in the conversation',
			lexicalDiversity > 60 ? 'Good lexical diversity in vocabulary usage' : 'Consistent language usage',
		],
		weaknesses: [
			avgResponseLength < 15 ? 'Responses tend to be brief — more elaboration would demonstrate proficiency' : 'Could benefit from more varied sentence structures',
			'Pronunciation assessment limited due to transcript-only analysis',
			lexicalDiversity < 50 ? 'Limited vocabulary range — try using more varied expressions' : 'Some responses could be more structured',
		],
		recommendations: [
			'Practice speaking in longer, more detailed responses',
			'Try using a wider variety of vocabulary and expressions',
			'Focus on structuring answers with clear introduction, body, and conclusion',
		],
		errors: [],
	}
}

// ============================================================
// SCORING ENGINE — Applies weights and calculates final scores
// ============================================================

/**
 * Apply configurable weights to dimension scores and calculate overall
 */
function applyScoring(assessmentData) {
	const dimensions = assessmentData.dimensions || {}
	const scores = {}
	let weightedSum = 0
	let totalWeight = 0

	for (const dim of DIMENSIONS) {
		const dimData = dimensions[dim]
		const score = dimData?.score ?? 50 // default 50 if missing
		scores[dim] = Math.max(0, Math.min(100, Math.round(score)))

		const weight = DIMENSION_WEIGHTS[dim] || 0
		weightedSum += scores[dim] * weight
		totalWeight += weight
	}

	const overallScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 50

	return {
		overallScore,
		scores,
		strengths: assessmentData.strengths || [],
		weaknesses: assessmentData.weaknesses || [],
		recommendations: assessmentData.recommendations || [],
		errors: assessmentData.errors || [],
		dimensions: assessmentData.dimensions || {},
	}
}

/**
 * Persist assessment results, metrics, and errors to database
 */
async function persistAssessmentResults(sessionId, scoredResult, assessmentData) {
	// 1. Create assessment_results record
	await prisma.assessment_results.create({
		data: {
			session_id: sessionId,
			overall_score: scoredResult.overallScore,
			pronunciation_score: scoredResult.scores.pronunciation,
			fluency_score: scoredResult.scores.fluency,
			grammar_score: scoredResult.scores.grammar,
			vocabulary_score: scoredResult.scores.vocabulary,
			sentence_construction_score: scoredResult.scores.sentence_construction,
			comprehension_score: scoredResult.scores.comprehension,
			coherence_score: scoredResult.scores.coherence,
			conversational_score: scoredResult.scores.conversational,
			strengths: scoredResult.strengths,
			weaknesses: scoredResult.weaknesses,
			recommendations: scoredResult.recommendations,
			completed_at: new Date(),
		},
	})

	// 2. Create assessment_metrics for each dimension (with evidence)
	const metricsData = DIMENSIONS.map(dim => ({
		session_id: sessionId,
		dimension: dim,
		score: scoredResult.scores[dim],
		confidence: assessmentData.dimensions?.[dim]?.confidence ?? 0.5,
		evidence: assessmentData.dimensions?.[dim]?.evidence || [],
	}))

	await prisma.assessment_metrics.createMany({
		data: metricsData,
		skipDuplicates: true,
	})

	// 3. Create assessment_errors
	const errors = scoredResult.errors || []
	if (errors.length > 0) {
		const errorData = errors.map(e => ({
			session_id: sessionId,
			category: e.category || 'general',
			severity: e.severity || 'medium',
			detected_text: e.detectedText || e.detected_text || null,
			correction: e.correction || null,
			explanation: e.explanation || null,
		}))

		await prisma.assessment_errors.createMany({
			data: errorData,
			skipDuplicates: true,
		})
	}

	console.log(`[Assessment Engine] Persisted results for session ${sessionId}: ${DIMENSIONS.length} metrics, ${errors.length} errors`)
}

/**
 * Mark a session as FAILED
 */
async function markSessionFailed(sessionId, reason) {
	try {
		await prisma.assessment_sessions.update({
			where: { id: sessionId },
			data: {
				assessment_status: 'FAILED',
				updated_at: new Date(),
			},
		})
		console.error(`[Assessment Engine] Session ${sessionId} marked FAILED: ${reason}`)
	} catch (err) {
		console.error(`[Assessment Engine] Could not mark session ${sessionId} as failed:`, err)
	}
}

module.exports = {
	processAssessment,
	DIMENSION_WEIGHTS,
	DIMENSIONS,
}
