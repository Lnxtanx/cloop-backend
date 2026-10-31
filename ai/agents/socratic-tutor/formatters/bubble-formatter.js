/** Deterministic safeguards for tutor language and the private question contract. */
let CHOICE_QUESTION = "Would you like me to explain the answer, or would you like another try?";
try {
  const state = require('./state');
  if (state.CHOICE_QUESTION) CHOICE_QUESTION = state.CHOICE_QUESTION;
} catch (_) {}
const MAX_WORDS_PER_BUBBLE = 30; // Strictly under 31 words.
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

function splitLongSentence(sentence, maxWords = MAX_WORDS_PER_BUBBLE) {
  const clean = String(sentence || '').trim();
  if (!clean) return [];
  if (wordCount(clean) <= maxWords) return [clean];
  // Semicolons may separate complete clauses. Never remove because/and/or/not,
  // rewrite connectives, or slice a grammatical clause at an arbitrary word.
  const clauses = clean.split(/(?<=[;])\s+/).filter(Boolean);
  const predicate = /\b(?:is|are|was|were|has|have|can|does|do|will|must|may|means|changes?|acts?|moves?|starts?|stops?|causes?|exerts?|pushes|pulls|becomes?|forms?|travels?|carries|converts?|controls?|adjusts?|absorbs?|reduces?|increases?|decreases?)\b|=/i;
  if (clauses.length < 2 || clauses.some(clause => wordCount(clause) > maxWords || !predicate.test(clause))) return [];
  return clauses;
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
    if (wordCount(s) > maxWords) {
      const parts = splitLongSentence(s, maxWords);
      if (!parts.length) return [];
      for (const p of parts) {
        if (!p) continue;
        const combined = chunks.length ? `${chunks[chunks.length - 1]} ${p}` : p;
        if (chunks.length && wordCount(combined) <= maxWords) chunks[chunks.length - 1] = combined;
        else chunks.push(p);
      }
      continue;
    }
    const combined = chunks.length ? `${chunks[chunks.length - 1]} ${s}` : s;
    if (chunks.length && wordCount(combined) <= maxWords) chunks[chunks.length - 1] = combined;
    else chunks.push(s);
  }
  return chunks;
}

