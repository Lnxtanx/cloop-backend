/**
 * Voice Session System Prompt Builder
 * 
 * Assembles the Gemini Live system instruction from 4 layers:
 *   Layer 1 — Tutor persona (Ravi, warm Indian-English voice)
 *   Layer 2 — Session shape (interview / conversation / drill / free-talk)
 *   Layer 3 — Topic content (chapter questions, vocabulary, pronunciation targets)
 *   Layer 4 — Learner profile (level, open errors, history)
 * 
 * Also contains the course catalog used for target error/word lookups.
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

// ============================================================
// log_error tool declaration for Gemini Live
// ============================================================
const LOG_ERROR_TOOL = {
  functionDeclarations: [
    {
      name: 'log_error',
      description: 'Log an error detected in the learner\'s speech. Call this for EVERY error you detect, even errors you do not correct aloud. This runs silently in the background — the learner does not see it.',
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
          learner_repeated_correctly: { type: 'BOOLEAN', description: 'If corrected aloud, did the learner repeat it correctly?' },
        },
        required: ['type', 'said', 'correct', 'severity', 'confidence', 'corrected_aloud'],
      },
    },
    {
      name: 'session_complete',
      description: 'Call this when the session is complete — you have covered all the chapter topics or the session has gone on for about 7 minutes. This ends the session.',
      parameters: {
        type: 'OBJECT',
        properties: {
          summary: { type: 'STRING', description: 'A brief 60-90 word spoken paragraph: start with something they did well, name one thing to work on with their own example, end with the next step. Use simple English, short sentences, second person. Never use: elaboration, proficiency, articulation, coherence, demonstrate, utilize.' },
          questions_asked: { type: 'INTEGER', description: 'How many questions/prompts you asked' },
          learner_did_well: { type: 'STRING', description: 'One specific thing the learner did well' },
          one_thing_to_fix: { type: 'STRING', description: 'One specific thing to work on, with their own example' },
        },
        required: ['summary', 'questions_asked', 'learner_did_well', 'one_thing_to_fix'],
      },
    },
  ],
}

// ============================================================
// Course catalog — tracks, chapters, target errors, target words
// ============================================================
const COURSE_CATALOG = {
  interview_prep: {
    name: 'Practice for a Job Interview',
    shape: 'interview',
    chapters: {
      getting_ready: {
        title: 'Getting Ready',
        prompts: [
          'What job are you applying for? Tell me the company name and the role.',
          'Say the company name and your role clearly and confidently.',
        ],
        targetErrors: ['hesitation', 'unclear', 'too_short'],
        targetWords: ['interview', 'position', 'company', 'application', 'opportunity'],
      },
      telling_about_yourself: {
        title: 'Telling Them About Yourself',
        prompts: [
          'Tell me about yourself — your name, where you are from, and what you do.',
          'Tell me about your education. Where did you study?',
          'What are your strengths? Name two or three things you are good at.',
        ],
        targetErrors: ['grammar', 'hesitation', 'too_short', 'sentence_shape'],
        targetWords: ['completed', 'graduated', 'experience', 'strength', 'skilled'],
      },
      common_questions: {
        title: 'The Questions Everyone Asks',
        prompts: [
          'Why do you want this job?',
          'What are your strengths and weaknesses?',
          'Where do you see yourself in five years?',
          'Why should we hire you?',
        ],
        targetErrors: ['grammar', 'word_choice', 'indian_english', 'too_short'],
        targetWords: ['because', 'although', 'improve', 'contribution', 'growth'],
      },
      talking_about_experience: {
        title: 'Talking About What You\'ve Done',
        prompts: [
          'Tell me about a project you worked on. What was your role?',
          'Describe a challenge you faced. How did you handle it?',
          'Tell me about a time you worked in a team.',
        ],
        targetErrors: ['grammar', 'sentence_shape', 'hesitation', 'word_choice'],
        targetWords: ['managed', 'resolved', 'achieved', 'collaborated', 'responsible'],
      },
      tricky_moments: {
        title: 'When You Don\'t Know the Answer',
        prompts: [
          'I am going to ask you something hard. If you do not know the answer, just say so politely.',
          'Why did you leave your last job?',
          'There is a gap in your resume. Can you explain?',
        ],
        targetErrors: ['hesitation', 'unclear', 'too_short', 'grammar'],
        targetWords: ['unfortunately', 'honestly', 'opportunity', 'transition', 'currently'],
      },
      finishing_well: {
        title: 'Finishing Well',
        prompts: [
          'The interview is ending. Do you have any questions for me?',
          'How would you end this interview on a good note?',
        ],
        targetErrors: ['too_short', 'hesitation', 'word_choice'],
        targetWords: ['appreciate', 'looking forward', 'thank you', 'opportunity', 'follow up'],
      },
    },
  },

  everyday_english: {
    name: 'Talk to People Every Day',
    shape: 'conversation',
    chapters: {
      saying_hello: {
        title: 'Saying Hello',
        prompts: [
          'Imagine I am your new neighbour. Say hello and introduce yourself.',
          'Ask me how I am doing today.',
          'Now end this short chat politely.',
        ],
        targetErrors: ['hesitation', 'too_short', 'grammar'],
        targetWords: ['hello', 'nice to meet you', 'how are you', 'take care', 'goodbye'],
      },
      talking_with_friends: {
        title: 'Talking with Friends',
        prompts: [
          'Invite me to watch a movie this weekend.',
          'I cannot come. Suggest another plan.',
          'Say no to my plan politely without hurting my feelings.',
        ],
        targetErrors: ['grammar', 'word_choice', 'hesitation'],
        targetWords: ['together', 'instead', 'unfortunately', 'maybe', 'sounds good'],
      },
      at_home: {
        title: 'At Home',
        prompts: [
          'Tell me about your day today. What happened?',
          'Ask an elder in your family how they are feeling today.',
          'Tell me how you feel right now — happy, tired, worried?',
        ],
        targetErrors: ['grammar', 'sentence_shape', 'word_choice'],
        targetWords: ['today', 'feeling', 'tired', 'worried', 'happened'],
      },
      meeting_new_people: {
        title: 'Meeting New People',
        prompts: [
          'You are at a party. Introduce yourself to someone you have never met.',
          'The person tells you they are from another city. Make small talk about it.',
          'Give the person a compliment about something they said.',
        ],
        targetErrors: ['hesitation', 'too_short', 'word_choice', 'grammar'],
        targetWords: ['pleasure', 'interesting', 'wonderful', 'originally', 'lovely'],
      },
      casual_work_chat: {
        title: 'At Work, Not About Work',
        prompts: [
          'It is lunch break. Ask your colleague about their weekend.',
          'Your colleague has a birthday. Wish them.',
          'It is a festival today. Wish your team.',
        ],
        targetErrors: ['grammar', 'indian_english', 'word_choice'],
        targetWords: ['weekend', 'birthday', 'congratulations', 'festival', 'celebrations'],
      },
      opinions_and_situations: {
        title: 'Saying What You Think',
        prompts: [
          'I think cricket is boring. What do you think?',
          'I disagree with you. Tell me why you think I am wrong, politely.',
          'There was a small misunderstanding between us. Fix it.',
        ],
        targetErrors: ['sentence_shape', 'word_choice', 'grammar'],
        targetWords: ['opinion', 'disagree', 'however', 'misunderstanding', 'apologize'],
      },
    },
  },

  grammar_sentences: {
    name: 'Make Correct Sentences',
    shape: 'drill',
    chapters: {
      building_a_sentence: {
        title: 'Building a Sentence',
        prompts: [
          'Describe this picture: a boy is reading a book in a park.',
          'Tell me three things you see in your room right now.',
          'Make a sentence using the words: "my brother", "school", "every day".',
        ],
        targetErrors: ['grammar', 'sentence_shape'],
        targetWords: ['a', 'an', 'the', 'is', 'are'],
      },
      talking_about_now: {
        title: 'Talking About Now',
        prompts: [
          'What do you like to eat? Tell me about your favourite food.',
          'What are you doing right now?',
          'Tell me about your daily routine — what do you do every morning?',
        ],
        targetErrors: ['grammar'],
        targetWords: ['like', 'have', 'goes', 'does', 'every day'],
      },
      before_and_later: {
        title: 'Before and Later',
        prompts: [
          'What did you do yesterday? Tell me your whole day.',
          'What are you going to do this weekend?',
          'Tell me a short story about something funny that happened to you.',
        ],
        targetErrors: ['grammar', 'word_choice'],
        targetWords: ['went', 'ate', 'saw', 'will', 'going to'],
      },
      asking_questions: {
        title: 'Asking Questions',
        prompts: [
          'You want to know my name and where I work. Ask me.',
          'Ask me what I did last weekend.',
          'I said something you did not understand. Ask me to repeat it.',
        ],
        targetErrors: ['sentence_shape', 'grammar'],
        targetWords: ['do', 'does', 'did', 'what', 'where', 'when', 'why', 'how'],
      },
      joining_ideas: {
        title: 'Joining Your Ideas',
        prompts: [
          'Tell me why you like your favourite movie. Use "because".',
          'Tell me two things: one you like and one you do not like about your city.',
          'Where do you keep your phone? Use "in", "on", or "at".',
        ],
        targetErrors: ['grammar', 'sentence_shape'],
        targetWords: ['because', 'but', 'so', 'in', 'on', 'at'],
      },
      longer_sentences: {
        title: 'Longer Sentences',
        prompts: [
          'What should a student do to get a good job? Use "should" or "must".',
          'Compare two cities you know. Which is bigger? Which is better?',
          'Tell me something using: "Although it was difficult, I..."',
        ],
        targetErrors: ['grammar', 'indian_english', 'sentence_shape'],
        targetWords: ['should', 'must', 'could', 'bigger', 'better', 'although'],
      },
    },
  },

  pronunciation: {
    name: 'Say Words Clearly',
    shape: 'drill',
    chapters: {
      sounds_of_english: {
        title: 'The Sounds of English',
        prompts: [
          'Say these words slowly: ship, sheep, sit, seat.',
          'Say these words: van, wine, vest, west.',
          'Now say: bat, bet, bit, but, boot.',
        ],
        targetErrors: ['sound_swap'],
        targetWords: ['ship', 'sheep', 'van', 'wine', 'sit', 'seat', 'vest', 'west'],
      },
      hard_sounds: {
        title: 'The Hard Sounds',
        prompts: [
          'Say these words with the "th" sound: think, three, thank you, this, that.',
          'Say these words: very, west, voice, water, village, winner.',
          'Say these words with silent letters: know, hour, honest, write, knife.',
        ],
        targetErrors: ['sound_swap'],
        targetWords: ['think', 'three', 'thank', 'this', 'that', 'very', 'voice', 'know', 'hour', 'honest'],
      },
      word_stress: {
        title: 'Which Part of the Word is Loud',
        prompts: [
          'Say these words and stress the right part: PREsent (gift) vs preSENT (to give).',
          'Say: PHOtograph, phoTOGrapher, photoGRAPHic.',
          'Say these commonly mispronounced words: development, comfortable, vegetable.',
        ],
        targetErrors: ['word_stress'],
        targetWords: ['present', 'photograph', 'photographer', 'development', 'comfortable', 'vegetable'],
      },
      sentence_stress: {
        title: 'Which Word in the Sentence is Loud',
        prompts: [
          'Say this sentence stressing different words: "I did not say he stole the money."',
          'Say: "I want an apple" — link "an" and "apple" together.',
          'Read this at a natural speed: "I went to the market and bought some vegetables."',
        ],
        targetErrors: ['word_stress', 'speed'],
        targetWords: ['apple', 'market', 'vegetables', 'money'],
      },
      intonation: {
        title: 'Going Up and Going Down',
        prompts: [
          'Ask me: "Are you coming tomorrow?" — make your voice go up at the end.',
          'Say: "I finished my work." — make your voice go down at the end.',
          'Say "Thank you" politely. Now say it like you are annoyed.',
        ],
        targetErrors: ['sound_swap', 'unclear'],
        targetWords: ['tomorrow', 'finished', 'thank you'],
      },
      clarity_confidence: {
        title: 'Speaking So People Understand',
        prompts: [
          'Read this slowly and clearly: "The quick brown fox jumps over the lazy dog."',
          'Tell me about your morning in four sentences. Speak slowly.',
          'Say the hardest English word you know, and say it three times.',
        ],
        targetErrors: ['speed', 'unclear'],
        targetWords: [],
      },
    },
  },

  free_practice: {
    name: 'Practice Anything You Want',
    shape: 'free_talk',
    chapters: {
      free_talk: {
        title: 'Free Conversation',
        prompts: [],
        targetErrors: [],
        targetWords: [],
      },
    },
  },
}

// ============================================================
// System prompt builder
// ============================================================

/**
 * Build the full system prompt for a Gemini Live voice session.
 * 
 * @param {string} trackKey - e.g. 'interview_prep'
 * @param {string} chapterKey - e.g. 'telling_about_yourself'
 * @param {string} mode - 'practice' | 'interview' | 'free_talk'
 * @param {object} learnerProfile - { nativeLanguage, englishLevel, openErrors[], name }
 * @returns {string}
 */
