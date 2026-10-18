/**
 * Gemini Live Duplex Session Provider
 *
 * Transport-only client for the Gemini Live BidiGenerateContent WebSocket API.
 * Handles protocol mechanics exclusively: connection, setup payload, audio
 * streaming, client content turns, tool responses, and message dispatch.
 *
 * NOT handled here (belongs to agents/services):
 *   - Session state machines, turn persistence, DB writes
 *   - Prompt construction, tool schemas, greetings, wrap-up rules
 *   - App-side WebSocket servers and auth
 *
 * Dispatch contract (mirrors the Gemini Live protocol order for a serverContent message):
 *   1. modelTurn parts  -> onAudio / onToolCall / onModelText (in part order)
 *   2. outputTranscription -> onOutputTranscription
 *   3. inputTranscription  -> onInputTranscription
 *   4. modelTurn present   -> onModelTurn (after transcriptions, before turnComplete)
 *   5. turnComplete        -> onTurnComplete
 *   6. interrupted         -> onInterrupted
 *
 * Any callback may return the exact value `false` to stop processing the
 * remainder of the current message (mirrors the legacy proxy's early `return`
 * after tool calls).
 */

const WebSocket = require('ws');
const { MODELS, ENDPOINTS, LIVE_CONFIG, TIMEOUTS, getApiKey } = require('./constants');

/**
 * Build the BidiGenerateContentSetup message.
 * Only fields accepted by the setup schema are included — unknown fields make
 * Gemini close the socket with code 1007.
 */
