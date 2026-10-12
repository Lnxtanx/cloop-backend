const test = require('node:test');
const assert = require('node:assert/strict');

const modelPath = require.resolve('../ai/deepseek-client');
let response;
let failure;
let callCount;
let lastContext;
let lastOptions;
require.cache[modelPath] = {
  id: modelPath, filename: modelPath, loaded: true,
  exports: {
    invokeModel: async (_prompt, messages, options) => {
      callCount++;
      lastContext = JSON.parse(messages[0].content);
      lastOptions = options;
      if (failure) throw failure;
      return response;
    },
    extractJson: JSON.parse
  }
};
const { generateFinalTest, validateFinalTestPlan, deterministicFinalTest,
  publicFinalTestQuestion, FINAL_TEST_PROMPT, SOURCE_LIMIT } = require('./final-test');

const goals = [
  { title: 'Combustion pollutants', description: 'Incomplete combustion produces carbon monoxide; burning sulfur-containing fuels produces sulfur dioxide' },
  { title: 'Health effects', description: 'Carbon monoxide binds to haemoglobin and reduces oxygen transport; symptoms include headache and dizziness' },
  { title: 'Acid rain', description: 'Sulfur dioxide and nitrogen oxides react with water and oxygen to form acids; acid rain harms plants and water bodies' },
  { title: 'Global warming', description: 'Carbon dioxide absorbs outgoing infrared radiation; increased greenhouse effect warms Earth' },
  { title: 'Cleaner fuels', description: 'Natural gas emits less carbon dioxide per unit of energy than coal; it still emits carbon dioxide' },
  { title: 'Emission controls', description: 'A catalytic converter converts harmful exhaust gases into less harmful substances; it does not produce pure clean air' }
];

function makePlan(sourceGoals = goals, questionCount = 5) {
  const groups = Array.from({ length: questionCount }, (_, index) => index < sourceGoals.length ? [index] : [index % sourceGoals.length]);
  sourceGoals.forEach((_, index) => { if (index >= questionCount) groups.at(-1).push(index); });
  return {
    questions: groups.map((goalIndices, index) => {
      const dimension = index === 1 || index === 2 ? 'concept' : 'academic';
      const criteria = goalIndices.flatMap(goalIndex => {
        const base = { required: true, goal_index: goalIndex, dimension, marks: 1,
          source_quote: sourceGoals[goalIndex].description.split(';')[0] };
        return [
          { ...base, id: `q${index + 1}-g${goalIndex}-fact`, description: `State the source fact for ${sourceGoals[goalIndex].title}` },
          { ...base, id: `q${index + 1}-g${goalIndex}-reason`, description: `Explain the source principle for ${sourceGoals[goalIndex].title}` }
        ];
      });
      const isMcq = index === 2;
      const message = { message: `What is the complete explanation for concept ${index + 1}?`, message_type: 'text' };
      if (isMcq) message.options = [{ text: 'The source-supported explanation', value: 'The source-supported explanation' },
        { text: 'The contradictory explanation', value: 'The contradictory explanation' }];
      return { id: `final-${index + 1}`, goal_indices: goalIndices, question_type: isMcq ? 'mcq' : 'open',
        kind: dimension, messages: [message], rubric: { criteria,
          model_answer: goalIndices.map(goalIndex => sourceGoals[goalIndex].description).join('; '),
          correct_option_text: isMcq ? 'The source-supported explanation' : null } };
    })
  };
}

function validate(plan, sourceGoals = goals, questionCount = 5, topicContent = '') {
  return validateFinalTestPlan(plan, { goals: sourceGoals, questionCount, topicContent });
}

function reset() { response = ''; failure = null; callCount = 0; lastContext = null; }

test('one private plan covers six goals in five questions, including an integrated final question', async () => {
  reset(); response = JSON.stringify(makePlan());
  const result = await generateFinalTest({ topicTitle: 'Harmful Effects of Combustion', goals });
  assert.equal(callCount, 1);
  assert.equal(result.questions.length, 5);
  assert.deepEqual(result.questions.at(-1).goal_indices, [4, 5]);
  assert.deepEqual(new Set(result.questions.flatMap(question => question.goal_indices)), new Set([0, 1, 2, 3, 4, 5]));
  assert.equal(result.index, 0);
  assert.equal(result.announced, false);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.exam_plan_source, 'model');
  assert.equal(lastOptions.subFeature, 'final-test-plan');
  assert.equal(lastOptions.maxTokens, 5600);
});

