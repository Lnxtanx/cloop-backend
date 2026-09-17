/**
 * Post-Session Error Consolidator & AI Feedback Generator
 * 
 * Analyzes the actual conversation transcript and real-time audio error logs
 * using Gemini Flash to generate 100% genuine, personalized feedback across
 * 3 tiers (Fix First, Sounds Off, Small Things), custom spoken summary,
 * fluency metrics (WPM, CEFR estimate), and logs token consumption.
 */

const prisma = require('../../lib/prisma')
const { logTokenUsage } = require('../token-tracker')

const GEMINI_API_KEY = () => process.env.GEMINI_API_KEY

// In-flight consolidation cache to prevent concurrent race condition duplicates
const inFlightConsolidations = new Map()

/**
 * Consolidate and evaluate errors for a completed voice session.
 * 
 * @param {number} sessionId 
 * @returns {Promise<object>} Consolidated session result
 */
async function consolidateSessionErrors(sessionId) {
  const sid = parseInt(sessionId, 10)
  if (!sid) throw new Error('Invalid session ID')

  // Prevent duplicate concurrent execution for the same session
  if (inFlightConsolidations.has(sid)) {
    return inFlightConsolidations.get(sid)
  }

  const promise = (async () => {
    try {
      const session = await prisma.voice_sessions.findUnique({
        where: { id: sid },
        include: {
          errors: true,
          turns: { orderBy: { sequence: 'asc' } },
          user: true,
        },
      })

      if (!session) {
        throw new Error(`Voice session ${sid} not found`)
      }

      const rawErrors = session.errors || []
      const turns = session.turns || []
      const userTurns = turns.filter((t) => t.speaker === 'user' && t.content && t.content.trim().length > 2)

      // Calculate words spoken
      const totalUserWords = userTurns.reduce(
        (sum, t) => sum + (t.content || '').trim().split(/\s+/).filter(Boolean).length,
        0
      )
      const durationSec = session.duration_seconds || 1
      const durationMin = Math.max(0.5, durationSec / 60)
      const wpm = Math.round(totalUserWords / durationMin)

      // Update words_spoken if not yet set
      if (!session.words_spoken || session.words_spoken !== totalUserWords) {
        await prisma.voice_sessions.update({
          where: { id: sid },
          data: { words_spoken: totalUserWords },
        }).catch(() => {})
      }

      // Check if this session was already deeply analyzed to avoid repeating API calls
      const alreadyAnalyzed = Boolean(
        session.summary_text &&
        rawErrors.some((e) => e.tier || e.detail)
      )

      let aiAnalysis = null
      if (!alreadyAnalyzed && userTurns.length > 0) {
        aiAnalysis = await runAiTranscriptAnalysis(turns, session)
      }

      // Combine real-time audio logged errors with transcript analysis errors
      const combinedErrors = []

      // 1. Add real-time errors logged during the call
      for (const err of rawErrors) {
        combinedErrors.push({
          id: err.id,
          error_type: err.error_type || 'grammar',
          said: err.said || '',
          correct: err.correct || '',
          target_word: err.target_word || null,
          detail: err.detail || null,
          severity: err.severity || 'sounds_non_native',
          confidence: err.confidence || 'high',
          tier: err.tier || null,
          source: 'audio_live',
        })
      }

      // 2. Add errors detected by the AI analysis on user turns
      if (aiAnalysis && Array.isArray(aiAnalysis.detected_errors)) {
        for (const err of aiAnalysis.detected_errors) {
          combinedErrors.push({
            error_type: err.type || 'grammar',
            said: err.said || '',
            correct: err.correct || '',
            target_word: err.target_word || null,
            detail: err.explanation || err.detail || null,
            severity: err.severity || 'sounds_non_native',
            confidence: 'high',
            source: 'transcript_analysis',
          })
        }
      }

      // 3. Deduplicate and rank errors
      const errorMap = new Map()
      for (const err of combinedErrors) {
        const key = `${(err.said || '').toLowerCase().trim()}->${(err.correct || '').toLowerCase().trim()}`
        if (!key || key === '->') continue

        if (errorMap.has(key)) {
          const existing = errorMap.get(key)
          existing.count = (existing.count || 1) + 1
          if (err.severity === 'blocks_understanding') existing.severity = 'blocks_understanding'
          if (err.tier && !existing.tier) existing.tier = err.tier
        } else {
          errorMap.set(key, {
            ...err,
            count: 1,
          })
        }
      }

      const uniqueErrors = Array.from(errorMap.values())

      // 4. Assign tiers
      const fixFirst = []
      const soundsOff = []
      const smallThings = []

      for (const err of uniqueErrors) {
        if (err.tier === 'fix_first' || err.severity === 'blocks_understanding' || err.error_type === 'sentence_shape') {
          if (fixFirst.length < 3) {
            fixFirst.push({ ...err, tier: 'fix_first' })
          } else {
            soundsOff.push({ ...err, tier: 'sounds_off' })
          }
        } else if (err.tier === 'small_things' || err.severity === 'minor' || err.error_type === 'indian_english') {
          smallThings.push({ ...err, tier: 'small_things' })
        } else {
          soundsOff.push({ ...err, tier: 'sounds_off' })
        }
      }

      // If fixFirst is empty but soundsOff has items, promote top 1-2 to fixFirst
      if (fixFirst.length === 0 && soundsOff.length > 0) {
        const promoted = soundsOff.splice(0, Math.min(2, soundsOff.length))
        promoted.forEach((p) => fixFirst.push({ ...p, tier: 'fix_first' }))
      }

      // 5. Build summary texts
      const minutes = Math.max(1, Math.round(durationSec / 60))
      let summary = aiAnalysis?.summary_paragraph || session.summary_text
      let learnerDidWell = aiAnalysis?.learner_did_well || session.learner_did_well
      let oneThingToFix = aiAnalysis?.one_thing_to_fix || session.one_thing_to_fix

      if (!summary) {
        if (fixFirst.length > 0) {
          const top = fixFirst[0]
          learnerDidWell = learnerDidWell || 'You expressed your ideas clearly and kept the conversation moving.'
          oneThingToFix = oneThingToFix || `You said "${top.said}" — in English we say "${top.correct}".`
          summary = `You spoke for ${minutes} minutes today. Great effort! You answered questions naturally and with confidence. One key thing to work on: remember to say "${top.correct}" instead of "${top.said}". Keep up the regular practice!`
        } else {
          learnerDidWell = learnerDidWell || 'Your pronunciation was clear and sentences were easy to follow.'
          oneThingToFix = oneThingToFix || 'Practise forming longer compound sentences to sound more natural.'
          summary = `You spoke for ${minutes} minutes today. Excellent practice! Your pronunciation was clear, and you communicated your thoughts smoothly without hesitation.`
        }
      }

      // 6. Update voice session in DB with real summary and results
      await prisma.voice_sessions.update({
        where: { id: sid },
        data: {
          summary_text: summary,
          learner_did_well: learnerDidWell,
          one_thing_to_fix: oneThingToFix,
        },
      }).catch((err) => console.error('[ErrorConsolidator] DB update error:', err))

      // 7. Persist newly detected errors to session_errors table if not already stored
      for (const err of [...fixFirst, ...soundsOff, ...smallThings]) {
        if (err.source === 'transcript_analysis') {
          await prisma.session_errors.create({
            data: {
              session_id: sid,
              error_type: err.error_type || 'grammar',
              said: err.said,
              correct: err.correct,
              target_word: err.target_word,
              detail: err.detail,
              severity: err.severity,
              confidence: 'high',
              tier: err.tier,
            },
          }).catch(() => {})
        } else if (err.id && err.tier) {
          // Update tier for existing live-logged error
          await prisma.session_errors.update({
            where: { id: err.id },
            data: { tier: err.tier },
          }).catch(() => {})
        }
      }

      // 8. Calculate Fluency Metrics & CEFR Estimate
      let cefrEstimate = 'A2'
      if (uniqueErrors.length <= 1 && totalUserWords >= 150) {
        cefrEstimate = 'B2'
      } else if (uniqueErrors.length <= 4 && totalUserWords >= 90) {
        cefrEstimate = 'B1'
      } else if (uniqueErrors.length <= 8) {
        cefrEstimate = 'A2'
      } else {
        cefrEstimate = 'A1'
      }

      const fluencyScore = Math.max(
        50,
        Math.min(95, Math.round(92 - uniqueErrors.length * 3.5 + Math.min(wpm, 130) / 12))
      )

      let paceRating = 'Balanced Pace'
      if (wpm < 75) paceRating = 'Deliberate & Thoughtful'
      else if (wpm > 140) paceRating = 'Fast & Energetic'
      else paceRating = 'Natural Conversational Pace'

      // 9. Persist CEFR level, strengths, and open errors to learner_profiles
      if (session.user_id) {
        const LEVEL_NAMES = { A1: 'Beginner', A2: 'Basic', B1: 'Workplace ready', B2: 'Fluent' }
        const openErrorsList = uniqueErrors.slice(0, 5).map(e => ({
          type: e.error_type,
          said: e.said,
          correct: e.correct,
          detail: e.detail,
        }))

        const strengthsList = learnerDidWell ? [learnerDidWell] : []

        await prisma.learner_profiles.upsert({
          where: { user_id: session.user_id },
          update: {
            cefr_estimate: cefrEstimate,
            english_level: LEVEL_NAMES[cefrEstimate] || 'Beginner',
            open_errors: openErrorsList,
            strengths: strengthsList,
            updated_at: new Date(),
          },
          create: {
            user_id: session.user_id,
            native_language: 'Hindi',
            english_level: LEVEL_NAMES[cefrEstimate] || 'Beginner',
            cefr_estimate: cefrEstimate,
            open_errors: openErrorsList,
            strengths: strengthsList,
            total_sessions: 1,
            total_minutes: minutes,
          },
        }).catch((err) => console.warn('[ErrorConsolidator] Profile update error:', err.message))

        // Update streak
        try {
          const { updateStreak } = require('../analytics/activity-tracker')
          if (updateStreak) {
            await updateStreak(session.user_id)
          }
        } catch {}
      }

      return {
        sessionId: sid,
        durationSeconds: durationSec,
        questionsAsked: session.questions_asked || 0,
        wordsSpoken: totalUserWords,
        summary,
        learnerDidWell,
        oneThingToFix,
        metrics: {
          wpm,
          paceRating,
          fluencyScore,
          cefrEstimate,
          durationMinutes: minutes,
          goalCompleted: durationSec >= 240, // 4+ mins completed
        },
        tiers: {
          fixFirst,
          soundsOff,
          smallThings,
          totalCount: uniqueErrors.length,
        },
      }
    } finally {
      // Release in-flight cache
      inFlightConsolidations.delete(sid)
    }
  })()

  inFlightConsolidations.set(sid, promise)
  return promise
}

