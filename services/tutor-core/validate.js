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

function unescapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'");
}

function escapeHtml(text) {
  const clean = unescapeHtml(text);
  return clean
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanProse(text) {
  let out = unescapeHtml(String(text || ''))
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

function cleanCompleteSentence(text, maxWords = 15) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  const firstSentenceMatch = clean.match(/^([^.!?]+[.!?])/);
  if (firstSentenceMatch) {
    const s = firstSentenceMatch[1].trim();
    if (wordCount(s) <= maxWords) return s;
  }
  const commaClauseMatch = clean.match(/^([^,]+)(?=,\s*(?:because|which|since|whereas|as)\b)/i);
  if (commaClauseMatch) {
    const clause = commaClauseMatch[1].trim();
    const words = clause.split(/\s+/);
    if (words.length <= maxWords && words.length >= 3) {
      return /[.!?]$/.test(clause) ? clause : `${clause}.`;
    }
  }
  const semicolonMatch = clean.match(/^([^;]+);/);
  if (semicolonMatch) {
    const clause = semicolonMatch[1].trim();
    const words = clause.split(/\s+/);
    if (words.length <= maxWords && words.length >= 3) {
      return /[.!?]$/.test(clause) ? clause : `${clause}.`;
    }
  }
  const relativeClauseMatch = clean.match(/^([^.!?]+?)(?=\s+(?:that|which|because|since|whereas)\b)/i);
  if (relativeClauseMatch) {
    const clause = relativeClauseMatch[1].trim();
    const words = clause.split(/\s+/);
    if (words.length <= maxWords && words.length >= 4) {
      return /[.!?]$/.test(clause) ? clause : `${clause}.`;
    }
  }
  const words = clean.split(/\s+/);
  if (words.length <= maxWords) {
    return clean;
  }
  // Preserving complete meaning: if it cannot fit within maxWords cleanly, omit short diff.
  return '';
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
  const cleanInserted = cleanCompleteSentence(inserted, 15);
  const cleanRemoved = wordCount(removed) > 15 ? cleanCompleteSentence(removed, 15).replace(/[.!?]+$/, '') : removed;
  if (!cleanInserted || !cleanRemoved) return null;
  if (cleanRemoved.trim().toLowerCase() === cleanInserted.trim().toLowerCase()) return null;
  return `<del>${escapeHtml(cleanRemoved)}</del><ins>${escapeHtml(cleanInserted)}</ins>`;
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

const PHYSICAL_ENTITIES = [
  'box', 'ball', 'block', 'car', 'cart', 'sponge', 'wire', 'magnet', 'bulb', 'pendulum',
  'beaker', 'spring', 'flask', 'stone', 'toy car', 'hand', 'wall', 'desk', 'table',
  'floor', 'ground', 'chair', 'book', 'tree', 'rope', 'bucket', 'brick', 'door', 'shelf', 'ceiling'
];

const CONFLICTING_ENTITY_GROUPS = [
  ['wall', 'desk', 'table', 'floor', 'ground', 'chair', 'door', 'shelf', 'ceiling'],
  ['car', 'toy car', 'cart', 'truck', 'bus', 'train', 'bicycle', 'bike'],
  ['beaker', 'flask', 'cup', 'glass', 'bucket'],
  ['sponge', 'spring', 'rubber band'],
  ['box', 'block', 'stone', 'brick']
];

function extractEntities(text) {
  const lower = String(text || '').toLowerCase();
  return PHYSICAL_ENTITIES.filter(entity => {
    const re = new RegExp(`\\b${entity}s?\\b`, 'i');
    return re.test(lower);
  });
}

function validateScenarioConsistency(explanationText, questionText, rubric = null) {
  if (!questionText) return true;
  const qEntities = extractEntities(questionText);

  if (explanationText) {
    const explEntities = extractEntities(explanationText);
    if (explEntities.length > 0 && qEntities.length > 0) {
      for (const group of CONFLICTING_ENTITY_GROUPS) {
        const inExpl = explEntities.filter(e => group.includes(e));
        const inQ = qEntities.filter(e => group.includes(e));
        if (inExpl.length > 0 && inQ.length > 0) {
          const groupOverlap = inExpl.some(e => inQ.includes(e));
          if (!groupOverlap) return false;
        }
      }
      const hasOverlap = explEntities.some(e => qEntities.includes(e));
      if (!hasOverlap) return false;
    }
  }

  if (rubric) {
    const rubricText = [rubric.model_answer || '', ...(rubric.criteria || []).map(c => c.description || '')].join(' ');
    const rubricEntities = extractEntities(rubricText);
    if (rubricEntities.length > 0 && qEntities.length > 0) {
      for (const group of CONFLICTING_ENTITY_GROUPS) {
        const inRubric = rubricEntities.filter(e => group.includes(e));
        const inQ = qEntities.filter(e => group.includes(e));
        if (inRubric.length > 0 && inQ.length > 0) {
          const groupOverlap = inRubric.some(e => inQ.includes(e));
          if (!groupOverlap) return false;
        }
      }
      const hasOverlap = rubricEntities.some(e => qEntities.includes(e));
      if (!hasOverlap) return false;
    }
  }

  return true;
}

function extractScenario(explanationText, questionText) {
  const combined = `${explanationText || ''} ${questionText || ''}`.trim();
  if (!combined) return null;
  const entities = extractEntities(combined);
  const actions = (combined.match(/\b(push(ed|ing)?|pull(ed|ing)?|squeez(ed|ing)?|mov(ed|ing)?|rest(ed|ing)?|drop(ped|ping)?|accelerat(ed|ing)?|decelerat(ed|ing)?|collid(ed|ing)?|stretching|compressing)\b/gi) || [])
    .map(a => a.toLowerCase());
  return {
    object: entities[0] || null,
    action: actions[0] || null,
    summary: cleanProse(explanationText || questionText).slice(0, 100)
  };
}

function createQuestionRecord(params = {}) {
  const {
    questionId,
    goalId,
    scenario,
    questionText = '',
    options = null,
    rubric = null,
    modelAnswer = null,
    requiredComponentIds = [],
    assisted = false,
    sourceVersion = 'v1'
  } = params;

  return {
    questionId: questionId || `q_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    goalId: goalId || null,
    scenario: scenario || null,
    questionText: String(questionText || '').trim(),
    options: Array.isArray(options) ? options : null,
    rubric: rubric || null,
    modelAnswer: modelAnswer || rubric?.model_answer || null,
    requiredComponentIds: Array.isArray(requiredComponentIds) && requiredComponentIds.length
      ? requiredComponentIds
      : (rubric?.criteria || []).map(c => c.id),
    assisted: Boolean(assisted),
    sourceVersion: sourceVersion || 'v1'
  };
}

const PEDAGOGICAL_OBJECTIVE_PREFIXES = /^(?:students\s+(?:will|should)\s+(?:be\s+able\s+to\s+)?|to\s+(?:be\s+able\s+to|understand\s+that|learn\s+that|know\s+that)\s+|understand\s+that\s+|identify\s+(?:the\s+)?|describe\s+(?:the\s+)?|explain\s+(?:how\s+|the\s+|that\s+)?|state\s+(?:the\s+)?|define\s+(?:the\s+)?|differentiate\s+between\s+|distinguish\s+between\s+|recall\s+(?:that\s+)?|recognize\s+(?:that\s+)?|demonstrate\s+(?:that\s+)?|show\s+that\s+|explore\s+(?:the\s+)?|observe\s+(?:the\s+)?|examine\s+(?:the\s+)?|list\s+(?:the\s+)?|name\s+(?:the\s+)?)\b/i;

function cleanConceptHeading(title, topicTitle) {
  const stripPrefix = s => unescapeHtml(String(s || ''))
    .trim()
    .replace(/^(?:topic|goal|chapter|unit|section|lesson)\s*\d*[\s:.-]*/i, '')
    .replace(/[?？!.,:;]+$/, '')
    .trim();

  let clean = stripPrefix(title);
  if (!clean || /^(?:goal|topic|lesson|chapter|unit)\s*\d*$/i.test(clean)) {
    clean = stripPrefix(topicTitle);
  }
  if (!clean) clean = 'this concept';
  return clean;
}

function cleanObjectiveText(text) {
  let s = unescapeHtml(String(text || '')).trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const hadTrailingPeriod = /\.$/.test(s);
  s = s.replace(PEDAGOGICAL_OBJECTIVE_PREFIXES, '');
  s = s.replace(/(?:,\s*(?:and\s+)?|\s+and\s+)(?:describe|explain|state|identify|give\s+examples?)\s+(?:the\s+)?(?:force|reason|cause|why|how)[^.]*/i, '');
  s = s.trim();
  if (!s) return '';
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (hadTrailingPeriod && !/[.!?]$/.test(s)) s += '.';
  return s;
}

/** Grounded fallback: source-backed explanation and check, no internal goal labels, no unbacked formulas. */
function buildFocusedFallback(context = {}) {
  const { currentGoalTitle = '', currentGoalDescription = '', topicTitle = '', academicNotes = null,
    sameAssessment = false, isHelpOrIdk = false, lastQuestionText = '', lastQuestionRubric = null, lastQuestionOptions = null } = context;
  const priorQuestion = cleanProse(lastQuestionText);
  const priorRubric = normalizeRubric(lastQuestionRubric);
  if (sameAssessment && !isHelpOrIdk && priorRubric && endsWithQuestion(priorQuestion) && wordCount(priorQuestion) <= MAX_WORDS_PER_BUBBLE) {
    const options = normalizeOptions(lastQuestionOptions, priorRubric.correct_option_text);
    // Do not turn a letters-only question into an open question with no choices.
    if (!lastQuestionOptions?.length || options) {
      return { messages: [{ message: priorQuestion, message_type: 'text', ...(options ? { options } : {}) }],
        lastQuestionRubric: priorRubric, fallbackQuestionType: options ? 'mcq' : 'open' };
    }
  }

  const conceptName = cleanConceptHeading(currentGoalTitle, topicTitle);
  const rawContent = String(currentGoalDescription || currentGoalTitle || '').trim();
  const content = cleanObjectiveText(rawContent) || conceptName;
  const allFacts = rawContent.split(/;|\n/).map(s => cleanObjectiveText(s)).filter(Boolean);
  // Illustrations aid teaching; recall should not demand every named example.
  const coreFacts = allFacts.filter(fact => !/^(?:examples?(?:\s+such as|\s*:)|for example\b|e\.g\.)/i.test(fact));
  const facts = coreFacts.length ? coreFacts : (allFacts.length ? allFacts : [conceptName]);

  const factualModelAnswer = academicNotes?.definition ? unescapeHtml(academicNotes.definition) : (content || conceptName);
  const hasFormula = Boolean(academicNotes?.formulas?.length || /\b(formula|units?|si unit|equation)\b/i.test(rawContent));

  let question;
  if (/^(what|how|why|which|can|does|is|are)\b/i.test(conceptName)) {
    question = `${conceptName.replace(/[?？!.,:;]+$/, '')}?`;
  } else if (hasFormula) {
    question = `What is meant by ${conceptName}, and what is its formula?`;
    if (wordCount(question) > MAX_WORDS_PER_BUBBLE) {
      question = `What is the definition and formula for ${conceptName}?`;
    }
  } else {
    question = `In simple terms, what is ${conceptName} and how does it work?`;
    if (wordCount(question) > MAX_WORDS_PER_BUBBLE) {
      question = `What is meant by ${conceptName}?`;
    }
  }
  if (wordCount(question) > MAX_WORDS_PER_BUBBLE) {
    const cleanTopic = cleanConceptHeading(topicTitle, 'this concept');
    question = `How would you explain ${cleanTopic}?`;
  }
  question = question.replace(/[?？]+$/, '?');

  return {
    messages: [{ message: question, message_type: 'text' }],
    lastQuestionRubric: rawContent ? { criteria: facts.map((description, i) => ({ id: `fact_${i + 1}`, description, required: true })), model_answer: factualModelAnswer } : null,
    fallbackQuestionType: 'open'
  };
}

function enforce(rawOutput, context = {}) {
  const { isCorrect = null, phase = 'DIALOGUE', questionType = 'open', diffHtml = null, studentMessage = '',
    helpSubtype = null, stateInstruction = null } = context;
  const ending = phase === 'WRAP' || phase === 'DONE';
  const explanationOnly = questionType === 'none' || helpSubtype === 'question_clarification' || stateInstruction === 'clarify_question';
  let actualQuestionType = explanationOnly ? 'none' : (rawOutput?.fallbackQuestionType || questionType);
  let rubric = explanationOnly ? null : normalizeRubric(rawOutput?.lastQuestionRubric);
  const priorRubric = normalizeRubric(context.lastQuestionRubric);
  let questionReplaced = false;
  let questionAssisted = Boolean(context.sameAssessment);
  const rawMessages = Array.isArray(rawOutput?.messages) ? rawOutput.messages : [];
  const expanded = rawMessages.flatMap(b => splitIntoMicroBubbles(reconcileTone(cleanProse(b?.message), isCorrect))
    .map((message, i, parts) => ({ message, message_type: 'text', ...(i === parts.length - 1 && b.options ? { options: b.options } : {}) })));
  let messages = expanded.length > MAX_BUBBLES ? [expanded[0], expanded[expanded.length - 1]] : expanded;

  if (ending) {
    messages = messages.filter(b => !endsWithQuestion(b.message)).slice(0, 1);
    if (!messages.length) messages = [{ message: 'Your session report and revision sheet are ready.', message_type: 'text' }];
    messages.forEach(b => delete b.options);
    return { messages, diff_html: sanitizeDiffHtml(diffHtml, studentMessage), lastQuestionRubric: null, questionType: null, questionReplaced: false, questionRecord: null };
  }

  if (explanationOnly) {
    messages.forEach(b => delete b.options);
    return {
      messages,
      diff_html: sanitizeDiffHtml(diffHtml, studentMessage),
      lastQuestionRubric: null,
      questionType: 'none',
      questionReplaced: false,
      questionAssisted,
      questionRecord: null
    };
  }

  // First recall is uncoached and asks for exactly the full stored core-facts rubric.
  // Assisted retries may explain, but retain that whole question and its original rubric.
  // Clarifications are handled above and do not trigger unconditional ROUNDUP replacement.
  if (phase === 'ROUNDUP' && context.currentGoalDescription) {
    const isAssistanceDirective = Boolean(context.stateInstruction && ['correct_and_reask', 'reteach_new_angle', 'hint_then_easier', 'explain_differently', 'give_starter', 'reveal_and_move_on'].includes(context.stateInstruction));
    const isRetryOrAssisted = Boolean(context.sameAssessment || context.isHelpOrIdk || context.questionAssisted || isAssistanceDirective);
    const recall = buildFocusedFallback(context);
    const explanation = isRetryOrAssisted ? messages.find(b => !endsWithQuestion(b.message)) : null;
    messages = explanation ? [explanation, recall.messages[0]] : recall.messages;
    messages.forEach(b => delete b.options);
    const isActuallyAssisted = Boolean(context.questionAssisted || isAssistanceDirective || context.isHelpOrIdk);
    const questionRecord = createQuestionRecord({
      goalId: context.currentGoalId || context.goalIndex || null,
      scenario: extractScenario(explanation?.message, recall.messages[0]?.message),
      questionText: recall.messages[0]?.message,
      options: null,
      rubric: recall.lastQuestionRubric,
      modelAnswer: recall.lastQuestionRubric?.model_answer,
      requiredComponentIds: (recall.lastQuestionRubric?.criteria || []).map(c => c.id),
      assisted: isActuallyAssisted,
      sourceVersion: context.sourceVersion || 'v1'
    });
    return { messages, diff_html: sanitizeDiffHtml(diffHtml, studentMessage),
      lastQuestionRubric: recall.lastQuestionRubric, questionType: 'open', questionReplaced: true, questionAssisted: isActuallyAssisted, questionRecord };
  }

  // CHECK retries restore the original question, choices and key
  if (context.sameAssessment && priorRubric && phase === 'CHECK') {
    const pending = buildFocusedFallback(context);
    const explanation = messages.find(b => !endsWithQuestion(b.message));
    messages = explanation ? [{ message: explanation.message, message_type: 'text' }, pending.messages[0]] : pending.messages;
    const retryType = pending.fallbackQuestionType;
    if (retryType !== 'mcq') messages.forEach(b => delete b.options);
    const retryRubric = pending.lastQuestionRubric;
    if (retryRubric && retryType !== 'mcq') delete retryRubric.correct_option_text;
    const questionRecord = createQuestionRecord({
      goalId: context.currentGoalId || context.goalIndex || null,
      scenario: extractScenario(explanation?.message, pending.messages[0]?.message),
      questionText: pending.messages[0]?.message,
      options: retryType === 'mcq' ? pending.messages[0]?.options : null,
      rubric: retryRubric,
      modelAnswer: retryRubric?.model_answer,
      requiredComponentIds: (retryRubric?.criteria || []).map(c => c.id),
      assisted: true,
      sourceVersion: context.sourceVersion || 'v1'
    });
    return { messages, diff_html: sanitizeDiffHtml(diffHtml, studentMessage),
      lastQuestionRubric: retryRubric, questionType: retryType, questionReplaced: true, questionAssisted: true, questionRecord };
  }

  // Open teaching retries (DIALOGUE, THEORY, PROBE): retain valid adaptive question and rubric
  if (context.sameAssessment && priorRubric) {
    const candidateFinal = messages[messages.length - 1];
    const candidateQuestion = cleanProse(candidateFinal?.message);
    const hasAdaptiveQuestion = endsWithQuestion(candidateQuestion) && wordCount(candidateQuestion) <= MAX_WORDS_PER_BUBBLE;
    const hasAdaptiveRubric = Boolean(rubric);

    if (hasAdaptiveQuestion && hasAdaptiveRubric) {
      questionAssisted = true;
    } else {
      const pending = buildFocusedFallback(context);
      const explanation = messages.find(b => !endsWithQuestion(b.message));
      messages = explanation ? [{ message: explanation.message, message_type: 'text' }, pending.messages[0]] : pending.messages;
      messages.forEach(b => delete b.options);
      rubric = pending.lastQuestionRubric;
      actualQuestionType = 'open';
      questionReplaced = true;
      questionAssisted = true;
    }
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

  // Validate explanation and question scenario consistency before delivery
  const explanationBubble = messages.length > 1 ? messages.find(b => !endsWithQuestion(b.message)) : null;
  const questionBubble = messages[messages.length - 1];
  if (explanationBubble && questionBubble && endsWithQuestion(questionBubble.message)) {
    if (!validateScenarioConsistency(explanationBubble.message, questionBubble.message, rubric)) {
      let fallback = buildFocusedFallback(context);
      messages = [explanationBubble, fallback.messages[0]];
      rubric = fallback.lastQuestionRubric;
      actualQuestionType = fallback.fallbackQuestionType;
      questionReplaced = true;
    }
  }

  // Options belong only to the final CHECK question, never a written or closing bubble.
  messages.forEach((b, i) => {
    if (phase !== 'CHECK' || actualQuestionType !== 'mcq' || i !== messages.length - 1) delete b.options;
  });
  if (phase !== 'CHECK') actualQuestionType = 'open';
  if (rubric && actualQuestionType !== 'mcq') delete rubric.correct_option_text;

  const deliveredFinalBubble = messages[messages.length - 1];
  const finalQuestionText = ending || actualQuestionType === 'none' ? '' : (deliveredFinalBubble?.message || '');
  const questionRecord = ending || actualQuestionType === 'none' ? null : createQuestionRecord({
    goalId: context.currentGoalId || context.goalIndex || null,
    scenario: extractScenario(explanationBubble?.message, finalQuestionText),
    questionText: finalQuestionText,
    options: actualQuestionType === 'mcq' ? deliveredFinalBubble?.options : null,
    rubric,
    modelAnswer: rubric?.model_answer,
    requiredComponentIds: (rubric?.criteria || []).map(c => c.id),
    assisted: questionAssisted,
    sourceVersion: context.sourceVersion || 'v1'
  });

  return { messages, diff_html: sanitizeDiffHtml(diffHtml, studentMessage), lastQuestionRubric: rubric,
    questionType: actualQuestionType, questionReplaced, questionAssisted, questionRecord };
}

module.exports = { PILL_NARRATION, enforce, cleanProse, wordCount, splitIntoMicroBubbles, endsWithQuestion,
  sanitizeDiffHtml, reconcileTone, normalizeRubric, normalizeOptions, buildFocusedFallback,
  validateScenarioConsistency, extractScenario, createQuestionRecord, unescapeHtml, escapeHtml,
  cleanConceptHeading, cleanObjectiveText, CONFLICTING_ENTITY_GROUPS, PHYSICAL_ENTITIES, MAX_WORDS_PER_BUBBLE };
