/**
 * Voice Chat API Routes
 * REST endpoints and WebSocket handler for voice chat
 */

const express = require('express')
const router = express.Router()
const { authenticateToken } = require('../../middleware/auth')
const prisma = require('../../lib/prisma')
const { buildMinimalContext } = require('../../services/user-context-builder')

// GET /api/voice-chat/session
// Create a new voice chat session and return session info
router.get('/session', authenticateToken, async (req, res) => {
    const userId = req.user?.user_id

    if (!userId) {
        return res.status(401).json({ error: 'Authentication required' })
    }

    try {
        // Build user context for the session
        const context = await buildMinimalContext(userId)

        if (!context) {
            return res.status(404).json({ error: 'User not found' })
        }

        // Return session info (WebSocket URL is relative)
        return res.status(200).json({
            sessionId: `voice_${userId}_${Date.now()}`,
            wsPath: '/api/voice-chat/stream',
            userContext: context,
            message: 'Ready to connect via WebSocket'
        })
    } catch (error) {
        console.error('[Voice API] Session creation error:', error)
        return res.status(500).json({ error: 'Failed to create voice session' })
    }
})

// POST /api/voice-chat/transcript
// Store a voice chat transcript in the normal_user_chat table
router.post('/transcript', authenticateToken, async (req, res) => {
    const userId = req.user?.user_id
    const { messages } = req.body

    if (!userId) {
        return res.status(401).json({ error: 'Authentication required' })
    }

    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Messages array is required' })
    }

    try {
        // Store each message in normal_user_chat
        const createdMessages = []

        for (const msg of messages) {
            if (!msg.sender || !msg.message) continue

            const created = await prisma.normal_user_chat.create({
                data: {
                    user_id: userId,
                    sender: msg.sender, // 'user' or 'ai'
                    message: msg.message,
                    message_type: 'voice_transcript',
                    images: [],
                    videos: [],
                    links: [],
                    emoji: msg.sender === 'ai' ? '🎙️' : null
                },
                select: {
                    id: true,
                    sender: true,
                    message: true,
                    created_at: true
                }
            })
            createdMessages.push(created)
        }

        // Update user's chat count
        if (createdMessages.length > 0) {
            await prisma.users.update({
                where: { user_id: userId },
                data: { num_chats: { increment: 1 } }
            })
        }

        return res.status(201).json({
            saved: createdMessages.length,
            messages: createdMessages
        })
    } catch (error) {
        console.error('[Voice API] Transcript save error:', error)
        return res.status(500).json({ error: 'Failed to save transcript' })
    }
})

// GET /api/voice-chat/history
// Get recent voice chat transcripts
router.get('/history', authenticateToken, async (req, res) => {
    const userId = req.user?.user_id
    const limit = Math.min(parseInt(req.query.limit) || 50, 100)

    if (!userId) {
        return res.status(401).json({ error: 'Authentication required' })
    }

    try {
        const messages = await prisma.normal_user_chat.findMany({
            where: {
                user_id: userId,
                message_type: 'voice_transcript'
            },
            orderBy: { created_at: 'desc' },
            take: limit,
            select: {
                id: true,
                sender: true,
                message: true,
                created_at: true
            }
        })

        return res.status(200).json({
            messages: messages.reverse() // Chronological order
        })
    } catch (error) {
        console.error('[Voice API] History fetch error:', error)
        return res.status(500).json({ error: 'Failed to fetch history' })
    }
})

module.exports = router
