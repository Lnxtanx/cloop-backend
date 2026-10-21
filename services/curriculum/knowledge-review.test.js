const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { checkStatement, reviewItems, buildVerifiedImport } = require('./knowledge-review');
const { validateStatement, planImport } = require('./knowledge-statements');

const pilot = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/knowledge-statements/scientific-inquiry.json'), 'utf8'));
const teacher = { teacher: 'R. Iyer', reference: 'NCERT Curiosity, Class 7, Chapter 1', date: '2026-10-21' };

test('the review page check agrees with the importer on every kind of statement', () => {
  const corpus = [
    'An inference is a conclusion based on observations.',
    'Scientific inquiry includes observing, asking a question, guessing a possible answer, testing the guess and analysing the results.',
    'An observation is information gathered directly through the senses; an inference is a conclusion based on observations.',
    'Students will explain inferences.',
    'This topic introduces scientific inquiry.',
    'Students learn about heat.',
    'Explain the role of curiosity.',
    'For example, a wet road.',
    'Summary.',
    'A is B. C is D. E is F. G is H.',
    'A thermometer measures temperature.\nExamples: clinical thermometer.',
    '<b>Heat</b> flows from hot to cold.',
    '',
    'x'.repeat(601),
  ];
  for (const statement of corpus) assert.deepEqual(checkStatement(statement), validateStatement(statement), statement);
});

test('a review queue exports one verified entry per forked copy, pinned by id', async () => {
  const queue = { review_queue: true, source: 'DeepSeek draft', verified: false, topics: [{
    topic_title: 'Topic 1: Introduction to Scientific Inquiry', board: 'CBSE', grade: '7',
    copies: [{ topic_id: 10, subject_id: 22, goal_ids: [101, 102, 103] }, { topic_id: 11, subject_id: 57, goal_ids: [111, 112, 113] }],
    goals: pilot().topics[0].goals.map(goal => ({ goal_title: goal.goal_title_includes[0], knowledge_statement: goal.knowledge_statement, draft_problems: [] })),
  }] };
  const items = reviewItems(queue);
  assert.equal(items.length, 3);
  assert.equal(items[0].copies, 2);
  const decisions = {
    '0:0': { status: 'approved', statement: items[0].draft },
    '0:1': { status: 'skipped' },
    '0:2': { status: 'approved', statement: 'An observation is what we notice with our senses; an inference is a conclusion drawn from observations.' },
  };
  const { spec, errors, approved } = buildVerifiedImport(queue, decisions, teacher);
  assert.deepEqual(errors, []);
  assert.equal(approved, 2);
  assert.equal(spec.verified, true);
  assert.equal(spec.review_queue, undefined);
  assert.equal(spec.source, 'Teacher-checked by R. Iyer against NCERT Curiosity, Class 7, Chapter 1, 2026-10-21');
  assert.deepEqual(spec.topics.map(t => [t.topic_id, t.goals.map(g => g.goal_id)]), [[10, [101, 103]], [11, [111, 113]]]);
  assert.match(spec.topics[0].goals[1].knowledge_statement, /what we notice/);
});

test('the pilot import file exports with its own matching and the teacher\'s edits', async () => {
  const file = pilot();
  const decisions = Object.fromEntries(reviewItems(file).map(item => [item.key, { status: 'approved', statement: item.draft }]));
  decisions['0:1'].statement = 'Curiosity leads to questions that start a scientific investigation.';
  const { spec, errors } = buildVerifiedImport(file, decisions, teacher);
  assert.deepEqual(errors, []);
  assert.deepEqual(spec.topics[0].goals.map(g => g.goal_title_includes), [['component'], ['curiosity'], ['inference']]);
  assert.equal(spec.topics[0].goals[1].knowledge_statement, 'Curiosity leads to questions that start a scientific investigation.');

  // The exported file goes straight into the importer, marked verified.
  const catalog = { topics: [{ id: 10, subject_id: 22, title: 'Topic 1: Introduction to Scientific Inquiry' }],
    goals: [
      { id: 101, topic_id: 10, title: 'Goal 1: Identify the core components of scientific inquiry' },
      { id: 102, topic_id: 10, title: 'Goal 2: Explain the role of curiosity and questioning' },
      { id: 103, topic_id: 10, title: 'Goal 3: Differentiate between observations and inferences' }] };
  const prisma = {
    global_topics: { findMany: async ({ where }) => catalog.topics.filter(t => t.title.toLowerCase().includes(where.title.contains.toLowerCase())) },
    global_topic_goals: { findMany: async () => catalog.goals },
  };
  const plan = await planImport(prisma, spec);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.verified, true);
  assert.equal(plan.changes.length, 3);
});

test('nothing exports without a named teacher, a textbook, and valid approved statements', () => {
  const file = pilot();
  assert.match(buildVerifiedImport(file, {}, teacher).errors.join(), /Approve at least one/);
  const anonymous = buildVerifiedImport(file, { '0:0': { status: 'approved', statement: 'A is B.' } }, {}).errors.join();
  assert.match(anonymous, /teacher's name/);
  assert.match(anonymous, /textbook/);
  const bad = buildVerifiedImport(file, { '0:0': { status: 'approved', statement: 'Students will name the steps.' } }, teacher);
  assert.equal(bad.spec, null);
  assert.match(bad.errors.join(), /objective/);
  assert.match(buildVerifiedImport(file, { '0:0': { status: 'approved', statement: 'A is B.' } },
    { teacher: 'x'.repeat(150), reference: 'y'.repeat(80) }).errors.join(), /Shorten/);
});