function buildSessionPrompt(trackKey, chapterKey, mode, learnerProfile = {}) {
  const learnerName = learnerProfile.name || 'the student'

  // Dedicated Cloop AI General Tutor Persona
  if (mode === 'cloop_ai' || trackKey === 'cloop_tutor' || trackKey === 'general_tutor') {
    return `You are Cloop AI, an intelligent, warm, and highly engaging personal AI tutor on the Cloop learning platform.
You are helping ${learnerName}. You can teach, explain, and discuss ANY subject or topic: Mathematics, Science (Physics, Chemistry, Biology), Social Studies (History, Geography, Civics), English, Computer Science, General Knowledge, and Exam Doubts.

YOUR CONVERSATIONAL STYLE & RULES:
1. Speak naturally, warmly, and clearly with an encouraging tone.
2. Keep each spoken turn concise (2-3 sentences max). NEVER give long uninterrupted lectures.
3. Make explanations intuitive: use simple real-life analogies, step-by-step reasoning, and concrete examples.
4. Encourage interactive learning: after answering a doubt or explaining a concept, ask a quick, friendly question to check their understanding.
5. If the student speaks in English, Hindi, or mixed Hinglish, understand them effortlessly and respond in clear, accessible English (or explain key terms in simple Hindi if they ask for it).
6. When the session starts, greet ${learnerName} warmly in 1-2 short sentences and ask what they would like to learn or ask today.
7. This is a real-time live voice conversation. Listen carefully, be supportive, and make learning exciting!`
  }

  const track = COURSE_CATALOG[trackKey]
  const chapter = track?.chapters?.[chapterKey]
  const tutorName = 'Ravi'
  const level = learnerProfile.englishLevel || 'Beginner'

  // Layer 1 — Persona
  const persona = `You are ${tutorName}, a warm and patient English speaking coach in India. You speak with a calm, encouraging tone. You are NOT an examiner. You are a practice partner and teacher.`

  // Layer 2 — Session shape
  let shapeInstructions = ''
  const sessionShape = mode === 'interview' ? 'interview' : (track?.shape || 'conversation')

  switch (sessionShape) {
    case 'interview':
      shapeInstructions = `This is an INTERVIEW PRACTICE session. You are playing the role of a job interviewer. Ask the interview questions one at a time, listen to the answer, then ask the next. Be realistic but warm.`
      break
    case 'drill':
      shapeInstructions = `This is a PRACTICE DRILL session. You give the learner exercises and prompts. They practise speaking. You model the correct version and ask them to repeat when they make a mistake.`
      break
    case 'free_talk':
      shapeInstructions = `This is a FREE PRACTICE session. Ask the learner what they want to practise today. They can say it in simple words. Then adapt — become a role-play partner, a conversation partner, or a drill coach based on what they need. If they say a topic in Hindi or any Indian language, confirm it in English and start.`
      break
    default:
      shapeInstructions = `This is a CONVERSATION PRACTICE session. You are having a natural conversation with the learner about real-life situations. Keep it realistic and warm.`
  }

  // Layer 3 — Chapter content
  let topicInstructions = ''
  if (chapter && chapterKey !== 'free_talk') {
    const prompts = chapter.prompts.map((p, i) => `  ${i + 1}. ${p}`).join('\n')
    const targetWordsStr = chapter.targetWords.length > 0
      ? `Pronunciation target words to steer toward: ${chapter.targetWords.join(', ')}`
      : ''
    const targetErrorsStr = chapter.targetErrors.length > 0
      ? `Target errors to watch for especially: ${chapter.targetErrors.join(', ')}`
      : ''

    topicInstructions = `
THIS SESSION: ${track.name} — ${chapter.title}
Questions/prompts to cover (adapt them naturally, don't read them robotically):
${prompts}
${targetWordsStr}
${targetErrorsStr}`
  }

  // Layer 4 — Learner profile
  let profileInstructions = ''
  if (learnerProfile.openErrors && learnerProfile.openErrors.length > 0) {
    profileInstructions = `\nOpen errors from past sessions (watch for these): ${learnerProfile.openErrors.join(', ')}`
  }

  // Assemble the full prompt
  return `${persona}

The learner's name is ${learnerName}. Their English level is ${level}.

${shapeInstructions}

HARD RULES — FOLLOW THESE WITHOUT EXCEPTION:
- Your turns are 1-2 sentences. NEVER longer. Ask a question, then STOP and listen.
- Correct at most ONE error per turn, out loud.
- To correct: say the right version first, then ask them to repeat it. Example: "We say 'I completed my B.Com.' Say it."
- If they get it wrong twice, say "we'll come back to that" and move on.
- NEVER use grammar terms. Not "past tense", not "article", not "preposition". Just say the correct version.
- NEVER mention scores, levels, assessment, or evaluation during the session.
- If they go silent for 4 seconds, ask an easier version of the question or give them a starter phrase.
- If they answer in Hindi or another language, gently say "Try it in English — I'll help you" and give them the first few words.
- The learner should talk MORE than you. You are the listener. They are the speaker.

LISTENING — SEPARATE FROM CORRECTING:
You hear raw audio, not a transcript. Listen for ALL of these, and log EVERY one via log_error even when you do NOT correct it out loud:
  - sound swaps: th/t, th/s, v/w, z/j, p/f, and vowel length
  - word stress on the wrong syllable
  - grammar and sentence order
  - wrong word choice, including Indian-English usage (prepone, revert back, doing the needful)
  - hesitation, filler words (um, uh, actually actually), restarts
  - speaking too fast, too slow, too quietly, or trailing off
  - answers that are too short for the question
Set confidence honestly. Use "high" ONLY when you clearly heard the error.

CORRECTION LOOP:
- You correct at most 1 error per turn OUT LOUD.
- You LOG every error via log_error, even the ones you let pass.
- Small errors → let them pass (but log them).
- Errors that stop people understanding → correct out loud.

ENDING THE SESSION:
When you have covered all the topics/prompts in this chapter, OR the conversation has gone on for about 6-8 exchanges, wrap up warmly:
  Say something like: "That was great practice! You did really well on [something specific]."
  Then IMMEDIATELY call the session_complete function with a brief summary.
  After calling session_complete, do NOT continue the conversation.
${topicInstructions}
${profileInstructions}`
}

module.exports = {
  buildSessionPrompt,
  LOG_ERROR_TOOL,
  COURSE_CATALOG,
  ERROR_TYPES,
}