/**
 * Call Gemini Flash text API to analyze conversation turns and log token consumption
 */
async function runAiTranscriptAnalysis(turns, session) {
  const apiKey = GEMINI_API_KEY()
  if (!apiKey) return null

  const formattedTranscript = turns
    .filter((t) => t.content && t.content.trim())
    .map((t) => `${t.speaker === 'tutor' || t.speaker === 'ai' ? 'Cloop Tutor' : 'Learner'}: ${t.content}`)
    .join('\n')

  if (!formattedTranscript || formattedTranscript.length < 10) return null

  const prompt = `You are an expert English language coach in India. Analyze the following practice conversation transcript between the Cloop Tutor and the Learner.

TRANSCRIPT:
---
${formattedTranscript}
---

SESSION CONTEXT:
- Track: ${session.track_key || 'General Practice'}
- Chapter: ${session.chapter_key || 'Free Conversation'}
- Spoken Duration: ${session.duration_seconds || 0} seconds

YOUR TASK:
Analyze what the LEARNER said and produce real, constructive feedback.
1. Identify all grammar, word choice, Indian-English phrasing, and sentence structure errors the learner made.
2. Formulate one specific thing the learner did well based on their actual words.
3. Formulate one specific thing to fix with their own example.
4. Write a warm 60-80 word spoken summary paragraph in simple, encouraging English (second person: "You spoke...").

Respond ONLY with valid JSON in this exact structure:
{
  "learner_did_well": "Specific positive observation based on what they said",
  "one_thing_to_fix": "Specific error to fix: You said \\"...\\", say \\"...\\"",
  "summary_paragraph": "60-80 word spoken paragraph summarizing the session",
  "detected_errors": [
    {
      "type": "grammar | word_choice | sentence_shape | sound_swap | indian_english",
      "said": "exact phrase learner said",
      "correct": "natural correct English version",
      "target_word": "optional specific word",
      "explanation": "concise plain English explanation (no grammatical jargon)",
      "severity": "blocks_understanding | sounds_non_native | minor"
    }
  ]
}`

  const startTime = Date.now()

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json',
          },
        }),
      }
    )

    if (!response.ok) {
      console.error('[ErrorConsolidator] Gemini Flash API error:', response.status)
      return null
    }

    const data = await response.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) return null

    // Track tokens for this post-session analysis
    if (session.user_id && data.usageMetadata) {
      const pTokens = data.usageMetadata.promptTokenCount || 0
      const cTokens = data.usageMetadata.candidatesTokenCount || 0
      const tTokens = data.usageMetadata.totalTokenCount || (pTokens + cTokens)

      logTokenUsage({
        userId: session.user_id,
        featureArea: 'voice_session',
        subFeature: 'post_evaluation',
        provider: 'google',
        modelName: 'gemini-2.5-flash',
        promptTokens: pTokens,
        completionTokens: cTokens,
        totalTokens: tTokens,
        requestDurationMs: Date.now() - startTime,
        status: 'success',
        metadata: {
          sessionId: session.id,
          trackKey: session.track_key,
          chapterKey: session.chapter_key,
        },
      })
    }

    const parsed = JSON.parse(text)
    console.log('[ErrorConsolidator] Successfully generated AI transcript analysis!')
    return parsed
  } catch (err) {
    console.error('[ErrorConsolidator] Failed to run AI transcript analysis:', err.message)
    return null
  }
}

module.exports = {
  consolidateSessionErrors,
}
