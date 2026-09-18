/**
 * Test Suite for Voice Session Ending Tools & S3 Storage
 */

const assert = require('assert')
const { buildSessionPrompt, LOG_ERROR_TOOL } = require('./services/voice-to-voice/voice-session-prompts')
const s3Storage = require('./services/s3-storage')

async function runTests() {
  console.log('🧪 Starting Voice Ending Tools & S3 Storage Test Suite...\n')
  let passed = 0
  let failed = 0

  function test(name, fn) {
    try {
      fn()
      console.log(`  ✅ PASS: ${name}`)
      passed++
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`)
      console.error(`     Error: ${err.message}`)
      failed++
    }
  }

  // 1. Tool Declaration Tests
  test('end_session tool is declared in LOG_ERROR_TOOL', () => {
    const endSessionTool = LOG_ERROR_TOOL.functionDeclarations.find(f => f.name === 'end_session')
    assert(endSessionTool, 'end_session tool should be defined')
    assert.strictEqual(endSessionTool.parameters.type, 'OBJECT')
    assert(endSessionTool.parameters.properties.reason, 'reason parameter should exist')
    assert(endSessionTool.parameters.properties.summary, 'summary parameter should exist')
    assert(endSessionTool.parameters.properties.learner_did_well, 'learner_did_well parameter should exist')
    assert(endSessionTool.parameters.properties.one_thing_to_fix, 'one_thing_to_fix parameter should exist')
    assert.deepStrictEqual(endSessionTool.parameters.required, ['summary', 'learner_did_well', 'one_thing_to_fix'])
  })

  test('session_complete alias tool is declared in LOG_ERROR_TOOL', () => {
    const sessionCompleteTool = LOG_ERROR_TOOL.functionDeclarations.find(f => f.name === 'session_complete')
    assert(sessionCompleteTool, 'session_complete tool should be defined as alias')
  })

  // 2. Prompt Instructions Tests
  test('buildSessionPrompt contains USER-REQUESTED EXIT priority rules', () => {
    const prompt = buildSessionPrompt('interview_prep', 'telling_about_yourself', 'practice', { name: 'Vivek', englishLevel: 'Beginner' })
    assert(prompt.includes('USER-REQUESTED EXIT (HIGHEST PRIORITY)'), 'Prompt must instruct AI on user exit priority')
    assert(prompt.includes('end_session'), 'Prompt must instruct AI to call end_session')
    assert(!prompt.includes('NEVER call session_complete early (under 5 minutes'), 'Prompt must NOT forbid early ending when user requests')
  })

  test('buildSessionPrompt for Cloop AI tutor contains ending instructions', () => {
    const tutorPrompt = buildSessionPrompt('general_tutor', 'free_talk', 'cloop_ai', { name: 'Vivek' })
    assert(tutorPrompt.includes('ENDING THE SESSION & CALLING end_session'), 'Cloop AI prompt must instruct on calling end_session')
    assert(tutorPrompt.includes('user_requested'), 'Cloop AI prompt must reference user_requested reason')
  })

  // 3. Audio & WAV Conversion Tests
  test('pcmToWavBuffer generates standard 44-byte RIFF WAV header', () => {
    const rawPcm = Buffer.alloc(16000 * 2) // 1 second of 16kHz 16-bit audio
    rawPcm.fill(128)
    const wav = s3Storage.pcmToWavBuffer(rawPcm, 16000, 1, 16)
    
    assert.strictEqual(wav.length, 44 + rawPcm.length, 'WAV size should be 44 bytes header + raw PCM length')
    assert.strictEqual(wav.slice(0, 4).toString('ascii'), 'RIFF', 'Header must start with RIFF')
    assert.strictEqual(wav.slice(8, 12).toString('ascii'), 'WAVE', 'Format must be WAVE')
    assert.strictEqual(wav.slice(12, 16).toString('ascii'), 'fmt ', 'Subchunk1 must be fmt ')
    assert.strictEqual(wav.readUInt32LE(16), 16, 'Subchunk1Size must be 16 for PCM')
    assert.strictEqual(wav.readUInt16LE(20), 1, 'AudioFormat must be 1 (PCM)')
    assert.strictEqual(wav.readUInt16LE(22), 1, 'NumChannels must be 1 (Mono)')
    assert.strictEqual(wav.readUInt32LE(24), 16000, 'SampleRate must be 16000')
    assert.strictEqual(wav.readUInt32LE(28), 32000, 'ByteRate must be 32000')
    assert.strictEqual(wav.readUInt16LE(32), 2, 'BlockAlign must be 2')
    assert.strictEqual(wav.readUInt16LE(34), 16, 'BitsPerSample must be 16')
    assert.strictEqual(wav.slice(36, 40).toString('ascii'), 'data', 'Subchunk2 must be data')
    assert.strictEqual(wav.readUInt32LE(40), rawPcm.length, 'Subchunk2Size must equal data length')
  })

  // 4. S3 Storage Graceful Fallback Test
  test('uploadSessionAudio handles unconfigured S3 credentials gracefully without crashing', async () => {
    const result = await s3Storage.uploadSessionAudio({
      sessionId: 99999,
      userId: 1,
      pcmBuffer: Buffer.alloc(100),
    })
    assert.strictEqual(result, null, 'Should return null gracefully when credentials are not configured')
  })

  console.log(`\nResults: ${passed} passed, ${failed} failed.`)
  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
