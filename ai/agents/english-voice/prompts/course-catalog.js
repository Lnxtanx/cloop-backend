/**
 * English Voice-to-Voice — Course Catalog
 *
 * Tracks, chapters, scene beats, target errors and target words for the
 * Cloop English speaking tutor (delivered over Gemini Live duplex audio).
 *
 * Data only — prompt assembly lives in ../prompts/session-prompt.js
 */

const COURSE_CATALOG = {
  interview_prep: {
    name: 'Practice for a Job Interview',
    shape: 'interview',
    chapters: {
      getting_ready: {
        title: 'Getting Ready',
        prompts: [
          'What job position and company are you preparing to interview for? Tell me why this specific role interests you.',
          'Practice stating your professional job title and your core area of expertise with crisp confidence.',
          'How have you prepared for today\'s interview? Mention two key things you researched about the company.',
          'Tell me about the professional environment or team culture you thrive in.',
          'Give a concise 30-second elevator pitch summarizing what unique value you bring to an employer.',
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
          'There is a gap in your work history. Can you explain it?',
        ],
        targetErrors: ['hesitation', 'unclear', 'too_short', 'grammar'],
        targetWords: ['unfortunately', 'honestly', 'opportunity', 'transition', 'currently'],
      },
      finishing_well: {
        title: 'Finishing Well',
        prompts: [
          'The interviewer says: "That concludes our questions. Do you have any questions for us?" Ask two thoughtful, intelligent questions about the role or company culture.',
          'The interviewer answers your questions. Respond professionally showing enthusiasm for the opportunity.',
          'Reiterate your top strength and explain why you are eager to contribute to the team.',
          'Ask about the next steps and timeline in the hiring process politely.',
          'Conclude the interview with a polished, memorable closing statement thanking the interviewer.',
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
          'Scenario 1 (New Neighbour): Imagine I am moving into the flat next door. Say hello, introduce yourself warmly, and ask if I need any help settling in.',
          'Scenario 1 Follow-up: Ask me where I moved from, and recommend a good local grocery shop, cafe, or park in this neighbourhood.',
          'Scenario 2 (Office Colleague): It is Monday morning by the office coffee machine. Greet me, ask how my weekend was, and tell me one thing you did over the weekend.',
          'Scenario 3 (Old Friend Reunion): You unexpectedly bump into an old school friend at a shopping mall. Greet me with genuine surprise, ask what I am working on these days, and share what you have been up to.',
          'Scenario 4 (Networking Meetup): You are at an industry meetup. Introduce yourself, state your background, and ask me what brought me to the event.',
          'Wrap-up: Conclude our conversation politely by exchanging contact info or pleasantries and saying goodbye warmly.',
        ],
        targetErrors: ['hesitation', 'too_short', 'grammar'],
        targetWords: ['hello', 'nice to meet you', 'how are you', 'take care', 'goodbye', 'settling in', 'weekend'],
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
          // Voice-only: imagination prompt, not an on-screen picture.
          'Imagine a boy reading a book in a park. Describe it to me — what is he doing, what is around him?',
          'Tell me three things you can see around you right now.',
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

module.exports = { COURSE_CATALOG }
