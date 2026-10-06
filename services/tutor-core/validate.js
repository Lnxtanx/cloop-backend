/** Deterministic safeguards for tutor language and the private question contract. */
const MAX_WORDS_PER_BUBBLE = 19; // Strictly fewer than 20.
const MAX_BUBBLES = 2;
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
  let out = String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '');
  for (const re of PILL_NARRATION) out = out.replace(re, ' ');
  return out.replace(/\s+/g, ' ').replace(/^[\s,;:.\u2014-]+/, '').replace(/\s+([,.?!])/g, '$1').trim();
}

function wordCount(text) { return String(text || '').trim().split(/\s+/).filter(Boolean).length; }
function endsWithQuestion(text) { return /[?？]$/.test(String(text || '').trim()); }

function sentencesIn(text) {
  const sentences = [];
  let start = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    if (!/[.!?？]/.test(s[i])) continue;
    // A decimal point belongs to its number, not a sentence boundary.
    if (s[i] === '.' && /\d/.test(s[i - 1] || '') && /\d/.test(s[i + 1] || '')) continue;
    if (i < s.length - 1 && !/\s/.test(s[i + 1])) continue;
    const sentence = s.slice(start, i + 1).trim();
    if (sentence) sentences.push(sentence);
    start = i + 1;
  }
  const tail = s.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

// Preserve complete sentences. A chopped fragment is never a valid replacement question.
function splitIntoMicroBubbles(text, maxWords = MAX_WORDS_PER_BUBBLE) {
  const clean = cleanProse(text);
  if (!clean) return [];
  if (wordCount(clean) <= maxWords) return [clean];
  const sentences = sentencesIn(clean);
  const chunks = [];
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (wordCount(s) > maxWords) continue;
    const combined = chunks.length ? `${chunks[chunks.length - 1]} ${s}` : s;
    if (chunks.length && wordCount(combined) <= maxWords) chunks[chunks.length - 1] = combined;
    else chunks.push(s);
  }
  return chunks;
}

function escapeHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sanitizeDiffHtml(diffHtml, rawStudentText = '') {
  if (typeof diffHtml !== 'string') return null;
  const deletions = [...diffHtml.matchAll(/<del\b[^>]*>([\s\S]*?)<\/del\s*>/gi)];
  const insertions = [...diffHtml.matchAll(/<ins\b[^>]*>([\s\S]*?)<\/ins\s*>/gi)];
  if (!deletions.length || !insertions.length) return null;
  // Rebuild from escaped text, discarding every attribute and every other HTML tag.
  const removed = deletions.map(m => m[1]).join(' ').trim() || rawStudentText;
  let inserted = insertions.map(m => m[1]).join(' ').trim();
  if (!inserted || !removed) return null;
  if (wordCount(inserted) > 15) {
    const sentence = (inserted.match(/^[^.!?]+[.!?]?/) || [inserted])[0];
    inserted = sentence.trim().split(/\s+/).slice(0, 15).join(' ');
  }
  const surgicalDeletion = wordCount(removed) > 15 ? removed.split(/\s+/).slice(0, 15).join(' ') : removed;
  return `<del>${escapeHtml(surgicalDeletion)}</del><ins>${escapeHtml(inserted)}</ins>`;
}

function reconcileTone(messageText, isCorrect) {
  if (isCorrect === true || !messageText) return messageText;
  const replacement = isCorrect === false ? 'Not quite! ' : '';
  return messageText.replace(/(^|[.!?]\s+)(exactly right|exactly correct|that(?:'s| is) (?:right|correct)|you(?:'re| are) (?:right|correct)|correct answer|great job|awesome|brilliant|perfect|you got it|spot on|well done|absolutely right|correct|right)(?:[!.,\u2014-]\s*|$)/gi, (_, boundary) => `${boundary}${replacement}`).trim();
}

function normalizeRubric(rubric) {
  if (!rubric || !Array.isArray(rubric.criteria) || !rubric.criteria.length || !String(rubric.model_answer || '').trim()) return null;
  const ids = new Set();
  const criteria = [];
  for (const item of rubric.criteria) {
    if (!item || !String(item.id || '').trim() || !String(item.description || '').trim() || ids.has(String(item.id))) return null;
    ids.add(String(item.id));
    criteria.push({ id: String(item.id), description: String(item.description).trim(), required: true });
  }
  return { criteria, model_answer: String(rubric.model_answer).trim(),
    ...(rubric.correct_option_text ? { correct_option_text: String(rubric.correct_option_text).trim() } : {}) };
}

