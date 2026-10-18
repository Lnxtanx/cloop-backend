/**
 * Gemini Provider Test Suite
 * Verifies constants, Live setup payload, message dispatch ordering,
 * duplex session mechanics (fake socket), and the text client (mocked fetch).
 * No live model or database calls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const gemini = require('./index');
const { buildSetupMessage, parseLiveMessage, dispatchLiveMessage, createLiveSession } = require('./live');
const { generateText, generateJson, parseJsonLoose } = require('./text');

// ============================================================
// Fake WebSocket for duplex session tests
// ============================================================

class FakeWebSocket extends EventEmitter {
  static instances = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closed = null;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  close(code, reason) {
    this.readyState = FakeWebSocket.CLOSED;
    this.closed = { code, reason };
  }
}

function lastFake() {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

// ============================================================
// G1: Constants
// ============================================================

test('G1: Constants define models, endpoints, and the 16k/24k audio contract', () => {
  assert.equal(gemini.MODELS.LIVE, process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview');
  assert.equal(gemini.MODELS.FLASH, process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash');
  assert.match(gemini.ENDPOINTS.LIVE_WS, /^wss:\/\/generativelanguage\.googleapis\.com\//);
  assert.match(gemini.generateContentUrl('gemini-2.5-flash'), /\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(gemini.LIVE_CONFIG.INPUT_SAMPLE_RATE, 16000);
  assert.equal(gemini.LIVE_CONFIG.OUTPUT_SAMPLE_RATE, 24000);
  assert.equal(gemini.LIVE_CONFIG.INPUT_MIME_TYPE, 'audio/pcm;rate=16000');
  assert.deepEqual(gemini.LIVE_CONFIG.RESPONSE_MODALITIES, ['AUDIO']);
});

// ============================================================
// G2: Setup message shape
// ============================================================

test('G2: buildSetupMessage produces a valid BidiGenerateContentSetup payload', () => {
  const tools = [{ functionDeclarations: [{ name: 'log_error' }] }];
  const msg = buildSetupMessage({
    model: 'gemini-3.1-flash-live-preview',
    systemInstruction: 'You are Cloop.',
    tools,
    voiceName: 'Aoede',
  });

  assert.equal(msg.setup.model, 'models/gemini-3.1-flash-live-preview');
  assert.deepEqual(msg.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(
    msg.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    'Aoede'
  );
  assert.equal(msg.setup.systemInstruction.parts[0].text, 'You are Cloop.');
  assert.deepEqual(msg.setup.tools, tools);
  assert.deepEqual(msg.setup.inputAudioTranscription, {});
  assert.deepEqual(msg.setup.outputAudioTranscription, {});
  assert.deepEqual(msg.setup.realtimeInputConfig.automaticActivityDetection, { disabled: false });

  // Only setup-schema fields are present (unknown fields cause code 1007 closes)
  const setupKeys = Object.keys(msg.setup).sort();
  assert.deepEqual(setupKeys, [
    'generationConfig',
    'inputAudioTranscription',
    'model',
    'outputAudioTranscription',
    'realtimeInputConfig',
    'systemInstruction',
    'tools',
  ]);
});

// ============================================================
// G3: Dispatch ordering for serverContent
// ============================================================

test('G3: dispatchLiveMessage routes events in protocol order', async () => {
  const events = [];
  await dispatchLiveMessage(
    {
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { data: 'AAA', mimeType: 'audio/pcm;rate=24000' } },
            { text: 'raw text' },
          ],
        },
        outputTranscription: { text: 'tutor says' },
        inputTranscription: { text: 'learner says' },
        turnComplete: true,
      },
    },
    {
      onAudio: (audio) => { events.push(`audio:${audio.data}`); },
      onModelText: (text) => { events.push(`text:${text}`); },
      onOutputTranscription: (text) => { events.push(`out:${text}`); },
      onInputTranscription: (text) => { events.push(`in:${text}`); },
      onModelTurn: () => { events.push('modelTurn'); },
      onTurnComplete: () => { events.push('turnComplete'); },
    }
  );

  assert.deepEqual(events, [
    'audio:AAA',
    'text:raw text',
    'out:tutor says',
    'in:learner says',
    'modelTurn',
    'turnComplete',
  ]);
});

test('G3b: returning false from a callback stops the rest of the message', async () => {
  const events = [];
  await dispatchLiveMessage(
    {
      serverContent: {
        modelTurn: {
          parts: [
            { functionCall: { name: 'log_error', id: 'c1' } },
            { text: 'should not be dispatched' },
          ],
        },
        turnComplete: true,
      },
    },
    {
      onToolCall: () => { events.push('toolCall'); return false; },
      onModelText: () => { events.push('text'); },
      onTurnComplete: () => { events.push('turnComplete'); },
    }
  );

  assert.deepEqual(events, ['toolCall']);
});

test('G3c: setupComplete and top-level toolCall are routed', async () => {
  const events = [];
  await dispatchLiveMessage({ setupComplete: {} }, {
    onSetupComplete: () => { events.push('setup'); },
  });
  await dispatchLiveMessage({ toolCall: { functionCalls: [{ name: 'end_session', id: 'x' }] } }, {
    onToolCall: (toolCall) => { events.push(`tool:${toolCall.functionCalls[0].name}`); },
  });
  assert.deepEqual(events, ['setup', 'tool:end_session']);
});

// ============================================================
// G4: Duplex session mechanics
// ============================================================

test('G4: createLiveSession sends setup on open and frames outbound payloads', async () => {
  const sentToClient = [];
  const session = createLiveSession({
    apiKey: 'test-key',
    systemInstruction: 'You are Cloop.',
    tools: [],
    WebSocketImpl: FakeWebSocket,
    callbacks: {
      onSetupComplete: () => { sentToClient.push('setupComplete'); },
    },
  });

  const connectPromise = session.connect();
  const fake = lastFake();
  assert.match(fake.url, /^wss:\/\/generativelanguage\.googleapis\.com\/.*\?key=test-key$/);

  fake.readyState = FakeWebSocket.OPEN;
  fake.emit('open');
  await connectPromise;
  assert.equal(session.isOpen(), true);

  // 1. Setup frame goes out on open
  assert.equal(fake.sent.length, 1);
  const setupMsg = JSON.parse(fake.sent[0]);
  assert.equal(setupMsg.setup.systemInstruction.parts[0].text, 'You are Cloop.');

  // 2. Audio framing
  session.sendAudio({ data: 'QUJD', mimeType: 'audio/pcm;rate=16000' });
  const audioMsg = JSON.parse(fake.sent[1]);
  assert.deepEqual(audioMsg.realtimeInput.audio, { mimeType: 'audio/pcm;rate=16000', data: 'QUJD' });

  // 3. Client content turn
  session.sendClientContent('Hello there');
  const contentMsg = JSON.parse(fake.sent[2]);
  assert.equal(contentMsg.clientContent.turns[0].parts[0].text, 'Hello there');
  assert.equal(contentMsg.clientContent.turnComplete, true);

  // 4. Tool response
  session.sendToolResponse([{ id: 'c1', name: 'log_error', response: { output: { status: 'logged' } } }]);
  const toolMsg = JSON.parse(fake.sent[3]);
  assert.equal(toolMsg.toolResponse.functionResponses[0].name, 'log_error');

  // 5. Inbound setupComplete is dispatched
  fake.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sentToClient, ['setupComplete']);

  // 6. Close
  session.close(1000, 'done');
  assert.deepEqual(fake.closed, { code: 1000, reason: 'done' });
});

test('G4b: parseLiveMessage tolerates garbage and dispatch ignores null', async () => {
  assert.equal(parseLiveMessage('not json'), null);
  await assert.doesNotReject(() => dispatchLiveMessage(null, {}));
});

// ============================================================
// G5: Text client (mocked fetch)
// ============================================================

test('G5: generateText shapes the request and returns usage', async () => {
  let capturedUrl = null;
  let capturedBody = null;

  const fakeFetch = async (url, init) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'hello world' }] } }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45, totalTokenCount: 165 },
      }),
    };
  };

  const result = await generateText({
    prompt: 'Analyze this transcript',
    systemInstruction: 'Be strict.',
    json: true,
    temperature: 0.2,
    fetchImpl: fakeFetch,
  });

  assert.match(capturedUrl, /\/models\/gemini-2\.5-flash:generateContent\?key=/);
  assert.equal(capturedBody.contents[0].parts[0].text, 'Analyze this transcript');
  assert.equal(capturedBody.systemInstruction.parts[0].text, 'Be strict.');
  assert.equal(capturedBody.generationConfig.responseMimeType, 'application/json');
  assert.equal(capturedBody.generationConfig.temperature, 0.2);
  assert.equal(result.text, 'hello world');
  assert.deepEqual(result.usage, { promptTokens: 120, completionTokens: 45, totalTokens: 165 });
});

test('G5b: generateText throws on HTTP errors and empty candidates', async () => {
  await assert.rejects(
    () => generateText({
      prompt: 'x',
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'Quota exceeded' }),
    }),
    /Gemini\] HTTP 429/
  );

  await assert.rejects(
    () => generateText({
      prompt: 'x',
      fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [] }) }),
    }),
    /Empty response payload/
  );
});

test('G5c: generateJson parses fenced and embedded JSON', async () => {
  const fenced = '```json\n{"learner_did_well": "great", "one_thing_to_fix": "tense"}\n```';
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: fenced }] } }] }),
  });

  const result = await generateJson({ prompt: 'Analyze', fetchImpl: fakeFetch });
  assert.equal(result.parsed.learner_did_well, 'great');

  assert.equal(parseJsonLoose('Here is the result: {"a": 1,} trailing').a, 1);
  assert.equal(parseJsonLoose('no json here'), null);
});

test('G5d: API key is required for Live and Text', async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    assert.throws(() => createLiveSession({ WebSocketImpl: FakeWebSocket }), /GEMINI_API_KEY/);
    await assert.rejects(() => generateText({ prompt: 'x' }), /GEMINI_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
  }
});
