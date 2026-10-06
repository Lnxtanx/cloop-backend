const test = require('node:test');
const assert = require('node:assert/strict');

// Exercise status propagation without running a real content pipeline.
// All database writes, model calls, and notifications are isolated stubs.
const prisma = {};
const statusUpdates = [];
const savedGoals = [];
let goalResponse = { goals: [] };
let goalCalls = 0;

function stubModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
stubModule('../lib/prisma', prisma);
stubModule('./ai/curriculum', {
  generateTopicGoals: async () => {
    goalCalls++;
    if (goalResponse instanceof Error) throw goalResponse;
    return goalResponse;
  }
});
stubModule('./notifications', { notifyContentGenerationStatus: async () => {} });

const personal = require('./content-pipeline');
const global = require('./global-curriculum-pipeline');
const silent = { log: () => {}, error: () => {} };
const topic = { id: 3, user_id: 7, title: 'Speed', content: 'Source curriculum' };
const chapter = { id: 2, title: 'Motion' };

test.beforeEach(() => {
  statusUpdates.length = 0;
  savedGoals.length = 0;
  goalCalls = 0;
  goalResponse = { goals: [] };
  for (const key of Object.keys(prisma)) delete prisma[key];
  const status = { status: 'failed', chapters_generated: true, topics_generated: true, goals_generated: false };
  const upsertStatus = async args => { statusUpdates.push(args.update); return args.update; };
  const createGoal = async args => { savedGoals.push(args.data); return args.data; };
  Object.assign(prisma, {
    users: { findUnique: async () => ({ user_id: 7, board: 'CBSE', grade_level: 'VI' }) },
    subjects: { findUnique: async () => ({ id: 8, name: 'Science' }) },
    content_generation_status: { findUnique: async () => status, upsert: upsertStatus },
    chapters: { findMany: async () => [chapter] },
    topics: { count: async () => 1, findMany: async () => [topic] },
    topic_goals: { count: async () => 0, create: createGoal },
    global_subjects: {
      findUnique: async () => ({ id: 8, chapters: [chapter] }),
      upsert: async () => ({ id: 8 })
    },
    global_curriculum_status: { findUnique: async () => status, upsert: upsertStatus },
    global_chapters: { findMany: async () => [chapter] },
    global_topics: { count: async () => 1, findMany: async () => [topic] },
    global_topic_goals: { count: async () => 0, create: createGoal }
  });
});

test('personal topic goals reject exhausted empty responses before any write', async () => {
  await assert.rejects(personal.generateGoalsForTopic(topic, silent), /no complete supported goal set/);
  assert.equal(goalCalls, 4);
  assert.equal(savedGoals.length, 0);
});

test('personal pipeline marks empty goal generation failed without completed flags', async () => {
  await assert.rejects(personal.runContentGenerationPipeline(7, 8), /no complete supported goal set/);
  assert.ok(statusUpdates.some(update => update.status === 'failed' && update.goals_generated === false));
  assert.ok(statusUpdates.every(update => update.status !== 'completed' && update.goals_generated !== true));
  assert.equal(savedGoals.length, 0);
});

test('personal pipeline preserves the curriculum failure instead of swallowing it', async () => {
  goalResponse = Object.assign(new Error('Missing authoritative curriculum'), { code: 'INSUFFICIENT_CURRICULUM' });
  await assert.rejects(personal.runContentGenerationPipeline(7, 8), { code: 'INSUFFICIENT_CURRICULUM' });
  assert.ok(statusUpdates.some(update => update.status === 'failed'));
  assert.ok(statusUpdates.every(update => update.status !== 'completed'));
});

test('global failed-goal status resumes despite existing chapters and fails honestly', async () => {
  await assert.rejects(global.ensureGlobalCurriculum('CBSE', 'VI', 'Science'), /no complete supported goal set/);
  assert.equal(goalCalls, 4, 'existing chapters must not conceal an earlier goal failure');
  assert.ok(statusUpdates.some(update => update.status === 'failed' && update.goals_generated === false));
  assert.ok(statusUpdates.every(update => update.status !== 'completed' && update.goals_generated !== true));
  assert.equal(savedGoals.length, 0);
});

test('missing-goal batches report failure when a topic cannot be grounded', async () => {
  const personalResult = await personal.generateMissingGoals();
  const globalResult = await global.generateMissingGlobalGoals();
  for (const result of [personalResult, globalResult]) {
    assert.equal(result.success, false);
    assert.equal(result.failed, 1);
    assert.equal(result.generated, 0);
  }
});

test('two supported goals are stored once without count-padding retries', async () => {
  goalResponse = { goals: [
    { title: 'Speed', description: 'Distance divided by time', order: 1 },
    { title: 'Average speed', description: 'Total distance divided by total time', order: 2 }
  ] };
  const result = await personal.generateGoalsForTopic(topic, silent, { board: 'ICSE', classLevel: 'VI' });
  assert.equal(goalCalls, 1);
  assert.equal(result.length, 2);
  assert.equal(savedGoals.length, 2);
});
