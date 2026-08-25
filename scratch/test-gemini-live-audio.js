const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env'), override: true })
const WebSocket = require('ws')

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
const GEMINI_MODEL = 'gemini-3.1-flash-live-preview'
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`

console.log('Testing sending realtimeInput to Gemini Live...')

const ws = new WebSocket(GEMINI_WS_URL)

ws.on('open', () => {
	console.log('Connected! Sending setup...')
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
				parts: [{ text: 'You are Eva. When greeting, say "Hello there, welcome to your speaking assessment!"' }]
			}
		}
	}
	ws.send(JSON.stringify(setupMsg))
})

ws.on('message', (data) => {
	const msg = JSON.parse(data.toString())
	console.log('Received:', Object.keys(msg))

	if (msg.setupComplete) {
		console.log('✅ Setup complete!')

		// Test 1: Send clientContent turn to trigger greeting
		console.log('Sending initial trigger turn...')
		const initialMsg = {
			clientContent: {
				turns: [
					{
						role: 'user',
						parts: [{ text: 'Please start now.' }]
					}
				],
				turnComplete: true
			}
		}
		ws.send(JSON.stringify(initialMsg))

		// Test 2: Send dummy PCM audio chunk
		setTimeout(() => {
			console.log('Testing sending realtimeInput with "audio"...')
			// Create 100ms of silence in PCM16 (1600 samples = 3200 bytes)
			const silencePcm16 = Buffer.alloc(3200)
			const base64Audio = silencePcm16.toString('base64')

			// Test new realtimeInput format: { realtimeInput: { audio: { data: ..., mimeType: ... } } }
			const audioMsg = {
				realtimeInput: {
					audio: {
						mimeType: 'audio/pcm;rate=16000',
						data: base64Audio
					}
				}
			}
			ws.send(JSON.stringify(audioMsg))
			console.log('Sent audio payload!')
		}, 1000)
	}

	if (msg.serverContent) {
		if (msg.serverContent.modelTurn?.parts) {
			for (const part of msg.serverContent.modelTurn.parts) {
				if (part.inlineData) {
					console.log('🔊 Received audio chunk from Eva! MimeType:', part.inlineData.mimeType, 'Data length:', part.inlineData.data?.length)
				}
				if (part.text) {
					console.log('💬 Received text from Eva:', part.text)
				}
			}
		}
		if (msg.serverContent.turnComplete) {
			console.log('🎉 Turn complete!')
			setTimeout(() => {
				ws.close()
				process.exit(0)
			}, 2000)
		}
	}
})

ws.on('error', (err) => {
	console.error('❌ WS Error:', err.message)
})

ws.on('close', (code, reason) => {
	console.log(`WS Closed: code=${code}, reason=${reason?.toString()}`)
})
