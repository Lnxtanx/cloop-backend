const WebSocket = require('ws')
const dotenv = require('dotenv')
const path = require('path')

dotenv.config({ path: path.join(__dirname, '..', '.env') })

const apiKey = process.env.GEMINI_API_KEY
const model = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview'
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`

const { buildSessionPrompt, LOG_ERROR_TOOL } = require('../services/voice-session-prompts')

console.log('Connecting to Gemini Live at:', url.replace(apiKey, '***'))
const ws = new WebSocket(url)

ws.on('open', () => {
  console.log('Connected to Gemini Live WebSocket!')

  const systemInstructionText = buildSessionPrompt('free_practice', 'free_talk', 'free_talk', {
    name: 'Rohit',
    englishLevel: 'Beginner'
  })

  const setupMsg = {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: 'Aoede',
            },
          },
        },
      },
      systemInstruction: {
        parts: [{ text: systemInstructionText }],
      },
      tools: [LOG_ERROR_TOOL],
    },
  }

  console.log('Sending setupMsg...')
  ws.send(JSON.stringify(setupMsg))
})

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  console.log('Received message from Gemini Live:', JSON.stringify(msg, null, 2).slice(0, 500))
  if (msg.setupComplete) {
    console.log('SUCCESS: Setup complete received from Gemini Live!')
    ws.close()
    process.exit(0)
  }
})

ws.on('error', (err) => {
  console.error('Gemini Live error:', err)
})

ws.on('close', (code, reason) => {
  console.log(`Gemini Live closed: code=${code}, reason=${reason?.toString()}`)
})
