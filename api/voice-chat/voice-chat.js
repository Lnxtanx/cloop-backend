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
const { invokeModel } = require('../../services/ai/bedrock-client')

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

        let cleanText = text.trim()
        if (cleanText.length > 500) {
            cleanText = cleanText.substring(0, 500) + '...'
        }

        const response = await axios.post(
            'https://api.sarvam.ai/text-to-speech',
            {
                text: cleanText,
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
                },
                timeout: 8000
            }
        )

        // The Sarvam AI REST API returns an object containing an array of audios: { audios: [ "base64String..." ] }
        if (response.data && response.data.audios && response.data.audios.length > 0) {
            const audioBase64 = response.data.audios[0]
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

// POST /api/voice-chat/message
// Send a message and get AI response + Sarvam TTS audio
router.post('/message', authenticateToken, async (req, res) => {
	const userId = req.user?.user_id
	const { message } = req.body

	if (!userId) {
		return res.status(401).json({ error: 'Authentication required' })
	}
	if (!message) {
		return res.status(400).json({ error: 'Message content is required' })
	}

	try {
		// 1. Save user's message as a voice transcript
		const userMsg = await prisma.normal_user_chat.create({
			data: {
				user_id: userId,
				sender: 'user',
				message: message,
				message_type: 'voice_transcript',
				images: [],
				videos: [],
				links: [],
				emoji: null
			}
		})

		// 2. Fetch recent voice chat history (last 10 messages)
		const historyRaw = await prisma.normal_user_chat.findMany({
			where: {
				user_id: userId,
				message_type: 'voice_transcript'
			},
			orderBy: { created_at: 'desc' },
			take: 10
		})

		// Reverse history to chronological order
		const history = historyRaw.reverse()

		// Format messages for Bedrock
		const messages = history.map(msg => ({
			role: msg.sender === 'ai' ? 'assistant' : 'user',
			content: msg.message
		}))

		// 3. Voice Tutor System Prompt (strictly conversational, no markdown)
		const systemPrompt = `You are Cloop AI, a friendly, encouraging, and helpful conversational Voice Tutor for competitive exams like NEET, JEE, and KCET.
		The student is speaking to you over a live voice call. 
		Be warm, direct, and conversational. 
		Since your response will be read aloud via Text-to-Speech:
		- DO NOT use markdown lists, headers, bullet points, asterisks, or LaTeX formulas.
		- Keep your explanation simple, clear, and concise (max 2-3 sentences).
		- Speak naturally as if in a face-to-face tutoring session.
		- Never mention you are a text-based AI. You can hear the user perfectly via speech recognition.`

		let aiResponseText = "I'm here to help!"
		try {
			const apiKey = process.env.SARVAM_API_KEY
			if (apiKey) {
				const chatResponse = await axios.post(
					'https://api.sarvam.ai/v1/chat/completions',
					{
						model: 'sarvam-2b-v0.5',
						messages: [
							{ role: 'system', content: systemPrompt },
							...messages
						],
						temperature: 0.7,
						max_tokens: 1024
					},
					{
						headers: {
							'api-subscription-key': apiKey,
							'Content-Type': 'application/json'
						},
						timeout: 8000
					}
				)

				if (chatResponse.data && chatResponse.data.choices && chatResponse.data.choices.length > 0) {
					aiResponseText = chatResponse.data.choices[0].message.content
				}
			}
		} catch (e) {
			console.error('[Voice API] Sarvam LLM Chat completion failed:', e.response?.data || e.message)
		}

		// 5. Save AI's response in the database
		const aiMsg = await prisma.normal_user_chat.create({
			data: {
				user_id: userId,
				sender: 'ai',
				message: aiResponseText,
				message_type: 'voice_transcript',
				images: [],
				videos: [],
				links: [],
				emoji: '🎙️'
			}
		})

		// Update user's chat count
		await prisma.users.update({
			where: { user_id: userId },
			data: { num_chats: { increment: 1 } }
		})

		// 6. Synthesize TTS with Sarvam AI
		let audioBase64 = null
		try {
			const apiKey = process.env.SARVAM_API_KEY
			if (apiKey && aiResponseText) {
				let cleanText = aiResponseText
					.replace(/<[^>]+>/g, "") // strip HTML tags
					.replace(/\*\*([^*]+)\*\*/g, "$1") // strip markdown bold
					.replace(/_([^_]+)_/g, "$1") // strip markdown italic
					.trim();

				if (cleanText.length > 500) {
					cleanText = cleanText.substring(0, 500) + "...";
				}

				if (cleanText) {
					const ttsResponse = await axios.post(
						'https://api.sarvam.ai/text-to-speech',
						{
							text: cleanText,
							speaker: 'priya',
							target_language_code: 'en-IN',
							model: 'bulbul:v3',
							pace: 1.0,
							sample_rate: 24000
						},
						{
							headers: {
								'api-subscription-key': apiKey,
								'Content-Type': 'application/json'
							},
							timeout: 8000
						}
					);

					if (ttsResponse.data && ttsResponse.data.audios && ttsResponse.data.audios.length > 0) {
						audioBase64 = ttsResponse.data.audios[0]
					}
				}
			}
		} catch (ttsErr) {
			console.error('[Voice API] Parallel TTS failed for message:', ttsErr.message)
		}

		// 7. Return the response
		return res.status(200).json({
			userMessage: userMsg,
			aiMessage: {
				...aiMsg,
				audio: audioBase64
			}
		})

	} catch (error) {
		console.error('[Voice API] Error processing voice message:', error)
		return res.status(500).json({ error: 'Failed to process voice message' })
	}
})

module.exports = router
