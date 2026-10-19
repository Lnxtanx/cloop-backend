/**
 * English Voice-to-Voice agent tests
 *
 * Run: node --test ai/agents/english-voice/english-voice.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { createEnglishVoiceAgent, LEGACY_ASSESSMENT_PROMPT } = require('./agent')
const { LOG_ERROR_TOOL } = require('./tools/voice-tools')
const { LEGACY_EVALUATION_TOOL } = require('./tools/legacy-assessment-tools')
const {
	createSessionState,
	takeUserTurn,
	takeTutorTurn,
	canEndSession,
	estimateTokenUsage,
} = require('./state/session-state')
const { parsePcmRate, resamplePcm16, buildConversationPcm } = require('./audio/pcm')

function createFakeGeminiSession() {
	const calls = { audio: [], clientContent: [], toolResponses: [], close: [] }
	let open = true
	return {
		calls,
		connect: async () => true,
		isOpen: () => open,
		sendAudio: (payload) => calls.audio.push(payload),
		sendClientContent: (text, opts) => calls.clientContent.push({ text, opts }),
		sendToolResponse: (responses) => calls.toolResponses.push(responses),
		close: (code, reason) => {
			calls.close.push({ code, reason })
			open = false
		},
		setOpen: (value) => { open = value },
	}
}

function createFakePrisma() {
	const calls = []
	const db = {}
	for (const model of ['voice_sessions', 'voice_session_turns', 'learner_profiles', 'session_errors', 'assessment_sessions', 'assessment_turns', 'assessment_results']) {
		db[model] = {
			update: async (args) => { calls.push({ model, op: 'update', args }); return {} },
			create: async (args) => { calls.push({ model, op: 'create', args }); return { id: 99 } },
			upsert: async (args) => { calls.push({ model, op: 'upsert', args }); return {} },
		}
	}
	return { db, calls }
}

function createFakeClient() {
	const sent = []
	return {
		sent,
		send: (payload) => sent.push(payload),
		close: (code, reason) => sent.push({ type: '__closed__', code, reason }),
	}
}

function makeAgent({ session = {}, mode = 'practice', deps = {} } = {}) {
	const fakePrisma = createFakePrisma()
	const client = createFakeClient()
	const session_ = createFakeGeminiSession()
	const captured = { options: null }
	const tokens = []
	const consolidated = []

	const isVoiceSession = session.isVoiceSession !== undefined ? session.isVoiceSession : true
	const agent = createEnglishVoiceAgent({
		session: {
			sessionId: 42,
			userId: '7',
			userName: 'Priya',
			isVoiceSession,
			trackKey: 'interview_prep',
			chapterKey: 'telling_about_yourself',
			mode,
			...session,
		},
		learnerProfile: { name: 'Priya', englishLevel: 'Beginner' },
		client,
		deps: {
			prisma: fakePrisma.db,
			createLiveSession: (options) => {
				captured.options = options
				return session_
			},
			recordTokenUsage: (params) => tokens.push(params),
			uploadConversationAudio: async () => 'https://s3.example/fake.wav',
			consolidateSessionErrors: async (sid) => { consolidated.push(sid) },
			...deps,
		},
	})

	return { agent, fakePrisma, gemini: session_, captured, client, tokens, consolidated }
}

test('start() wires the Cloop tutor prompt and log_error tools for voice sessions', async () => {
	const { agent, captured } = makeAgent()
	assert.equal(await agent.start(), true)
	assert.match(captured.options.systemInstruction, /warm and patient English speaking TUTOR/)
	assert.equal(captured.options.tools[0], LOG_ERROR_TOOL)
})

test('start() wires the legacy Eva prompt and evaluation tool for assessment sessions', async () => {
	const { agent, captured } = makeAgent({ session: { isVoiceSession: false, trackKey: undefined, chapterKey: undefined } })
	assert.equal(await agent.start(), true)
	assert.equal(captured.options.systemInstruction, LEGACY_ASSESSMENT_PROMPT)
	assert.equal(captured.options.tools[0], LEGACY_EVALUATION_TOOL)
})

test('setupComplete triggers the voice greeting and setup_complete message', async () => {
	const { agent, captured, client, gemini } = makeAgent()
	await agent.start()
	await captured.options.callbacks.onSetupComplete()
	assert.deepEqual(client.sent[0], { type: 'setup_complete' })
	assert.equal(gemini.calls.clientContent.length, 1)
	assert.match(gemini.calls.clientContent[0].text, /ready to practise/)
})

test('setupComplete uses the Cloop AI greeting in cloop_ai mode', async () => {
	const { agent, captured, gemini } = makeAgent({ mode: 'cloop_ai' })
	await agent.start()
	await captured.options.callbacks.onSetupComplete()
	assert.match(gemini.calls.clientContent[0].text, /greet me warmly as Cloop AI/)
})

test('transcriptions accumulate and turn flushing matches the legacy thresholds', async () => {
	const { agent, captured, client } = makeAgent()
	await agent.start()
	const cb = captured.options.callbacks

	await cb.onInputTranscription('Hello ')
	await cb.onInputTranscription('there')
	assert.equal(agent.state.currentUserText, 'Hello there')
	assert.deepEqual(client.sent.pop(), { type: 'user_live_transcript', text: 'Hello there' })

	// short buffer (<4 chars) is not flushed
	agent.state.currentUserText = 'hey'
	assert.equal(await cb.onModelTurn([]), undefined)
	assert.equal(agent.state.currentUserText, 'hey')

	agent.state.currentUserText = 'Hello there'
	await cb.onModelTurn([])
	assert.equal(agent.state.turns[0].speaker, 'user')
	assert.equal(agent.state.turns[0].content, 'Hello there')
	assert.equal(agent.state.turns[0].sequence, 1)
	assert.equal(agent.state.currentUserText, '')

	await cb.onOutputTranscription('What is your name?')
	await cb.onTurnComplete()
	const tutorTurn = agent.state.turns[1]
	assert.equal(tutorTurn.speaker, 'ai')
	assert.equal(agent.state.questionCount, 1)
	assert.deepEqual(client.sent.pop(), {
		type: 'turn_complete',
		speaker: 'ai',
		questionCount: 1,
		text: 'What is your name?',
	})

	await cb.onInterrupted()
	assert.deepEqual(client.sent.pop(), { type: 'interrupted' })
	assert.equal(agent.state.currentAiText, '')
})

test('log_error persists the error, notifies the client and responds to Gemini', async () => {
	const { agent, fakePrisma, gemini, client } = makeAgent()
	await agent.start()

	await agent.handleToolCalls({
		functionCalls: [{
			name: 'log_error',
			id: 'call_1',
			args: { type: 'grammar', said: 'I am having two years experience', correct: 'I have two years of experience', severity: 'blocks_understanding', confidence: 'high', corrected_aloud: true },
		}],
	})

	const created = fakePrisma.calls.find((c) => c.model === 'session_errors' && c.op === 'create')
	assert.equal(created.args.data.error_type, 'grammar')
	assert.equal(agent.state.loggedErrors.length, 1)

	const logged = client.sent.find((m) => m.type === 'error_logged')
	assert.equal(logged.error.id, 99)
	assert.equal(logged.error.said, 'I am having two years experience')

	assert.equal(gemini.calls.toolResponses.length, 1)
	assert.equal(gemini.calls.toolResponses[0][0].response.output.status, 'logged')
})

test('end_session before 4.5 minutes is blocked unless the learner asked to stop', async () => {
	const { agent, gemini, client } = makeAgent()
	await agent.start()

	await agent.handleToolCalls({ functionCalls: [{ name: 'end_session', id: 'call_2', args: { reason: 'practice_completed' } }] })

	assert.equal(gemini.calls.toolResponses.length, 1)
	const output = gemini.calls.toolResponses[0][0].response.output
	assert.equal(output.status, 'continue_practice')
	assert.match(output.instruction, /at least 5 minutes/)
	assert.equal(client.sent.some((m) => m.type === 'session_complete'), false)
	assert.equal(agent.state.sessionCompleted, false)
})

test('end_session after the learner requests it completes the session and logs telemetry', async () => {
	const { agent, fakePrisma, gemini, client, captured, tokens, consolidated } = makeAgent()
	await agent.start()
	await captured.options.callbacks.onSetupComplete()

	agent.handleClientMessage({ type: 'audio_chunk', data: Buffer.alloc(320).toString('base64'), mimeType: 'audio/pcm;rate=16000' })
	agent.handleClientMessage({ type: 'end_session' })
	assert.equal(agent.state.userRequestedEnd, true)
	assert.match(gemini.calls.clientContent[1].text, /end_session function now/)

	await agent.handleToolCalls({
		functionCalls: [{
			name: 'end_session',
			id: 'call_3',
			args: { reason: 'user_requested', summary: 'Great job!', learner_did_well: 'Clear introduction', one_thing_to_fix: 'Articles', questions_asked: 4 },
		}],
	})

	const completion = client.sent.find((m) => m.type === 'session_complete')
	assert.equal(completion.sessionId, 42)
	assert.equal(completion.summary, 'Great job!')
	assert.equal(completion.audioUrl, 'https://s3.example/fake.wav')
	assert.equal(completion.waitForAudioDrain, true)

	const update = fakePrisma.calls.find((c) => c.model === 'voice_sessions' && c.op === 'update' && c.args.data.status === 'COMPLETED')
	assert.equal(update.args.data.summary_text, 'Great job!')
	assert.equal(update.args.data.questions_asked, 4)

	assert.equal(tokens.length, 1)
	assert.equal(tokens[0].featureArea, 'voice_session')
	assert.equal(tokens[0].provider, 'google')
	assert.equal(tokens[0].metadata.audioUrl, 'https://s3.example/fake.wav')

	await new Promise((resolve) => setImmediate(resolve))
	assert.deepEqual(consolidated, [42])
	assert.equal(agent.state.sessionCompleted, true)
})

test('legacy submit_speaking_evaluation completes the assessment', async () => {
	const { agent, fakePrisma, gemini, client } = makeAgent({ session: { isVoiceSession: false, trackKey: undefined, chapterKey: undefined } })
	await agent.start()

	await agent.handleToolCalls({
		functionCalls: [{
			name: 'submit_speaking_evaluation',
			id: 'call_4',
			args: { overall_score: 82, cefr_level: 'B1', strengths: ['clear'], weaknesses: ['articles'], recommendations: ['practice articles'] },
		}],
	})

	const sessionUpdate = fakePrisma.calls.find((c) => c.model === 'assessment_sessions' && c.op === 'update')
	assert.equal(sessionUpdate.args.data.status, 'COMPLETED')
	assert.equal(sessionUpdate.args.data.overall_score, 82)
	assert.ok(fakePrisma.calls.some((c) => c.model === 'assessment_results' && c.op === 'upsert'))
	assert.deepEqual(client.sent.find((m) => m.type === 'assessment_completed'), {
		type: 'assessment_completed',
		sessionId: 42,
		overallScore: 82,
		cefrLevel: 'B1',
	})
	assert.equal(gemini.calls.toolResponses[0][0].response.output.status, 'success')
})

test('legacy assessment turns persist to assessment_turns with ai/user speakers', async () => {
	const { agent, fakePrisma, captured } = makeAgent({ session: { isVoiceSession: false } })
	await agent.start()
	const cb = captured.options.callbacks

	agent.state.currentUserText = 'Hello there'
	await cb.onModelTurn([])
	agent.state.currentAiText = 'Tell me about yourself.'
	await cb.onTurnComplete()

	const userTurn = fakePrisma.calls.find((c) => c.model === 'assessment_turns' && c.args.data.speaker === 'user')
	assert.equal(userTurn.args.data.content, 'Hello there')
	const aiTurn = fakePrisma.calls.find((c) => c.model === 'assessment_turns' && c.args.data.speaker === 'ai')
	assert.equal(aiTurn.args.data.content, 'Tell me about yourself.')
	assert.equal(fakePrisma.calls.some((c) => c.model === 'voice_session_turns'), false)
})

test('8-minute time check note is sent to Gemini for active sessions', async () => {
	const { agent, gemini } = makeAgent({ deps: { timeCheckMs: 15 } })
	await agent.start()
	await new Promise((resolve) => setTimeout(resolve, 50))
	assert.equal(gemini.calls.clientContent.length, 1)
	assert.match(gemini.calls.clientContent[0].text, /^\[time check\]/)
})

test('time check is cleared on client close and after completion', async () => {
	const closed = makeAgent({ deps: { timeCheckMs: 15 } })
	await closed.agent.start()
	await closed.agent.handleClientClose()
	await new Promise((resolve) => setTimeout(resolve, 50))
	assert.equal(closed.gemini.calls.clientContent.length, 0)

	const completed = makeAgent({ deps: { timeCheckMs: 15 } })
	await completed.agent.start()
	completed.agent.handleClientMessage({ type: 'end_session' })
	await completed.agent.handleToolCalls({
		functionCalls: [{ name: 'end_session', id: 'call_tc', args: { reason: 'user_requested', summary: 'x', learner_did_well: 'y', one_thing_to_fix: 'z' } }],
	})
	await new Promise((resolve) => setTimeout(resolve, 50))
	const timeChecks = completed.gemini.calls.clientContent.filter((m) => m.text.startsWith('[time check]'))
	assert.equal(timeChecks.length, 0)
})

test('client disconnect closes Gemini and records fallback metrics + token usage', async () => {
	const { agent, fakePrisma, gemini, tokens } = makeAgent()
	await agent.start()
	agent.handleClientMessage({ type: 'audio_chunk', data: Buffer.alloc(320).toString('base64'), mimeType: 'audio/pcm;rate=16000' })

	await agent.handleClientClose()

	assert.deepEqual(gemini.calls.close[0], { code: 1000, reason: 'Client closed' })

	const durationUpdate = fakePrisma.calls.find((c) => c.model === 'voice_sessions' && c.op === 'update' && c.args.data.duration_seconds !== undefined)
	assert.ok(durationUpdate)
	assert.ok(fakePrisma.calls.some((c) => c.model === 'learner_profiles' && c.op === 'upsert'))

	assert.equal(tokens.length, 1)
	assert.equal(tokens[0].metadata.exitReason, 'client_closed')
	assert.equal(agent.state.tokensLogged, true)
})

test('session-state: turn buffers, completion guard and token presets', () => {
	const state = createSessionState({ sessionId: 1, userId: 2 })
	assert.equal(state.trackKey, 'interview_prep')
	assert.equal(state.chapterKey, 'telling_about_yourself')
	assert.equal(state.mode, 'practice')

	state.currentUserText = 'hey'
	assert.equal(takeUserTurn(state), null)
	assert.equal(state.currentUserText, 'hey')

	state.currentUserText = 'hello'
	const userTurn = takeUserTurn(state)
	assert.equal(userTurn.content, 'hello')
	assert.equal(state.currentUserText, '')

	state.currentUserText = 'ok'
	assert.equal(takeUserTurn(state, 2).content, 'ok')

	state.currentAiText = 'Ready?'
	const tutorTurn = takeTutorTurn(state)
	assert.equal(tutorTurn.content, 'Ready?')
	assert.equal(state.questionCount, 1)
	assert.equal(state.currentAiText, '')

	const blocked = canEndSession({ ...state, startedAt: new Date(Date.now() - 10_000) }, 'practice_completed')
	assert.equal(blocked.allowed, false)
	const elapsed = canEndSession({ ...state, startedAt: new Date(Date.now() - 271_000) }, 'practice_completed')
	assert.equal(elapsed.allowed, true)
	const requested = canEndSession({ ...state, userRequestedEnd: true, startedAt: new Date() }, 'completed')
	assert.equal(requested.allowed, true)

	const fallback = estimateTokenUsage({ ...state, turns: [], userAudioChunksCount: 0, aiAudioChunksCount: 0 }, 'client_closed')
	assert.equal(fallback.promptTokens, 100)
	assert.equal(fallback.completionTokens, 50)
	const completed = estimateTokenUsage({ ...state, turns: [], userAudioChunksCount: 0, aiAudioChunksCount: 0 }, 'completed')
	assert.equal(completed.promptTokens, 200)
	assert.equal(completed.completionTokens, 100)
})

test('audio: PCM rate parsing, resampling and conversation mixing', () => {
	assert.equal(parsePcmRate('audio/pcm;rate=24000'), 24000)
	assert.equal(parsePcmRate('audio/pcm', 16000), 16000)
	assert.equal(parsePcmRate(undefined, 1234), 1234)

	const pcm = Buffer.alloc(320)
	assert.equal(resamplePcm16(pcm, 16000, 16000), pcm)

	assert.equal(buildConversationPcm([]).length, 0)

	const now = Date.now()
	const mixed = buildConversationPcm([
		{ source: 'user', data: Buffer.alloc(320), rate: 16000, ts: now, seq: 0 },
		{ source: 'ai', data: Buffer.alloc(480), rate: 24000, ts: now + 300, seq: 1 },
	])
	assert.ok(mixed.length > 0)
	assert.equal(mixed.length % 2, 0)
})
