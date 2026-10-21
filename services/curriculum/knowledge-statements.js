/**
 * Curated knowledge statements for learning goals.
 *
 * global_topic_goals.description holds a learning objective ("Students will
 * explain..."). A knowledge statement is the goal's full-mark answer: 1-3
 * short factual sentences the tutor teaches, grades and recaps from. See
 * prisma/sql/20261021_add_goal_knowledge_statement.sql.
 *
 * Import is planned first and written only on request, all or nothing:
 *   - a goal must be matched exactly once, or nothing is written;
 *   - every sentence must pass the validator's own fact filter, so an
 *     objective or a lesson summary is refused here rather than ignored later;
 *   - a teacher-verified statement is never overwritten without --force.
 */

const { factualSourceParts } = require('../tutor-core/validate');

const MAX_SENTENCES = 3;
const MAX_CHARS = 600;
const MAX_SOURCE_CHARS = 200; // knowledge_source is VARCHAR(200)
// Catalog titles carry their position in the text: "Topic 1: ...", "Goal 2: ...".
const ORDINAL_PREFIX = /^(?:topic|goal|chapter|unit|lesson)\s*\d+\s*[:.\-–]\s*/i;

function normalizeTitle(title) {
  return String(title || '').replace(ORDINAL_PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The same sentence split the validator uses, so counts agree with what it grades. */
function sentencesOf(text) {
  return String(text || '').split(/;|\n+|(?<=[.!?])\s+(?=[A-Z])/).map(s => s.trim()).filter(Boolean);
}

/** Problems with a statement, or [] when the tutor can use every sentence of it. */
function validateStatement(text) {
  const statement = String(text || '').trim();
  if (!statement) return ['the statement is empty'];
  const problems = [];
  if (statement.length > MAX_CHARS) problems.push(`it is longer than ${MAX_CHARS} characters`);
  const parts = sentencesOf(statement);
  if (parts.length > MAX_SENTENCES) problems.push(`it has ${parts.length} sentences; keep it to ${MAX_SENTENCES}`);
  for (const part of parts) {
    if (!factualSourceParts(part).length) {
      problems.push(`"${part}" reads like an objective or a lesson summary, not a fact`);
    }
  }
  return problems;
}

/**
 * Work out exactly what an import would change, without writing anything.
 *
 * spec = {
 *   source: "where these statements come from",      // required, <= 200 chars
 *   verified: false,                                  // true only after teacher review
 *   topics: [{
 *     topic_title: "Introduction to Scientific Inquiry",  // matched without "Topic N:" prefixes
 *     subject_id: 22,                                  // optional: limit to one subject's copy
 *     topic_id: 10,                                    // optional: limit to exactly one topic
 *     goals: [
 *       { goal_title_includes: ["component"], knowledge_statement: "..." },
 *       { goal_id: 1234, knowledge_statement: "..." },
 *     ],
 *   }],
 * }
 */
async function planImport(prisma, spec = {}, { force = false } = {}) {
  const errors = [];
  const changes = [];
  const source = String(spec.source || '').trim();
  const verified = spec.verified === true;
  if (!source) errors.push('"source" is required: say where these statements come from');
  if (source.length > MAX_SOURCE_CHARS) errors.push(`"source" must be at most ${MAX_SOURCE_CHARS} characters`);
  if (!Array.isArray(spec.topics) || !spec.topics.length) errors.push('"topics" must list at least one topic');
  if (spec.review_queue === true) {
    errors.push('this is a review queue of unchecked drafts; a teacher opens it in the review page, and you import the file that page exports');
  }

  const claimed = new Map(); // goal id -> where it was matched, so no goal is written twice
  for (const [t, entry] of (spec.topics || []).entries()) {
    const wanted = normalizeTitle(entry.topic_title);
    const label = `topics[${t}] "${entry.topic_title}"`;
    if (!wanted) { errors.push(`${label}: topic_title is required`); continue; }

    const candidates = await prisma.global_topics.findMany({
      where: { title: { contains: String(entry.topic_title).trim(), mode: 'insensitive' },
        ...(entry.topic_id ? { id: entry.topic_id } : {}),
        ...(entry.subject_id ? { subject_id: entry.subject_id } : {}) },
      select: { id: true, title: true, subject_id: true, chapter_id: true },
      orderBy: { id: 'asc' },
    });
    const topics = candidates.filter(topic => normalizeTitle(topic.title) === wanted);
    if (!topics.length) { errors.push(`${label}: no topic has this title`); continue; }

    for (const topic of topics) {
      const goals = await prisma.global_topic_goals.findMany({
        where: { topic_id: topic.id },
        select: { id: true, title: true, order: true, knowledge_statement: true, knowledge_verified: true },
        orderBy: { order: 'asc' },
      });
      for (const [g, item] of (entry.goals || []).entries()) {
        const where = `${label} (topic ${topic.id}, subject ${topic.subject_id}) goals[${g}]`;
        let matches;
        if (item.goal_id) {
          matches = goals.filter(goal => goal.id === item.goal_id);
        } else {
          const words = (item.goal_title_includes || []).map(w => String(w).toLowerCase().trim()).filter(Boolean);
          if (!words.length) { errors.push(`${where}: give goal_id or goal_title_includes`); continue; }
          matches = goals.filter(goal => words.every(w => normalizeTitle(goal.title).includes(w)));
        }
        if (matches.length !== 1) {
          errors.push(`${where}: matched ${matches.length} goals${matches.length ? ` (${matches.map(m => `${m.id} "${m.title}"`).join(', ')})` : ''}; it must match exactly one`);
          continue;
        }
        const goal = matches[0];
        if (claimed.has(goal.id)) {
          errors.push(`${where}: goal ${goal.id} is already matched by ${claimed.get(goal.id)}`);
          continue;
        }
        claimed.set(goal.id, where);

        const statement = String(item.knowledge_statement || '').trim();
        for (const problem of validateStatement(statement)) errors.push(`${where}: ${problem}`);
        if (goal.knowledge_verified && goal.knowledge_statement !== statement && !force) {
          errors.push(`${where}: goal ${goal.id} has a teacher-verified statement; re-run with --force only after review`);
        }
        changes.push({
          topic_id: topic.id, topic_title: topic.title, subject_id: topic.subject_id,
          goal_id: goal.id, goal_title: goal.title,
          before: goal.knowledge_statement || null, after: statement,
          // Re-importing the same words unverified must not undo a teacher's sign-off.
          unchanged: goal.knowledge_statement === statement && (Boolean(goal.knowledge_verified) || !verified),
        });
      }
    }
  }
  return { errors, changes, source, verified };
}

/** Write a plan with no errors, in one transaction. Returns the number of goals written. */
async function applyImport(prisma, plan) {
  if (plan.errors.length) throw new Error(`Refusing to write: ${plan.errors.length} problem(s) in the plan`);
  const writes = plan.changes.filter(change => !change.unchanged).map(change => prisma.global_topic_goals.update({
    where: { id: change.goal_id },
    data: { knowledge_statement: change.after, knowledge_source: plan.source,
      knowledge_verified: plan.verified, knowledge_updated_at: new Date() },
  }));
  if (writes.length) await prisma.$transaction(writes);
  return writes.length;
}

module.exports = { normalizeTitle, validateStatement, planImport, applyImport, MAX_SENTENCES, MAX_CHARS };