function cleanCompleteSentence(text, maxWords = 30) {
  const clean = unescapeHtml(text).trim().replace(/\s+/g, ' ');
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
  const pairRegex = /<del\b[^>]*>([\s\S]*?)<\/del\s*>([\s]*?)<ins\b[^>]*>([\s\S]*?)<\/ins\s*>/gi;
  const pairs = [];
  let match;
  const normalized = value => unescapeHtml(value).replace(/\s+/g, ' ').trim().toLowerCase();
  const normStudent = normalized(rawStudentText || '');

  while ((match = pairRegex.exec(diffHtml)) !== null) {
    const rawDel = match[1];
    const rawSep = match[2];
    const rawIns = match[3];
    const removed = unescapeHtml(rawDel).replace(/\s+/g, ' ').trim();
    const inserted = unescapeHtml(rawIns).replace(/\s+/g, ' ').trim();
    if (!inserted || !removed) continue;
    const normRemoved = normalized(removed);
    if (normStudent) {
      const words = normRemoved.split(/\s+/).filter(w => w.length > 2);
      const matchesWord = words.length > 0 && words.some(w => normStudent.includes(w));
      if (!normStudent.includes(normRemoved) && !matchesWord) continue;
    }
    const firstSentence = inserted.match(/^([^.!?]+[.!?])/);
    if (wordCount(inserted) > 15 && (!firstSentence || wordCount(firstSentence[1]) > 15)) continue;
    const cleanInserted = cleanCompleteSentence(inserted, 15);
    if (!cleanInserted || normRemoved === normalized(cleanInserted)) continue;
    pairs.push({
      removed: escapeHtml(removed),
      cleanInserted: escapeHtml(cleanInserted),
      hasSep: Boolean(rawSep && rawSep.length > 0)
    });
  }

  if (!pairs.length) return null;
  if (pairs.length === 1) {
    const p = pairs[0];
    const sep = p.hasSep ? ' ' : '';
    return `<del>${p.removed}</del>${sep}<ins>${p.cleanInserted}</ins>`;
  }
  return pairs.map(p => `<del>${p.removed}</del> <ins>${p.cleanInserted}</ins>`).join(', ');
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

function shuffleOptions(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function normalizeOptions(options, correctOption, shuffle = false) {
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
  const norm = s => String(s || '').trim().replace(/[.?!,;:]+$/, '').toLowerCase().replace(/\s+/g, ' ');
  const targetNorm = norm(correctOption);
  const matching = result.filter(o => norm(o.text) === targetNorm || o.text === correctOption);
  if (matching.length !== 1) return null;
  return shuffle ? shuffleOptions(result) : result;
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

const FEEDBACK_PREFIX_REGEX = /^(?:(?:right|exactly|spot\s*on|correct|yes|good|well\s*done|great|nice|true|that(?:'s| is) (?:right|correct)|you(?:'re| are) (?:right|correct)|your (?:[a-z]+\s+)?(?:answer|response|point|brake)|you mentioned|you said|as you said|not quite|careful|nice try|almost|today\s+we['’]?ll\s+learn|let['’]?s\s+explore|in\s+the\s+last|as\s+we\s+saw)\b)/i;

function isFeedbackBubble(text) {
  const clean = cleanProse(text).trim();
  return FEEDBACK_PREFIX_REGEX.test(clean);
}

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

  // Conversational feedback acknowledging the student's prior answer reflects the prior scenario,
  // not setting up this question's scenario. Do not cross-check feedback against the new question.
  if (explanationText && !isFeedbackBubble(explanationText)) {
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
    sourceVersion = 'v1',
    learningPointId = null,
    learning_point_id = null,
    explicitRequirements = null,
    explicit_requirements = null,
    responseMode = null,
    response_mode = null
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
    sourceVersion: sourceVersion || 'v1',
    learning_point_id: learning_point_id || learningPointId || null,
    explicit_requirements: explicit_requirements || explicitRequirements || (rubric?.criteria || []).map(c => c.description),
    response_mode: response_mode || responseMode || null
  };
}

const ACTION_VERBS = /^(?:identify(?:\s+the)?|describe(?:\s+the)?|explain(?:\s+the|\s+how)?|state(?:\s+the)?|define(?:\s+the)?|demonstrate(?:\s+the|\s+how)?|analyze(?:\s+the)?|apply(?:\s+the)?|calculate(?:\s+the)?|compare(?:\s+the)?|observe(?:\s+the)?|label(?:\s+the)?|draw(?:\s+the)?|list(?:\s+the)?|name(?:\s+the)?|understand(?:\s+the)?|differentiate\s+between|distinguish\s+between)\s+/i;
const PEDAGOGICAL_OBJECTIVE_PREFIXES = /^(?:students\s+(?:will|should)\s+(?:be\s+able\s+to\s+)?|to\s+(?:be\s+able\s+to|understand\s+that|learn\s+that|know\s+that)\s+|understand\s+that\s+|identify\s+(?:the\s+)?|describe\s+(?:the\s+)?|explain\s+(?:how\s+|the\s+|that\s+)?|state\s+(?:the\s+)?|define\s+(?:the\s+)?|demonstrate\s+(?:the\s+|that\s+)?|analyze\s+(?:the\s+)?|apply\s+(?:the\s+)?|differentiate\s+between\s+|distinguish\s+between\s+|recall\s+(?:that\s+)?|recognize\s+(?:that\s+)?|show\s+that\s+|explore\s+(?:the\s+)?|observe\s+(?:the\s+)?|examine\s+(?:the\s+)?|list\s+(?:the\s+)?|name\s+(?:the\s+)?|label\s+(?:the\s+)?|draw\s+(?:the\s+)?)\b/i;

function cleanConceptHeading(title, topicTitle) {
  const stripPrefix = s => unescapeHtml(String(s || ''))
    .trim()
    .replace(/^(?:topic|goal|chapter|unit|section|lesson)\s*\d*[\s:.-]*/i, '')
    .replace(ACTION_VERBS, '')
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

/** An objective is a task for the tutor, never a factual answer for the student. */
function factualSourceParts(value) {
  return String(value || '').split(/;|\n+|(?<=[.!?])\s+(?=[A-Z])/)
    .map(cleanProse).filter(text => text &&
      !/^(?:(?:brief|short|basic)\s+)?(?:note|stub|placeholder|tbd|todo|description|summary)[.!?]*$/i.test(text) &&
      !/^(?:(?:this|the)\s+(?:topic|chapter|lesson|unit|section)\s+(?:introduces|covers|explains|explores|discusses|focuses|describes|highlights|traces|investigates|teaches)|students?\s+(?:learn|explore|discover|study)\b)/i.test(text) &&
      !/^(?:students?\s+(?:will|should|can)|learners?\s+(?:will|should)|learning\s+(?:goal|objective)|(?:identify|describe|explain|define|demonstrate|analy[sz]e|understand|label|draw|list|name|recall|compare|give\s+examples?)(?:\s|:)|examples?(?:\s+such as|\s*:)|for example\b|e\.g\.)/i.test(text));
}

function isGoalHeadingQuestion(text) {
  return /(?:\b(?:goal|topic|chapter)\s*\d+\s*:|\bwhat is (?:identify|describe|explain|demonstrate|analy[sz]e)\b|\bin simple terms,? what is .+ and how does it work\?|\bin an everyday situation,? how would you analy[sz]e)/i.test(String(text || ''));
}

function sourceFactsFor(context = {}) {
  const notes = context.academicNotes || {};
  // A goal's knowledge statement is its curated full-mark answer, so it outranks
  // the description, which usually states an objective ("Students will...").
  const knowledgeFacts = factualSourceParts(context.currentGoalKnowledge || notes.knowledge_statement);
  if (knowledgeFacts.length) return [...new Set(knowledgeFacts)];
  // The current goal defines the recall perimeter. Notes fill thin/objective-only goals.
  const goalFacts = factualSourceParts(context.currentGoalDescription);
  if (goalFacts.length) return [...new Set(goalFacts)];
  const noteFacts = [notes.definition, notes.scientific_definition,
    ...(Array.isArray(notes.exam_points) ? notes.exam_points : []),
    ...(Array.isArray(notes.key_facts) ? notes.key_facts : []),
    ...(Array.isArray(notes.formulas) ? notes.formulas : [])]
    .flatMap(factualSourceParts);
  return [...new Set(noteFacts)];
}

/** Facts for an explicit topic recap, kept distinct from internal learning objectives. */
function topicFactsFor(context = {}) {
  const goals = Array.isArray(context.goals) ? context.goals : [];
  const seen = new Set();
  const sourceGoals = goals.length ? goals : [{ title: context.currentGoalTitle, description: context.currentGoalDescription }];
  return sourceGoals.map(goal => {
    const facts = sourceFactsFor({ currentGoalKnowledge: goal?.knowledge_statement || '',
      currentGoalDescription: goal?.description || '',
      academicNotes: goal?.academicNotes || (goal?.title === context.currentGoalTitle ? context.academicNotes : null) })
      .filter(fact => {
        const key = fact.toLowerCase().replace(/\s+/g, ' ').trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return { goal_title: goal?.title || '', facts };
  });
}

/** Keep a definition's grouped bubbles together when paging a requested recap. */
function paginateSupportBubbles(bubbles = []) {
  const queue = bubbles.filter(item => item && cleanProse(item.message)).map(item => ({ ...item, message_type: 'text' }));
  const groups = [];
  for (const bubble of queue) {
    const previous = groups[groups.length - 1];
    if (previous && bubble.support_fact_id && previous[0].support_fact_id === bubble.support_fact_id) previous.push(bubble);
    else groups.push([bubble]);
  }
  const page = [];
  let consumed = 0;
  for (const group of groups) {
    // Reserve the third bubble for the continuation instruction when possible.
    const limit = queue.length > 3 && group.length <= 2 ? 2 : 3;
    if (page.length && page.length + group.length > limit) break;
    if (group.length > 3) {
      // Existing source chunks are complete sentences/clauses; long groups remain queued in order.

      const fitting = group.slice(0, 3 - page.length);
      page.push(...fitting);
      consumed += fitting.length;
      break;
    }
    page.push(...group);
    consumed += group.length;
    if (page.length >= limit) break;
  }
  const supportContinuation = queue.slice(consumed);
  if (supportContinuation.length && page.length < 3) {
    page.push({ message: 'Say continue for the remaining definitions.', message_type: 'text' });
  }
  return { messages: page.map(({ support_fact_id, ...bubble }) => bubble), supportContinuation };
}

function topicRecapFallback(context) {
  const facts = topicFactsFor(context).flatMap(goal => goal.facts);
  if (!facts.length) return { ...repairFallback(), recapSourceBacked: true };
  const groups = facts.map(fact => splitIntoMicroBubbles(fact, 25));
  if (groups.some(group => !group.length || group.length > 3)) return { ...repairFallback('explanation_needs_rewrite'), recapSourceBacked: true };
  const bubbles = groups.flatMap((group, index) => group
    .map(message => ({ message, message_type: 'text', support_fact_id: `recap_fact_${index}` })));
  return { ...repairFallback('requested_topic_recap'), ...paginateSupportBubbles(bubbles), recapSourceBacked: true };
}

function repairFallback(reason = 'missing_factual_source', messages = null) {
  return {
    messages: messages || [{ message: "Let me find a clearer way to ask this.", message_type: 'text' }],
    lastQuestionRubric: null,
    fallbackQuestionType: 'none',
    taskRepair: true,
    fallbackReason: reason,
    questionAssisted: true
  };
}

// A sentence may contain several list requirements. Count only a parsed list,
// never the number of source sentences as if it were a mark/answer count.
function listedRequirements(facts) {
  if (facts.length !== 1) return null;
  const match = facts[0].match(/^(.+?)\s+(?:includes?|comprises?|consists?\s+of|contains?)\s+(.+?)[.!?]*$/i);
  if (!match) return null;
  const items = match[2].replace(/[.!?]+$/, '').split(/,\s*|\s+and\s+/i).map(item => item.trim()).filter(Boolean);
  if (items.length < 2 || items.length > 6 || items.some(item => wordCount(item) > 8)) return null;
  return { subject: match[1].replace(/^(?:a|an|the)\s+/i, '').trim(), items };
}

function comparableFact(value) {
  return cleanProse(value).toLowerCase().replace(/\b(?:a|an|the)\b/g, ' ')
    .replace(/[^\p{L}\p{N}=]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function coversRequiredRecall(candidate, expected) {
  if (!candidate || !expected) return false;
  const criteria = candidate.criteria.filter(criterion => criterion.required).map(criterion => comparableFact(criterion.description));
  return expected.criteria.every(criterion => criteria.some(description => description.includes(comparableFact(criterion.description))));
}

/** Grounded fallback: factual recall or ungraded repair; never invent an answer from an objective. */
function buildFocusedFallback(context = {}) {
  const { currentGoalTitle = '', topicTitle = '', sameAssessment = false,
    lastQuestionText = '', lastQuestionRubric = null, lastQuestionOptions = null } = context;
  const priorQuestion = cleanProse(lastQuestionText);
  const priorRubric = normalizeRubric(lastQuestionRubric);
  const help = !context.assessmentAdvanced && Boolean(context.isHelpOrIdk || ['HELP', 'IDK'].includes(context.evaluatorResult?.intent) ||
    ['explain', 'task_repair'].includes(context.response_mode) ||
    ['explain_answer', 'clarify_question', 'task_repair'].includes(context.stateInstruction));
  const facts = sourceFactsFor(context);
  if (['explain', 'task_repair'].includes(context.response_mode) && context.supportRequestKind === 'recap_topic') return topicRecapFallback(context);
  if (help) {
    if (context.supportRequestKind === 'clarify_term' && /\beffects?\b/i.test(`${context.studentMessage || ''} ${lastQuestionText}`)) {
      return repairFallback('term_clarification', [
        { message: 'An effect means a change or result.', message_type: 'text' },
        { message: 'Here, describe what changes in the situation, rather than only naming the push or pull.', message_type: 'text' }
      ]);
    }
    if (context.supportRequestKind === 'give_example') {
      const sourceExample = [context.currentGoalDescription, context.topicContent, ...(context.academicNotes?.exam_points || [])]
        .flatMap(text => String(text || '').split(/;|\n+|(?<=[.!?])\s+(?=[A-Z])/))
        .map(cleanProse).find(text => /\b(?:for example|for instance|such as|e\.g\.|example of)\b/i.test(text) && !/^(?:students?|identify|describe|explain)\b/i.test(text));
      if (sourceExample) {
        const exampleBubbles = splitIntoMicroBubbles(sourceExample, 25);
        if (exampleBubbles.length) return repairFallback('worked_example', exampleBubbles.slice(0, 3).map(message => ({ message, message_type: 'text' })));
      }
      return repairFallback('example_source_unavailable', [{ message: 'Let me find a good example for this first.', message_type: 'text' }]);
    }
    const answer = factualSourceParts(context.evaluatorResult?.complete_answer || priorRubric?.model_answer).join(' ') || facts.join(' ');
    if (!answer) return repairFallback();
    const explanation = splitIntoMicroBubbles(answer, 25);
    if (!explanation.length) return repairFallback('explanation_needs_rewrite');
    return repairFallback('assistance_fallback', explanation.slice(0, 3)
      .map(message => ({ message, message_type: 'text' })));
  }
  if (sameAssessment && priorRubric && !isGoalHeadingQuestion(priorQuestion) && endsWithQuestion(priorQuestion) && wordCount(priorQuestion) <= MAX_WORDS_PER_BUBBLE) {
    const options = normalizeOptions(lastQuestionOptions, priorRubric.correct_option_text);
    if (!lastQuestionOptions?.length || options) {
      return { messages: [{ message: priorQuestion, message_type: 'text', ...(options ? { options } : {}) }],
        lastQuestionRubric: priorRubric, fallbackQuestionType: options ? 'mcq' : 'open' };
    }
  }
  if (!facts.length) return repairFallback();

  const firstFact = facts[0];
  const list = listedRequirements(facts);
  const definitionMatch = firstFact.match(/^(.+?)\s+(?:is defined as|are defined as|is|are|means|refers to)\s+(.+)/i);
  const causeMatch = firstFact.match(/^(.+?)\s+can\s+(.+)/i);
  const sourceSubject = (list?.subject || definitionMatch?.[1] || causeMatch?.[1] || '').replace(/^(?:the|a|an)\s+/i, '').trim();
  const heading = cleanConceptHeading(currentGoalTitle, topicTitle);
  const subject = sourceSubject || heading;
  if (!subject || subject === 'this concept' || wordCount(subject) > 9) return repairFallback();
  let question;
  let requirements = facts;
  if (list) {
    question = `Name all ${list.items.length} components of ${subject.toLowerCase()}?`;
    requirements = list.items.map(item => `${list.subject} includes ${item}.`);
  } else if (causeMatch && /\b(?:change|start|stop|speed|slow|turn)\b/i.test(causeMatch[2])) {
    question = `What changes can ${/^[aeiou]/i.test(subject) ? 'an' : 'a'} ${subject.toLowerCase()} cause?`;
  } else if (facts.length === 1 && definitionMatch) {
    question = /^What is [^?]+[?]$/i.test(currentGoalTitle) && wordCount(currentGoalTitle) <= MAX_WORDS_PER_BUBBLE
      ? currentGoalTitle : `What is meant by ${subject.toLowerCase()}?`;
  } else if (facts.length > 1 && facts.every(fact => /^(.+?)\s+(?:is defined as|are defined as|is|are|means|refers to)\s+(.+)/i.test(fact)) &&
      new Set(facts.map(fact => comparableFact(fact.match(/^(.+?)\s+(?:is defined as|are defined as|is|are|means|refers to)\s+/i)[1]))).size > 1) {
    const subjects = [...new Set(facts.map(fact => fact.match(/^(.+?)\s+(?:is defined as|are defined as|is|are|means|refers to)\s+/i)[1]
      .replace(/^(?:a|an|the)\s+/i, '').toLowerCase()))];
    const joined = subjects.length === 2 ? subjects.join(' and ') : `${subjects.slice(0, -1).join(', ')} and ${subjects.at(-1)}`;
    question = `Define ${joined}?`;
  } else if (facts.length > 1) {
    const labels = [...new Set(facts.map(fact => /\b(?:formula|equation)\b|=/i.test(fact) ? 'formula'
      : /\b(?:units?|measured in)\b/i.test(fact) ? 'units'
      : /\b(?:interact|interaction)\b/i.test(fact) ? 'interaction'
      : /\b(?:is|are|means|defined as|refers to)\b/i.test(fact) ? 'meaning' : null))];
    if (labels.includes(null) || labels.length < 2) return repairFallback('recall_scope_unavailable');
    const scope = labels.length === 2 ? labels.join(' and ') : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
    question = `Explain ${subject.toLowerCase()}: its ${scope}?`;
  } else {
    const causal = firstFact.match(/^(.+?)\s+(starts?(?:\s+with)?|begins?(?:\s+with)?|sparks?|prompts?|motivates?|opposes?|produces?|releases?|requires?|changes?|leads?\s+to)\s+(.+)/i);
    const passive = firstFact.match(/^(.+?)\s+(can|must|should|may)\s+be\s+([\w-]+)\s+(?:by|through|using)\s+(.+)/i);
    const modal = firstFact.match(/^(.+?)\s+(must|should)\s+(observe|measure|compare|identify|control|test)\b/i);
    const conditional = firstFact.split(',').length === 2 && firstFact.match(/^When\s+([^,]+),\s+(.+)/i);
    const pattern = firstFact.match(/^(.+?)\s+(occurs?)\s+in\s+(.+)/i);
    if (causal) {
      const singular = /s$/.test(causal[2].split(/\s+/)[0]);
      const action = causal[2].replace(/^([a-z]+)s\b/i, '$1').toLowerCase();
      question = `What ${singular ? 'does' : 'do'} ${causal[1].toLowerCase()} ${action}?`;
    } else if (conditional) {
      question = `What happens when ${conditional[1].toLowerCase()}?`;
    } else if (pattern && /\b(?:pairs?|groups?|patterns?)\b/i.test(pattern[3])) {
      const singular = /s$/.test(pattern[2]);
      question = `In what pattern ${singular ? 'does' : 'do'} ${pattern[1].toLowerCase()} occur?`;
    } else if (passive) {
      question = `How ${passive[2].toLowerCase()} ${passive[1].toLowerCase()} be ${passive[3].toLowerCase()}?`;
    } else if (modal) {
      question = `What ${modal[2].toLowerCase()} ${modal[1].toLowerCase()} ${modal[3].toLowerCase()}?`;
    } else {
      // A source fragment or objective heading cannot establish a concrete task.
      // Let the caller perform bounded recovery instead of asking vaguely.
      return repairFallback('recall_scope_unavailable');
    }
  }
  if (wordCount(question) > MAX_WORDS_PER_BUBBLE) return repairFallback();
  return {
    messages: [{ message: question, message_type: 'text' }],
    lastQuestionRubric: { criteria: requirements.map((description, index) => ({ id: `fact_${index + 1}`, description, required: true })),
      model_answer: facts.join('; ') },
    fallbackQuestionType: 'open'
  };
}

function enforce(rawOutput, context = {}) {
  const { isCorrect = null, phase = 'DIALOGUE', questionType = 'open', diffHtml = null, studentMessage = '',
    helpSubtype = null, stateInstruction = null, response_mode = null } = context;
  const ending = phase === 'WRAP' || phase === 'DONE' || response_mode === 'closing';
  const supportRequestKind = ['explain', 'task_repair'].includes(response_mode) ? context.supportRequestKind : null;
  if (!ending && supportRequestKind === 'recap_topic' && !rawOutput?.recapSourceBacked) {
    return enforce(topicRecapFallback(context), context);
  }
  const explanationOnly = rawOutput?.fallbackQuestionType === 'none' || rawOutput?.taskRepair === true || questionType === 'none' ||
    helpSubtype === 'question_clarification' ||
    stateInstruction === 'clarify_question' || stateInstruction === 'explain_answer' || stateInstruction === 'task_repair' ||
    response_mode === 'explain' ||
    response_mode === 'task_repair';
  let actualQuestionType = explanationOnly ? 'none' : (rawOutput?.fallbackQuestionType || questionType);
  let rubric = explanationOnly ? null : normalizeRubric(rawOutput?.lastQuestionRubric);
  const priorRubric = normalizeRubric(context.lastQuestionRubric);
  let questionReplaced = false;
  let questionAssisted = Boolean((phase !== 'ROUNDUP' && context.sameAssessment) || context.questionAssisted || rawOutput?.questionAssisted);
  const isHelpOrIdk = Boolean(context.isHelpOrIdk || (studentMessage && /\b(idnt|i\s*dnt|idk|explain|don['’]?t\s+know|dont\s+know|don['’]?t\s+understand|didn['’]?t\s+understand|samjh|samajh)\b/i.test(studentMessage)));
  const isTeachingOrExplanation = explanationOnly || phase === 'THEORY' || response_mode === 'teach' || response_mode === 'explain' || isHelpOrIdk;
  const effectiveMaxBubbles = isTeachingOrExplanation ? 3 : MAX_BUBBLES;
  const maxWordsPerBubble = isTeachingOrExplanation ? 30 : MAX_WORDS_PER_BUBBLE;
  const rawMessages = Array.isArray(rawOutput?.messages) ? rawOutput.messages : [];
  if (!ending && response_mode === 'explain' && rawMessages.some(b => cleanProse(b?.message) && !splitIntoMicroBubbles(cleanProse(b.message), maxWordsPerBubble).length)) {
    const recovery = buildFocusedFallback({ ...context, response_mode: 'task_repair' });
    return enforce(recovery, { ...context, response_mode: 'task_repair', questionType: 'none' });
  }
  const expanded = rawMessages
    .filter(b => cleanProse(b?.message))
    .flatMap(b => {
      const bubbles = splitIntoMicroBubbles(reconcileTone(cleanProse(b?.message), isCorrect), maxWordsPerBubble);
      const toUse = bubbles.length ? bubbles : [cleanProse(b?.message)];
      return toUse.map((message, i, parts) => ({ message, message_type: 'text', ...(i === parts.length - 1 && b.options ? { options: b.options } : {}) }));
    });
  let messages = expanded.length > effectiveMaxBubbles
    ? (isTeachingOrExplanation
        ? (expanded.length >= 3 && endsWithQuestion(expanded[expanded.length - 1]?.message)
            ? [expanded[0], expanded[1], expanded[expanded.length - 1]]
            : expanded.slice(0, effectiveMaxBubbles))
        : [expanded[0], expanded[expanded.length - 1]])
    : expanded;

  if (ending) {
    messages = messages.filter(b => !endsWithQuestion(b.message)).slice(0, 1);
    if (!messages.length) messages = [{ message: 'Your session report and revision sheet are ready.', message_type: 'text' }];
    messages.forEach(b => delete b.options);
    return { messages, diff_html: sanitizeDiffHtml(diffHtml, studentMessage), lastQuestionRubric: null, questionType: null, questionReplaced: false, questionRecord: null };
  }

  if (response_mode === 'offer_choice') {
    const explanation = messages.find(b => !endsWithQuestion(b.message) && !b.message.includes('explain the answer'));
    const choiceBubble = {
      message: CHOICE_QUESTION,
      message_type: 'text',
      options: [
        { text: 'Explain the answer', value: 'Explain the answer' },
        { text: 'I want another try', value: 'I want another try' }
      ]
    };
    messages = explanation ? [explanation, choiceBubble] : [choiceBubble];
    return {
      messages,
      diff_html: sanitizeDiffHtml(diffHtml, studentMessage),
      lastQuestionRubric: null,
      questionType: 'choice',
      questionReplaced: false,
      questionAssisted: true,
      questionRecord: null
    };
  }

  if (explanationOnly) {
    messages = messages.filter(b => !endsWithQuestion(b.message));
    if (!messages.length) {
      const repair = buildFocusedFallback({ ...context, response_mode: 'task_repair' });
      messages = repair.messages;
    }
    messages.forEach(b => delete b.options);
    return {
      messages,
      diff_html: sanitizeDiffHtml(diffHtml, studentMessage),
      lastQuestionRubric: null,
      questionType: 'none',
      questionReplaced: false,
      questionAssisted,
      taskRepair: rawOutput?.taskRepair === true,
      fallbackReason: rawOutput?.fallbackReason || null,
      supportContinuation: Array.isArray(rawOutput?.supportContinuation) ? rawOutput.supportContinuation : [],
      questionRecord: null
    };
  }

  // A valid generated recall task must survive formatting, including when
  // stored goals contain objectives rather than canonical factual sentences.
  // A source-backed full rubric still cannot be reduced to an easier subset.
  if (phase === 'ROUNDUP' && context.currentGoalDescription) {
    const assistanceDirective = ['correct_and_reask', 'reteach_new_angle', 'hint_then_easier',
      'explain_differently', 'give_starter', 'reveal_and_move_on'].includes(context.stateInstruction);
    // Re-presenting the same task after an infrastructure failure is not a hint.
    // Assistance requires actual help/correction or an explicit assisted marker.
    const recallAssisted = Boolean(context.questionAssisted || rawOutput?.questionAssisted || context.isHelpOrIdk ||
      (context.sameAssessment && assistanceDirective));
    const candidate = messages.at(-1);
    const candidateQuestion = cleanProse(candidate?.message);
    const candidateValid = endsWithQuestion(candidateQuestion) && wordCount(candidateQuestion) <= MAX_WORDS_PER_BUBBLE &&
      !isGoalHeadingQuestion(candidateQuestion) && Boolean(rubric);
    const expected = context.sameAssessment && priorRubric
      ? priorRubric : buildFocusedFallback({ ...context, sameAssessment: false, isHelpOrIdk: false,
        evaluatorResult: null, response_mode: 'check', stateInstruction: 'roundup_recall' }).lastQuestionRubric;
    const sufficientlyScoped = !expected || coversRequiredRecall(rubric, expected);
    const freshWholeGoal = !expected || expected.criteria.length <= 1 ||
      /\b(?:all|each|every|effects?|components?|difference|compare|both|and)\b/i.test(candidateQuestion);
    if (candidateValid && sufficientlyScoped && freshWholeGoal) {
      const assisted = recallAssisted;
      if (!assisted) messages = [{ message: candidateQuestion, message_type: 'text' }];
      // Normal validation below owns question identity and checks scenario consistency.
      questionAssisted = assisted;
    } else {
      const recall = buildFocusedFallback(context);
      if (recall.fallbackQuestionType === 'none') {
        const explanations = messages.filter(b => !endsWithQuestion(b.message));
        return enforce({ ...recall, messages: explanations.length ? explanations : recall.messages }, { ...context, questionType: 'none' });
      }
      const explanation = recallAssisted ? messages.find(b => !endsWithQuestion(b.message)) : null;
      messages = explanation ? [explanation, recall.messages[0]] : recall.messages;
      messages.forEach(b => delete b.options);
      const isActuallyAssisted = recallAssisted;
      const questionRecord = createQuestionRecord({
        goalId: context.currentGoalId || context.goalIndex || null,
        scenario: extractScenario(explanation?.message, recall.messages[0]?.message),
        questionText: recall.messages[0]?.message,
        options: null, rubric: recall.lastQuestionRubric, modelAnswer: recall.lastQuestionRubric?.model_answer,
        requiredComponentIds: (recall.lastQuestionRubric?.criteria || []).map(c => c.id),
        assisted: isActuallyAssisted, sourceVersion: context.sourceVersion || 'v1',
        learning_point_id: context.learning_point_id || context.activeLearningPointId || null, response_mode
      });
      return { messages, diff_html: sanitizeDiffHtml(diffHtml, studentMessage), lastQuestionRubric: recall.lastQuestionRubric,
        questionType: 'open', questionReplaced: true, questionAssisted: isActuallyAssisted, questionRecord };
    }
  }

  // CHECK retries restore the original question, choices and key
  if (context.sameAssessment && priorRubric && phase === 'CHECK') {
    const pending = buildFocusedFallback(context);
    if (pending.fallbackQuestionType === 'none') return enforce(pending, { ...context, questionType: 'none' });
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
      sourceVersion: context.sourceVersion || 'v1',
      learning_point_id: context.learning_point_id || context.activeLearningPointId || null,
      response_mode
    });
    return { messages, diff_html: sanitizeDiffHtml(diffHtml, studentMessage),
      lastQuestionRubric: retryRubric, questionType: retryType, questionReplaced: true, questionAssisted: true, questionRecord };
  }

  // Open teaching retries (DIALOGUE, THEORY, PROBE): retain valid adaptive question and rubric
  if (context.sameAssessment && priorRubric && phase !== 'ROUNDUP') {
    const candidateFinal = messages[messages.length - 1];
    const candidateQuestion = cleanProse(candidateFinal?.message);
    const hasAdaptiveQuestion = endsWithQuestion(candidateQuestion) && wordCount(candidateQuestion) <= MAX_WORDS_PER_BUBBLE;
    const hasAdaptiveRubric = Boolean(rubric);

    if (hasAdaptiveQuestion) {
      if (!rubric) rubric = priorRubric;
      actualQuestionType = 'open';
      questionAssisted = true;
    } else {
      const pending = buildFocusedFallback(context);
      if (pending.fallbackQuestionType === 'none') return enforce(pending, { ...context, questionType: 'none' });
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
  if (!explanationOnly && final?.message && !endsWithQuestion(final.message)) {
    final.message = final.message.replace(/[.!?]*$/, '') + '?';
  }
  let originalFinal = cleanProse(rawMessages[rawMessages.length - 1]?.message);
  if (!explanationOnly && originalFinal && !endsWithQuestion(originalFinal)) {
    originalFinal = originalFinal.replace(/[.!?]*$/, '') + '?';
  }
  const originalTerminalQuestion = sentencesIn(originalFinal).at(-1);
  const retainedTerminalQuestion = sentencesIn(final?.message).at(-1);
  const wholeQuestion = endsWithQuestion(final?.message) && endsWithQuestion(originalFinal) &&
    (wordCount(originalFinal) <= MAX_WORDS_PER_BUBBLE ||
      (endsWithQuestion(originalTerminalQuestion) && wordCount(originalTerminalQuestion) <= MAX_WORDS_PER_BUBBLE &&
       originalTerminalQuestion === retainedTerminalQuestion));
  const validOptions = phase === 'CHECK' && actualQuestionType === 'mcq'
    ? normalizeOptions(final?.options, rubric?.correct_option_text) : null;
  const missingContract = !rubric && Boolean(context.currentGoalDescription || context.currentGoalTitle);
  if (!wholeQuestion || isGoalHeadingQuestion(final?.message) || missingContract || (actualQuestionType === 'mcq' && !validOptions)) {
    let fallback = buildFocusedFallback(context);
    if (fallback.fallbackQuestionType === 'none' && !context.fallbackQuestion) {
      if (final?.message && !isGoalHeadingQuestion(final.message) && !explanationOnly) {
        if (!endsWithQuestion(final.message)) final.message = final.message.replace(/[.!?]*$/, '') + '?';
        rubric = {
          criteria: [{ id: 'fact_1', description: cleanObjectiveText(context.currentGoalDescription || context.currentGoalTitle || final.message), required: true }],
          model_answer: cleanProse(final.message)
        };
        actualQuestionType = 'open';
      } else {
        return enforce(fallback, { ...context, questionType: 'none' });
      }
    } else {
      // Legacy callers can provide a focused fallback until all question contracts are migrated.
      if (!fallback.lastQuestionRubric && context.fallbackQuestion && wordCount(cleanProse(context.fallbackQuestion)) <= MAX_WORDS_PER_BUBBLE && endsWithQuestion(cleanProse(context.fallbackQuestion))) {
        fallback.messages[0].message = cleanProse(context.fallbackQuestion);
        fallback.fallbackQuestionType = 'open';
      }
      messages = messages.length && !endsWithQuestion(messages[0].message) && wordCount(messages[0].message) <= MAX_WORDS_PER_BUBBLE
        ? [messages[0], fallback.messages[0]] : fallback.messages;
      rubric = fallback.lastQuestionRubric;
      actualQuestionType = fallback.fallbackQuestionType;
      questionReplaced = true;
    }
  } else if (validOptions) {
    final.options = context.shuffleOptions ? shuffleOptions(validOptions) : validOptions;
    if (rubric?.correct_option_text) {
      const norm = s => String(s || '').trim().replace(/[.?!,;:]+$/, '').toLowerCase().replace(/\s+/g, ' ');
      const match = validOptions.find(o => norm(o.text) === norm(rubric.correct_option_text));
      if (match) rubric.correct_option_text = match.text;
    }
  }

  // Validate explanation and question scenario consistency before delivery
  const explanationBubble = messages.length > 1 ? messages.find(b => !endsWithQuestion(b.message)) : null;
  const questionBubble = messages[messages.length - 1];
  if (explanationBubble && questionBubble && endsWithQuestion(questionBubble.message)) {
    if (!validateScenarioConsistency(explanationBubble.message, questionBubble.message, rubric)) {
      let fallback = buildFocusedFallback(context);
      if (fallback.fallbackQuestionType === 'none') {
        if (!rubric) {
          rubric = {
            criteria: [{ id: 'fact_1', description: cleanObjectiveText(context.currentGoalDescription || context.currentGoalTitle || questionBubble.message), required: true }],
            model_answer: cleanProse(questionBubble.message)
          };
        }
      } else {
        messages = [explanationBubble, fallback.messages[0]];
        rubric = fallback.lastQuestionRubric;
        actualQuestionType = fallback.fallbackQuestionType;
        questionReplaced = true;
      }
    }
  }

  // Options belong only to the final CHECK question, never a written or closing bubble.
  messages.forEach((b, i) => {
    if ((phase !== 'CHECK' && !(phase === 'ROUNDUP' && actualQuestionType === 'mcq')) || actualQuestionType !== 'mcq' || i !== messages.length - 1) delete b.options;
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
    sourceVersion: context.sourceVersion || 'v1',
    learning_point_id: context.learning_point_id || context.activeLearningPointId || null,
    response_mode
  });

  return { messages, diff_html: sanitizeDiffHtml(diffHtml, studentMessage), lastQuestionRubric: rubric,
    questionType: actualQuestionType, questionReplaced, questionAssisted, questionRecord };
}

module.exports = { PILL_NARRATION, enforce, cleanProse, wordCount, splitIntoMicroBubbles, endsWithQuestion,
  sanitizeDiffHtml, reconcileTone, normalizeRubric, normalizeOptions, buildFocusedFallback, factualSourceParts, sourceFactsFor, topicFactsFor, paginateSupportBubbles, isGoalHeadingQuestion,
  validateScenarioConsistency, isFeedbackBubble, extractScenario, createQuestionRecord, unescapeHtml, escapeHtml,
  cleanConceptHeading, cleanObjectiveText, CONFLICTING_ENTITY_GROUPS, PHYSICAL_ENTITIES, MAX_WORDS_PER_BUBBLE, CHOICE_QUESTION };
