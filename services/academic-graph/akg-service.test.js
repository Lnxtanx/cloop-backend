const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the provider before loading AKG modules so tests are fast, offline, and deterministic
const clientPath = require.resolve('../ai/deepseek-client');
let modelResponse;
const calls = [];
require.cache[clientPath] = {
  id: clientPath,
  filename: clientPath,
  loaded: true,
  exports: {
    invokeModel: async (...args) => {
      calls.push(args);
      if (modelResponse instanceof Error) throw modelResponse;
      return JSON.stringify(modelResponse);
    },
    extractJson: text => (typeof text === 'string' ? JSON.parse(text) : text),
  },
};

const { buildAkgContext, buildTutorSnippet, buildEvaluatorSnippet } = require('./akg-context-builder');
const { buildFallbackIntelligence, buildSynthesisPrompt } = require('./akg-synthesizer');
const { resolveTopicIntelligence } = require('./akg-service');

test.beforeEach(() => {
  calls.length = 0;
  modelResponse = {
    preceding_anchor: 'Students previously learned that objects change position in Introduction to Motion.',
    succeeding_teaser: 'Next, we will explore Types of Forces such as friction and gravity.',
    in_scope_concepts: ['Push and pull', 'Changing state of motion', 'Changing shape'],
    out_of_scope_boundaries: ["Newton's Laws of Motion", 'Inertia', 'F = ma equations'],
    common_misconceptions: [
      { misconception: 'A continuous force is required to keep an object moving', correction_angle: 'Force is required to change motion, not maintain it' },
    ],
  };
});

test('buildAkgContext normalizes DB records and constructs compact prompt snippets', () => {
  const sampleDbRecord = {
    id: 1,
    topic_id: 42,
    preceding_anchor: 'Rest and Motion basics from Chapter 2.',
    succeeding_teaser: 'Contact and non-contact forces in the next topic.',
    in_scope_concepts: ['Push and pull', 'Change of state of motion', 'Change of shape'],
    out_of_scope_boundaries: ["Newton's Laws", 'Inertia', 'F = ma vector math'],
    common_misconceptions: [
      { misconception: 'Force is stored inside an object', correction_angle: 'Force is an interaction between bodies' },
    ],
  };

  const context = buildAkgContext(sampleDbRecord);
  assert.ok(context, 'Context should not be null');
  assert.equal(context.preceding_anchor, 'Rest and Motion basics from Chapter 2.');
  assert.equal(context.succeeding_teaser, 'Contact and non-contact forces in the next topic.');
  assert.equal(context.in_scope_concepts.length, 3);
  assert.equal(context.out_of_scope_boundaries.length, 3);
  assert.equal(context.common_misconceptions.length, 1);

  // Tutor context assertions
  assert.ok(context.tutor_context.prompt_snippet.includes('FOUNDATION:'));
  assert.ok(context.tutor_context.prompt_snippet.includes('FORBIDDEN (Out-of-scope for this grade):'));
  assert.ok(context.tutor_context.prompt_snippet.includes("Newton's Laws"));
  assert.ok(context.tutor_context.prompt_snippet.includes('WRAP TEASER:'));

  // Evaluator context assertions
  assert.ok(context.evaluator_context.prompt_snippet.includes('IN-SCOPE:'));
  assert.ok(context.evaluator_context.prompt_snippet.includes('OUT-OF-SCOPE:'));
  assert.ok(context.evaluator_context.prompt_snippet.includes('KNOWN MISCONCEPTIONS:'));
  assert.ok(context.evaluator_context.prompt_snippet.includes('Force is stored inside an object'));
});

test('buildAkgContext handles stringified JSON and null safely', () => {
  assert.equal(buildAkgContext(null), null);
  assert.equal(buildAkgContext(undefined), null);

  const stringifiedRecord = {
    topic_id: 10,
    preceding_anchor: null,
    succeeding_teaser: null,
    in_scope_concepts: JSON.stringify(['Photosynthesis', 'Chlorophyll']),
    out_of_scope_boundaries: JSON.stringify(['Calvin Cycle', 'ATP synthase']),
    common_misconceptions: JSON.stringify([
      { misconception: 'Plants breathe only at night', correction_angle: 'Plants respire continuously' },
    ]),
  };

  const context = buildAkgContext(stringifiedRecord);
  assert.ok(context);
  assert.deepEqual(context.in_scope_concepts, ['Photosynthesis', 'Chlorophyll']);
  assert.deepEqual(context.out_of_scope_boundaries, ['Calvin Cycle', 'ATP synthase']);
  assert.equal(context.common_misconceptions[0].misconception, 'Plants breathe only at night');
});

