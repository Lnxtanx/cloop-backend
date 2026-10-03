/**
 * Tavus CVI REST client.
 *
 * Used by /api/avatar. All calls are server-side only -- the API key must never
 * reach the browser.
 */

const TAVUS_BASE_URL = process.env.TAVUS_BASE_URL || 'https://tavusapi.com';

// How long we wait on Tavus before giving up. Keep this well under the
// Worker's own CPU limit so we can return a useful error instead of a 500.
const REQUEST_TIMEOUT_MS = 15000;

const isConfigured = () => Boolean(process.env.TAVUS_API_KEY && process.env.TAVUS_PAL_ID);

async function tavus(path, { method = 'GET', body } = {}) {
  const apiKey = process.env.TAVUS_API_KEY;

  if (!apiKey) {
    const error = new Error('TAVUS_API_KEY is not configured on the server');
    error.status = 500;
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${TAVUS_BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    const aborted = cause && cause.name === 'AbortError';
    const error = new Error(
      aborted ? 'Tavus request timed out' : 'Could not reach Tavus',
    );
    error.status = 502;
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (err) {
      payload = {};
    }
  }

  if (!response.ok) {
    const error = new Error(
      payload.error || payload.message || `Tavus responded ${response.status}`,
    );
    error.status = response.status;
    // Tavus returns 400 "User has reached maximum concurrent conversations"
    // when a previous session leaked its slot. Surface it as a conflict so the
    // client can show something meaningful.
    if (response.status === 400 && /concurrent/i.test(error.message)) {
      error.status = 409;
    }
    throw error;
  }

  return payload;
}

const DEFAULT_MAX_CALL_SECONDS = 300;

function getMaxCallSeconds() {
  const parsed = Number(process.env.TAVUS_MAX_CALL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CALL_SECONDS;
}

/**
 * @param {object} options
 * @param {string} [options.faceId]      Overrides the PAL's default face.
 * @param {string[]} [options.languages] Overrides the PAL's languages. First entry
 *                                       is the conversation's opening language and
 *                                       selects the TTS voice.
 * @param {string} [options.greeting]    Spoken verbatim once on join.
 * @param {string} [options.context]     Appended to the PAL's own context.
 * @param {boolean} [options.testMode]   Create without joining. Costs 0 minutes
 *                                       and does not consume concurrency.
 */
async function createConversation({
  faceId,
  languages,
  greeting,
  context,
  testMode = false,
} = {}) {
  const palId = process.env.TAVUS_PAL_ID;

  if (!palId) {
    const error = new Error('TAVUS_PAL_ID is not configured on the server');
    error.status = 500;
    throw error;
  }

  const properties = {
    max_call_duration: getMaxCallSeconds(),
    participant_absent_timeout: 120,
    participant_left_timeout: 60,
    enable_closed_captions: true,
  };

  if (Array.isArray(languages) && languages.length) {
    properties.languages = languages.slice(0, 42);
  }

  const payload = {
    pal_id: palId,
    conversation_name: 'Cloop AI Avatar',
    properties,
  };

  if (faceId) payload.face_id = faceId;
  if (greeting) payload.custom_greeting = greeting;
  if (context) payload.conversational_context = context;
  if (testMode) payload.test_mode = true;

  return tavus('/v2/conversations', { method: 'POST', body: payload });
}

/**
 * DELETE, not POST -- Tavus returns 405 for POST on this path.
 *
 * Getting this wrong leaks a concurrency slot. The free tier allows only one
 * concurrent conversation, so a single failure here locks out every later call.
 */
async function endConversation(conversationId) {
  return tavus(`/v2/conversations/${conversationId}`, { method: 'DELETE' });
}

function getConversation(conversationId) {
  return tavus(`/v2/conversations/${conversationId}`);
}

module.exports = {
  isConfigured,
  createConversation,
  endConversation,
  getConversation,
  getMaxCallSeconds,
};