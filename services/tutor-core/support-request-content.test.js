const test = require('node:test');
const assert = require('node:assert/strict');

const goals = [
  { title: 'Define force', description: 'Force is a push or pull.' },
  { title: 'Define motion', description: 'Motion is change in position over time.' },
  { title: 'Describe effects', description: 'Force can start or stop motion; Force can change direction.' }
];
const base = {
  topicTitle: 'Force and Motion', goals, currentGoalTitle: goals[0].title, currentGoalDescription: goals[0].description,
  phase: 'ROUNDUP', response_mode: 'task_repair', questionType: 'none', stateInstruction: 'task_repair',
  supportRequestKind: 'recap_topic', studentMessage: 'List all concepts and definitions before we move.',
  lastQuestionText: 'What is force?', lastQuestionRubric: {
    criteria: [{ id: 'force', description: 'Force is a push or pull.', required: true }], model_answer: 'Force is a push or pull.'
  }
};

for (const path of ['./validate', '../../ai/agents/socratic-tutor/formatters/bubble-formatter']) {
  const V = require(path);
  test(`${path}: requested recap includes all sourced goals and pages without a compulsory quiz`, () => {
    const out = V.enforce({ messages: [{ message: 'Force is a push or pull.' }], lastQuestionRubric: null }, base);
    assert.equal(out.questionType, 'none');
    assert.equal(out.lastQuestionRubric, null);
    assert.equal(out.questionRecord, null);
    assert.match(out.messages.map(b => b.message).join(' '), /Motion is change in position over time/);
    assert.ok(out.supportContinuation.length);
    assert.ok(out.messages.some(b => b.message === 'Say continue for the remaining definitions.'));
    let next = out.supportContinuation;
    const delivered = [...out.messages];
    let pages = 0;
    while (next.length) {
      const page = V.paginateSupportBubbles(next);
      assert.ok(page.messages.length <= 3);
      assert.ok(page.messages.every(b => V.wordCount(b.message) <= 25 && !b.message.endsWith('?')));
      assert.ok(page.messages.every(b => b.support_fact_id === undefined));
      delivered.push(...page.messages);
      next = page.supportContinuation;
      assert.ok(++pages < 10);
    }
    const text = delivered.map(b => b.message).join(' ');
    for (const fact of goals.flatMap(g => V.factualSourceParts(g.description))) assert.ok(text.includes(fact), fact);
    assert.doesNotMatch(text, /Goal [123]|Students will|how does it work/);
  });

  test(`${path}: multi-bubble definition stays on one page`, () => {
    const queue = [
      { message: 'Force is a push or pull.', message_type: 'text', support_fact_id: 'a' },
      { message: 'Motion is change in position over time.', message_type: 'text', support_fact_id: 'b' },
      { message: 'Position is described with respect to surroundings.', message_type: 'text', support_fact_id: 'b' },
      { message: 'Force can change direction.', message_type: 'text', support_fact_id: 'c' }
    ];
    const first = V.paginateSupportBubbles(queue);
    assert.deepEqual(first.messages.map(b => b.message), ['Force is a push or pull.', 'Say continue for the remaining definitions.']);
    assert.equal(first.supportContinuation[0].support_fact_id, 'b');
    const second = V.paginateSupportBubbles(first.supportContinuation);
    assert.ok(second.messages.some(b => b.message.startsWith('Motion is')));
    assert.ok(second.messages.some(b => b.message.startsWith('Position is')));
  });

  test(`${path}: objective-only recap does not manufacture definitions or recurse`, () => {
    const out = V.enforce(null, { ...base, goals: [{ title: 'Define force', description: 'Students will define force.' }],
      currentGoalDescription: 'Students will define force.', academicNotes: null });
    assert.equal(out.questionType, 'none');
    assert.equal(out.taskRepair, true);
    assert.equal(out.lastQuestionRubric, null);
    assert.deepEqual(out.supportContinuation, []);
  });

  test(`${path}: clarifying effect explains the word instead of asking the abstract goal`, () => {
    const out = V.buildFocusedFallback({ ...base, supportRequestKind: 'clarify_term', studentMessage: 'What do you mean by which effect?',
      lastQuestionText: 'A goalkeeper stops a moving ball. Which effect of force is this?', isHelpOrIdk: true });
    assert.match(out.messages.map(m => m.message).join(' '), /effect means a change or result/i);
    assert.ok(out.messages.every(m => !m.message.endsWith('?')));
    assert.equal(out.lastQuestionRubric, null);
  });

  test(`${path}: worked example fallback uses supplied example, not a bare definition`, () => {
    const out = V.buildFocusedFallback({ ...base, supportRequestKind: 'give_example', studentMessage: 'Give an example.',
      topicContent: 'For example, pushing a door applies a force that opens it.', isHelpOrIdk: true });
    assert.match(out.messages.map(m => m.message).join(' '), /pushing a door applies a force that opens it/i);
    assert.equal(out.lastQuestionRubric, null);
    assert.ok(out.messages.every(m => !m.message.endsWith('?')));
  });
}

