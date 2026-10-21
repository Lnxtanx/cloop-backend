/**
 * Draft knowledge statements for goals that have none, for teacher review.
 *
 * Drafts are never written to the database. They go to a review-queue file
 * ("review_queue": true) that a teacher opens in the review page; the importer
 * refuses the queue itself and accepts only the file the page exports.
 *
 * The same topic is often forked into several subjects. Copies with the same
 * board, grade, title and goal titles are drafted once and listed as copies,
 * so a teacher reviews each statement once and every copy receives it.
 */

const { normalizeTitle, validateStatement, MAX_SENTENCES } = require('./knowledge-statements');

const TOPIC_CONTENT_CHARS = 6000;

const SYSTEM_PROMPT = `You write knowledge statements for a school tutoring app. A knowledge statement is the full-mark answer to one learning goal: what a student must be able to say in the exam.

Rules:
- 1 to ${MAX_SENTENCES} short sentences per goal. Each sentence is one point an examiner would award a mark for.
- State facts. Never write an objective ("Students will..."), a lesson summary ("This topic covers...") or an instruction ("Explain...", "Identify...").
- No examples inside the statement.
- Match the goal as written, at the stated class level. Use the textbook's own words where you know them.
- Use only what the board textbook for this class teaches. Do not add material from higher classes.
- Preferred shapes: "X includes A, B and C." for lists; "X is ..." for a definition; "An A is ...; a B is ..." for two definitions.
- If you are not sure what the textbook teaches for a goal, return an empty string for that goal. A teacher will write it.

Return JSON only, in this shape: {"goals":[{"n":1,"knowledge_statement":"..."}]}`;

/** Group goal-less topics into drafting units, without loading topic content yet. */
async function findTopicsToDraft(prisma, { subjectId, chapterId, topicId, limit = 20 } = {}) {
  const topics = await prisma.global_topics.findMany({
    where: {
      ...(topicId ? { id: topicId } : {}),
      ...(chapterId ? { chapter_id: chapterId } : {}),
      ...(subjectId ? { subject_id: subjectId } : {}),
      goals: { some: { knowledge_statement: null } },
    },
    select: {
      id: true, title: true, subject_id: true, chapter_id: true,
      chapter: { select: { title: true, subject: { select: { board: true, grade: true, name: true } } } },
      goals: { select: { id: true, title: true, description: true, knowledge_statement: true }, orderBy: [{ order: 'asc' }, { id: 'asc' }] },
    },
    orderBy: [{ subject_id: 'asc' }, { chapter_id: 'asc' }, { order: 'asc' }, { id: 'asc' }],
  });

  const groups = new Map();
  for (const topic of topics) {
    const subject = topic.chapter?.subject || {};
    const key = [subject.board, subject.grade, normalizeTitle(topic.title),
      ...topic.goals.map(goal => normalizeTitle(goal.title))].join('|').toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, {
        representative_topic_id: topic.id, topic_title: topic.title,
        board: subject.board || '', grade: subject.grade || '', subject: subject.name || '',
        chapter_title: topic.chapter?.title || '',
        goals: topic.goals.map(goal => ({ title: goal.title, description: goal.description || '' })),
        copies: [],
      });
    }
    groups.get(key).copies.push({ topic_id: topic.id, subject_id: topic.subject_id,
      goal_ids: topic.goals.map(goal => goal.id), missing: topic.goals.map(goal => !goal.knowledge_statement) });
  }

  // A goal that already has a statement in any copy keeps it; only goals missing
  // everywhere are drafted, so a draft never competes with existing work.
  const drafting = [];
  for (const group of groups.values()) {
    const keep = group.goals.map((_, i) => group.copies.every(copy => copy.missing[i]));
    if (!keep.some(Boolean)) continue;
    drafting.push({ ...group,
      goals: group.goals.filter((_, i) => keep[i]),
      copies: group.copies.map(({ topic_id, subject_id, goal_ids }) => ({ topic_id, subject_id,
        goal_ids: goal_ids.filter((_, i) => keep[i]) })) });
  }
  return drafting.slice(0, limit);
}

function topicBrief(group, content) {
  return {
    board: group.board, class: group.grade, subject: group.subject,
    chapter: group.chapter_title, topic: group.topic_title,
    topic_content: String(content || '').slice(0, TOPIC_CONTENT_CHARS),
  };
}

function parseDrafts(text, extractJson) {
  const parsed = extractJson(text);
  const list = Array.isArray(parsed?.goals) ? parsed.goals : [];
  return new Map(list.filter(item => Number.isInteger(item?.n))
    .map(item => [item.n, String(item.knowledge_statement || '').trim()]));
}

/**
 * Draft every goal of one group. invoke(systemPrompt, userMessage) returns the
 * model's text. Goals whose draft fails validation are retried once, with the
 * problems named; anything still failing is kept with its problems listed, so
 * the teacher sees it and rewrites it.
 */
async function draftGroup(group, content, { invoke, extractJson }) {
  const brief = topicBrief(group, content);
  const goals = group.goals.map((goal, i) => ({ n: i + 1, title: goal.title, description: goal.description }));
  const drafts = parseDrafts(await invoke(SYSTEM_PROMPT, JSON.stringify({ ...brief, goals })), extractJson);

  const problemsOf = n => validateStatement(drafts.get(n) || '');
  const failing = goals.filter(goal => drafts.get(goal.n) && problemsOf(goal.n).length);
  if (failing.length) {
    const retry = parseDrafts(await invoke(SYSTEM_PROMPT, JSON.stringify({ ...brief,
      goals: failing.map(goal => ({ ...goal, refused_draft: drafts.get(goal.n), problems: problemsOf(goal.n) })),
      instruction: 'These drafts were refused for the problems listed. Rewrite only these goals.' })), extractJson);
    for (const goal of failing) if (retry.get(goal.n)) drafts.set(goal.n, retry.get(goal.n));
  }

  return goals.map(goal => {
    const statement = drafts.get(goal.n) || '';
    return { statement, problems: statement ? problemsOf(goal.n) : ['no draft: the model was not sure what the textbook teaches; write this one'] };
  });
}

/** The review-queue file for drafted groups. */
function buildReviewQueue(drafted, { date = new Date().toISOString().slice(0, 10) } = {}) {
  return {
    review_queue: true,
    source: `DeepSeek draft, ${date}. Not checked by a teacher.`,
    verified: false,
    generated_at: date,
    topics: drafted.map(({ group, results }) => ({
      topic_title: group.topic_title, board: group.board, grade: group.grade,
      subject: group.subject, chapter_title: group.chapter_title,
      copies: group.copies,
      goals: group.goals.map((goal, i) => ({
        goal_title: goal.title, goal_description: goal.description,
        knowledge_statement: results[i].statement, draft_problems: results[i].problems,
      })),
    })),
  };
}

/** Find, draft and package one batch. Never writes to the database. */
async function draftBatch(prisma, options, { invoke, extractJson, log = () => {} }) {
  const groups = await findTopicsToDraft(prisma, options);
  const drafted = [];
  for (const group of groups) {
    const topic = await prisma.global_topics.findUnique({ where: { id: group.representative_topic_id }, select: { content: true } });
    log(`Drafting "${group.topic_title}" (${group.goals.length} goals, ${group.copies.length} cop${group.copies.length === 1 ? 'y' : 'ies'})`);
    drafted.push({ group, results: await draftGroup(group, topic?.content, { invoke, extractJson }) });
  }
  return buildReviewQueue(drafted, options);
}

module.exports = { SYSTEM_PROMPT, findTopicsToDraft, draftGroup, buildReviewQueue, draftBatch };
