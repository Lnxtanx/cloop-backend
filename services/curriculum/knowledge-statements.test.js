const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTitle, validateStatement, planImport, applyImport } = require('./knowledge-statements');

/** Just enough of Prisma for the importer, over in-memory rows. */
function fakePrisma({ topics, goals }) {
  const writes = [];
  return {
    writes,
    global_topics: {
      findMany: async ({ where }) => topics.filter(t =>
        t.title.toLowerCase().includes(where.title.contains.toLowerCase()) &&
        (!where.id || t.id === where.id) &&
        (!where.subject_id || t.subject_id === where.subject_id)),
    },
    global_topic_goals: {
      findMany: async ({ where }) => goals.filter(g => g.topic_id === where.topic_id),
      update: ({ where, data }) => ({ where, data }),
    },
    $transaction: async (ops) => { writes.push(...ops); return ops; },
  };
}

// The catalog's real shape: ordinal prefixes in titles, the same topic forked
// into two subjects, objective-only descriptions, and a similarly named topic.
const catalog = () => ({
  topics: [
    { id: 10, subject_id: 22, chapter_id: 1, title: 'Topic 1: Introduction to Scientific Inquiry' },
    { id: 11, subject_id: 57, chapter_id: 2, title: 'Topic 1: Introduction to Scientific Inquiry' },
    { id: 12, subject_id: 22, chapter_id: 1, title: 'Topic 2: Scientific Inquiry in Daily Life' },
  ],
  goals: [10, 11].flatMap(topic_id => [
    { id: topic_id * 10 + 1, topic_id, order: 1, title: 'Goal 1: Identify the core components of scientific inquiry', knowledge_statement: null, knowledge_verified: false },
    { id: topic_id * 10 + 2, topic_id, order: 2, title: 'Goal 2: Explain the role of curiosity and questioning', knowledge_statement: null, knowledge_verified: false },
    { id: topic_id * 10 + 3, topic_id, order: 3, title: 'Goal 3: Differentiate between observations and inferences', knowledge_statement: null, knowledge_verified: false },
  ]),
});
const pilot = () => JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../../data/knowledge-statements/scientific-inquiry.json'), 'utf8'));

test('titles match without the catalog\'s ordinal prefixes', () => {
  assert.equal(normalizeTitle('Topic 1: Introduction to Scientific Inquiry'), 'introduction to scientific inquiry');
  assert.equal(normalizeTitle('Goal 3:  Differentiate  between observations'), 'differentiate between observations');
});

test('objectives and lesson summaries are refused; facts are accepted', () => {
  assert.deepEqual(validateStatement('An inference is a conclusion based on observations.'), []);
  assert.match(validateStatement('Students will explain inferences.').join(), /objective or a lesson summary/);
  assert.match(validateStatement('This topic introduces scientific inquiry.').join(), /objective or a lesson summary/);
  assert.match(validateStatement('A is B. C is D. E is F. G is H.').join(), /4 sentences/);
  assert.match(validateStatement('').join(), /empty/);
});

test('the pilot file itself passes validation', () => {
  for (const goal of pilot().topics[0].goals) assert.deepEqual(validateStatement(goal.knowledge_statement), [], goal.knowledge_statement);
});

test('the pilot matches every forked copy of the topic, three goals each, and nothing else', async () => {
  const plan = await planImport(fakePrisma(catalog()), pilot());
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.changes.map(c => c.goal_id).sort(), [101, 102, 103, 111, 112, 113]);
  assert.ok(!plan.changes.some(c => c.topic_id === 12), 'a similarly named topic is not touched');
  assert.equal(plan.verified, false);
});

test('subject_id limits the import to one copy', async () => {
  const spec = pilot(); spec.topics[0].subject_id = 57;
  const plan = await planImport(fakePrisma(catalog()), spec);
  assert.deepEqual(plan.changes.map(c => c.topic_id), [11, 11, 11]);
});

test('an ambiguous or missing goal match stops the whole import', async () => {
  const spec = pilot();
  spec.topics[0].goals[1].goal_title_includes = ['e']; // matches every goal in the topic
  const plan = await planImport(fakePrisma(catalog()), spec);
  assert.ok(plan.errors.some(e => /matched 3 goals/.test(e)));
  await assert.rejects(applyImport(fakePrisma(catalog()), plan), /Refusing to write/);
});

test('a goal cannot be claimed by two entries', async () => {
  const spec = pilot(); spec.topics[0].goals[2].goal_title_includes = ['component'];
  const plan = await planImport(fakePrisma(catalog()), spec);
  assert.ok(plan.errors.some(e => /already matched/.test(e)));
});

test('a teacher-verified statement is protected unless --force', async () => {
  const data = catalog();
  Object.assign(data.goals[0], { knowledge_statement: 'Scientific inquiry includes observation.', knowledge_verified: true });
  assert.ok((await planImport(fakePrisma(data), pilot())).errors.some(e => /teacher-verified/.test(e)));
  assert.deepEqual((await planImport(fakePrisma(data), pilot(), { force: true })).errors, []);
});

test('apply writes only real changes, with provenance, in one transaction', async () => {
  const data = catalog();
  Object.assign(data.goals[0], { knowledge_statement: pilot().topics[0].goals[0].knowledge_statement, knowledge_verified: false });
  const prisma = fakePrisma(data);
  const plan = await planImport(prisma, pilot());
  assert.equal(await applyImport(prisma, plan), 5, 'the already-correct goal is skipped');
  for (const op of prisma.writes) {
    assert.equal(op.data.knowledge_source, plan.source);
    assert.equal(op.data.knowledge_verified, false);
    assert.ok(op.data.knowledge_updated_at instanceof Date);
  }
});

test('a missing source is refused', async () => {
  const spec = pilot(); delete spec.source;
  assert.ok((await planImport(fakePrisma(catalog()), spec)).errors.some(e => /source/.test(e)));
});

test('topic_id limits the import to that exact topic', async () => {
  const spec = pilot(); spec.topics[0].topic_id = 11;
  const plan = await planImport(fakePrisma(catalog()), spec);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.changes.map(c => c.goal_id), [111, 112, 113]);
});

test('a review queue of unchecked drafts cannot be imported', async () => {
  const spec = pilot(); spec.review_queue = true;
  const plan = await planImport(fakePrisma(catalog()), spec);
  assert.ok(plan.errors.some(e => /review queue/.test(e)));
});

test('re-importing the same statement unverified keeps the teacher\'s sign-off', async () => {
  const data = catalog();
  Object.assign(data.goals[0], { knowledge_statement: pilot().topics[0].goals[0].knowledge_statement, knowledge_verified: true });
  const plan = await planImport(fakePrisma(data), pilot());
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.changes.find(c => c.goal_id === 101).unchanged, true);
});

test('the signed-off pilot file marks goals 1 and 2 verified and leaves goal 3 alone', async () => {
  const signed = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../../data/knowledge-statements/scientific-inquiry.verified.json'), 'utf8'));
  const plan = await planImport(fakePrisma(catalog()), signed);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.verified, true);
  assert.deepEqual(plan.changes.map(c => c.goal_id).sort(), [101, 102, 111, 112]);
  // The signed-off words are the pilot's words, so the two files never disagree.
  const drafts = new Map(pilot().topics[0].goals.map(g => [g.goal_title_includes[0], g.knowledge_statement]));
  for (const goal of signed.topics[0].goals) assert.equal(goal.knowledge_statement, drafts.get(goal.goal_title_includes[0]));
});