test('four-question plans are supported and source processing does not discard later curriculum', async () => {
  reset(); response = JSON.stringify(makePlan(goals, 4));
  const source = 'x'.repeat(2500) + ' Late curriculum fact. ' + 'z'.repeat(SOURCE_LIMIT);
  const result = await generateFinalTest({ goals, questionCount: 4, topicContent: source });
  assert.equal(result.questions.length, 4);
  assert.equal(result.exam_plan_source, 'model');
  assert.equal(lastContext.topic_content.length, SOURCE_LIMIT);
  assert.ok(lastContext.topic_content.includes('Late curriculum fact.'));
  assert.equal(lastOptions.maxTokens, 4800);
});

test('an entirely written model plan is valid when it assesses both dimensions and covers every goal', async () => {
  reset();
  const plan = makePlan();
  plan.questions[2].question_type = 'open';
  delete plan.questions[2].messages[0].options;
  plan.questions[2].rubric.correct_option_text = null;
  response = JSON.stringify(plan);
  const result = await generateFinalTest({ goals });
  assert.equal(result.exam_plan_source, 'model');
  assert.ok(result.questions.every(question => question.question_type === 'open'));
  assert.equal(result.questions.length, 5);
});

test('only 4-5 questions can be requested, never a silent count override', async () => {
  for (const questionCount of [0, 3, 6, '5', 4.5]) {
    await assert.rejects(generateFinalTest({ goals, questionCount }), /4 or 5/);
    assert.throws(() => deterministicFinalTest({ goals, questionCount }), /4 or 5/);
    assert.equal(validateFinalTestPlan(makePlan(), { goals, questionCount }), null);
  }
});

test('public questions exclude answers, criteria, marks, source metadata, and internal identifiers', () => {
  const plan = validate(makePlan());
  const publicQuestion = publicFinalTestQuestion(plan.questions[2]);
  assert.deepEqual(Object.keys(publicQuestion), ['messages']);
  assert.equal(publicQuestion.messages[0].options.length, 2);
  const json = JSON.stringify(publicQuestion);
  assert.ok(!/model_answer|correct_option_text|rubric|source_quote|dimension|marks|goal_indices/u.test(json));
  publicQuestion.messages[0].options[0].text = 'Mutated';
  assert.notEqual(plan.questions[2].messages[0].options[0].text, 'Mutated');
});

test('malformed or unmarked coverage cannot claim a complete final test', () => {
  let plan = makePlan();
  plan.questions.at(-1).goal_indices = [4];
  plan.questions.at(-1).rubric.criteria = plan.questions.at(-1).rubric.criteria.filter(criterion => criterion.goal_index === 4);
  assert.equal(validate(plan), null);
  plan = makePlan();
  plan.questions.at(-1).rubric.criteria = plan.questions.at(-1).rubric.criteria.filter(criterion => criterion.goal_index === 4);
  assert.equal(validate(plan), null);
  plan = makePlan();
  plan.questions[0].goal_indices = ['0'];
  assert.equal(validate(plan), null);
});

test('dimensions, types, and distinct source-backed criteria are enforced', () => {
  for (const change of [
    plan => { plan.questions.forEach(question => { question.kind = 'academic'; question.rubric.criteria.forEach(criterion => { criterion.dimension = 'academic'; }); }); },
    plan => { plan.questions[1].rubric.criteria[0].dimension = 'spelling'; },
    plan => { plan.questions[0].rubric.criteria[0].marks = 0; },
    plan => { plan.questions[0].rubric.criteria[0].marks = 4; },
    plan => { plan.questions[0].rubric.criteria[0].marks = 1.5; },
    plan => { plan.questions[0].rubric.criteria[0].required = false; },
    plan => { plan.questions[0].rubric.criteria[0].source_quote = 'Unsupported science from outside the topic'; },
    plan => { plan.questions[0].rubric.criteria[0].id = plan.questions[1].rubric.criteria[0].id; },
    plan => { plan.questions[0].rubric.criteria[0].id = ` ${plan.questions[1].rubric.criteria[0].id} `; },
    plan => { plan.questions[0].id = plan.questions[1].id; },
    plan => { plan.questions[0].id = ` ${plan.questions[1].id} `; },
    plan => { plan.questions[0].kind = 'integrated'; },
    plan => { plan.questions[0].messages = plan.questions[1].messages; },
    plan => { plan.questions[0].rubric.criteria.pop(); },
    plan => { plan.questions.forEach(question => { question.question_type = 'mcq'; question.messages[0].options = [
      { text: 'Correct text', value: 'Correct text' }, { text: 'Incorrect text', value: 'Incorrect text' }
    ]; question.rubric.correct_option_text = 'Correct text'; }); }
  ]) {
    const plan = makePlan(); change(plan);
    assert.equal(validate(plan), null, change.toString());
  }
});

