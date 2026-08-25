const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env'), override: true })
const WebSocket = require('ws')

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
const GEMINI_MODEL = 'gemini-3.1-flash-live-preview'
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`

console.log('Testing transcriptions in serverContent...')

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
				parts: [{ text: 'You are Eva, an English interviewer. Say: "Welcome to the test! Tell me about yourself."' }]
			}
		}
	}
	ws.send(JSON.stringify(setupMsg))
})

ws.on('message', (data) => {
	const msg = JSON.parse(data.toString())

	if (msg.setupComplete) {
		const initialMsg = {
			clientContent: {
				turns: [{ role: 'user', parts: [{ text: 'Hello, please start.' }] }],
				turnComplete: true
			}
		}
		ws.send(JSON.stringify(initialMsg))
	}

	if (msg.serverContent) {
		if (msg.serverContent.outputTranscription) {
			console.log('📝 outputTranscription:', JSON.stringify(msg.serverContent.outputTranscription))
		}
		if (msg.serverContent.inputTranscription) {
			console.log('🎤 inputTranscription:', JSON.stringify(msg.serverContent.inputTranscription))
		}
		if (msg.serverContent.turnComplete) {
			console.log('Turn complete! Done.')
			ws.close()
			process.exit(0)
		}
	}
})

ws.on('error', (err) => console.error('WS Error:', err.message))
