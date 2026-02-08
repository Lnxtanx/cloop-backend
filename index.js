const express = require('express')
const cors = require('cors')
const dotenv = require('dotenv')
const path = require('path')
const http = require('http')
const WebSocket = require('ws')
const url = require('url')
const jwt = require('jsonwebtoken')
const { startContinuousProcessing } = require('./services/background-processor')

dotenv.config({ path: path.join(__dirname, '.env') })

const app = express()

// Configure CORS for development and production
const corsOptions = {
	origin: function (origin, callback) {
		// Allow requests with no origin (like mobile apps, Postman, curl)
		if (!origin) return callback(null, true)

		const allowedOrigins = [
			// Development
			'http://localhost:8081',
			'http://localhost:19000',
			'http://localhost:19002',
			'http://localhost:3000',
			// Production - Add your frontend URLs here
			process.env.FRONTEND_URL,
		].filter(Boolean)

		// Allow all local network IPs for development
		const isLocalNetwork = /^http:\/\/(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01]))/.test(origin)

		if (allowedOrigins.indexOf(origin) !== -1 || isLocalNetwork || process.env.NODE_ENV === 'development') {
			callback(null, true)
		} else {
			callback(new Error('Not allowed by CORS'))
		}
	},
	credentials: true,
	methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
	allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}

app.use(cors(corsOptions))
app.use(express.json())

// Mount API routes
app.use('/api/signup', require('./api/signup/signup'))
app.use('/api/signup/options', require('./api/signup/options'))
app.use('/api/login', require('./api/login/login'))
// Profile routes
app.use('/api/profile', require('./api/profile/get-profile'))
app.use('/api/profile', require('./api/profile/update'))
app.use('/api/profile', require('./api/profile/push-token'))
app.use('/api/profile', require('./api/profile/manage-subjects'))
app.use('/api/profile/chat-history', require('./api/profile/chat-history'))
app.use('/api/profile/metrics', require('./api/profile/metrics'))
app.use('/api/profile/learning-analytics', require('./api/profile/learning-analytics'))
// Chapters and Topics routes
app.use('/api/chapters', require('./api/chapters/chapters'))
app.use('/api/topics', require('./api/topics/topics'))
// Topic Chat routes
app.use('/api/topic-chats', require('./api/topic-chats/topic-chats'))
// Normal Chat routes
app.use('/api/normal-chat', require('./api/normal-chat/normal-chat'))
// Content Generation (AI Pipeline) routes
app.use('/api/content-generation', require('./api/content-generation/content-generation'))
app.use('/api/saved-topics', require('./api/saved-topics/saved-topics'))
app.use('/api/notifications', require('./api/notifications/notifications'))
// Voice Chat REST routes
app.use('/api/voice-chat', require('./api/voice-chat/voice-chat'))

const PORT = process.env.PORT || 4000
const HOST = process.env.HOST || '0.0.0.0' // Listen on all network interfaces

// Create HTTP server for both Express and WebSocket
const server = http.createServer(app)

// Create WebSocket server for voice chat
const wss = new WebSocket.Server({ noServer: true })

// Voice realtime service (lazy loaded to avoid circular deps)
let voiceRealtimeService = null
const getVoiceService = () => {
	if (!voiceRealtimeService) {
		voiceRealtimeService = require('./services/voice-realtime')
	}
	return voiceRealtimeService
}

// Prisma for storing transcripts
const prisma = require('./lib/prisma')

// Handle WebSocket upgrade requests
server.on('upgrade', (request, socket, head) => {
	const { pathname, query } = url.parse(request.url, true)

	if (pathname === '/api/voice-chat/stream') {
		// Authenticate via token in query string
		const token = query.token
		if (!token) {
			socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
			socket.destroy()
			return
		}

		try {
			const decoded = jwt.verify(token, process.env.JWT_SECRET)
			request.user = decoded

			wss.handleUpgrade(request, socket, head, (ws) => {
				wss.emit('connection', ws, request)
			})
		} catch (err) {
			console.error('[Voice WS] Auth error:', err.message)
			socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
			socket.destroy()
		}
	} else {
		socket.destroy()
	}
})

