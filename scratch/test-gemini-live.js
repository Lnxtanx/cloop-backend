const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env'), override: true })
const axios = require('axios')
const WebSocket = require('ws')

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY

console.log('======================================================')
console.log('🔑 TESTING GEMINI API KEY & MODELS')
console.log('======================================================\n')
console.log('API Key detected:', GEMINI_API_KEY ? `${GEMINI_API_KEY.slice(0, 8)}...${GEMINI_API_KEY.slice(-4)}` : '❌ NOT FOUND')

if (!GEMINI_API_KEY) {
	console.error('❌ Please set GEMINI_API_KEY in .env')
	process.exit(1)
}

async function testGeminiModels() {
	// 1. Test listing available models
	console.log('\n1️⃣ Checking available Gemini models via REST API...')
	try {
		const res = await axios.get(
			`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`
		)
		if (res.data && res.data.models) {
			const models = res.data.models.map(m => m.name.replace('models/', ''))
			console.log(`✅ Success! Found ${models.length} models.`)
			console.log('Available models relevant for Live/Chat:')
			const relevant = models.filter(m => m.includes('flash') || m.includes('live') || m.includes('2.0') || m.includes('2.5') || m.includes('3.'))
			console.log(relevant.slice(0, 15).map(m => `   - ${m}`).join('\n'))
		}
	} catch (err) {
		console.error('❌ Failed to list models:', err.response?.data || err.message)
	}

	// 2. Test generateContent REST API
	console.log('\n2️⃣ Testing Gemini REST generateContent (assessment evaluation model)...')
	const testModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']
	let workingRestModel = null

	for (const model of testModels) {
		try {
			const res = await axios.post(
				`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
				{
					contents: [{ parts: [{ text: 'Hello! Respond with {"status":"ok","model":"' + model + '"}' }] }],
					generationConfig: { responseMimeType: 'application/json' }
				}
			)
			const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text
			console.log(`   ✅ [REST ${model}] Response:`, text?.trim())
			workingRestModel = model
			break
		} catch (err) {
			console.log(`   ⚠️ [REST ${model}] Failed:`, err.response?.data?.error?.message || err.message)
		}
	}

	// 3. Test Gemini Live WebSocket API
	console.log('\n3️⃣ Testing Gemini Multimodal Live WebSocket connection...')
	const liveModelsToTest = [
		'gemini-2.0-flash-exp',
		'gemini-2.0-flash-realtime-exp',
		'gemini-2.5-flash',
		'gemini-3.1-flash-live-preview'
	]

	for (const model of liveModelsToTest) {
		await testLiveWebSocket(model)
	}

	console.log('\n======================================================\n')
}

function testLiveWebSocket(modelName) {
	return new Promise((resolve) => {
		console.log(`\n   Connecting to Live WS with model "${modelName}"...`)
		const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`

		const ws = new WebSocket(wsUrl)
		let resolved = false

		const timer = setTimeout(() => {
			if (!resolved) {
				resolved = true
				console.log(`   ⏱ [WS ${modelName}] Timed out after 5s`)
				ws.terminate()
				resolve(false)
			}
		}, 5000)

		ws.on('open', () => {
			console.log(`   ✅ [WS ${modelName}] Connected to Google server! Sending setup...`)
			const setupMsg = {
				setup: {
					model: `models/${modelName}`,
					generationConfig: {
						responseModalities: ['AUDIO'],
						speechConfig: {
							voiceConfig: {
								prebuiltVoiceConfig: { voiceName: 'Aoede' }
							}
						}
					}
				}
			}
			ws.send(JSON.stringify(setupMsg))
		})

		ws.on('message', (data) => {
			try {
				const parsed = JSON.parse(data.toString())
				if (parsed.setupComplete) {
					console.log(`   🎉 [WS ${modelName}] Setup complete! This model is FULLY SUPPORTED for Live conversation.`)
					clearTimeout(timer)
					if (!resolved) {
						resolved = true
						ws.close()
						resolve(true)
					}
				} else {
					console.log(`   ℹ [WS ${modelName}] Message:`, JSON.stringify(parsed).slice(0, 120))
				}
			} catch (e) {
				console.log(`   ℹ [WS ${modelName}] Raw message:`, data.toString().slice(0, 100))
			}
		})

		ws.on('error', (err) => {
			console.log(`   ❌ [WS ${modelName}] Error:`, err.message)
		})

		ws.on('close', (code, reason) => {
			console.log(`   ℹ [WS ${modelName}] Closed: code=${code}, reason=${reason?.toString() || 'none'}`)
			clearTimeout(timer)
			if (!resolved) {
				resolved = true
				resolve(false)
			}
		})
	})
}

testGeminiModels()