function normalizeOptions(options, correctOption) {
  if (!Array.isArray(options) || options.length < 2 || options.length > 4 || !correctOption) return null;
  const seen = new Set();
  const result = [];
  for (const option of options) {
    const text = cleanProse(typeof option === 'string' ? option : option?.text);
    const key = text.toLowerCase();
    if (!text || seen.has(key) || /^[a-d1-4][.)]?$/i.test(text) || /^(correct concept principle|opposite effect occurs|option\s*[a-d1-4]|answer\s*[a-d1-4])$/i.test(text)) return null;
    seen.add(key);
    result.push({ text, value: text });
  }
  return result.filter(o => o.text === correctOption).length === 1 ? result : null;
}

/** Grounded fallback: no invented MCQ answer and no broad chapter question. */
function buildFocusedFallback(context = {}) {
  const { currentGoalTitle = '', currentGoalDescription = '', sameAssessment = false,
    lastQuestionText = '', lastQuestionRubric = null, lastQuestionOptions = null } = context;
  const priorQuestion = cleanProse(lastQuestionText);
  const priorRubric = normalizeRubric(lastQuestionRubric);
  if (sameAssessment && priorRubric && endsWithQuestion(priorQuestion) && wordCount(priorQuestion) <= MAX_WORDS_PER_BUBBLE) {
    const options = normalizeOptions(lastQuestionOptions, priorRubric.correct_option_text);
    // Do not turn a letters-only question into an open question with no choices.
    if (!lastQuestionOptions?.length || options) {
      return { messages: [{ message: priorQuestion, message_type: 'text', ...(options ? { options } : {}) }],
        lastQuestionRubric: priorRubric, fallbackQuestionType: options ? 'mcq' : 'open' };
    }
  }
  const title = cleanProse(currentGoalTitle).replace(/[?？]+$/, '');
  const question = title && wordCount(title) <= 9
    ? `Explain "${title}": definition, key facts, and any formula with units?`
    : 'State this goal’s definition, key facts, and any formula with units?';
  const content = String(currentGoalDescription || currentGoalTitle || '').trim();
  const allFacts = content.split(/;|\n/).map(s => s.trim()).filter(Boolean);
  // Illustrations aid teaching; recall should not demand every named example.
  const coreFacts = allFacts.filter(fact => !/^(?:examples?(?:\s+such as|\s*:)|for example\b|e\.g\.)/i.test(fact));
  const facts = coreFacts.length ? coreFacts : allFacts;
  return {
    messages: [{ message: question, message_type: 'text' }],
    lastQuestionRubric: content ? { criteria: facts.map((description, i) => ({ id: `fact_${i + 1}`, description, required: true })), model_answer: content } : null,
    fallbackQuestionType: 'open'
  };
}

