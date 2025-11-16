const express = require('express')
const router = express.Router()
const { authenticateToken } = require('../../middleware/auth')

const prisma = require('../../lib/prisma')

// OpenAI integration
const OpenAI = require('openai')
const openai = new OpenAI({
  apiKey: process.env.API_KEY_OPENAI,
})

// GET /api/normal-chat/
// Fetch all normal chat messages for a user
router.get('/', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id

	// For production, always require authenticated user
	if (!user_id) {
		return res.status(401).json({ error: 'Authentication required - please login' })
	}

	try {
		// Fetch chat messages for this user from normal_user_chat
		const chatMessages = await prisma.normal_user_chat.findMany({
			where: {
				user_id: user_id
			},
			orderBy: {
				created_at: 'asc'
			},
			select: {
				id: true,
				sender: true,
				message: true,
				message_type: true,
				images: true,
				videos: true,
				links: true,
				emoji: true,
				created_at: true
			}
		})

		return res.status(200).json({
			messages: chatMessages
		})
	} catch (err) {
		console.error('Error fetching normal chat messages:', err)
		return res.status(500).json({ error: 'Server error while fetching chat messages' })
	}
})

// POST /api/normal-chat/message
// Send a new message in normal chat
router.post('/message', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id
	const { message, file_url, file_type } = req.body

	// For production, always require authenticated user
	if (!user_id) {
		return res.status(401).json({ error: 'Authentication required - please login' })
	}

	if (!message && !file_url) {
		return res.status(400).json({ error: 'Message or file is required' })
	}

	try {
		// Create user message in normal_user_chat
		const userMessage = await prisma.normal_user_chat.create({
			data: {
				user_id: user_id,
				sender: 'user',
				message: message || null,
				message_type: 'text',
				images: file_url ? [file_url] : [],
				videos: [],
				links: []
			},
			select: {
				id: true,
				sender: true,
				message: true,
				message_type: true,
				images: true,
				videos: true,
				links: true,
				emoji: true,
				created_at: true
			}
		})

		// Generate AI response using OpenAI
		let aiResponseText = 'I apologize, but I encountered an issue generating a response. Please try again.'
		
		try {
			const completion = await openai.chat.completions.create({
				model: "gpt-3.5-turbo",
				messages: [
					{
						role: "system",
						content: `You are Cloop AI, a helpful and friendly educational assistant. You help students with their studies across various subjects. 
						
						Key traits:
						- Be encouraging and supportive
						- Provide clear, easy-to-understand explanations
						- Ask follow-up questions to ensure understanding
						- Relate concepts to real-world examples when possible
						- Maintain a positive, learning-focused tone
						- Keep responses concise but comprehensive
						- If you don't know something, admit it and suggest how to find the answer
						
						The student's message: "${message}"`
					},
					{
						role: "user",
						content: message
					}
				],
				max_tokens: 500,
				temperature: 0.7,
			})

			if (completion.choices && completion.choices[0] && completion.choices[0].message) {
				aiResponseText = completion.choices[0].message.content
			}
		} catch (openaiError) {
			console.error('OpenAI API error:', openaiError)
			// Fallback to a friendly error message
			aiResponseText = "I'm having trouble connecting to my knowledge base right now. Could you please try asking your question again? I'm here to help! 🤖📚"
		}
		
		const aiMessage = await prisma.normal_user_chat.create({
			data: {
				user_id: user_id,
				sender: 'ai',
				message: aiResponseText,
				message_type: 'text',
				images: [],
				videos: [],
				links: []
			},
			select: {
				id: true,
				sender: true,
				message: true,
				message_type: true,
				images: true,
				videos: true,
				links: true,
				emoji: true,
				created_at: true
			}
		})

		// Update user's chat count
		await prisma.users.update({
			where: { user_id: user_id },
			data: { num_chats: { increment: 1 } }
		})

		return res.status(201).json({
			userMessage,
			aiMessage
		})
	} catch (err) {
		console.error('Error sending normal chat message:', err)
		return res.status(500).json({ error: 'Server error while sending message' })
	}
})

// DELETE /api/normal-chat/clear
// Clear all normal chat messages for a user
router.delete('/clear', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id

	// For production, always require authenticated user
	if (!user_id) {
		return res.status(401).json({ error: 'Authentication required - please login' })
	}

	try {
		await prisma.normal_user_chat.deleteMany({
			where: {
				user_id: user_id
			}
		})

		return res.status(200).json({ message: 'Chat history cleared successfully' })
	} catch (err) {
		console.error('Error clearing chat history:', err)
		return res.status(500).json({ error: 'Server error while clearing chat history' })
	}
})

module.exports = router

