const express = require('express')
const router = express.Router()
const { authenticateToken } = require('../../middleware/auth')

const prisma = require('../../lib/prisma')

// Bedrock integration
const { invokeModel } = require('../../services/ai/bedrock-client')

// GET /api/normal-chat/sessions
// Fetch all chat sessions for a user
router.get('/sessions', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id
	if (!user_id) return res.status(401).json({ error: 'Authentication required' })

	try {
		const sessions = await prisma.normal_chat_sessions.findMany({
			where: { user_id },
			orderBy: { updated_at: 'desc' },
			include: {
				messages: {
					orderBy: { created_at: 'desc' },
					take: 1,
					select: { message: true }
				}
			}
		})

		return res.status(200).json({ sessions })
	} catch (err) {
		console.error('Error fetching sessions:', err)
		return res.status(500).json({ error: 'Server error' })
	}
})

// POST /api/normal-chat/sessions
// Create a new chat session
router.post('/sessions', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id
	const { title } = req.body
	if (!user_id) return res.status(401).json({ error: 'Authentication required' })

	try {
		const session = await prisma.normal_chat_sessions.create({
			data: {
				user_id,
				title: title || 'New Chat'
			}
		})
		return res.status(201).json({ session })
	} catch (err) {
		console.error('Error creating session:', err)
		return res.status(500).json({ error: 'Server error' })
	}
})

// GET /api/normal-chat/
// Fetch messages for a specific session (or default to latest)
router.get('/', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id
	const { session_id } = req.query

	if (!user_id) return res.status(401).json({ error: 'Authentication required' })

	try {
		let target_session_id = session_id ? parseInt(session_id) : null

		if (!target_session_id) {
			const latestSession = await prisma.normal_chat_sessions.findFirst({
				where: { user_id },
				orderBy: { updated_at: 'desc' }
			})
			target_session_id = latestSession?.id || null
		}

		if (!target_session_id) {
			return res.status(200).json({ messages: [], session_id: null })
		}

		const chatMessages = await prisma.normal_user_chat.findMany({
			where: { session_id: target_session_id },
			orderBy: { created_at: 'asc' }
		})

		return res.status(200).json({
			messages: chatMessages,
			session_id: target_session_id
		})
	} catch (err) {
		console.error('Error fetching chat messages:', err)
		return res.status(500).json({ error: 'Server error' })
	}
})

// POST /api/normal-chat/message
// Send a new message in normal chat
router.post('/message', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id
	const { message, session_id } = req.body

	if (!user_id) return res.status(401).json({ error: 'Authentication required' })
	if (!message) return res.status(400).json({ error: 'Message is required' })

	try {
		let current_session_id = session_id ? parseInt(session_id) : null

		// Auto-create session if none exists
		if (!current_session_id) {
			const newSession = await prisma.normal_chat_sessions.create({
				data: {
					user_id,
					title: message.substring(0, 30) + (message.length > 30 ? '...' : '')
				}
			})
			current_session_id = newSession.id
		}

		// Create user message
		const userMessage = await prisma.normal_user_chat.create({
			data: {
				user_id,
				session_id: current_session_id,
				sender: 'user',
				message,
				message_type: 'text'
			}
		})

		// Update session updated_at
		await prisma.normal_chat_sessions.update({
			where: { id: current_session_id },
			data: { updated_at: new Date() }
		})

		// Generate AI response with history
		let aiResponseText = "I'm here to help!"
		try {
			// Fetch last 10 messages for context
			const history = await prisma.normal_user_chat.findMany({
				where: { session_id: current_session_id },
				orderBy: { created_at: 'asc' },
				take: 11 // Current message is already saved, so take 10 previous + 1 current
			})

			const messages = history.map(msg => ({
				role: msg.sender === 'ai' ? 'assistant' : 'user',
				content: msg.message
			}))

			const systemPrompt = `You are Cloop AI, a helpful educational assistant for competitive exams like NEET, JEE, and KCET. 
			Be supportive, clear, and concise. 
			When explaining technical concepts, use simple analogies.
			ALWAYS format math formulas using LaTeX notation like $[ formula ]$ or $$ formula $$ for better rendering.
			Example: $[ \text{Strain} = \frac{\Delta L}{L} ]$`

			aiResponseText = await invokeModel(systemPrompt, messages, {
				maxTokens: 2048,
				temperature: 0.7
			})
		} catch (e) {
			console.error('AI Error:', e)
		}
		
		const aiMessage = await prisma.normal_user_chat.create({
			data: {
				user_id,
				session_id: current_session_id,
				sender: 'ai',
				message: aiResponseText,
				message_type: 'text'
			}
		})

		return res.status(201).json({
			userMessage,
			aiMessage,
			session_id: current_session_id
		})
	} catch (err) {
		console.error('Error sending message:', err)
		return res.status(500).json({ error: 'Server error' })
	}
})

// DELETE /api/normal-chat/sessions/:id
router.delete('/sessions/:id', authenticateToken, async (req, res) => {
	const { id } = req.params
	try {
		await prisma.normal_chat_sessions.delete({
			where: { id: parseInt(id) }
		})
		return res.status(200).json({ message: 'Session deleted' })
	} catch (err) {
		return res.status(500).json({ error: 'Server error' })
	}
})

module.exports = router

