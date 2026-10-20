const test = require('node:test');
const assert = require('node:assert/strict');

for (const path of ['./validate', '../../ai/agents/socratic-tutor/formatters/bubble-formatter']) {
  const V = require(path);
  const context = {
    topicTitle: 'What Is a Force?', currentGoalTitle: 'Define force',
    currentGoalDescription: 'Students will define force as a push or pull acting on an object in their own words.',
    academicNotes: {
      scientific_definition: 'A force is a push or a pull acting on an object.',
      exam_points: ['A force is a push or a pull acting on an object.', 'Force is an interaction between two objects.']
    }, phase: 'DIALOGUE', questionType: 'open'
  };

  test(`${path}: fallback assesses facts rather than the learning objective`, () => {
    const out = V.buildFocusedFallback(context);
    assert.match(out.messages.at(-1).message, /force/i);
    assert.doesNotMatch(out.messages.at(-1).message, /in simple terms|how does it work|goal|define force/i);
    assert.equal(out.lastQuestionRubric.criteria.length, 2);
    assert.doesNotMatch(out.lastQuestionRubric.model_answer, /students|will define/i);
    assert.match(out.lastQuestionRubric.model_answer, /interaction between two objects/);
  });

  test(`${path}: objective-only context is an ungraded recoverable repair`, () => {
    const out = V.enforce({ messages: [] }, { ...context, academicNotes: null });
    assert.equal(out.questionType, 'none');
    assert.equal(out.lastQuestionRubric, null);
    assert.equal(out.questionRecord, null);
    assert.equal(out.taskRepair, true);
    assert.doesNotMatch(JSON.stringify(out.messages), /Students will|how does it work|Goal 1/i);
  });

  test(`${path}: HELP during generation failure explains without repeating the failed question`, () => {
    const question = 'In simple terms, what is force and how does it work?';
    const out = V.enforce(null, {
      ...context, isHelpOrIdk: true, sameAssessment: true, studentMessage: "I don't know",
      evaluatorResult: { intent: 'IDK' }, lastQuestionText: question,
      lastQuestionRubric: { criteria: [{ id: 'force', description: 'A force is a push or pull.', required: true }], model_answer: 'A force is a push or pull.' }
    });
    assert.equal(out.questionType, 'none');
    assert.equal(out.lastQuestionRubric, null);
    assert.match(out.messages.map(b => b.message).join(' '), /push or pull/i);
    assert.ok(out.messages.every(b => !b.message.endsWith('?')));
    assert.ok(!out.messages.some(b => b.message === question));
  });

  test(`${path}: new ROUNDUP keeps all core criteria and leaks no answer`, () => {
    const facts = 'Force can start or stop motion; force can change speed; force can change direction; force can change shape';
    const out = V.enforce({ messages: [{ message: 'A force can change speed.' }, { message: 'Can force change speed?' }],
      lastQuestionRubric: { criteria: [{ id: 'speed', description: 'Force changes speed.', required: true }], model_answer: 'Yes.' } },
    { ...context, academicNotes: null, currentGoalTitle: 'Describe effects of force', currentGoalDescription: facts, phase: 'ROUNDUP' });
    assert.equal(out.questionType, 'open');
    assert.equal(out.messages.length, 1);
    assert.match(out.messages[0].message, /What changes can a force cause/);
    assert.equal(out.lastQuestionRubric.criteria.length, 4);
    assert.ok(out.lastQuestionRubric.criteria.every(c => c.required));
    assert.equal(out.questionAssisted, false);
    assert.doesNotMatch(out.messages[0].message, /start|stop|speed|shape|direction/);
  });

  test(`${path}: explanation mode cannot become another compulsory check`, () => {
    const out = V.enforce({ messages: [{ message: 'The push stops the moving ball.' }, { message: 'Which effect is this?' }] },
      { ...context, response_mode: 'explain', questionType: 'none' });
    assert.equal(out.questionType, 'none');
    assert.equal(out.lastQuestionRubric, null);
    assert.deepEqual(out.messages.map(m => m.message), ['The push stops the moving ball.']);
  });
}

