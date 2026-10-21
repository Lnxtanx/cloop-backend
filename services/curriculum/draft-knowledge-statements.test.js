const test = require('node:test');
const assert = require('node:assert/strict');
const { findTopicsToDraft, draftGroup, draftBatch, SYSTEM_PROMPT } = require('./draft-knowledge-statements');
const { planImport } = require('./knowledge-statements');
const { extractJson } = require('../../ai/providers/deepseek/reasoner');

const subject = (id) => ({ board: 'CBSE', grade: '7', name: id === 57 ? 'Science (Hindi medium)' : 'Science' });
const goalRow = (id, title, statement = null) => ({ id, title, description: `Students will ${title.toLowerCase()}.`, knowledge_statement: statement, knowledge_verified: false });

/** Enough of Prisma for the drafter and the importer, over in-memory rows. */
function fakePrisma() {
  const topics = [
    { id: 10, subject_id: 22, chapter_id: 1, order: 1, title: 'Topic 1: Heat and Temperature', content: 'Temperature is measured with a thermometer.' },
    { id: 11, subject_id: 57, chapter_id: 2, order: 1, title: 'Topic 1: Heat and Temperature', content: 'Temperature is measured with a thermometer.' },
    { id: 12, subject_id: 22, chapter_id: 1, order: 2, title: 'Topic 2: Conduction', content: '' },
  ];
  const goals = {
    10: [goalRow(101, 'Goal 1: Define temperature'), goalRow(102, 'Goal 2: Name the instrument that measures temperature')],
    11: [goalRow(111, 'Goal 1: Define temperature'), goalRow(112, 'Goal 2: Name the instrument that measures temperature')],
    12: [goalRow(121, 'Goal 1: Explain conduction', 'Conduction is the transfer of heat through a material without the material moving.')],
  };
  const withRelations = (topic) => ({ ...topic,
    chapter: { title: topic.chapter_id === 1 ? 'Heat' : 'ऊष्मा', subject: subject(topic.subject_id) },
    goals: goals[topic.id] });
  return {
    global_topics: {
      findMany: async ({ where }) => topics
        .filter(t => (!where.id || t.id === where.id) && (!where.subject_id || t.subject_id === where.subject_id) &&
          (!where.chapter_id || t.chapter_id === where.chapter_id) &&
          (!where.title || t.title.toLowerCase().includes(where.title.contains.toLowerCase())) &&
          (!where.goals || goals[t.id].some(g => g.knowledge_statement === null)))
        .map(withRelations),
      findUnique: async ({ where }) => topics.find(t => t.id === where.id),
    },
    global_topic_goals: { findMany: async ({ where }) => goals[where.topic_id] },
  };
}

/** A model stub that answers from a script, recording what it was sent. */
function scriptedModel(replies) {
  const calls = [];
  const invoke = async (system, user) => { calls.push({ system, user: JSON.parse(user) }); return replies.shift(); };
  return { invoke, calls };
}

test('forked copies are drafted once, and goals that already have a statement are left alone', async () => {
  const groups = await findTopicsToDraft(fakePrisma(), {});
  assert.equal(groups.length, 1, 'the conduction topic already has its statement');
  assert.deepEqual(groups[0].copies, [
    { topic_id: 10, subject_id: 22, goal_ids: [101, 102] },
    { topic_id: 11, subject_id: 57, goal_ids: [111, 112] },
  ]);
  assert.equal(groups[0].board, 'CBSE');
  assert.equal(groups[0].grade, '7');
});

test('the model gets the class, chapter, topic content and goals, and is told to leave unsure goals empty', async () => {
  const [group] = await findTopicsToDraft(fakePrisma(), {});
  const model = scriptedModel([JSON.stringify({ goals: [
    { n: 1, knowledge_statement: 'Temperature is a measure of how hot or cold something is.' },
    { n: 2, knowledge_statement: 'A thermometer is an instrument that measures temperature.' }] })]);
  const results = await draftGroup(group, 'Temperature is measured with a thermometer.', { invoke: model.invoke, extractJson });
  assert.equal(model.calls.length, 1);
  const sent = model.calls[0].user;
  assert.equal(sent.class, '7');
  assert.equal(sent.chapter, 'Heat');
  assert.match(sent.topic_content, /thermometer/);
  assert.deepEqual(sent.goals.map(g => g.n), [1, 2]);
  assert.match(SYSTEM_PROMPT, /return an empty string/);
  assert.deepEqual(results.map(r => r.problems), [[], []]);
});

test('an objective-style draft is retried once with its problem, and kept flagged if still wrong', async () => {
  const [group] = await findTopicsToDraft(fakePrisma(), {});
  const model = scriptedModel([
    JSON.stringify({ goals: [
      { n: 1, knowledge_statement: 'Students will define temperature.' },
      { n: 2, knowledge_statement: 'Explain what a thermometer does.' }] }),
    JSON.stringify({ goals: [
      { n: 1, knowledge_statement: 'Temperature is a measure of how hot or cold something is.' },
      { n: 2, knowledge_statement: 'Explain the thermometer.' }] }),
  ]);
  const results = await draftGroup(group, '', { invoke: model.invoke, extractJson });
  assert.equal(model.calls.length, 2);
  assert.deepEqual(model.calls[1].user.goals.map(g => g.n), [1, 2]);
  assert.match(model.calls[1].user.goals[0].problems.join(), /objective/);
  assert.deepEqual(results[0], { statement: 'Temperature is a measure of how hot or cold something is.', problems: [] });
  assert.match(results[1].problems.join(), /objective/);
});

test('an empty or unparseable answer becomes a flagged gap, not an invented statement', async () => {
  const [group] = await findTopicsToDraft(fakePrisma(), {});
  const results = await draftGroup(group, '', { invoke: scriptedModel(['not json']).invoke, extractJson });
  assert.equal(results[0].statement, '');
  assert.match(results[0].problems.join(), /write this one/);
});

test('the review queue lists every copy and cannot be imported until a teacher exports it', async () => {
  const model = scriptedModel([JSON.stringify({ goals: [
    { n: 1, knowledge_statement: 'Temperature is a measure of how hot or cold something is.' },
    { n: 2, knowledge_statement: 'A thermometer is an instrument that measures temperature.' }] })]);
  const queue = await draftBatch(fakePrisma(), { date: '2026-10-21' }, { invoke: model.invoke, extractJson });
  assert.equal(queue.review_queue, true);
  assert.equal(queue.verified, false);
  assert.match(queue.source, /Not checked by a teacher/);
  assert.equal(queue.topics[0].copies.length, 2);
  assert.equal(queue.topics[0].goals[1].goal_title, 'Goal 2: Name the instrument that measures temperature');
  const plan = await planImport(fakePrisma(), queue);
  assert.ok(plan.errors.some(e => /review queue/.test(e)));
});