test('buildFallbackIntelligence creates deterministic boundaries on failure', () => {
  const fallback = buildFallbackIntelligence({
    topic: { id: 1, title: 'Combustion and Flame' },
    chapter: { title: 'Chemical Effects' },
    precedingTopic: { title: 'Fuels' },
    succeedingTopic: { title: 'Fire Safety' },
    classLevel: 'Class 8',
  });

  assert.equal(fallback.preceding_anchor, 'Earlier understanding of Fuels.');
  assert.equal(fallback.succeeding_teaser, 'Coming up next: Fire Safety.');
  assert.deepEqual(fallback.in_scope_concepts, ['Combustion and Flame']);
  assert.ok(fallback.out_of_scope_boundaries.length > 0);
});

test('resolveTopicIntelligence serves cached intelligence without synthesizer', async () => {
  const mockCached = {
    id: 99,
    topic_id: 101,
    preceding_anchor: 'Cached anchor',
    succeeding_teaser: 'Cached teaser',
    in_scope_concepts: ['Concept A'],
    out_of_scope_boundaries: ['Forbidden B'],
    common_misconceptions: [],
  };

  let findUniqueCalls = 0;
  let upsertCalls = 0;

  const mockPrisma = {
    topic_academic_intelligence: {
      findUnique: async ({ where }) => {
        findUniqueCalls++;
        if (where.topic_id === 101) return mockCached;
        return null;
      },
      upsert: async () => {
        upsertCalls++;
      },
    },
  };

  const result = await resolveTopicIntelligence(101, mockPrisma);
  assert.equal(findUniqueCalls, 1);
  assert.equal(upsertCalls, 0, 'Should not synthesize or upsert on cache hit');
  assert.equal(result.preceding_anchor, 'Cached anchor');
  assert.equal(result.succeeding_teaser, 'Cached teaser');
});

test('resolveTopicIntelligence synthesizes and persists on cache miss', async () => {
  let upsertPayload = null;

  const mockTopic = {
    id: 202,
    title: 'Force and Pressure',
    content: 'A push or pull on an object is called a force.',
    order: 2,
    chapter: {
      id: 5,
      title: 'Force',
      order: 1,
      subject_id: 1,
      topics: [
        { id: 201, title: 'Introduction to Motion', order: 1 },
        { id: 202, title: 'Force and Pressure', order: 2 },
        { id: 203, title: 'Types of Forces', order: 3 },
      ],
    },
  };

  const mockPrisma = {
    topic_academic_intelligence: {
      findUnique: async () => null, // Cache miss
      upsert: async ({ create }) => {
        upsertPayload = create;
        return { id: 300, ...create };
      },
    },
    global_topics: {
      findUnique: async () => mockTopic,
    },
  };

  const result = await resolveTopicIntelligence(mockTopic, mockPrisma, { classLevel: 'Class 6' });
  assert.ok(result, 'Result should be generated');
  assert.ok(upsertPayload, 'Should have persisted to DB');
  assert.equal(upsertPayload.topic_id, 202);
  assert.ok(upsertPayload.preceding_anchor.includes('Introduction to Motion'));
  assert.ok(upsertPayload.succeeding_teaser.includes('Types of Forces'));
  assert.equal(calls.length, 1, 'Synthesizer should be called exactly once');
});

test('resolveTopicIntelligence gracefully handles DB errors without crashing', async () => {
  modelResponse = new Error('Model provider unavailable');

  const faultyPrisma = {
    topic_academic_intelligence: {
      findUnique: async () => {
        throw new Error('Connection refused');
      },
      upsert: async () => {
        throw new Error('Connection refused');
      },
    },
    global_topics: {
      findUnique: async () => {
        throw new Error('Connection refused');
      },
    },
  };

  const result = await resolveTopicIntelligence(505, faultyPrisma);
  assert.ok(result, 'Should return fallback context without throwing');
  assert.ok(result.in_scope_concepts.length > 0);
  assert.ok(result.out_of_scope_boundaries.length > 0);
});

test('buildTutorPrompt correctly ingests AKG boundaries and instructions', () => {
  const { buildTutorPrompt } = require('../tutor-core/tutor-generator');
  const akgContext = buildAkgContext({
    preceding_anchor: 'Motion basics',
    succeeding_teaser: 'Contact forces',
    in_scope_concepts: ['Push and pull'],
    out_of_scope_boundaries: ["Newton's Laws"],
    common_misconceptions: [{ misconception: 'Force is an object property', correction_angle: 'Force is an interaction' }],
  });

  const prompt = buildTutorPrompt({
    topicTitle: 'Force',
    currentGoalTitle: 'What is Force',
    akgContext,
    phase: 'DIALOGUE',
    stateInstruction: 'open_goal_dialogue',
  });

  assert.ok(prompt.includes('academic_boundaries'));
  assert.ok(prompt.includes("Newton's Laws"));
  assert.ok(prompt.includes('Respect academic boundaries'));
});

