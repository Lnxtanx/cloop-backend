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
// Voice Chat REST routes (Legacy - Moved to Python Service)
// app.use('/api/voice-chat', require('./api/voice-chat/voice-chat'))
app.use('/api/internal/tools', require('./api/internal/tools'))

const PORT = process.env.PORT || 4000
const HOST = process.env.HOST || '0.0.0.0' // Listen on all network interfaces

// Create HTTP server for both Express and WebSocket
const server = http.createServer(app)

// Create WebSocket server (Legacy - Removed)
// const wss = new WebSocket.Server({ noServer: true })

// Voice realtime service (lazy loaded to avoid circular deps)
// let voiceRealtimeService = null

// Prisma for storing transcripts
const prisma = require('./lib/prisma')

// Handle WebSocket upgrade requests
// WebSocket handling for voice chat has been moved to Python microservice
// wss.handleUpgrade and wss.on('connection') logic removed.

server.listen(PORT, HOST, async () => {
	console.log(`\n🚀 Backend server listening on ${HOST}:${PORT}`)
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