function enforce(rawOutput, context = {}) {
  const { isCorrect = null, phase = 'DIALOGUE', questionType = 'open', diffHtml = null, studentMessage = '' } = context;
  const ending = phase === 'WRAP' || phase === 'DONE';
  let actualQuestionType = rawOutput?.fallbackQuestionType || questionType;
  let rubric = normalizeRubric(rawOutput?.lastQuestionRubric);
  const priorRubric = normalizeRubric(context.lastQuestionRubric);
  // Retries never replace a multi-part assessment with an easier generated rubric.
  if (!ending && context.sameAssessment && priorRubric) rubric = priorRubric;
  let questionReplaced = false;
  const rawMessages = Array.isArray(rawOutput?.messages) ? rawOutput.messages : [];
  const expanded = rawMessages.flatMap(b => splitIntoMicroBubbles(reconcileTone(cleanProse(b?.message), isCorrect))
    .map((message, i, parts) => ({ message, message_type: 'text', ...(i === parts.length - 1 && b.options ? { options: b.options } : {}) })));
  let messages = expanded.length > MAX_BUBBLES ? [expanded[0], expanded[expanded.length - 1]] : expanded;

  if (ending) {
    messages = messages.filter(b => !endsWithQuestion(b.message)).slice(0, 1);
    if (!messages.length) messages = [{ message: 'Your session report and revision sheet are ready.', message_type: 'text' }];
    messages.forEach(b => delete b.options);
    return { messages, diff_html: sanitizeDiffHtml(diffHtml, studentMessage), lastQuestionRubric: null, questionType: null, questionReplaced: false };
  }

  // Every retry retains its original question, options, answer key, and obligations.
  // Keeping only the rubric would unfairly ask an easier question and grade a harder one.
  if (context.sameAssessment && priorRubric) {
    const pending = buildFocusedFallback(context);
    const explanation = messages.find(b => !endsWithQuestion(b.message));
    messages = explanation ? [{ message: explanation.message, message_type: 'text' }, pending.messages[0]] : pending.messages;
    const retryType = phase === 'CHECK' ? pending.fallbackQuestionType : 'open';
    if (retryType !== 'mcq') messages.forEach(b => delete b.options);
    const retryRubric = pending.lastQuestionRubric;
    if (retryRubric && retryType !== 'mcq') delete retryRubric.correct_option_text;
    return { messages, diff_html: sanitizeDiffHtml(diffHtml, studentMessage),
      lastQuestionRubric: retryRubric, questionType: retryType, questionReplaced: true };
  }

  // First recall is uncoached and asks for exactly the full stored core-facts rubric.
  // Assisted retries may explain, but retain that whole question and its original rubric.
  if (phase === 'ROUNDUP' && context.currentGoalDescription) {
    const recall = buildFocusedFallback(context);
    const explanation = context.sameAssessment ? messages.find(b => !endsWithQuestion(b.message)) : null;
    messages = explanation ? [explanation, recall.messages[0]] : recall.messages;
    messages.forEach(b => delete b.options);
    return { messages, diff_html: sanitizeDiffHtml(diffHtml, studentMessage),
      lastQuestionRubric: recall.lastQuestionRubric, questionType: 'open', questionReplaced: true };
  }

  const final = messages[messages.length - 1];
  // A question shortened by dropping its beginning no longer matches its saved rubric.
  const originalFinal = cleanProse(rawMessages[rawMessages.length - 1]?.message);
  const originalTerminalQuestion = sentencesIn(originalFinal).at(-1);
  const retainedTerminalQuestion = sentencesIn(final?.message).at(-1);
  const wholeQuestion = endsWithQuestion(final?.message) && endsWithQuestion(originalFinal) &&
    (wordCount(originalFinal) <= MAX_WORDS_PER_BUBBLE ||
      (endsWithQuestion(originalTerminalQuestion) && wordCount(originalTerminalQuestion) <= MAX_WORDS_PER_BUBBLE &&
       originalTerminalQuestion === retainedTerminalQuestion));
  const validOptions = phase === 'CHECK' && actualQuestionType === 'mcq'
    ? normalizeOptions(final?.options, rubric?.correct_option_text) : null;
  const missingContract = !rubric && Boolean(context.currentGoalDescription || context.currentGoalTitle);
  if (!wholeQuestion || missingContract || (actualQuestionType === 'mcq' && !validOptions)) {
    let fallback = buildFocusedFallback(context);
    // Legacy callers can provide a focused fallback until all question contracts are migrated.
    if (!fallback.lastQuestionRubric && context.fallbackQuestion && wordCount(cleanProse(context.fallbackQuestion)) <= MAX_WORDS_PER_BUBBLE && endsWithQuestion(cleanProse(context.fallbackQuestion))) {
      fallback.messages[0].message = cleanProse(context.fallbackQuestion);
    }
    messages = messages.length && !endsWithQuestion(messages[0].message)
      ? [messages[0], fallback.messages[0]] : fallback.messages;
    rubric = fallback.lastQuestionRubric;
    actualQuestionType = fallback.fallbackQuestionType;
    questionReplaced = true;
  } else if (validOptions) {
    final.options = validOptions;
  }
  // Options belong only to the final CHECK question, never a written or closing bubble.
  messages.forEach((b, i) => {
    if (phase !== 'CHECK' || actualQuestionType !== 'mcq' || i !== messages.length - 1) delete b.options;
  });
  if (phase !== 'CHECK') actualQuestionType = 'open';
  if (rubric && actualQuestionType !== 'mcq') delete rubric.correct_option_text;
  return { messages, diff_html: sanitizeDiffHtml(diffHtml, studentMessage), lastQuestionRubric: rubric, questionType: actualQuestionType, questionReplaced };
}

module.exports = { PILL_NARRATION, enforce, cleanProse, wordCount, splitIntoMicroBubbles, endsWithQuestion,
  sanitizeDiffHtml, reconcileTone, normalizeRubric, normalizeOptions, buildFocusedFallback, MAX_WORDS_PER_BUBBLE };
