const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the provider before loading either entry point: these checks never
// need credentials, a database, or a live model.
const clientPath = require.resolve('../ai/deepseek-client');
let response;
const calls = [];
require.cache[clientPath] = {
  id: clientPath, filename: clientPath, loaded: true,
  exports: {
    invokeModel: async (...args) => {
      calls.push(args);
      if (response instanceof Error) throw response;
      return JSON.stringify(response);
    },
    extractJson: text => JSON.parse(text)
  }
};
const { generateTopicGoals, generateTopicGreeting } = require('./topic-chat-helpers');
const { wordCount } = require('../tutor-core/validate');

const SPEED_CONTENT = 'Speed is distance travelled divided by time taken; v = d/t, SI unit m/s. Average speed is total distance divided by total time for the whole journey.';
const SPEED_GOALS = [
  { title: 'Speed', description: 'Speed is distance travelled divided by time taken; v = d/t, SI unit m/s', order: 1 },
  { title: 'Average speed', description: 'Average speed is total distance divided by total time for the whole journey', order: 2 }
];
const FORCE_TITLE = 'What Can a Force Do to the Bodies on Which It Is Applied?';
const FORCE_CONTENT = 'A force can start motion in a stationary object or stop a moving object. A force can change speed, direction, or shape. Stretching and bending change shape.';

test.beforeEach(() => { calls.length = 0; response = { goals: SPEED_GOALS }; });

test('narrow topics keep two goals and model fields cannot enter Prisma', async () => {
  response = { goals: SPEED_GOALS.map(g => ({ ...g, id: 99, score: 100, arbitrary: true })) };
  assert.deepEqual(await generateTopicGoals('Speed and Average Speed', SPEED_CONTENT), { goals: SPEED_GOALS });
  assert.equal(calls[0][2].temperature, 0.1);
  assert.equal(calls[0][2].jsonFormat, true);
});

test('the full supplied syllabus, including late facts, reaches the prompt', async () => {
  const content = `${SPEED_CONTENT}\n${'Journey examples. '.repeat(160)}\nLAST_SYLLABUS_FACT: distinguish total time from moving time.`;
  await generateTopicGoals('Speed and Average Speed', content, { board: 'ICSE', classLevel: 'VI', userId: 18 });
  assert.ok(calls[0][1][0].content.includes(content));
  assert.match(calls[0][0], /Board: ICSE\r?\nClass: VI/);
  assert.match(calls[0][0], /does not license adding a guessed CBSE\/ICSE syllabus/);
  assert.equal(calls[0][2].userId, 18);
});

test('missing or oversized curriculum fails before a model call', async () => {
  await assert.rejects(generateTopicGoals('Forces', ''), { code: 'INSUFFICIENT_CURRICULUM' });
  await assert.rejects(generateTopicGoals('Forces', ' '.repeat(32001)), { code: 'INSUFFICIENT_CURRICULUM' });
  await assert.rejects(generateTopicGoals('Forces', SPEED_CONTENT.repeat(300)), { code: 'CURRICULUM_TOO_LONG' });
  assert.equal(calls.length, 0);
});

test('duplicate concepts fail instead of creating vague fallback goals', async () => {
  response = { goals: [SPEED_GOALS[0], { ...SPEED_GOALS[0], order: 2 }] };
  await assert.rejects(generateTopicGoals('Speed and Average Speed', SPEED_CONTENT), { code: 'INVALID_TOPIC_GOALS' });
});

test('duplicate or non-contiguous order values are rejected', async () => {
  response = { goals: SPEED_GOALS.map(g => ({ ...g, order: 1 })) };
  await assert.rejects(generateTopicGoals('Speed and Average Speed', SPEED_CONTENT), { code: 'INVALID_TOPIC_GOALS' });
  response = { goals: SPEED_GOALS.map(g => ({ ...g, order: g.order + 1 })) };
  await assert.rejects(generateTopicGoals('Speed and Average Speed', SPEED_CONTENT), { code: 'INVALID_TOPIC_GOALS' });
});

test('valid numbered goals are sorted without changing their content', async () => {
  response = { goals: [...SPEED_GOALS].reverse() };
  assert.deepEqual(await generateTopicGoals('Speed and Average Speed', SPEED_CONTENT), { goals: SPEED_GOALS });
});

