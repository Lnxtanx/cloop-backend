/**
 * English Voice-to-Voice — Gemini Live tool declarations
 *
 * `log_error` + `end_session` / `session_complete` are the tools the live
 * tutor model calls during a session. The runtime resolver lives in
 * ../agent.js (handleToolCalls).
 */

// ============================================================
// 10-type error taxonomy (from platform-design-v2.md Part 5A.3)
// ============================================================
const ERROR_TYPES = [
  'sound_swap',       // sink → think, wery → very
  'word_stress',      // PREsent vs preSENT
  'grammar',          // I am having two years experience
  'word_choice',      // I did my graduation → I graduated
  'sentence_shape',   // Why you are calling? → Why are you calling?
  'hesitation',       // Long pauses, umm, restarts, actually actually
  'speed',            // Too fast or too slow
  'too_short',        // One-word answers where three sentences were needed
  'indian_english',   // prepone, revert back, doing the needful
  'unclear',          // Trailing off, mumbling sentence endings
]

// Buckets for the dashboard (grammar · sentence · pronunciation · fluency)
const ERROR_CATEGORIES = {
  sound_swap: 'pronunciation',
  word_stress: 'pronunciation',
  grammar: 'grammar',
  word_choice: 'grammar',
  indian_english: 'grammar',
  sentence_shape: 'sentence',
  too_short: 'sentence',
  hesitation: 'fluency',
  speed: 'fluency',
  unclear: 'fluency',
}

// ============================================================
// log_error and end_session tool declarations for Gemini Live
// ============================================================
const LOG_ERROR_TOOL = {
  functionDeclarations: [
    {
      name: 'log_error',
      description: "Log an error detected in the learner's speech. Call this for EVERY error you detect, even errors you do not correct aloud. This runs silently in the background. Always include 'said' and 'correct' so the app can show the fix in the transcript.",
      parameters: {
        type: 'OBJECT',
        properties: {
          type: {
            type: 'STRING',
            enum: ERROR_TYPES,
            description: 'The error category from the 10-type taxonomy',
          },
          said: { type: 'STRING', description: 'What the learner actually said' },
          correct: { type: 'STRING', description: 'The correct English version' },
          target_word: { type: 'STRING', description: 'The specific word with the error, if applicable' },
          detail: { type: 'STRING', description: 'Technical detail: e.g. "produced /s/ in place of /θ/"' },
          severity: {
            type: 'STRING',
            enum: ['blocks_understanding', 'sounds_non_native', 'minor'],
            description: 'How much this error affects communication',
          },
          confidence: {
            type: 'STRING',
            enum: ['high', 'medium', 'low'],
            description: 'How confident you are that this is genuinely an error. Use "high" only when you clearly heard it.',
          },
          corrected_aloud: { type: 'BOOLEAN', description: 'Whether you corrected this error aloud to the learner in this turn' },
          is_repeat: { type: 'BOOLEAN', description: 'True if this repeats one of the learner\'s known past errors, or an error already made earlier in this session' },
          rule_explained: { type: 'BOOLEAN', description: 'True if you gave the learner a quick plain-words grammar rule for it (typically done for repeats)' },
          learner_repeated_correctly: { type: 'BOOLEAN', description: 'If corrected aloud, did the learner repeat it correctly?' },
        },
        required: ['type', 'said', 'correct', 'severity', 'confidence', 'corrected_aloud'],
      },
    },
    {
      name: 'end_session',
      description: 'Call this tool to end the voice session and generate the post-session report. You MUST call this tool when: 1) The learner asks to stop, leave, end the chat, or says goodbye (e.g. "I\'m done", "let\'s stop", "bye", "end chat", "I have to go", "bas", "khatam karo"); OR 2) At the ~8-minute check-in the learner says they do NOT want to continue. Before calling it, give the spoken round-up (see the ENDING instructions).',
      parameters: {
        type: 'OBJECT',
        properties: {
          reason: {
            type: 'STRING',
            enum: ['user_requested', 'practice_completed', 'time_limit_reached'],
            description: 'The reason why the session is ending',
          },
          summary: {
            type: 'STRING',
            description: 'A warm spoken closing paragraph (50-90 words): start with something they did well (their own example), then name the KEY errors to work on (grammar/sentence, each with their words and the correct version), and end by inviting them to come back soon. Simple English, short sentences, second person.',
          },
          questions_asked: { type: 'INTEGER', description: 'How many questions/prompts you asked' },
          learner_did_well: { type: 'STRING', description: 'One specific thing the learner did well' },
          one_thing_to_fix: { type: 'STRING', description: 'The single most important thing to work on, with their own example' },
          key_errors: {
            type: 'ARRAY',
            description: 'The main grammar/sentence/pronunciation errors from this session — each as "what they said -> correct version".',
            items: { type: 'STRING' },
          },
          scenario_used: { type: 'STRING', description: 'A short label of the situation/scenario practised this session, so the next session can pick a different one.' },
          next_session_focus: { type: 'STRING', description: 'The one thing to practise next time' },
        },
        required: ['summary', 'learner_did_well', 'one_thing_to_fix'],
      },
    },
    {
      name: 'session_complete',
      description: 'Alias for end_session. Concludes the practice session and compiles the post-session evaluation report.',
      parameters: {
        type: 'OBJECT',
        properties: {
          reason: { type: 'STRING', description: 'Why the session is ending' },
          summary: { type: 'STRING', description: 'A warm spoken closing paragraph with the key errors to work on' },
          questions_asked: { type: 'INTEGER', description: 'How many questions/prompts you asked' },
          learner_did_well: { type: 'STRING', description: 'One specific thing the learner did well' },
          one_thing_to_fix: { type: 'STRING', description: 'One specific thing to work on, with their own example' },
          key_errors: { type: 'ARRAY', description: 'Main errors as "said -> correct"', items: { type: 'STRING' } },
          scenario_used: { type: 'STRING', description: 'Label of the situation practised this session' },
          next_session_focus: { type: 'STRING', description: 'The one thing to practise next time' },
        },
        required: ['summary', 'learner_did_well', 'one_thing_to_fix'],
      },
    },
  ],
}

module.exports = {
  ERROR_TYPES,
  ERROR_CATEGORIES,
  LOG_ERROR_TOOL,
}
