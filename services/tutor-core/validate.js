/**
 * Step 4: Quality & Structural Validator (The Gatekeeper)
 *
 * Runs deterministically in pure JavaScript (0ms latency, zero I/O).
 * Enforces structural invariants before messages are saved to the database
 * or sent to the frontend:
 * 1. Purges empty or whitespace-only bubbles.
 * 2. Enforces max bubble count (up to 2 bubbles: concept + question).
 * 3. Enforces strict <= 20 words per bubble (splits or trims long bubbles).
 * 4. Ensures the final bubble ends with an answerable question (never dead-ends), except in WRAP/DONE.
 * 5. Reconciles tone (strips unearned praise on incorrect attempts).
 * 6. Enforces MCQ isolation: strips options when questionType is 'open'.
 * 7. Sanitizes strikethrough diff HTML.
 */

const MAX_WORDS_PER_BUBBLE = 20;
const MAX_BUBBLES = 2; // Strict hard cap: at most 2 bubbles (ideally 1)

/**
 * Phrases that send the student off to a card instead of answering.
 *
 * A card renders as its own element; it needs no introduction, and a bubble
 * spent pointing at it is a bubble the student cannot answer. This was a real
 * production failure — "Open the 'Write this down' card, then tell me: ..." —
 * so it is stripped here rather than merely discouraged in the prompt.
 */