test('the transcript force topic falls back to four distinct concrete effects', async () => {
  response = { goals: [
    { title: 'Identify effects of force', description: 'Force changes speed, direction, and shape', order: 1 },
    { title: 'Classify force effects', description: 'Classify how force changes speed, shape, and direction', order: 2 }
  ] };
  const result = await generateTopicGoals(FORCE_TITLE, FORCE_CONTENT, { grade_level: 'VI', board: 'CBSE' });
  assert.deepEqual(result.goals.map(g => g.title), ['Starting and stopping motion', 'Changing speed', 'Changing direction', 'Changing shape']);
  assert.equal(result.goals.length, 4);
  assert.ok(result.goals.every(g => !/acceleration|contact|newton/i.test(g.description)));
});

test('stretching is not counted as a fifth force effect', async () => {
  response = new Error('provider timed out');
  const result = await generateTopicGoals(FORCE_TITLE, FORCE_CONTENT);
  assert.equal(result.goals.filter(g => /shape/i.test(g.title)).length, 1);
  assert.equal(result.goals.filter(g => /stretch/i.test(g.title)).length, 0);
});

test('a fallback includes only force effects actually present in the source', async () => {
  response = new Error('provider timed out');
  const result = await generateTopicGoals('Effects of force', 'A force can change the speed of a moving object. A force can change the direction of a moving object.');
  assert.deepEqual(result.goals.map(g => g.title), ['Changing speed', 'Changing direction']);
});

test('source definitions form a deterministic fallback on model failure', async () => {
  response = new Error('provider timed out');
  const content = 'Speed: distance travelled divided by time taken; v = d/t; SI unit m/s\nAverage speed: total distance divided by total time over the whole journey';
  const result = await generateTopicGoals('Speed and Average Speed', content);
  assert.equal(result.goals.length, 2);
  assert.equal(result.goals[0].description, content.split('\n')[0]);
  assert.equal(result.goals[1].description, content.split('\n')[1]);
});

test('provider failure without source anchors is explicit, not fictional goals', async () => {
  response = new Error('provider timed out');
  await assert.rejects(generateTopicGoals('Speed and Average Speed', SPEED_CONTENT), { code: 'TOPIC_GOALS_UNAVAILABLE' });
});

test('unsupported acceleration is rejected', async () => {
  response = { goals: [SPEED_GOALS[0], { title: 'Acceleration', description: 'Acceleration is the rate of change of speed over time', order: 2 }] };
  await assert.rejects(generateTopicGoals('Speed and Average Speed', SPEED_CONTENT), { code: 'INVALID_TOPIC_GOALS' });
});

test('greeting uses an unscored, short open probe and validates stray options', async () => {
  response = { messages: [
    { message: "Let's explore forces together.", message_type: 'text' },
    { message: 'What happens when you kick a stationary ball?', options: [{ text: 'It moves', value: 'It moves' }] }
  ], arbitrary: 'discard' };
  const result = await generateTopicGreeting(FORCE_TITLE, FORCE_CONTENT, [], { grade_level: 'VI', board: 'CBSE' });
  assert.equal(result.messages.length, 2);
  assert.ok(result.messages.every(m => wordCount(m.message) < 20 && !m.options));
  assert.match(result.messages.at(-1).message, /\?$/);
  assert.match(calls[0][0], /Do NOT explain the concept/);
  assert.match(calls[0][0], /CBSE Class VI/);
  assert.equal(result.arbitrary, undefined);
});

test('greeting fallback remains relevant for science and never leaks a definition', async () => {
  response = new Error('provider timed out');
  const result = await generateTopicGreeting(FORCE_TITLE, FORCE_CONTENT);
  assert.ok(result.messages.length <= 2);
  assert.ok(result.messages.every(m => wordCount(m.message) < 20));
  assert.match(result.messages.at(-1).message, /\?$/);
  assert.doesNotMatch(result.messages.map(m => m.message).join(' '), /human actions|push or pull|speed|direction|shape/);
});

test('a model-generated definition in the welcome cannot reveal the probe answer', async () => {
  response = { messages: [
    { message: 'Force is a push or pull that changes speed, direction, or shape.' },
    { message: 'What happens when you kick a stationary ball?' }
  ] };
  const result = await generateTopicGreeting(FORCE_TITLE, FORCE_CONTENT);
  assert.equal(result.messages[0].message, "Let's explore this topic together.");
  assert.doesNotMatch(result.messages[0].message, /push or pull|shape/);
});

test('the pre-generation entry point shares the same goals and userId contract', async () => {
  const tavilyPath = require.resolve('../tavily-search');
  require.cache[tavilyPath] = { id: tavilyPath, filename: tavilyPath, loaded: true, exports: {} };
  const curriculum = require('../ai/curriculum');
  const result = await curriculum.generateTopicGoals('Speed and Average Speed', SPEED_CONTENT, 32);
  assert.deepEqual(result, { goals: SPEED_GOALS });
  assert.equal(calls[0][2].userId, 32);
});