test('MCQs require unique real-text options, a single exact key, and no options on written questions', () => {
  for (const change of [
    plan => { plan.questions[2].rubric.correct_option_text = 'A'; },
    plan => { plan.questions[2].messages[0].options[1] = { ...plan.questions[2].messages[0].options[0] }; },
    plan => { plan.questions[2].messages[0].options[0].value = 'A'; },
    plan => { plan.questions[2].messages[0].options.pop(); },
    plan => { plan.questions[0].messages[0].options = plan.questions[2].messages[0].options; },
    plan => { plan.questions[2].messages[0].options = [{ text: 'A', value: 'A' }, { text: 'B', value: 'B' }]; }
  ]) {
    const plan = makePlan(); change(plan);
    assert.equal(validate(plan), null);
  }
});

test('long, nonterminal and first-question multipart bubbles cause safe plan rejection', () => {
  for (const change of [
    plan => { plan.questions[0].messages[0].message = 'word '.repeat(20) + '?'; },
    plan => { plan.questions[0].messages[0].message = 'An instruction without a question.'; },
    plan => { plan.questions[0].messages.unshift({ message: 'State the definition first.', message_type: 'text' }); }
  ]) {
    const plan = makePlan(); change(plan);
    assert.equal(validate(plan), null);
  }
});

test('failed generation gives sourced written questions that test definitions AND explained applications', async () => {
  reset(); failure = new Error('provider unavailable');
  const result = await generateFinalTest({ goals });
  assert.equal(callCount, 1);
  assert.equal(result.exam_plan_source, 'deterministic_fallback');
  assert.equal(result.questions.length, 5);
  assert.deepEqual(result.questions.at(-1).goal_indices, [4, 5]);
  for (const question of result.questions) {
    assert.equal(question.messages.length, 1);
    assert.equal(question.question_type, 'open');
    assert.equal(question.grading_available, true);
    assert.ok(question.messages[0].message.split(/\s+/u).length < 20);
    assert.ok(question.messages[0].message.endsWith('?'));
    assert.ok(/definitions|key facts/u.test(question.messages[0].message));
    assert.ok(/explain.*application/u.test(question.messages[0].message));
    assert.ok(question.rubric.criteria.some(criterion => criterion.dimension === 'academic'));
    assert.ok(question.rubric.criteria.some(criterion => criterion.dimension === 'concept'));
    assert.ok(question.rubric.criteria.filter(criterion => criterion.dimension === 'concept').every(criterion => criterion.description.includes('HOW')));
  }
  assert.ok(!JSON.stringify(result).includes('Correct concept principle'));
});

test('malformed plans also fall back rather than exposing unsupported questions', async () => {
  reset(); const invalid = makePlan(); invalid.questions.pop(); response = JSON.stringify(invalid);
  const result = await generateFinalTest({ goals });
  assert.equal(result.exam_plan_source, 'deterministic_fallback');
  assert.equal(result.questions.length, 5);
});

test('fallback covers 1-6 goals with 4-5 distinct bounded questions and no invented MCQs', () => {
  for (const count of [4, 5]) for (let goalCount = 1; goalCount <= 6; goalCount++) {
    const result = deterministicFinalTest({ goals: goals.slice(0, goalCount), questionCount: count });
    assert.equal(result.questions.length, count);
    assert.equal(new Set(result.questions.flatMap(question => question.goal_indices)).size, goalCount);
    assert.equal(new Set(result.questions.map(question => question.messages[0].message)).size, count);
    assert.ok(result.questions.every(question => question.messages[0].message.split(/\s+/u).length < 20));
    assert.ok(result.questions.every(question => question.rubric.criteria.every(criterion =>
      goals[criterion.goal_index].description.includes(criterion.source_quote))));
  }
});

test('missing verified source explicitly disables grading instead of fabricating academic facts', () => {
  const result = deterministicFinalTest({ goals: [{ title: 'Unverified topic', description: '' }] });
  assert.ok(result.questions.every(question => question.grading_available === false));
  assert.ok(result.questions.every(question => question.rubric.model_answer === ''));
});

test('planner prompt requires precise academic content and distinct scientific concepts', () => {
  assert.ok(FINAL_TEST_PROMPT.includes('At least TWO questions must assess academic knowledge'));
  assert.ok(FINAL_TEST_PROMPT.includes('new concrete situation'));
  assert.ok(FINAL_TEST_PROMPT.includes('not pure clean air'));
  assert.ok(FINAL_TEST_PROMPT.includes('nitrogen (N2) is not nitrogen oxides (NOx)'));
  assert.ok(FINAL_TEST_PROMPT.includes('not proof'));
  assert.ok(FINAL_TEST_PROMPT.includes('Use the whole supplied source'));
});