// Handle WebSocket connections for voice chat
wss.on('connection', async (clientWs, request) => {
	const userId = request.user?.user_id
	console.log(`[Voice WS] Client connected: user_${userId}`)

	let openaiWs = null
	let transcripts = []

	try {
		const voiceService = getVoiceService()

		// Build user context
		const userContext = await voiceService.buildMinimalContext(userId)

		// Connect to OpenAI Realtime API
		openaiWs = await voiceService.createRealtimeSession(userId, userContext)

		// Setup message handler to relay between client and OpenAI
		voiceService.setupMessageHandler(openaiWs, clientWs, userId, (sender, text) => {
			// Collect transcripts for saving
			transcripts.push({ sender, message: text, timestamp: new Date() })
		})

		// Handle messages from client
		clientWs.on('message', (data) => {
			try {
				const msg = JSON.parse(data.toString())

				switch (msg.type) {
					case 'audio':
						// Client sending audio data
						voiceService.sendAudio(openaiWs, msg.audio)
						break

					case 'commit':
						// Client signals end of speech (manual mode)
						voiceService.commitAudio(openaiWs)
						break

					case 'cancel':
						// Client wants to interrupt AI
						voiceService.cancelResponse(openaiWs)
						break

					case 'ping':
						clientWs.send(JSON.stringify({ type: 'pong' }))
						break

					default:
						console.log('[Voice WS] Unknown message type:', msg.type)
				}
			} catch (err) {
				console.error('[Voice WS] Message parse error:', err)
			}
		})

		clientWs.on('close', async () => {
			console.log(`[Voice WS] Client disconnected: user_${userId}`)
			voiceService.closeSession(openaiWs)

			// Save transcripts to database
			if (transcripts.length > 0) {
				try {
					for (const t of transcripts) {
						await prisma.normal_user_chat.create({
							data: {
								user_id: userId,
								sender: t.sender,
								message: t.message,
								message_type: 'voice_transcript',
								images: [],
								videos: [],
								links: []
							}
						})
					}
					console.log(`[Voice WS] Saved ${transcripts.length} transcripts for user_${userId}`)
				} catch (saveErr) {
					console.error('[Voice WS] Failed to save transcripts:', saveErr)
				}
			}
		})

		clientWs.on('error', (err) => {
			console.error('[Voice WS] Client error:', err)
			voiceService.closeSession(openaiWs)
		})

	} catch (err) {
		console.error('[Voice WS] Connection setup error:', err)
		clientWs.send(JSON.stringify({
			type: 'error',
			message: 'Failed to establish voice connection: ' + err.message
		}))
		clientWs.close()
	}
})

server.listen(PORT, HOST, async () => {
	console.log(`\n🚀 Backend server listening on ${HOST}:${PORT}`)
	console.log(`🎙️ Voice WebSocket available at ws://${HOST}:${PORT}/api/voice-chat/stream`)
	console.log(`Environment: ${process.env.NODE_ENV || 'development'}`)
	console.log('='.repeat(60))

	// Start continuous background processor
	console.log('\n🔄 Initializing Content Generation Background Processor...')
	try {
		// Wait 3 seconds after server starts, then start continuous processing
		setTimeout(async () => {
			try {
				await startContinuousProcessing()
			} catch (error) {
				console.error('❌ Error starting background processor:', error)
			}
		}, 3000)
	} catch (error) {
		console.error('❌ Failed to initialize background processor:', error)
	}
})

// Graceful shutdown
process.on('SIGINT', async () => {
	console.log('\n\n🛑 Shutting down server...')
	const { stopContinuousProcessing } = require('./services/background-processor')
	await stopContinuousProcessing()

	// Close WebSocket server
	wss.close()
	server.close()

	process.exit(0)
})

process.on('SIGTERM', async () => {
	console.log('\n\n🛑 Shutting down server...')
	const { stopContinuousProcessing } = require('./services/background-processor')
	await stopContinuousProcessing()

	// Close WebSocket server
	wss.close()
	server.close()

	process.exit(0)
})

module.exports = app
