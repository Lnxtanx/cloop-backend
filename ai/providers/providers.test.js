/**
 * Providers Layer Test Suite
 * Verifies constants, always-on thinking extraction, native search, prompt caching, and telemetry.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deepseek,
  invokeReasoner,
  extractJson,
  executeSearch,
  assembleCachedPrompt,
  computeCacheMetrics,
  recordTokenUsage,
} = require('./index');

test('P1: Constants define official models and endpoints', () => {
  assert.equal(deepseek.MODELS.FLASH, 'deepseek-flash');
  assert.equal(deepseek.MODELS.PRO, 'deepseek-v4-pro');
  assert.equal(deepseek.MODELS.DEFAULT, 'deepseek-v4-pro');
  assert.equal(deepseek.MODELS.LEGACY_MAP['deepseek-chat'], 'deepseek-v4-pro');
  assert.equal(deepseek.MODELS.LEGACY_MAP['deepseek-reasoner'], 'deepseek-v4-pro');
  assert.equal(deepseek.THINKING_CONFIG.DEFAULT_STATUS, 'enabled');
  assert.match(deepseek.ENDPOINTS.CHAT_COMPLETIONS, /\/chat\/completions$/);
  assert.match(deepseek.ENDPOINTS.SEARCH, /\/v1\/tools\/search$/);
});

test('P2: extractJson strips <think> tags, markdown fences, and repairs trailing commas', () => {
  // Case A: Embedded in thinking tags and markdown fence
  const rawWithThinking = `
    <think>
    We need to check the ciliary muscles.
    The answer is option 1.
    </think>
    \`\`\`json
    {
      "is_correct": true,
      "feedback": "Great understanding of lens accommodation.",
    }
    \`\`\`
  `;
  const parsedA = extractJson(rawWithThinking);
  assert.ok(parsedA, 'Should successfully parse JSON');
  assert.equal(parsedA.is_correct, true);
  assert.equal(parsedA.feedback, 'Great understanding of lens accommodation.');

  // Case B: Raw JSON string without tags
  const rawClean = '{"score": 95, "outcome": "passed"}';
  const parsedB = extractJson(rawClean);
  assert.equal(parsedB.score, 95);

  // Case C: Non-JSON returns null
  assert.equal(extractJson('Hello, this is just plain text.'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
});

test('P3: Prompt Cache Formatter guarantees static blocks precede dynamic data', () => {
  const assembled = assembleCachedPrompt({
    systemIdentity: 'You are Cloop, a CBSE Class 10 Science Tutor.',
    staticRules: 'Rule 1: Teach before checking.\nRule 2: Never repeat a question.',
    schema: '{"messages": [{"message": "string"}]}',
    topicBoundaries: 'IN-SCOPE: Ciliary muscles, focal length.\nOUT-OF-SCOPE: Ray diagrams for cataracts.',
    dynamicTurnData: 'STUDENT_MESSAGE: The lens gets thicker.\nSTATE_INSTRUCTION: check_concept',
  });

  // Verify prefix starts with permanent static identity and rules
  assert.ok(assembled.startsWith('You are Cloop, a CBSE Class 10 Science Tutor.'));
  const staticRulesIdx = assembled.indexOf('STRICT PEDAGOGICAL RULES:');
  const schemaIdx = assembled.indexOf('OUTPUT JSON SCHEMA:');
  const boundaryIdx = assembled.indexOf('CURRICULUM BOUNDARIES:');
  const dynamicDividerIdx = assembled.indexOf('--- SESSION DATA (DYNAMIC) ---');
  const studentMsgIdx = assembled.indexOf('STUDENT_MESSAGE: The lens gets thicker.');

  // Guarantee strict sequential ordering for DeepSeek prefix caching
  assert.ok(staticRulesIdx < schemaIdx, 'Rules must precede schema');
  assert.ok(schemaIdx < boundaryIdx, 'Schema must precede topic boundaries');
  assert.ok(boundaryIdx < dynamicDividerIdx, 'Boundaries must precede dynamic divider');
  assert.ok(dynamicDividerIdx < studentMsgIdx, 'Divider must precede dynamic turn data');
});

test('P4: computeCacheMetrics accurately computes cache ratios and counts', () => {
  const metricsA = computeCacheMetrics({ promptTokens: 1000, cachedPromptTokens: 850 });
  assert.equal(metricsA.hitRatio, 0.85);
  assert.equal(metricsA.cachedTokens, 850);
  assert.equal(metricsA.uncachedTokens, 150);
  assert.equal(metricsA.isCacheHit, true);

  const metricsB = computeCacheMetrics({ promptTokens: 500, cachedPromptTokens: 0 });
  assert.equal(metricsB.hitRatio, 0);
  assert.equal(metricsB.isCacheHit, false);
});

test('P5: Telemetry records token usage and updates daily aggregates with userId', async () => {
  const createdLogs = [];
  const upsertedDaily = [];

  const mockPrisma = {
    ai_token_logs: {
      create: async ({ data }) => {
        createdLogs.push(data);
        return { id: 1n, ...data };
      },
    },
    ai_user_daily_token_usage: {
      upsert: async ({ where, update, create }) => {
        upsertedDaily.push({ where, update, create });
        return { id: 1, ...create };
      },
    },
  };

  recordTokenUsage({
    userId: 42,
    featureArea: 'tutor-core',
    subFeature: 'evaluator',
    provider: 'deepseek',
    modelName: 'deepseek-flash',
    promptTokens: 400,
    completionTokens: 80,
    cachedPromptTokens: 320,
    reasoningTokens: 45,
    requestDurationMs: 650,
    status: 'success',
    prismaClient: mockPrisma,
  });

  // Allow setImmediate to fire
  await new Promise(r => setTimeout(r, 150));

  assert.equal(createdLogs.length, 1);
  const log = createdLogs[0];
  assert.equal(log.user_id, 42);
  assert.equal(log.feature_area, 'tutor-core');
  assert.equal(log.sub_feature, 'evaluator');
  assert.equal(log.prompt_tokens, 400);
  assert.equal(log.completion_tokens, 80);
  assert.equal(log.cached_prompt_tokens, 320);
  assert.equal(log.reasoning_tokens, 45);
  assert.equal(log.metadata.cache_hit_ratio, 0.8);
  assert.equal(log.metadata.tokens_saved_by_cache, 320);

  // Verify daily rollup occurred for feature + 'all'
  assert.equal(upsertedDaily.length, 2);
  assert.equal(upsertedDaily[0].where.user_id_date_feature_area.user_id, 42);
});

test('P6: Live DeepSeek Reasoner generates thinking chain and structured output', async () => {
  if (!process.env.DEEPSEEK_API_KEY && !process.env.DEEPSEEK_KEY) {
    console.log('Skipping live test: DEEPSEEK_API_KEY not present');
    return;
  }

  const result = await invokeReasoner(
    'You are a physics evaluator. Reason about whether the answer is scientifically sound. Respond strictly in JSON: {"is_correct": boolean, "verdict": "string"}',
    [{ role: 'user', content: 'Question: What happens to ciliary muscles for distant vision? Student: They contract.' }],
    {
      featureArea: 'test-suite',
      subFeature: 'live-reasoner',
      timeoutMs: 30000,
    }
  );

  assert.ok(result.reasoning, 'Model must produce reasoning_content (Thinking chain)');
  assert.ok(result.reasoning.length > 5, 'Reasoning must have substantive thinking text');
  assert.ok(result.content, 'Model must produce final content');
  assert.ok(result.parsed, 'Model must emit parseable JSON');
  assert.equal(result.parsed.is_correct, false, 'Ciliary muscles relax for distant vision');
  assert.ok(result.usage.reasoningTokens > 0, 'Reasoning tokens must be > 0');
});

test('P7: Live DeepSeek Native Search returns ranked educational results', async () => {
  if (!process.env.DEEPSEEK_API_KEY && !process.env.DEEPSEEK_KEY) {
    console.log('Skipping live test: DEEPSEEK_API_KEY not present');
    return;
  }

  const searchResult = await executeSearch('CBSE Class 10 Science power of accommodation', {
    count: 3,
  });

  assert.ok(Array.isArray(searchResult.results), 'Search must return results array');
  assert.ok(searchResult.results.length > 0, 'Must return at least 1 result');
  const first = searchResult.results[0];
  assert.ok(first.title, 'Result must have a title');
  assert.ok(first.url, 'Result must have a URL');
  assert.ok(first.summary, 'Result must have a snippet/summary');
});