const PILL_NARRATION = [
  /\bopen the\s+['"\u2018\u2019\u201c\u201d]?[\w\s'-]{0,30}['"\u2018\u2019\u201c\u201d]?\s*(card|pill|link|note)\b[,:]?\s*/gi,
  /\b(tap|click|press)\s+(the|on)\b[^.?!]*[.?!]?\s*/gi,
  /\bcheck\s+(the|out)\s+(card|diagram|link|note|sheet)\b[^.?!]*[.?!]?\s*/gi,
  /\b(card|diagram|sheet|note)s?\s+below\b[^.?!]*[.?!]?\s*/gi,
  /\bsee below\b[^.?!]*[.?!]?\s*/gi,
  /\bcopy (it|this) down\b[,:]?\s*/gi,
  /\bi'?(ve| have) added\b[^.?!]*[.?!]?\s*/gi,
  /\bhave a look\b[^.?!]*[.?!]?\s*/gi,
  /\bthen tell me\b[,:]?\s*/gi,
];

function cleanProse(text) {
  if (!text) return '';
  let out = String(text)
    .replace(/```(?:mermaid|json)?[\s\S]*?```/gi, '') // Remove code fences
    .replace(/<think>[\s\S]*?<\/think>/gi, '');        // Remove reasoning tags

  for (const re of PILL_NARRATION) out = out.replace(re, ' ');

  return out
    .replace(/\s+/g, ' ')            // Collapse whitespace
    .replace(/^[\s,;:.\u2014-]+/, '') // Tidy a leading fragment left behind
    .replace(/\s+([,.?!])/g, '$1')
    .trim();
}

/**
 * Count words in a string
 */
function wordCount(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Split a text that exceeds MAX_WORDS_PER_BUBBLE into clean smaller chunks
 */
function splitIntoMicroBubbles(text, maxWords = MAX_WORDS_PER_BUBBLE) {
  const clean = cleanProse(text);
  if (!clean) return [];
  if (wordCount(clean) <= maxWords) return [clean];

  // Try splitting by sentence boundaries (. ! ?)
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  const chunks = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    const testChunk = currentChunk ? `${currentChunk} ${trimmed}` : trimmed;
    if (wordCount(testChunk) <= maxWords) {
      currentChunk = testChunk;
    } else {
      if (currentChunk) chunks.push(currentChunk);
      // If a single sentence exceeds maxWords, split by words
      if (wordCount(trimmed) > maxWords) {
        const words = trimmed.split(/\s+/);
        for (let i = 0; i < words.length; i += maxWords) {
          chunks.push(words.slice(i, i + maxWords).join(' '));
        }
        currentChunk = '';
      } else {
        currentChunk = trimmed;
      }
    }
  }

  if (currentChunk) chunks.push(currentChunk);
  return chunks.filter(c => c && c.trim().length > 0);
}

/**
 * Check if a message bubble ends with an active question or prompting phrase
 */
function endsWithQuestion(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (/[?？]$/.test(trimmed)) return true;
  return /\b(predict|choose|explain|tell me|calculate|what do you think|which one|try this)\b/i.test(trimmed);
}

/**
 * Sanitize and validate diff_html
 */
function sanitizeDiffHtml(diffHtml, rawStudentText) {
  if (!diffHtml || typeof diffHtml !== 'string') return null;

  // Verify tags exist
  const hasDel = /<del>[\s\S]*?<\/del>/i.test(diffHtml);
  const hasIns = /<ins>[\s\S]*?<\/ins>/i.test(diffHtml);

  if (!hasDel && !hasIns) return null;

  // Extract ins content and verify it's not a giant essay
  const insMatch = diffHtml.match(/<ins>([\s\S]*?)<\/ins>/i);
  if (insMatch && insMatch[1]) {
    const insWords = wordCount(insMatch[1]);
    // If the model wrote > 15 words in <ins>, replace with clean fallback
    if (insWords > 15) {
      const fallbackTarget = insMatch[1].split(/[.!?]/)[0].trim().split(/\s+/).slice(0, 10).join(' ');
      return `<del>${rawStudentText || 'mistake'}</del><ins>${fallbackTarget}</ins>`;
    }
  }

  return diffHtml;
}

/**
 * Reconcile tone: Strip misplaced praise if the student was marked incorrect
 */
function reconcileTone(messageText, isCorrect) {
  if (isCorrect !== false || !messageText) return messageText;

  // Strip openings that praise an incorrect answer
  return messageText
    .replace(/^(great job|awesome|brilliant|perfect|you got it|spot on|well done)[!.,]?\s*/i, 'Not quite! ')
    .trim();
}

/**
 * Main Enforce Function
 *
 * @param {object} rawOutput - { messages: Array }
 * @param {object} context
 * @param {boolean|null} context.isCorrect - Verdict from Step 1
 * @param {string} context.phase - Current session phase
 * @param {string} [context.questionType] - 'open' | 'mcq' | null
 * @param {string} [context.fallbackQuestion] - Topic-level fallback question
 * @param {string} [context.diffHtml] - Raw diff from Evaluator
 * @param {string} [context.studentMessage] - Raw student message
 * @returns {object} { messages: Array, diff_html: string|null }
 */
function enforce(rawOutput, context = {}) {
  const {
    isCorrect = null,
    phase = 'DIALOGUE',
    questionType = 'open',
    fallbackQuestion = 'What do you think is the next step?',
    diffHtml = null,
    studentMessage = ''
  } = context;

  const rawMessages = Array.isArray(rawOutput?.messages) ? rawOutput.messages : [];
  const maxAllowedBubbles = MAX_BUBBLES;

  // 1. Purge empty / whitespace bubbles
  const validBubbles = rawMessages.filter(m => {
    if (!m) return false;
    const text = cleanProse(m.message);
    if (text.length > 0) return true;
    if (Array.isArray(m.options) && m.options.length > 0) return true;
    return false;
  });

  // 2. Expand / split bubbles exceeding 20 words
  const expandedBubbles = [];
  for (const b of validBubbles) {
    let cleanText = cleanProse(b.message);

    // Reconcile tone on the first bubble
    if (expandedBubbles.length === 0 && isCorrect === false) {
      cleanText = reconcileTone(cleanText, isCorrect);
    }

    const chunks = splitIntoMicroBubbles(cleanText, MAX_WORDS_PER_BUBBLE);

    if (chunks.length === 0 && Array.isArray(b.options) && b.options.length > 0) {
      expandedBubbles.push({
        message: 'Choose an option:',
        message_type: b.message_type || 'text',
        options: b.options
      });
    } else {
      chunks.forEach((chunk, idx) => {
        const isLastChunk = idx === chunks.length - 1;
        expandedBubbles.push({
          message: chunk,
          message_type: b.message_type || 'text',
          ...(isLastChunk && b.options ? { options: b.options } : {})
        });
      });
    }
  }

  // 3. Hard Cap at MAX_BUBBLES (max 2 bubbles: concept + question)
  let cappedBubbles = [];
  if (expandedBubbles.length <= maxAllowedBubbles) {
    cappedBubbles = [...expandedBubbles];
  } else {
    // If more than 2 bubbles, retain the first thought and the final question/prompt
    const firstBubble = expandedBubbles[0];
    const lastBubble = expandedBubbles[expandedBubbles.length - 1];
    cappedBubbles = [firstBubble, lastBubble];
  }

  // If we ended with 0 bubbles, provide a safe fallback
  if (cappedBubbles.length === 0) {
    cappedBubbles.push({
      message: fallbackQuestion,
      message_type: 'text'
    });
  }

  // 4. MCQ Isolation Guard: On 'open' turns, defensively purge any accidental options
  if (questionType === 'open' || phase === 'PROBE' || phase === 'THEORY' || phase === 'OBJECTIVES' || phase === 'DIALOGUE') {
    for (const bubble of cappedBubbles) {
      if (bubble.options) delete bubble.options;
    }
  }

  // 5. Ensure terminal question (unless session is WRAP or DONE)
  if (phase !== 'WRAP' && phase !== 'DONE') {
    const lastBubble = cappedBubbles[cappedBubbles.length - 1];
    const hasOptions = Array.isArray(lastBubble.options) && lastBubble.options.length > 0;
    if (!endsWithQuestion(lastBubble.message) && !hasOptions) {
      // Append a question if under word count
      if (wordCount(`${lastBubble.message} ${fallbackQuestion}`) <= MAX_WORDS_PER_BUBBLE) {
        lastBubble.message = `${lastBubble.message.replace(/[.]+$/, '')}. ${fallbackQuestion}`;
      } else if (cappedBubbles.length < maxAllowedBubbles) {
        // Add as a separate question bubble if currently at 1 bubble
        cappedBubbles.push({
          message: fallbackQuestion,
          message_type: 'text'
        });
      } else {
        // Replace last bubble with question to ensure prompt
        lastBubble.message = fallbackQuestion;
      }
    }
  }

  // 6. Sanitize diff_html
  const sanitizedDiff = sanitizeDiffHtml(diffHtml, studentMessage);

  return {
    messages: cappedBubbles,
    diff_html: sanitizedDiff
  };
}

module.exports = {
  PILL_NARRATION,
  enforce,
  cleanProse,
  wordCount,
  splitIntoMicroBubbles,
  endsWithQuestion,
  sanitizeDiffHtml,
  reconcileTone,
  MAX_WORDS_PER_BUBBLE
};
