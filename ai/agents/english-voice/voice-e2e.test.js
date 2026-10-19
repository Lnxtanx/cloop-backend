/**
 * End-to-end voice feature tests.
 *
 * Exercises the real HTTP routes, WebSocket adapter and english-voice agent
 * against in-memory Prisma/S3/telemetry stubs and a fake Gemini Live duplex
 * session. Verifies the full lifecycle: create session -> call -> end ->
 * audio upload -> report consolidation -> result API, plus premature-end
 * blocking, abrupt client close, and the legacy speaking assessment.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const Module = require('node:module')

const express = require('express')
const WebSocket = require('ws')
const jwt = require('jsonwebtoken')

process.env.JWT_SECRET = 'english-voice-e2e-secret'

const USER_ID = 101
const USER_TOKEN = jwt.sign({ userId: USER_ID, name: 'E2E Learner' }, process.env.JWT_SECRET)

const AI_ANALYSIS = {
  learner_did_well: 'You explained your sales experience clearly.',
  one_thing_to_fix: 'Say "I have two years of experience" instead of "I am having".',
  summary_paragraph: 'You spoke clearly today and explained your sales experience well. Remember to say "I have two years of experience" instead of "I am having two years of experience". Keep practising every day.',
  detected_errors: [
    {
      type: 'grammar',
      said: 'I am having two years of experience',
      correct: 'I have two years of experience',
      explanation: 'Use "have" for experience, not "am having".',
      severity: 'blocks_understanding',
    },
  ],
}

let activeHarness = null

function clone(value) {
  return value == null ? value : structuredClone(value)
}

function matches(record, where = {}) {
  return Object.entries(where).every(([key, value]) => record[key] === value)
}

function applyData(record, data = {}) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !(value instanceof Date) && 'increment' in value) {
      record[key] = (record[key] || 0) + value.increment
    } else {
      record[key] = value
    }
  }
  return record
}

function createFakeDb(idBase) {
  const db = {
    users: new Map([[USER_ID, { id: USER_ID, name: 'E2E Learner', email: 'e2e@test.local' }]]),
    voice_sessions: new Map(),
    voice_session_turns: [],
    session_errors: [],
    learner_profiles: new Map([[
      USER_ID,
      {
        id: 1,
        user_id: USER_ID,
        native_language: 'Hindi',
        english_level: 'Beginner',
        total_sessions: 0,
        total_minutes: 0,
        open_errors: [],
        strengths: [],
        track_preferences: null,
      },
    ]]),
    assessment_sessions: new Map(),
    assessment_turns: [],
    assessment_results: new Map(),
  }

  let nextId = idBase
  const newId = () => nextId++

  function voiceInclude(row, include) {
    if (!row) return null
    const out = clone(row)
    if (include?.errors) out.errors = clone(db.session_errors.filter((e) => e.session_id === row.id))
    if (include?.turns) {
      out.turns = clone(
        db.voice_session_turns
          .filter((t) => t.session_id === row.id)
          .sort((a, b) => a.sequence - b.sequence)
      )
    }
    if (include?.user) out.user = clone(db.users.get(row.user_id) || null)
    return out
  }

  const prisma = {
    voice_sessions: {
      async create({ data }) {
        const row = { id: data.id || newId(), created_at: new Date(), ...applyData({}, data) }
        db.voice_sessions.set(row.id, row)
        return clone(row)
      },
      async findFirst({ where, include } = {}) {
        const row = [...db.voice_sessions.values()].find((r) => matches(r, where))
        return voiceInclude(row, include)
      },
      async findUnique({ where, include } = {}) {
        return voiceInclude(db.voice_sessions.get(where.id), include)
      },
      async update({ where, data }) {
        const row = db.voice_sessions.get(where.id)
        if (!row) throw new Error(`voice_session ${where.id} not found`)
        return clone({ ...applyData(row, data) })
      },
      async upsert({ where, update, create }) {
        const row = db.voice_sessions.get(where.id)
        if (row) return clone({ ...applyData(row, update) })
        const created = { id: where.id || newId(), created_at: new Date(), ...create }
        db.voice_sessions.set(created.id, created)
        return clone(created)
      },
    },
    voice_session_turns: {
      async create({ data }) {
        const row = { id: newId(), ...data }
        db.voice_session_turns.push(row)
        return clone(row)
      },
    },
    session_errors: {
      async create({ data }) {
        const row = { id: newId(), ...data }
        db.session_errors.push(row)
        return clone(row)
      },
      async update({ where, data }) {
        const row = db.session_errors.find((e) => e.id === where.id)
        if (!row) throw new Error(`session_error ${where.id} not found`)
        return clone({ ...applyData(row, data) })
      },
    },
    learner_profiles: {
      async findUnique({ where } = {}) {
        return clone(db.learner_profiles.get(where.user_id) || null)
      },
      async upsert({ where, update, create }) {
        const row = db.learner_profiles.get(where.user_id)
        if (row) return clone({ ...applyData(row, update) })
        const created = { id: newId(), ...create }
        db.learner_profiles.set(where.user_id, created)
        return clone(created)
      },
    },
    assessment_sessions: {
      async create({ data }) {
        const row = { id: data.id || newId(), created_at: new Date(), ...data }
        db.assessment_sessions.set(row.id, row)
        return clone(row)
      },
      async findFirst({ where } = {}) {
        return clone([...db.assessment_sessions.values()].find((r) => matches(r, where)) || null)
      },
      async update({ where, data }) {
        const row = db.assessment_sessions.get(where.id)
        if (!row) throw new Error(`assessment_session ${where.id} not found`)
        return clone({ ...applyData(row, data) })
      },
    },
    assessment_turns: {
      async create({ data }) {
        const row = { id: newId(), ...data }
        db.assessment_turns.push(row)
        return clone(row)
      },
    },
    assessment_results: {
      async upsert({ where, update, create }) {
        const row = db.assessment_results.get(where.session_id)
        if (row) return clone({ ...applyData(row, update) })
        const created = { id: newId(), session_id: where.session_id, ...create }
        db.assessment_results.set(where.session_id, created)
        return clone(created)
      },
    },
  }

  return { db, prisma }
}

const fakePrisma = {
  voice_sessions: {
    create: (args) => activeHarness.db.prisma.voice_sessions.create(args),
    findFirst: (args) => activeHarness.db.prisma.voice_sessions.findFirst(args),
    findUnique: (args) => activeHarness.db.prisma.voice_sessions.findUnique(args),
    update: (args) => activeHarness.db.prisma.voice_sessions.update(args),
    upsert: (args) => activeHarness.db.prisma.voice_sessions.upsert(args),
  },
  voice_session_turns: {
    create: (args) => activeHarness.db.prisma.voice_session_turns.create(args),
  },
  session_errors: {
    create: (args) => activeHarness.db.prisma.session_errors.create(args),
    update: (args) => activeHarness.db.prisma.session_errors.update(args),
  },
  learner_profiles: {
    findUnique: (args) => activeHarness.db.prisma.learner_profiles.findUnique(args),
    upsert: (args) => activeHarness.db.prisma.learner_profiles.upsert(args),
  },
  assessment_sessions: {
    create: (args) => activeHarness.db.prisma.assessment_sessions.create(args),
    findFirst: (args) => activeHarness.db.prisma.assessment_sessions.findFirst(args),
    update: (args) => activeHarness.db.prisma.assessment_sessions.update(args),
  },
  assessment_turns: {
    create: (args) => activeHarness.db.prisma.assessment_turns.create(args),
  },
  assessment_results: {
    upsert: (args) => activeHarness.db.prisma.assessment_results.upsert(args),
  },
}

const fakeAudioStorage = {
  isConfigured: () => true,
  async uploadSessionAudio(args) {
    activeHarness.uploads.push(args)
    return `https://s3.e2e.local/voice/${args.sessionId}.wav`
  },
  async getPresignedAudioUrl(url) {
    return `${url}?X-Amz-Signature=e2e`
  },
}

const fakeTokenLogger = {
  recordTokenUsage(params) {
    activeHarness.tokenCalls.push(params)
  },
}

const fakeActivityTracker = {
  async updateStreak() {
    activeHarness.streakUpdates++
  },
}

function stubModule(filename, exports) {
  const stub = new Module(filename, null)
  stub.filename = filename
  stub.loaded = true
  stub.exports = exports
  require.cache[filename] = stub
}

stubModule(require.resolve(path.join(__dirname, '../../../lib/prisma')), fakePrisma)
stubModule(require.resolve(path.join(__dirname, '../../../services/english-voice/audio-storage')), fakeAudioStorage)
stubModule(require.resolve(path.join(__dirname, '../../providers/telemetry/token-logger')), fakeTokenLogger)
stubModule(require.resolve(path.join(__dirname, '../../../services/analytics/activity-tracker')), fakeActivityTracker)

const gemini = require('../../providers/gemini')
gemini.createLiveSession = (options) => activeHarness.createFakeSession(options)
gemini.generateJson = async (options) => {
  activeHarness.generateJsonCalls.push(options)
  await new Promise((resolve) => setTimeout(resolve, 20))
  if (activeHarness.generateJsonFails) throw new Error('Gemini analysis unavailable')
  return { parsed: AI_ANALYSIS }
}

const voiceSessionRouter = require('../../../api/voice-sessions/voice-session-routes')
const assessmentRouter = require('../../../api/assessment/assessment-routes')
const { handleAssessmentWsUpgrade } = require('../../../services/english-voice/live-proxy')

const PRACTICE_GREETING = 'Hello! I am Cloop. What would you like to practise today?'
const PRACTICE_REPLY = 'That is great experience! Can you tell me about your daily responsibilities?'
const WRAP_LINE = 'You did a wonderful job today! Remember to say "I have two years of experience". Come back soon!'

class FakeLiveSession {
  constructor({ callbacks, systemInstruction, tools }) {
    this.callbacks = callbacks
    this.systemInstruction = systemInstruction
    this.tools = tools
    this.open = false
    this.audioIn = []
    this.clientContents = []
    this.toolResponses = []
    this.greetingSent = false
    this.userTurnEmitted = false
    this.timers = new Set()
  }

  _schedule(fn, delay) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      Promise.resolve()
        .then(fn)
        .catch((err) => console.error('[E2E fake Gemini] timer error:', err))
    }, delay)
    this.timers.add(timer)
    return timer
  }

  async connect() {
    this.open = true
    setImmediate(() => {
      Promise.resolve()
        .then(() => this.callbacks.onSetupComplete())
        .catch((err) => console.error('[E2E fake Gemini] setup error:', err))
    })
    return this
  }

  isOpen() {
    return this.open
  }

  sendClientContent(text) {
    this.clientContents.push(text)
    if (text.includes('call the end_session function')) {
      this._schedule(() => this._wrapUp(), 10)
      return
    }
    if (text.startsWith('[time check]') || this.greetingSent) return
    this.greetingSent = true
    if (this.mode === 'autoEnd') {
      this._schedule(() => this._prematureEnd(), 10)
      return
    }
    this._schedule(() => this._greetingTurn(), 5)
  }

  sendAudio({ data }) {
    this.audioIn.push(data)
    if (this.mode !== 'practice' || this.userTurnEmitted) return
    this.userTurnEmitted = true
    this._schedule(() => this._practiceReply(), 5)
  }

  sendToolResponse(responses) {
    this.toolResponses.push(...responses)
  }

  close() {
    if (!this.open) return
    this.open = false
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    if (this.callbacks.onClose) this.callbacks.onClose(1000, 'fake closed')
  }

  async _emitTutorTurn(text) {
    await this.callbacks.onOutputTranscription(text)
    await this.callbacks.onAudio({
      data: Buffer.alloc(3840, 1).toString('base64'),
      mimeType: 'audio/pcm;rate=24000',
    })
    await this.callbacks.onModelTurn([])
    await this.callbacks.onTurnComplete()
  }

  async _emitUserTurn(text) {
    await this.callbacks.onInputTranscription(text)
    await this.callbacks.onModelTurn([])
  }

  async _greetingTurn() {
    await this._emitTutorTurn(this.mode === 'legacy' ? 'Hello, I am Eva, your speaking examiner. Could you tell me about yourself?' : PRACTICE_GREETING)
    if (this.mode === 'legacy') this._schedule(() => this._legacyFlow(), 5)
  }

  async _practiceReply() {
    await this._emitUserTurn('I am having two years of experience in sales.')
    await this._emitTutorTurn(PRACTICE_REPLY)
  }

  async _wrapUp() {
    await this._emitTutorTurn(WRAP_LINE)
    await this.callbacks.onToolCall({
      functionCalls: [{
        id: 'call_end',
        name: 'end_session',
        args: {
          reason: 'user_requested',
          summary: 'Spoken closing summary from the model.',
          learner_did_well: 'You explained your sales experience.',
          one_thing_to_fix: 'Use "I have" instead of "I am having".',
          questions_asked: 1,
        },
      }],
    })
  }

  async _prematureEnd() {
    await this.callbacks.onToolCall({
      functionCalls: [{
        id: 'call_early',
        name: 'end_session',
        args: {
          reason: 'practice_completed',
          summary: 'Too early.',
          learner_did_well: 'Nice start.',
          one_thing_to_fix: 'Keep going.',
          questions_asked: 1,
        },
      }],
    })
  }

  async _legacyFlow() {
    await this._emitUserTurn('I have been working in sales for two years.')
    await this.callbacks.onToolCall({
      functionCalls: [{
        id: 'call_eval',
        name: 'submit_speaking_evaluation',
        args: {
          overall_score: 82,
          cefr_level: 'B1',
          pronunciation_score: 80,
          fluency_score: 84,
          grammar_score: 78,
          vocabulary_score: 83,
          sentence_construction_score: 81,
          comprehension_score: 85,
          coherence_score: 82,
          conversational_score: 84,
          strengths: ['Clear pronunciation'],
          weaknesses: ['Tense consistency'],
          recommendations: ['Practise past tense verbs'],
        },
      }],
    })
  }
}

let harnessSeq = 0

function createHarness(mode) {
  const { db, prisma } = createFakeDb(++harnessSeq * 1000)
  const harness = {
    db: { db, prisma },
    mode,
    uploads: [],
    tokenCalls: [],
    generateJsonCalls: [],
    generateJsonFails: false,
    streakUpdates: 0,
    liveSessions: [],
    createFakeSession(options) {
      const session = new FakeLiveSession(options)
      session.mode = mode
      harness.liveSessions.push(session)
      return session
    },
  }
  return harness
}

async function waitFor(fn, label, timeoutMs = 3000) {
  const start = Date.now()
  let lastError = null
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn()
      if (value) return value
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`)
}

function collectMessages(ws) {
  const messages = []
  const consumed = new Set()
  const waiters = []

  ws.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }
    messages.push(message)
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]
      if (waiter.predicate(message)) {
        waiters.splice(i, 1)
        clearTimeout(waiter.timer)
        consumed.add(message)
        waiter.resolve(message)
      }
    }
  })

  return {
    messages,
    waitFor(predicate, label = 'message', timeoutMs = 3000) {
      const existing = messages.find((m) => !consumed.has(m) && predicate(m))
      if (existing) {
        consumed.add(existing)
        return Promise.resolve(existing)
      }
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve }
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error(`Timed out waiting for ${label}`))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
  }
}

async function openSocket(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const inbox = collectMessages(ws)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return { ws, inbox }
}

async function closeSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return
  const closed = new Promise((resolve) => ws.once('close', resolve))
  ws.close()
  await closed
}

async function startServer() {
  const app = express()
  app.use(express.json())
  app.use('/api/voice-sessions', voiceSessionRouter)
  app.use('/api/assessment', assessmentRouter)

  const server = http.createServer(app)
  handleAssessmentWsUpgrade(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

function authHeaders() {
  return { Authorization: `Bearer ${USER_TOKEN}` }
}

test('E2E: learner ends practice call -> audio, turns, report and result API', async () => {
  activeHarness = createHarness('practice')
  const { server, port } = await startServer()
  let ws = null

  try {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/voice-sessions`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackKey: 'interview_prep', chapterKey: 'telling_about_yourself', mode: 'practice' }),
    })
    assert.equal(createRes.status, 200)
    const { session } = await createRes.json()
    assert.equal(session.status, 'ACTIVE')

    const wsUrl = `ws://127.0.0.1:${port}/ws/assessment?sessionId=${session.id}&token=${encodeURIComponent(USER_TOKEN)}&trackKey=interview_prep&chapterKey=telling_about_yourself&mode=practice`
    const opened = await openSocket(wsUrl)
    ws = opened.ws
    const inbox = opened.inbox

    await inbox.waitFor((m) => m.type === 'setup_complete', 'setup_complete')
    await inbox.waitFor((m) => m.type === 'turn_complete', 'greeting turn_complete')
    assert.equal(activeHarness.liveSessions.length, 1)

    ws.send(JSON.stringify({
      type: 'audio_chunk',
      data: Buffer.alloc(3200, 2).toString('base64'),
      mimeType: 'audio/pcm;rate=16000',
    }))

    const userTranscript = await inbox.waitFor((m) => m.type === 'user_live_transcript', 'user transcript')
    assert.match(userTranscript.text, /two years of experience/)
    await inbox.waitFor((m) => m.type === 'turn_complete' && /daily responsibilities/.test(m.text || ''), 'tutor reply')

    ws.send(JSON.stringify({ type: 'end_session' }))
    const complete = await inbox.waitFor((m) => m.type === 'session_complete', 'session_complete', 5000)

    assert.equal(complete.sessionId, session.id)
    assert.equal(complete.waitForAudioDrain, true)
    assert.equal(complete.summary, 'Spoken closing summary from the model.')
    assert.match(complete.audioUrl, /s3\.e2e\.local/)
    assert.equal(complete.wordsSpoken, 9)

    await closeSocket(ws)
    ws = null

    const row = activeHarness.db.db.voice_sessions.get(session.id)
    assert.equal(row.status, 'COMPLETED')
    assert.ok(row.completed_at instanceof Date)
    assert.equal(row.duration_seconds, complete.durationSeconds)
    assert.equal(row.words_spoken, 9)
    assert.equal(row.questions_asked, 1)
    assert.equal(row.audio_url, complete.audioUrl)

    const turns = activeHarness.db.db.voice_session_turns.filter((t) => t.session_id === session.id)
    assert.deepEqual(turns.map((t) => t.speaker), ['tutor', 'user', 'tutor', 'tutor'])
    assert.deepEqual(turns.map((t) => t.sequence), [1, 2, 3, 4])

    assert.equal(activeHarness.uploads.length, 1)
    assert.equal(activeHarness.uploads[0].sessionId, session.id)
    assert.ok(activeHarness.uploads[0].pcmBuffer.length > 1000)
    assert.equal(activeHarness.uploads[0].pcmBuffer.length % 2, 0)

    assert.equal(activeHarness.tokenCalls.length, 1)
    assert.equal(activeHarness.tokenCalls[0].featureArea, 'voice_session')
    assert.equal(activeHarness.tokenCalls[0].metadata.sessionId, session.id)
    assert.equal(activeHarness.tokenCalls[0].status, 'success')

    const resultRes = await fetch(`http://127.0.0.1:${port}/api/voice-sessions/${session.id}/result`, {
      headers: authHeaders(),
    })
    assert.equal(resultRes.status, 200)
    const { result, session: resultSession } = await resultRes.json()

    assert.equal(result.sessionId, session.id)
    assert.equal(result.summary, AI_ANALYSIS.summary_paragraph)
    assert.equal(result.learnerDidWell, AI_ANALYSIS.learner_did_well)
    assert.equal(result.oneThingToFix, AI_ANALYSIS.one_thing_to_fix)
    assert.equal(result.wordsSpoken, 9)
    assert.equal(result.tiers.fixFirst.length, 1)
    assert.equal(result.tiers.fixFirst[0].tier, 'fix_first')
    assert.equal(result.tiers.totalCount, 1)
    assert.equal(result.metrics.cefrEstimate, 'A2')
    assert.ok(result.metrics.wpm > 0)
    assert.ok(result.metrics.fluencyScore >= 50 && result.metrics.fluencyScore <= 95)
    assert.match(resultSession.audio_url, /\?X-Amz-Signature=e2e$/)

    assert.equal(activeHarness.generateJsonCalls.length, 1)
    assert.match(activeHarness.generateJsonCalls[0].prompt, /I am having two years of experience in sales\./)

    const errors = activeHarness.db.db.session_errors.filter((e) => e.session_id === session.id)
    assert.equal(errors.length, 1)
    assert.equal(errors[0].tier, 'fix_first')

    const profile = activeHarness.db.db.learner_profiles.get(USER_ID)
    assert.equal(profile.cefr_estimate, 'A2')
    assert.equal(profile.total_sessions, 1)
    assert.ok(profile.total_minutes >= 1)
    assert.equal(profile.open_errors.length, 1)
    assert.equal(activeHarness.streakUpdates, 1)

    const getRes = await fetch(`http://127.0.0.1:${port}/api/voice-sessions/${session.id}`, {
      headers: authHeaders(),
    })
    assert.equal(getRes.status, 200)
    const details = await getRes.json()
    assert.equal(details.session.turns.length, 4)
    assert.equal(details.session.errors.length, 1)
  } finally {
    await closeSocket(ws)
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
})

test('E2E: model cannot end the call before 4.5 minutes without learner request', async () => {
  activeHarness = createHarness('autoEnd')
  const { server, port } = await startServer()
  let ws = null

  try {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/voice-sessions`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackKey: 'interview_prep' }),
    })
    const { session } = await createRes.json()

    const wsUrl = `ws://127.0.0.1:${port}/ws/assessment?sessionId=${session.id}&token=${encodeURIComponent(USER_TOKEN)}&trackKey=interview_prep`
    const opened = await openSocket(wsUrl)
    ws = opened.ws
    const inbox = opened.inbox
    await inbox.waitFor((m) => m.type === 'setup_complete', 'setup_complete')

    const fake = activeHarness.liveSessions[0]
    await waitFor(() => fake.toolResponses.length === 1, 'blocked tool response')
    assert.equal(fake.toolResponses[0].name, 'end_session')
    assert.equal(fake.toolResponses[0].response.output.status, 'continue_practice')
    assert.match(fake.toolResponses[0].response.output.instruction, /at least 5 minutes/)

    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(inbox.messages.some((m) => m.type === 'session_complete'), false)

    const row = activeHarness.db.db.voice_sessions.get(session.id)
    assert.equal(row.status, 'IN_PROGRESS')
    assert.equal(row.completed_at, undefined)
    assert.equal(activeHarness.uploads.length, 0)
  } finally {
    await closeSocket(ws)
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
})

test('E2E: closing the socket without ending does not complete or analyze the session', async () => {
  activeHarness = createHarness('practice')
  const { server, port } = await startServer()
  let ws = null

  try {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/voice-sessions`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackKey: 'interview_prep' }),
    })
    const { session } = await createRes.json()

    const wsUrl = `ws://127.0.0.1:${port}/ws/assessment?sessionId=${session.id}&token=${encodeURIComponent(USER_TOKEN)}&trackKey=interview_prep`
    const opened = await openSocket(wsUrl)
    ws = opened.ws
    const inbox = opened.inbox
    await inbox.waitFor((m) => m.type === 'setup_complete', 'setup_complete')
    await inbox.waitFor((m) => m.type === 'turn_complete', 'greeting turn_complete')

    ws.send(JSON.stringify({
      type: 'audio_chunk',
      data: Buffer.alloc(3200, 2).toString('base64'),
      mimeType: 'audio/pcm;rate=16000',
    }))
    await inbox.waitFor((m) => m.type === 'turn_complete' && /daily responsibilities/.test(m.text || ''), 'tutor reply')

    await closeSocket(ws)
    ws = null

    const row = await waitFor(
      () => {
        const current = activeHarness.db.db.voice_sessions.get(session.id)
        return current && current.audio_url && activeHarness.tokenCalls.length === 1 ? current : null
      },
      'client-close fallback persistence'
    )

    assert.equal(row.status, 'IN_PROGRESS')
    assert.equal(row.completed_at, undefined)
    assert.equal(row.summary_text, undefined)
    assert.equal(row.words_spoken, 9)
    assert.ok(row.duration_seconds >= 1)
    assert.match(row.audio_url, /s3\.e2e\.local/)
    assert.equal(activeHarness.uploads.length, 1)
    assert.equal(activeHarness.tokenCalls[0].metadata.exitReason, 'client_closed')
    assert.equal(activeHarness.generateJsonCalls.length, 0)
    assert.equal(activeHarness.db.db.session_errors.length, 0)
  } finally {
    await closeSocket(ws)
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
})

test('E2E: report still renders when the Gemini analysis call fails', async () => {
  activeHarness = createHarness('practice')
  activeHarness.generateJsonFails = true
  const { server, port } = await startServer()
  let ws = null

  try {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/voice-sessions`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackKey: 'interview_prep' }),
    })
    const { session } = await createRes.json()

    const wsUrl = `ws://127.0.0.1:${port}/ws/assessment?sessionId=${session.id}&token=${encodeURIComponent(USER_TOKEN)}&trackKey=interview_prep`
    const opened = await openSocket(wsUrl)
    ws = opened.ws
    const inbox = opened.inbox

    await inbox.waitFor((m) => m.type === 'setup_complete', 'setup_complete')
    await inbox.waitFor((m) => m.type === 'turn_complete', 'greeting turn_complete')

    ws.send(JSON.stringify({
      type: 'audio_chunk',
      data: Buffer.alloc(3200, 2).toString('base64'),
      mimeType: 'audio/pcm;rate=16000',
    }))
    await inbox.waitFor((m) => m.type === 'turn_complete' && /daily responsibilities/.test(m.text || ''), 'tutor reply')

    ws.send(JSON.stringify({ type: 'end_session' }))
    await inbox.waitFor((m) => m.type === 'session_complete', 'session_complete', 5000)
    await closeSocket(ws)
    ws = null

    const resultRes = await fetch(`http://127.0.0.1:${port}/api/voice-sessions/${session.id}/result`, {
      headers: authHeaders(),
    })
    assert.equal(resultRes.status, 200)
    const { result } = await resultRes.json()

    assert.equal(result.sessionId, session.id)
    assert.equal(result.summary, 'Spoken closing summary from the model.')
    assert.equal(result.wordsSpoken, 9)
    assert.equal(result.tiers.totalCount, 0)
    assert.equal(result.tiers.fixFirst.length, 0)
    assert.ok(result.metrics.wpm > 0)
    assert.ok(result.metrics.cefrEstimate)
    assert.ok(activeHarness.generateJsonCalls.length >= 1)

    const row = activeHarness.db.db.voice_sessions.get(session.id)
    assert.equal(row.status, 'COMPLETED')
    assert.equal(row.summary_text, 'Spoken closing summary from the model.')
  } finally {
    await closeSocket(ws)
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
})

test('E2E: legacy speaking assessment persists transcript and scores', async () => {
  activeHarness = createHarness('legacy')
  const { server, port } = await startServer()
  let ws = null

  try {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/assessment/sessions`, {
      method: 'POST',
      headers: authHeaders(),
    })
    assert.equal(createRes.status, 201)
    const { session } = await createRes.json()

    const wsUrl = `ws://127.0.0.1:${port}/ws/assessment?sessionId=${session.id}&token=${encodeURIComponent(USER_TOKEN)}`
    const opened = await openSocket(wsUrl)
    ws = opened.ws
    const inbox = opened.inbox

    await inbox.waitFor((m) => m.type === 'setup_complete', 'setup_complete')
    const completed = await inbox.waitFor((m) => m.type === 'assessment_completed', 'assessment_completed', 5000)
    assert.equal(completed.overallScore, 82)
    assert.equal(completed.cefrLevel, 'B1')

    const row = activeHarness.db.db.assessment_sessions.get(session.id)
    assert.equal(row.status, 'COMPLETED')
    assert.equal(row.assessment_status, 'READY')
    assert.equal(row.overall_score, 82)
    assert.ok(row.duration_seconds >= 1)
    assert.equal(row.question_count, 1)

    const result = activeHarness.db.db.assessment_results.get(session.id)
    assert.equal(result.overall_score, 82)
    assert.equal(result.pronunciation_score, 80)
    assert.deepEqual(result.strengths, ['Clear pronunciation'])
    assert.deepEqual(result.recommendations, ['Practise past tense verbs'])

    const speakers = activeHarness.db.db.assessment_turns
      .filter((t) => t.session_id === session.id)
      .map((t) => t.speaker)
      .sort()
    assert.deepEqual(speakers, ['ai', 'user'])

    assert.equal(activeHarness.uploads.length, 0)
    assert.equal(activeHarness.tokenCalls.length, 0)
    assert.equal(activeHarness.generateJsonCalls.length, 0)
  } finally {
    await closeSocket(ws)
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
})