// Exercise the production generator as well as the compatibility generator.
for (const [generatorPath, providerPath] of [
  ['./tutor-generator', '../ai/deepseek-client'],
  ['../../ai/agents/socratic-tutor/generators/dialogue-generator', '../../ai/providers']
]) {
  const providerId = require.resolve(providerPath);
  require.cache[providerId] = { id: providerId, filename: providerId, loaded: true,
    exports: { invokeModel: async () => { throw new Error('offline fixture'); }, extractJson: JSON.parse } };
  const generator = require(generatorPath);
  const params = {
    topicTitle: 'What Is a Force?', currentGoalTitle: 'Define force',
    currentGoalDescription: 'Force is a push or pull.', goals: [{ title: 'Define force', description: 'Force is a push or pull.' }],
    studentMessage: 'Explain the answer', evaluatorResult: { intent: 'HELP' },
    lastQuestionText: 'What is force?',
    lastQuestionRubric: { criteria: [{ id: 'force', description: 'Force is a push or pull.', required: true }], model_answer: 'Force is a push or pull.' },
    classLevel: 'Class 8 CBSE', phase: 'DIALOGUE', response_mode: 'explain', questionType: 'none', stateInstruction: 'explain_answer'
  };
  test(`${generatorPath}: explanation schema wins over mandatory-check instructions`, () => {
    const prompt = generator.buildTutorPrompt(params);
    assert.doesNotMatch(prompt, /EXACTLY 3 micro-bubbles|Bubble 3: Simple guiding check/);
    assert.match(prompt, /Do not ask a check question/);
    assert.match(prompt, /no question and no rubric/);
    assert.match(prompt, /includes CHECK and ROUNDUP recall/);
    assert.match(prompt, /resting book still experiences forces/);
    assert.match(prompt, /Require a reason, example, list count or non-living qualifier only when visibly asked/);
  });
  test(`${generatorPath}: model outage while explaining yields facts, no academic retry`, async () => {
    const out = await generator.generateTutorResponse(params);
    assert.equal(out.fallbackQuestionType, 'none');
    assert.equal(out.lastQuestionRubric, null);
    assert.match(out.messages.map(m => m.message).join(' '), /push or pull/);
    assert.ok(out.messages.every(m => !m.message.endsWith('?')));
  });
}

for (const path of ['./validate', '../../ai/agents/socratic-tutor/formatters/bubble-formatter']) {
  const V = require(path);
  const E = require('../../ai/agents/socratic-tutor/evaluators/answer-evaluator');
  test(`${path}: correction keeps the complete actual deleted span beyond 14 words`, () => {
    const student = 'Force is the energy that an object stores inside itself and uses whenever it wants to move.';
    const diff = E.safeDiff(`<del>${student}</del><ins>Force is a push or pull.</ins>`, student);
    assert.ok(diff);
    const out = V.enforce({ messages: [{ message: 'Force means a push or pull.' }] }, {
      phase: 'DIALOGUE', response_mode: 'explain', questionType: 'none', studentMessage: student, diffHtml: diff
    });
    assert.equal(out.diff_html, `<del>${student}</del><ins>Force is a push or pull.</ins>`);
    assert.doesNotMatch(out.diff_html, /<del>[^<]*inside itself<\/del>/);
  });
  test(`${path}: correction decodes apostrophes before sentence and clause parsing`, () => {
    const student = "The ball's motion increases.";
    const diff = E.safeDiff("<del>The ball&#39;s motion increases.</del><ins>The ball&#39;s motion stops. Its speed decreases to zero when the goalkeeper catches it carefully with both hands.</ins>", student);
    assert.ok(diff);
    const out = V.sanitizeDiffHtml(diff, student);
    assert.ok(out);
    assert.equal(V.unescapeHtml(out), "<del>The ball's motion increases.</del><ins>The ball's motion stops.</ins>");
    assert.doesNotMatch(out, /&amp;#|<ins>The ball&#39[.]<\/ins>/);
  });
  test(`${path}: invented deleted text and severed long insertions are omitted`, () => {
    assert.equal(V.sanitizeDiffHtml('<del>pull</del><ins>push</ins>', 'It stops moving.'), null);
    assert.equal(V.sanitizeDiffHtml("<del>push</del><ins>The ball&#39;s motion changes because the hand applies an external force that acts against the motion and brings it gradually to rest.</ins>", 'push'), null);
  });
}
