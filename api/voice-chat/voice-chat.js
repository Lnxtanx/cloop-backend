/**
 * Voice Chat API Routes
 * REST endpoints and WebSocket handler for voice chat
 */

const express = require('express')
const router = express.Router()
const axios = require('axios')
const { authenticateToken } = require('../../middleware/auth')
const prisma = require('../../lib/prisma')
const { buildMinimalContext } = require('../../services/user-context-builder')

// POST /api/voice-chat/sarvam-tts
// Convert text to speech using Sarvam AI
router.post('/sarvam-tts', authenticateToken, async (req, res) => {
    const { text, speaker = 'priya', language = 'en-IN' } = req.body

    if (!text) {
        return res.status(400).json({ error: 'Text content is required' })
    }

    try {
        const apiKey = process.env.SARVAM_API_KEY
        if (!apiKey) {
            console.error('[Voice API] SARVAM_API_KEY not configured')
            return res.status(500).json({ error: 'Sarvam AI service configuration missing' })
        }

        console.log(`[Voice API] Synthesizing text with speaker ${speaker} and language ${language}`)

        const response = await axios.post(
            'https://api.sarvam.ai/text-to-speech',
            {
                text: text,
                speaker: speaker,
                target_language_code: language,
                model: 'bulbul:v3',
                pace: 1.0,
                sample_rate: 24000
            },
            {
                headers: {
                    'api-subscription-key': apiKey,
                    'Content-Type': 'application/json'
                }
            }
        )

        // The Sarvam AI REST API returns an object containing an array of audios: { audios: [ { audio: "base64String..." } ] }
        if (response.data && response.data.audios && response.data.audios.length > 0) {
            const audioBase64 = response.data.audios[0].audio
            return res.status(200).json({ audio: audioBase64 })
        } else {
            console.error('[Voice API] Sarvam TTS response did not return audio', response.data)
            return res.status(500).json({ error: 'Failed to synthesize speech' })
        }
    } catch (error) {
        console.error('[Voice API] Sarvam TTS error:', error.response?.data || error.message)
        return res.status(error.response?.status || 500).json({
            error: 'Sarvam AI synthesis request failed',
            details: error.response?.data || error.message
        })
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