function buildSetupMessage({
  model = MODELS.LIVE,
  systemInstruction = '',
  tools = [],
  voiceName = LIVE_CONFIG.VOICE_NAME,
  inputAudioTranscription = LIVE_CONFIG.INPUT_AUDIO_TRANSCRIPTION,
  outputAudioTranscription = LIVE_CONFIG.OUTPUT_AUDIO_TRANSCRIPTION,
  automaticActivityDetection = LIVE_CONFIG.AUTOMATIC_ACTIVITY_DETECTION,
  responseModalities = LIVE_CONFIG.RESPONSE_MODALITIES,
} = {}) {
  const setup = {
    model: `models/${model}`,
    generationConfig: {
      responseModalities: [...responseModalities],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
    realtimeInputConfig: {
      automaticActivityDetection,
    },
    systemInstruction: {
      parts: [{ text: systemInstruction || '' }],
    },
    tools: tools || [],
  };

  if (inputAudioTranscription) setup.inputAudioTranscription = {};
  if (outputAudioTranscription) setup.outputAudioTranscription = {};

  return { setup };
}

/**
 * Parse an incoming Gemini Live frame into an object. Returns null on invalid JSON.
 */
function parseLiveMessage(rawData) {
  try {
    const text = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/**
 * Route a parsed Gemini Live server message to the provided callbacks.
 * Awaits each callback sequentially; returning `false` stops the message.
 */
async function dispatchLiveMessage(msg, callbacks = {}) {
  if (!msg) return;

  const {
    onSetupComplete,
    onToolCall,
    onAudio,
    onModelText,
    onOutputTranscription,
    onInputTranscription,
    onModelTurn,
    onTurnComplete,
    onInterrupted,
    onUnknown,
  } = callbacks;

  // 1. Setup handshake
  if (msg.setupComplete) {
    if (onSetupComplete) {
      const result = await onSetupComplete(msg);
      if (result === false) return;
    }
    return;
  }

  // 2. Top-level tool call
  if (msg.toolCall) {
    if (onToolCall) {
      const result = await onToolCall(msg.toolCall, msg);
      if (result === false) return;
    } else {
      return;
    }
    return;
  }

  // 3. Server content (audio, transcripts, turns)
  const content = msg.serverContent;
  if (content) {
    // 3a. Model turn parts, in order
    const parts = content.modelTurn && Array.isArray(content.modelTurn.parts)
      ? content.modelTurn.parts
      : [];
    for (const part of parts) {
      if (part.inlineData) {
        if (onAudio) {
          const result = await onAudio(
            { data: part.inlineData.data, mimeType: part.inlineData.mimeType },
            part
          );
          if (result === false) return;
        }
      }
      if (part.functionCall) {
        if (onToolCall) {
          const result = await onToolCall({ functionCalls: [part.functionCall] }, msg);
          if (result === false) return;
        }
      }
      if (part.text && onModelText) {
        const result = await onModelText(part.text, part);
        if (result === false) return;
      }
    }

    // 3b. Model output transcription (tutor speaking)
    if (content.outputTranscription && content.outputTranscription.text && onOutputTranscription) {
      const result = await onOutputTranscription(content.outputTranscription.text, content);
      if (result === false) return;
    }

    // 3c. User input transcription (learner speaking)
    if (content.inputTranscription && content.inputTranscription.text && onInputTranscription) {
      const result = await onInputTranscription(content.inputTranscription.text, content);
      if (result === false) return;
    }

    // 3d. Model turn observed (after transcriptions — used to flush pending user turn)
    if (parts.length > 0 && onModelTurn) {
      const result = await onModelTurn(parts, content);
      if (result === false) return;
    }

    // 3e. Turn complete
    if (content.turnComplete && onTurnComplete) {
      const result = await onTurnComplete(content);
      if (result === false) return;
    }

    // 3f. Interruption
    if (content.interrupted && onInterrupted) {
      const result = await onInterrupted(content);
      if (result === false) return;
    }

    return;
  }

  if (onUnknown) await onUnknown(msg);
}

/**
 * Create a Gemini Live duplex session.
 *
 * @param {Object} options
 * @param {string} [options.apiKey] - defaults to GEMINI_API_KEY env
 * @param {string} [options.model]
 * @param {string} [options.systemInstruction]
 * @param {Array}  [options.tools] - function declarations
 * @param {string} [options.voiceName]
 * @param {Object} [options.callbacks] - see dispatchLiveMessage
 * @param {Function} [options.WebSocketImpl] - injectable WebSocket (tests)
 * @param {number} [options.connectTimeoutMs] - 0 disables
 * @returns session handle with connect/send* methods
 */
function createLiveSession({
  apiKey,
  model = MODELS.LIVE,
  systemInstruction = '',
  tools = [],
  voiceName = LIVE_CONFIG.VOICE_NAME,
  callbacks = {},
  WebSocketImpl = WebSocket,
  connectTimeoutMs = TIMEOUTS.LIVE_CONNECT_MS,
} = {}) {
  const key = apiKey || getApiKey();
  if (!key) {
    throw new Error('[GeminiLive] GEMINI_API_KEY is missing in environment variables (.env)');
  }

  let ws = null;
  let messageQueue = Promise.resolve();
  let connectTimer = null;

  function sendPayload(payload) {
    if (!ws || ws.readyState !== WebSocketImpl.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }

  const session = {
    get raw() {
      return ws;
    },

    get readyState() {
      return ws ? ws.readyState : WebSocketImpl.CLOSED;
    },

    isOpen() {
      return !!ws && ws.readyState === WebSocketImpl.OPEN;
    },

    /**
     * Open the socket, send the setup message, and resolve once connected.
     * Session flow continues through callbacks (onSetupComplete fires when Gemini acks).
     */
    connect() {
      return new Promise((resolve, reject) => {
        let settled = false;

        const settle = (fn, value) => {
          if (settled) return;
          settled = true;
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
          fn(value);
        };

        try {
          ws = new WebSocketImpl(`${ENDPOINTS.LIVE_WS}?key=${key}`);
        } catch (err) {
          reject(err);
          return;
        }

        if (connectTimeoutMs > 0) {
          connectTimer = setTimeout(() => {
            settle(reject, new Error(`[GeminiLive] Connection timed out after ${connectTimeoutMs}ms`));
            try {
              ws.close(4500, 'Connect timeout');
            } catch (_) {}
          }, connectTimeoutMs);
        }

        ws.on('open', () => {
          settle(resolve, session);
          try {
            callbacks.onOpen && callbacks.onOpen();
          } catch (err) {
            console.error('[GeminiLive] onOpen callback error:', err);
          }
          ws.send(JSON.stringify(buildSetupMessage({ model, systemInstruction, tools, voiceName })));
        });

        ws.on('message', (data) => {
          const msg = parseLiveMessage(data);
          if (!msg) return;
          // Sequential ordered processing: each message fully drains its
          // callbacks (including async DB work) before the next is handled.
          messageQueue = messageQueue
            .then(() => dispatchLiveMessage(msg, callbacks))
            .catch((err) => {
              console.error('[GeminiLive] Error processing message:', err);
              callbacks.onCallbackError && callbacks.onCallbackError(err);
            });
        });

        ws.on('error', (err) => {
          settle(reject, err);
          callbacks.onError && callbacks.onError(err);
        });

        ws.on('close', (code, reason) => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
          const reasonText = reason ? reason.toString() : '';
          callbacks.onClose && callbacks.onClose(code, reasonText);
        });
      });
    },

    /**
     * Stream a mic audio chunk (base64 PCM16) to Gemini.
     */
    sendAudio({ data, mimeType = LIVE_CONFIG.INPUT_MIME_TYPE } = {}) {
      return sendPayload({
        realtimeInput: {
          audio: { mimeType, data },
        },
      });
    },

    /**
     * Send a client text turn (greeting trigger, wrap-up trigger).
     */
    sendClientContent(text, { turnComplete = true } = {}) {
      return sendPayload({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete,
        },
      });
    },

    /**
     * Return tool call results to Gemini.
     */
    sendToolResponse(functionResponses) {
      return sendPayload({
        toolResponse: { functionResponses },
      });
    },

    /**
     * Escape hatch for protocol additions.
     */
    sendRaw(payload) {
      return sendPayload(payload);
    },

    close(code = 1000, reason = 'Session closed') {
      if (!ws) return;
      try {
        if (ws.readyState === WebSocketImpl.OPEN || ws.readyState === WebSocketImpl.CONNECTING) {
          ws.close(code, reason);
        }
      } catch (err) {
        console.error('[GeminiLive] Error closing socket:', err);
      }
    },
  };

  return session;
}

module.exports = {
  buildSetupMessage,
  parseLiveMessage,
  dispatchLiveMessage,
  createLiveSession,
};
