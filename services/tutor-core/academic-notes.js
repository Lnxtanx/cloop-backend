// Keep full exam facts outside the short conversational bubbles. These notes are
// extracted from the supplied curriculum, rather than guessed from a board name.
const { createHash } = require('node:crypto');
const NOTE_SCHEMA_VERSION = 1;
const STOP = new Set('a an the of in on to and or for by from with is are be can how explain identify describe analyse analyze evaluate demonstrate classify effects impact impacts changes strategies alternatives'.split(' '));
const words = text => (String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length > 2 && !STOP.has(w));
const facts = text => String(text || '').split(/\n+|;\s*|(?<=[.!?])\s+(?=[A-Z])/).map(s => s.trim()).filter(Boolean);

function buildAcademicNotes(goal, topicContent = '') {
  const primary = facts(goal.description);
  const tokens = new Set(words(`${goal.title} ${goal.description}`));
  const source = facts(String(topicContent).slice(0, 32000));
  const relevant = source.map((text, index) => ({ text, index,
    score: [...new Set(words(text))].filter(w => tokens.has(w)).length }))
    .filter(item => item.score >= 2 && !primary.includes(item.text))
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3).map(item => item.text);
  const examPoints = [...new Set([...primary, ...relevant])];
  const definition = examPoints.find(s => /\b(is|are|defined|definition|means|refers)\b|\s=\s/i.test(s)) || examPoints[0] || '';
  const mechanism = examPoints.find(s => /\b(because|binds?|reacts?|reduces?|causes?|converts?|traps?|formed|incomplete|oxygen transport|absorbs?|lowers?|removes?|cools?|cooling|smothering)\b/i.test(s)) || '';
  const formulas = examPoints.filter(s => /=|\bformula\b/i.test(s));
  const examKeywords = [...new Set((examPoints.join(' ').match(/\b(?:CO2|CO|SO2|NOx|haemoglobin|hemoglobin|incomplete combustion|oxygen transport|sulfur dioxide|sulphur dioxide|nitrogen oxides|carbon monoxide|carbon dioxide|acid rain|greenhouse effect|catalytic converter|ignition temperature|fire triangle|fuel|oxygen|heat|cooling|smothering|water extinguisher|Class A|independent variables?|dependent variables?|controlled variables?|fair test|testable question|hypothesis|measurement|observation|measurable property|experimental object|experimental subject)\b/gi) || []))];
  return { goal: goal.title, definition, mechanism, exam_points: examPoints,
    exam_keywords: examKeywords, model_answer: examPoints.join('; '), formulas,
    common_mistake: examPoints.find(s => /\b(not|never|less|rather than)\b/i.test(s)) || '' };
}

function notesFingerprint(goals, topicContent) {
  // Select the content fields explicitly so property ordering and unrelated
  // database metadata do not change the key. Goal order is part of the content.
  return createHash('sha256').update(JSON.stringify({
    schema: NOTE_SCHEMA_VERSION,
    source: String(topicContent || ''),
    goals: goals.map(goal => ({ title: String(goal.title || ''),
      description: String(goal.description || ''), order: goal.order ?? null }))
  })).digest('hex');
}

function completeSavedNotes(notes, goals) {
  const stringList = list => Array.isArray(list) && list.every(value => typeof value === 'string');
  return Array.isArray(notes) && notes.length === goals.length && notes.every((note, index) =>
    note && typeof note === 'object' && note.goal === goals[index].title &&
    typeof note.definition === 'string' && note.definition.trim().length > 0 &&
    typeof note.mechanism === 'string' && typeof note.common_mistake === 'string' &&
    stringList(note.exam_points) && note.exam_points.length > 0 &&
    note.exam_points.every(point => point.trim().length > 0) &&
    note.exam_points.includes(note.definition) &&
    stringList(note.exam_keywords) && stringList(note.formulas) &&
    note.model_answer === note.exam_points.join('; '));
}

function prepareAcademicGoals(goals, topicContent, savedNotes, savedFingerprint) {
  const fingerprint = notesFingerprint(goals, topicContent);
  const notes = savedFingerprint === fingerprint && completeSavedNotes(savedNotes, goals)
    ? savedNotes : goals.map(goal => buildAcademicNotes(goal, topicContent));
  return { notes, fingerprint, goals: goals.map((goal, index) => ({ ...goal,
    description: notes[index]?.model_answer || goal.description || '' })) };
}

module.exports = { buildAcademicNotes, prepareAcademicGoals };
