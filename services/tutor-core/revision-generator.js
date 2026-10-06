/** Grounded revision notes generated at WRAP, with a deterministic fallback. */
const { invokeModel, extractJson } = require('../ai/deepseek-client');

const wordCount = value => String(value || '').trim().split(/\s+/u).filter(Boolean).length;
const plainText = value => typeof value === 'string' && value.trim().length > 0 && !/[<>\u0000-\u0008]/u.test(value);
const clean = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
const unique = values => [...new Set(values.filter(Boolean))];

function normalizeGoals(goals) {
  return (Array.isArray(goals) ? goals : []).map((goal, index) => ({
    title: clean(typeof goal === 'string' ? goal : goal?.title) || `Goal ${index + 1}`,
    description: clean(typeof goal === 'object' ? goal?.description : '')
  }));
}

function clauses(description) {
  return description.split(/;\s*|\.(?:\s+|$)/u).map(clean).filter(Boolean);
}

function formulaFor(goal) {
  const parts = clauses(goal.description);
  // Units may be in the following clause. Keep complete clauses; never clip a formula.
  const formulaParts = parts.filter(part => /=|\bformula\b/iu.test(part) &&
    !/\bno formula\b|\bformula (?:is )?(?:not applicable|not required)\b/iu.test(part));
  if (!formulaParts.length) return null;
  const units = parts.filter(part => /\bunits?\b|\bm\/s\b|\bkm\/h\b/iu.test(part));
  return `${goal.title}: ${unique([...formulaParts, ...units]).join('; ')}`;
}

function withAliases(sheet) {
  return {
    ...sheet,
    key_points: [...sheet.key_concepts],
    common_mistakes: sheet.quick_recall_tips.filter(tip => /mistake|avoid|caution/iu.test(tip))
  };
}

function sheetWordCount(sheet) {
  return wordCount([
    sheet.topic, ...sheet.key_concepts,
    ...sheet.definitions.flatMap(item => [item.term, item.definition]),
    ...sheet.formulas, ...sheet.quick_recall_tips, sheet.practice_next_time
  ].join(' '));
}

/** All goals remain represented. Unsupported chemistry or other facts are never invented. */
function buildFallbackRevisionSheet({ topicTitle, goals = [], keyErrors = [], masteryReport } = {}) {
  const sourceGoals = normalizeGoals(goals);
  const earlyEnd = masteryReport?.ended_reason && masteryReport.ended_reason !== 'complete';
  const sheet = {
    topic: clean(topicTitle) || 'Study Revision',
    key_concepts: sourceGoals.map(goal => goal.title),
    definitions: sourceGoals.filter(goal => goal.description).map(goal => ({
      term: goal.title,
      definition: clauses(goal.description)[0] || goal.description
    })),
    formulas: unique(sourceGoals.map(formulaFor)),
    quick_recall_tips: [
      earlyEnd ? 'Session ended early; review unassessed goals before your next attempt.' : 'Recall each concept in your own words without notes.',
      (Array.isArray(keyErrors) && keyErrors.length)
        ? `Common mistake to avoid: ${unique(keyErrors.map(error => clean(typeof error === 'string' ? error : error?.type))).join(', ') || 'repeat errors from this session'}.`
        : 'Common mistake to avoid: counting examples as separate concepts.',
      'Think about: Can you explain each goal and apply it?'
    ],
    practice_next_time: 'Give an everyday example for each goal, then explain it using the topic notes.'
  };
  if (!sheet.key_concepts.length) {
    sheet.key_concepts = ['Review the verified topic notes before trying another recall question.'];
  }

  // Remove complete optional statements, rather than severing definitions or formula units.
  // Very long source descriptions can be revisited in the original topic notes.
  if (sheetWordCount(sheet) >= 200) sheet.practice_next_time = 'Practise explaining each goal from memory.';
  if (sheetWordCount(sheet) >= 200) sheet.quick_recall_tips = [
    earlyEnd ? 'Session ended early; revisit unassessed goals.' : 'Recall each goal without notes.'
  ];
  while (sheetWordCount(sheet) >= 200 && sheet.definitions.length) {
    const longest = sheet.definitions.reduce((best, item, index, items) =>
      wordCount(item.term + ' ' + item.definition) > wordCount(items[best].term + ' ' + items[best].definition) ? index : best, 0);
    sheet.definitions.splice(longest, 1);
  }
  // Pathological source fields cannot all fit. Preserve whole facts and a reference to every goal.
  // Never drop a verified formula or its units merely to fit the word target.
  // For unusually long source formulas, factual completeness takes priority.
  if (sheetWordCount(sheet) >= 200) {
    sheet.key_concepts = sourceGoals.map((goal, index) => wordCount(goal.title) <= 12 ? goal.title : `Goal ${index + 1}: review the topic notes`);
  }
  return withAliases(sheet);
}

