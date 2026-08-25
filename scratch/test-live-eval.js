const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env'), override: true })
const WebSocket = require('ws')

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
const GEMINI_MODEL = 'gemini-3.1-flash-live-preview'
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`

console.log('Testing In-Session Live Evaluation with Function Calling on Gemini Live...')

const ws = new WebSocket(GEMINI_WS_URL)

ws.on('open', () => {
	const setupMsg = {
		setup: {
			model: `models/${GEMINI_MODEL}`,
			generationConfig: {
				responseModalities: ['AUDIO'],
				speechConfig: {
					voiceConfig: {
						prebuiltVoiceConfig: { voiceName: 'Aoede' }
					}
				}
			},
			systemInstruction: {
				parts: [{
					text: `You are Eva, an expert English language interviewer and assessor. 
Conduct a short speaking test. When the interview ends or you are requested to finalize the evaluation, invoke the tool function "submit_speaking_evaluation" with the detailed 8-dimension assessment based on both the spoken audio (pronunciation, fluency, rhythm) and content.`
				}]
			},
			tools: [
				{
					functionDeclarations: [
						{
							name: 'submit_speaking_evaluation',
							description: 'Submits the complete speaking assessment report evaluating the candidate across all 8 dimensions including phonetic pronunciation and audio fluency.',
							parameters: {
								type: 'OBJECT',
								properties: {
									overall_score: { type: 'INTEGER', description: 'Overall score 0-100' },
									cefr_level: { type: 'STRING', description: 'CEFR level A1-C2' },
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
									recommendations: { type: 'ARRAY', items: { type: 'STRING' } }
								},
								required: ['overall_score', 'cefr_level', 'pronunciation_score', 'fluency_score', 'grammar_score', 'vocabulary_score', 'strengths', 'weaknesses', 'recommendations']
							}
						}
					]
				}
			]
		}
	}
	ws.send(JSON.stringify(setupMsg))
})

ws.on('message', (data) => {
	const msg = JSON.parse(data.toString())
	console.log('Received message types:', Object.keys(msg))

	if (msg.setupComplete) {
		console.log('✅ Setup complete with Tool Declaration!')

		// Simulate 1 user turn
		const turn1 = {
			clientContent: {
				turns: [
					{
						role: 'user',
						parts: [{ text: 'Hello Eva! My name is Vivek, I am from India and I work as a software engineer building web applications.' }]
					}
				],
				turnComplete: true
			}
		}
		ws.send(JSON.stringify(turn1))

		// After 2 seconds, trigger evaluation in the SAME session
		setTimeout(() => {
			console.log('Triggering in-session evaluation tool call...')
			const evalPrompt = {
				clientContent: {
					turns: [
						{
							role: 'user',
							parts: [{ text: 'The interview is now finished. Please call the "submit_speaking_evaluation" function now to submit your full assessment report for my English speaking performance.' }]
						}
					],
					turnComplete: true
				}
			}
			ws.send(JSON.stringify(evalPrompt))
		}, 3000)
	}

	if (msg.toolCall) {
		console.log('🎉 Tool Call Received directly from Gemini Live!')
		console.log(JSON.stringify(msg.toolCall, null, 2))
		ws.close()
		process.exit(0)
	}

	if (msg.serverContent) {
		if (msg.serverContent.outputTranscription) {
			console.log('Eva speech:', msg.serverContent.outputTranscription.text)
		}
		if (msg.serverContent.modelTurn?.parts) {
			for (const p of msg.serverContent.modelTurn.parts) {
				if (p.functionCall) {
					console.log('🎉 Function Call inside modelTurn!', JSON.stringify(p.functionCall, null, 2))
					ws.close()
					process.exit(0)
				}
			}
		}
	}
})

ws.on('error', (err) => console.error('WS Error:', err))