for (const [path, providerPath] of [
  ['./tutor-generator', '../ai/deepseek-client'],
  ['../../ai/agents/socratic-tutor/generators/dialogue-generator', '../../ai/providers']
]) {
  const id = require.resolve(providerPath);
  require.cache[id] = { id, filename: id, loaded: true, exports: { invokeModel: async () => { throw new Error('offline fixture'); }, extractJson: JSON.parse } };
  const G = require(path);
  for (const kind of ['recap_topic', 'give_example', 'clarify_term', 'clarify_task']) {
    test(`${path}: ${kind} request is explicit source context with no compulsory quiz`, () => {
      const prompt = G.buildTutorPrompt({ ...base, supportRequestKind: kind });
      assert.ok(prompt.includes(`"support_request_kind":"${kind}"`));
      assert.match(prompt, /Do not quiz/);
      assert.match(prompt, /Question type: none/);
      assert.doesNotMatch(prompt, /For ROUNDUP: require ALL/);
      if (kind === 'recap_topic') {
        assert.ok(prompt.includes('Motion is change in position over time.'));
        assert.ok(prompt.includes('Force can change direction.'));
      }
    });
  }
  test(`${path}: stale support kind cannot replace the next academic assessment`, () => {
    const prompt = G.buildTutorPrompt({ ...base, response_mode: 'check', questionType: 'open', stateInstruction: 'roundup_recall' });
    assert.match(prompt, /"support_request_kind":null/);
    assert.match(prompt, /Question type: open/);
    assert.match(prompt, /For ROUNDUP: require ALL/);
  });
}

for (const path of ['./validate', '../../ai/agents/socratic-tutor/formatters/bubble-formatter']) {
  const V = require(path);
  test(`${path}: reflow preserves every scientific connective and negation`, () => {
    const sentence = 'A force is a push or pull, not something stored inside a ball; a ball changes motion because a push acts on it.';
    const bubbles = V.splitIntoMicroBubbles(sentence, 19);
    assert.equal(bubbles.length, 2);
    const meaningfulWords = text => text.toLowerCase().match(/[a-z]+/g);
    assert.deepEqual(meaningfulWords(bubbles.join(' ')), meaningfulWords(sentence));
    assert.match(bubbles.join(' '), /push or pull/);
    assert.match(bubbles.join(' '), /not something/);
    assert.match(bubbles.join(' '), /because a push/);
    assert.ok(bubbles.every(b => V.wordCount(b) <= 19));
  });
  test(`${path}: unsplittable overlong clauses request repair instead of semantic rewriting`, () => {
    const overlong = 'A force is a push or pull and not a property that an object owns because another object acts upon it to cause a change in its motion.';
    assert.deepEqual(V.splitIntoMicroBubbles(overlong, 25), []);
    const out = V.enforce({ messages: [{ message: overlong }, { message: 'What is force?' }] }, {
      ...base, supportRequestKind: null, response_mode: 'explain', currentGoalDescription: 'Force is a push or pull.',
      studentMessage: 'Explain the answer.'
    });
    assert.equal(out.questionType, 'none');
    assert.equal(out.lastQuestionRubric, null);
    assert.equal(out.taskRepair, true);
    assert.ok(out.messages.every(m => V.wordCount(m.message) <= 25 && !m.message.endsWith('?')));
    assert.ok(!out.messages.some(m => /push pull|because another[.]$|owns another/.test(m.message)));
  });
}
