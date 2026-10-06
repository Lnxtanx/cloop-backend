const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the model seam before importing, so tests never load SDKs, credentials or make calls.
const clientPath = require.resolve('../ai/deepseek-client');
const previousClient = require.cache[clientPath];
let invoke = async () => { throw new Error('stub timeout'); };
require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: {
  invokeModel: (...args) => invoke(...args),
  extractJson: text => JSON.parse(text)
} };
const { buildFallbackRevisionSheet, generateRevisionSheet } = require('./revision-generator');
if (previousClient) require.cache[clientPath] = previousClient;
else delete require.cache[clientPath];

const forceGoals = [
  { title: 'Force', description: 'Force is a push or pull; a force acts on an object' },
  { title: 'Starting motion', description: 'A force can make a stationary object move' },
  { title: 'Stopping motion', description: 'A force can stop a moving object' },
  { title: 'Changing speed', description: 'A force can increase or decrease speed' },
  { title: 'Changing direction', description: 'A force can change the direction of motion' },
  { title: 'Changing shape', description: 'A force can change shape by stretching, compressing or bending' }
];
const renderedWords = sheet => [sheet.topic, ...sheet.key_concepts,
  ...sheet.definitions.flatMap(item => [item.term, item.definition]),
  ...sheet.formulas, ...sheet.quick_recall_tips, sheet.practice_next_time].join(' ').split(/\s+/u).length;
const validModelSheet = () => ({
  topic: 'Force', key_concepts: forceGoals.map(goal => goal.title),
  definitions: [{ term: 'Force', definition: 'A push or pull.' }],
  formulas: [], quick_recall_tips: ['Recall each effect.', 'Common mistake to avoid: counting stretching twice.'],
  practice_next_time: 'Explain how kicking a football changes motion.'
});

test('fallback represents all six goals without unrelated facts and keeps UI aliases', () => {
  const sheet = buildFallbackRevisionSheet({ topicTitle: 'Force', goals: forceGoals, keyErrors: [{ type: 'Conceptual', count: 1 }] });
  assert.deepEqual(sheet.key_concepts, forceGoals.map(goal => goal.title));
  assert.equal(sheet.definitions.length, 6);
  assert.deepEqual(sheet.key_points, sheet.key_concepts);
  assert.equal(sheet.common_mistakes.length, 1);
  assert.deepEqual(sheet.formulas, []);
  assert.doesNotMatch(JSON.stringify(sheet), /reactants|products|inputs|outputs/iu);
  assert.ok(renderedWords(sheet) < 200);
});

test('fallback preserves complete formula clauses, symbols and separately listed units', () => {
  const sheet = buildFallbackRevisionSheet({ topicTitle: 'Speed', goals: [
    { title: 'Speed', description: 'Speed = distance travelled / time taken; formula v = d/t; SI unit metre per second (m/s)' },
    { title: 'Average speed', description: 'Average speed = total distance / total time; measured in m/s or km/h' }
  ] });
  assert.match(sheet.formulas[0], /v = d\/t; SI unit metre per second \(m\/s\)/u);
  assert.match(sheet.formulas[1], /total distance \/ total time; measured in m\/s or km\/h/u);
  assert.ok(renderedWords(sheet) < 200);
});

test('fallback shortens by removing complete definitions, never by clipping a scientific fact', () => {
  const longFact = 'A force can change the direction of motion ' + 'in suitable conditions '.repeat(50);
  const sheet = buildFallbackRevisionSheet({ topicTitle: 'Force', goals: [
    ...forceGoals.slice(0, 5), { title: 'Changing shape', description: longFact }
  ] });
  assert.equal(sheet.key_concepts.length, 6);
  assert.ok(renderedWords(sheet) < 200);
  for (const item of sheet.definitions) assert.ok(forceGoals.some(goal => goal.title === item.term && goal.description.startsWith(item.definition)));
});

test('prompt supplies every goal description and honest early-ending evidence', async () => {
  let prompt;
  invoke = async systemPrompt => { prompt = systemPrompt; return JSON.stringify(validModelSheet()); };
  const sheet = await generateRevisionSheet({ topicTitle: 'Force', goals: forceGoals,
    masteryReport: { ended_reason: 'turn_limit', per_goal: [
      { goal: 'Force', asked: 2, band: 'Developing' },
      { goal: 'Changing shape', asked: 0, band: 'Not covered' }
    ] } });
  for (const goal of forceGoals) assert.ok(prompt.includes(goal.description));
  assert.match(prompt, /Ended reason: turn_limit/u);
  assert.match(prompt, /Changing shape: unassessed/u);
  assert.deepEqual(sheet.key_points, sheet.key_concepts);
});

test('model timeout produces complete schema and early-session wording', async () => {
  invoke = async () => { throw new Error('stub timeout'); };
  const sheet = await generateRevisionSheet({ topicTitle: 'Force', goals: forceGoals,
    masteryReport: { ended_reason: 'off_topic' } });
  assert.equal(sheet.topic, 'Force');
  assert.match(sheet.quick_recall_tips[0], /ended early/u);
  assert.deepEqual(Object.keys(sheet).sort(), ['topic', 'key_concepts', 'definitions', 'formulas', 'quick_recall_tips', 'practice_next_time', 'key_points', 'common_mistakes'].sort());
});

test('malformed, malicious, off-topic or incomplete model sheets use the grounded fallback', async () => {
  const malformed = [
    null, {}, { ...validModelSheet(), quick_recall_tips: 'unsafe type' },
    { ...validModelSheet(), definitions: [null] },
    { ...validModelSheet(), key_concepts: ['<script>alert(1)</script>'] },
    { ...validModelSheet(), topic: 'Chemical Reactions' },
    { ...validModelSheet(), formulas: ['F = ma'] },
    { ...validModelSheet(), key_concepts: forceGoals.slice(0, 4).map(goal => goal.title) },
    { ...validModelSheet(), key_concepts: Array(6).fill('Unrelated chemistry') },
    { ...validModelSheet(), practice_next_time: 'Fully mastered all goals.' }
  ];
  for (const output of malformed) {
    invoke = async () => JSON.stringify(output);
    const params = { topicTitle: 'Force', goals: forceGoals, masteryReport: { ended_reason: 'turn_limit' } };
    assert.deepEqual(await generateRevisionSheet(params), buildFallbackRevisionSheet(params));
  }
});

test('source formulas retain units when a valid model omits units from its formula text', async () => {
  const goals = [{ title: 'Speed', description: 'Speed = distance / time; v = d/t; SI unit m/s' }];
  invoke = async () => JSON.stringify({ topic: 'Speed', key_concepts: ['Speed: distance / time'],
    definitions: [{ term: 'Speed', definition: 'Distance travelled per unit time.' }],
    formulas: ['v = d/t'], quick_recall_tips: ['Recall the units.'], practice_next_time: 'Time a short walk.' });
  const sheet = await generateRevisionSheet({ topicTitle: 'Speed', goals });
  assert.match(sheet.formulas[0], /SI unit m\/s/u);
});

test('compact fallback never deletes a verified formula or its units to meet a word target', () => {
  const explanation = 'symbol names '.repeat(110).trim();
  const goals = [{ title: 'Source formula', description: `Relation = ${explanation}; units: newton (N)` }];
  const sheet = buildFallbackRevisionSheet({ topicTitle: 'Source formula', goals });
  assert.equal(sheet.formulas.length, 1);
  assert.match(sheet.formulas[0], /units: newton \(N\)/u);
  assert.match(sheet.formulas[0], /Relation =/u);
});