function isValidSheet(parsed, fallback) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (!plainText(parsed.topic) || parsed.topic.trim() !== fallback.topic) return false;
  for (const field of ['key_concepts', 'formulas', 'quick_recall_tips']) {
    if (!Array.isArray(parsed[field]) || !parsed[field].every(plainText)) return false;
  }
  if (parsed.key_concepts.length < fallback.key_concepts.length || !parsed.quick_recall_tips.length || !Array.isArray(parsed.definitions)) return false;
  if (!fallback.key_concepts.every(title => parsed.key_concepts.some(concept =>
    concept.trim().toLowerCase() === title.toLowerCase() ||
    concept.trim().toLowerCase().startsWith(`${title.toLowerCase()}:`)))) return false;
  if (!parsed.definitions.every(item => item && typeof item === 'object' && plainText(item.term) && plainText(item.definition))) return false;
  if (!plainText(parsed.practice_next_time) || sheetWordCount(parsed) >= 200) return false;
  // A formula absent from the verified goal descriptions is not safe to introduce here.
  if (!fallback.formulas.length && parsed.formulas.length) return false;
  if (fallback.formulas.length && !parsed.formulas.length) return false;
  return true;
}

async function generateRevisionSheet({ topicTitle, goals = [], keyErrors = [], classLevel = '10', masteryReport } = {}) {
  const sourceGoals = normalizeGoals(goals);
  const fallback = buildFallbackRevisionSheet({ topicTitle, goals, keyErrors, masteryReport });
  const goalsText = sourceGoals.map((goal, index) => `${index + 1}. ${goal.title}: ${goal.description || 'No verified definition supplied; do not invent one.'}`).join('\n');
  const reportGoals = Array.isArray(masteryReport?.per_goal) ? masteryReport.per_goal : [];
  const coverageText = reportGoals.length ? reportGoals.map(goal =>
    `${goal.goal || goal.goal_title}: ${goal.asked > 0 ? 'assessed' : 'unassessed'}; ${goal.band || 'no mastery evidence'}`).join('\n') : 'Coverage evidence unavailable; do not claim mastery.';
  const errorsText = (Array.isArray(keyErrors) ? keyErrors : []).map(error =>
    `${clean(typeof error === 'string' ? error : error?.type)}: ${Number(error?.count) || 1}`).join(', ') || 'No recorded error types';
  const systemPrompt = `You are Cloop's study guide assistant for Class ${classLevel}.
Create a concise revision sheet grounded ONLY in these verified topic goal descriptions.
Topic: ${JSON.stringify(fallback.topic)}
ALL TOPIC GOALS (revision coverage, not a claim the student mastered them):
${goalsText}
SESSION EVIDENCE:
Ended reason: ${masteryReport?.ended_reason || 'unknown'}
${coverageText}
Common recorded errors: ${errorsText}

Cover EVERY goal, including unassessed goals for future revision. Each key_concepts entry must begin with its exact goal title (optionally followed by a colon and explanation). Do not invent curriculum facts, terms, formulas or units.
Use exact definitions and formulas from the descriptions. If no formula is supplied, formulas must be [].
Preserve formula symbols and units. Avoid generic reactants/products tips for unrelated topics.
Do not claim completion or mastery; this sheet is study material, not an assessment report.
Keep the ENTIRE sheet strictly under 200 words. Return plain text values, no HTML or markdown.
Return STRICT JSON with all these keys:
{"topic": ${JSON.stringify(fallback.topic)}, "key_concepts": ["one concise idea per goal"], "definitions": [{"term": "term", "definition": "verified definition"}], "formulas": ["verified formula with units"], "quick_recall_tips": ["recall aid", "common mistake to avoid", "Think about: self-check?"], "practice_next_time": "1-2 topic-related everyday applications, under 30 words"}`;
  try {
    const raw = await invokeModel(systemPrompt, [{ role: 'user', content: 'Create the grounded revision sheet.' }], {
      temperature: 0.3, maxTokens: 800, jsonFormat: true,
      featureArea: 'tutor-core', subFeature: 'revision-sheet'
    });
    const parsed = extractJson(typeof raw === 'string' ? raw : raw?.text);
    if (!isValidSheet(parsed, fallback)) throw new Error('Invalid or ungrounded revision sheet');
    if (masteryReport?.ended_reason && masteryReport.ended_reason !== 'complete' &&
        /fully mastered|all (?:the )?goals (?:are )?(?:mastered|achieved)|session complete/iu.test(JSON.stringify(parsed))) {
      throw new Error('Revision sheet contradicts early session ending');
    }
    const sheet = {
      topic: fallback.topic,
      key_concepts: parsed.key_concepts.map(clean),
      definitions: parsed.definitions.map(item => ({ term: clean(item.term), definition: clean(item.definition) })),
      // Verified source formulas retain their symbols and units even when the model paraphrases.
      formulas: [...fallback.formulas],
      quick_recall_tips: parsed.quick_recall_tips.map(clean),
      practice_next_time: clean(parsed.practice_next_time)
    };
    return sheetWordCount(sheet) < 200 ? withAliases(sheet) : fallback;
  } catch (error) {
    console.warn('[Tutor-Core Revision] Using grounded fallback revision sheet.');
    return fallback;
  }
}

module.exports = { generateRevisionSheet, buildFallbackRevisionSheet };
