/**
 * Voice Realtime Service
 * Handles WebSocket connection to OpenAI Realtime API for voice processing
 */

const WebSocket = require('ws')
const { toolDefinitions, executeTool } = require('./ai-tools')
const { buildMinimalContext } = require('./user-context-builder')

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17'

/**
 * Create a new realtime session for a user
 */
async function createRealtimeSession(userId, userContext) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.API_KEY_OPENAI
        if (!apiKey) {
            reject(new Error('OpenAI API key not configured'))
            return
        }

        const ws = new WebSocket(OPENAI_REALTIME_URL, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        })

        ws.on('open', () => {
            console.log('[Voice] Connected to OpenAI Realtime API')

            // Configure the session
            const sessionConfig = {
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'],
                    instructions: buildSystemPrompt(userContext),
                    voice: 'alloy',
                    input_audio_format: 'pcm16',
                    output_audio_format: 'pcm16',
                    input_audio_transcription: {
                        model: 'whisper-1'
                    },
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.6,
                        prefix_padding_ms: 500,
                        silence_duration_ms: 1500
                    },
                    tools: toolDefinitions
                }
            }

            ws.send(JSON.stringify(sessionConfig))
            resolve(ws)
        })

        ws.on('error', (error) => {
            console.error('[Voice] OpenAI WebSocket error:', error)
            reject(error)
        })

        // Set a connection timeout
        setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                ws.close()
                reject(new Error('Connection timeout'))
            }
        }, 10000)
    })
}

/**
 * Build system prompt with user context
 */
function buildSystemPrompt(userContext) {
    return `You are Cloop AI, a friendly study assistant. You are in a voice conversation with a student.

${userContext || 'Student information not available.'}

CRITICAL BEHAVIOR RULES:
1. WAIT and LISTEN - Do NOT speak until the student asks you something or gives you a command
2. Do NOT proactively offer information or suggestions unless specifically asked
3. Keep responses SHORT - maximum 2 sentences unless the student asks for details
4. Only use tools when the student explicitly asks for data (scores, progress, recommendations)
5. ALWAYS respond in English by default

When the student speaks:
- If they ask a question → Answer briefly
- If they ask for data → Use tools to fetch it, then summarize
- If they just say "hi" or "hello" → Say a brief greeting like "Hey! What can I help you with?"
- If they're silent → Stay silent too, wait for them to speak

You are a LISTENER first. Let the student lead the conversation.`
}

/**
 * Handle messages from OpenAI and relay to client
 */
function setupMessageHandler(openaiWs, clientWs, userId, onTranscript) {
    let conversationItems = []

    openaiWs.on('message', async (data) => {
        try {
            const event = JSON.parse(data.toString())

            switch (event.type) {
                case 'session.created':
                    console.log('[Voice] Session created')
                    clientWs.send(JSON.stringify({ type: 'session.ready' }))
                    break

                case 'session.updated':
                    console.log('[Voice] Session updated')
                    break

                case 'input_audio_buffer.speech_started':
                    clientWs.send(JSON.stringify({ type: 'user.speaking' }))
                    break

                case 'input_audio_buffer.speech_stopped':
                    clientWs.send(JSON.stringify({ type: 'user.stopped' }))
                    break

                case 'conversation.item.input_audio_transcription.completed':
                    // User's speech transcribed
                    const userTranscript = event.transcript
                    console.log('[Voice] User said:', userTranscript)
                    clientWs.send(JSON.stringify({
                        type: 'transcript.user',
                        text: userTranscript
                    }))
                    if (onTranscript) {
                        onTranscript('user', userTranscript)
                    }
                    break

                case 'response.audio_transcript.delta':
                    // AI speaking - partial transcript
                    clientWs.send(JSON.stringify({
                        type: 'transcript.ai.delta',
                        text: event.delta
                    }))
                    break

                case 'response.audio_transcript.done':
                    // AI finished speaking - full transcript
                    console.log('[Voice] AI said:', event.transcript)
                    clientWs.send(JSON.stringify({
                        type: 'transcript.ai',
                        text: event.transcript
                    }))
                    if (onTranscript) {
                        onTranscript('ai', event.transcript)
                    }
                    break

                case 'response.audio.delta':
                    // Audio data from AI - relay to client
                    clientWs.send(JSON.stringify({
                        type: 'audio.delta',
                        audio: event.delta // base64 encoded audio
                    }))
                    break

                case 'response.audio.done':
                    clientWs.send(JSON.stringify({ type: 'audio.done' }))
                    break

                case 'response.function_call_arguments.done':
                    // AI wants to call a tool
                    console.log('[Voice] Tool call:', event.name, event.arguments)

                    try {
                        const args = JSON.parse(event.arguments || '{}')
                        const result = await executeTool(userId, event.name, args)

                        // Send tool result back to OpenAI
                        openaiWs.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: event.call_id,
                                output: JSON.stringify(result)
                            }
                        }))

                        // Trigger response generation
                        openaiWs.send(JSON.stringify({
                            type: 'response.create'
                        }))
                    } catch (toolError) {
                        console.error('[Voice] Tool execution error:', toolError)
                        openaiWs.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: event.call_id,
                                output: JSON.stringify({ error: toolError.message })
                            }
                        }))
                        openaiWs.send(JSON.stringify({
                            type: 'response.create'
                        }))
                    }
                    break

                case 'error':
                    console.error('[Voice] OpenAI error:', event.error)
                    clientWs.send(JSON.stringify({
                        type: 'error',
                        message: event.error?.message || 'Unknown error'
                    }))
                    break

                case 'rate_limits.updated':
                    // Ignore rate limit updates
                    break

                default:
                    // Log unhandled events for debugging
                    if (event.type && !event.type.includes('delta')) {
                        console.log('[Voice] Event:', event.type)
                    }
            }
        } catch (error) {
            console.error('[Voice] Error processing message:', error)
        }
    })

    openaiWs.on('close', (code, reason) => {
        console.log('[Voice] OpenAI connection closed:', code, reason?.toString())
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
                type: 'session.ended',
                reason: 'OpenAI connection closed'
            }))
        }
    })

    openaiWs.on('error', (error) => {
        console.error('[Voice] OpenAI error:', error)
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
                type: 'error',
                message: 'Voice service connection error'
            }))
        }
    })
}

/**
 * Send audio data to OpenAI
 */
function sendAudio(openaiWs, audioBase64) {
    if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: audioBase64
        }))
    }
}

/**
 * Commit audio buffer (signal end of speech, optional manual mode)
 */
function commitAudio(openaiWs) {
    if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.commit'
        }))
        openaiWs.send(JSON.stringify({
            type: 'response.create'
        }))
    }
}

/**
 * Cancel current response (interrupt AI)
 */
function cancelResponse(openaiWs) {
    if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
            type: 'response.cancel'
        }))
    }
}

/**
 * Close the session
 */
function closeSession(openaiWs) {
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close()
    }
}

module.exports = {
    createRealtimeSession,
    setupMessageHandler,
    sendAudio,
    commitAudio,
    cancelResponse,
    closeSession,
    buildMinimalContext
}
