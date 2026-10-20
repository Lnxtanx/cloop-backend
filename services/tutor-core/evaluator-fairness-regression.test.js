const test = require('node:test');
const assert = require('node:assert/strict');

// Exercise both production entry points with the model boundary stubbed. No SDK,
// credential, database or real model call is needed for these contract checks.
let output;
let calls = 0;
for (const modulePath of ['../ai/deepseek-client', '../../ai/providers']) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = {
    id: filename, filename, loaded: true,
    exports: {
      invokeModel: async () => { calls += 1; return JSON.stringify(output); },
      extractJson: JSON.parse,
    },
  };
}
const evaluators = [
  ['agent', require('../../ai/agents/socratic-tutor/evaluators/answer-evaluator')],
  ['compatibility', require('./evaluator')],
];
const forceQuestion = 'In your own words, what is a force, and who or what can exert one?';
const forceAnswer = 'Force is a push or pull that moves things around. One object can exert it on another.';
const criteria = [
  { id: 'definition', description: 'Defines force as a push or pull.', required: true },
  { id: 'interaction', description: 'One object exerts force on another.', required: true },
];
const params = {
  phase: 'DIALOGUE', topicTitle: 'What is a force?',
  currentGoal: { title: 'Define force', description: 'Force is a push or pull acting on an object.' },
  lastQuestionText: forceQuestion, studentMessage: forceAnswer,
  lastQuestionRubric: { criteria, model_answer: 'A force is a push or pull acting on an object.' },
};
function evidence(criterion, satisfied, questionRequirement) {
  return { id: criterion.id, satisfied, evidence: satisfied ? 'Student supplied this fact.' : 'Required fact absent.', question_requirement: questionRequirement };
}
function model(results, extra = {}) {
  output = {
    intent: 'ANSWER', criterion_results: results, contradictions: [],
    error_type: 'Incomplete', complete_answer: params.lastQuestionRubric.model_answer,
    feedback: 'Specific feedback.', diff_html: null, ...extra,
  };
}

for (const [name, evaluator] of evaluators) {
  test(`${name}: the latest student definition satisfies exactly the two visible requirements`, async () => {
    model([
      evidence(criteria[0], true, 'what is a force'),
      evidence(criteria[1], true, 'who or what can exert one'),
    ], { error_type: null });
    const result = await evaluator.evaluateStudentTurn(params);
    assert.equal(result.is_correct, true);
    assert.equal(result.score_percent, 100);
    assert.equal(result.diff_html, null);
  });

  test(`${name}: a hidden non-living example requirement is a tutor repair, never a student failure`, async () => {
    const hidden = { id: 'non_living', description: 'Give a non-living object as an example.', required: true };
    model([
      evidence(criteria[0], true, 'what is a force'),
      evidence(criteria[1], true, 'who or what can exert one'),
      evidence(hidden, false, null),
    ]);
    const result = await evaluator.evaluateStudentTurn({
      ...params, lastQuestionRubric: { ...params.lastQuestionRubric, criteria: [...criteria, hidden] },
    });
    assert.equal(result.evaluation_status, 'repair_needed');
    assert.equal(result.is_correct, null);
    assert.equal(result.score_percent, null);
    assert.equal(result.diff_html, null);
    assert.match(result.reasoning, /non_living/);
  });

  test(`${name}: unattributed or invented required obligations cannot record a wrong answer`, async () => {
    for (const quote of [undefined, null, 'and include a non-living example']) {
      model([evidence(criteria[0], false, quote), evidence(criteria[1], true, 'who or what can exert one')]);
      const result = await evaluator.evaluateStudentTurn(params);
      assert.equal(result.evaluation_status, 'repair_needed');
      assert.equal(result.is_correct, null);
    }
  });

  test(`${name}: an explicitly requested mechanism remains required without the literal word why`, async () => {
    const question = 'Identify the changing variable and describe how it affects the result?';
    const rubric = {
      criteria: [
        { id: 'variable', description: 'Name the changing variable.', required: true },
        { id: 'mechanism', description: 'Explain how the changing variable affects the result.', required: true },
      ],
      model_answer: 'Increasing the amount of light can affect measured plant growth.',
    };
    model([evidence(rubric.criteria[0], true, 'Identify the changing variable'), evidence(rubric.criteria[1], false, 'describe how it affects the result')]);
    const result = await evaluator.evaluateStudentTurn({ ...params, studentMessage: 'Amount of light.', lastQuestionText: question, lastQuestionRubric: rubric });
    assert.equal(result.evaluation_status, 'evaluated');
    assert.equal(result.is_correct, false);
    assert.equal(result.score_percent, 50);
    assert.equal(result.criterion_results[1].required, true);
  });

  test(`${name}: clarification is ungraded and never reaches the model`, async () => {
    for (const message of ['What do you mean?', 'Why do you mean by which effect?', 'What does that mean?']) {
      const before = calls;
      const result = await evaluator.evaluateStudentTurn({ ...params, studentMessage: message });
      assert.equal(calls, before);
      assert.equal(result.intent, 'HELP');
      assert.equal(result.request_kind, 'clarify_term');
      assert.equal(result.is_correct, null);
    }
  });

  test(`${name}: incomplete answers preserve correct words instead of replacing the whole answer`, async () => {
    model([evidence(criteria[0], true, 'what is a force'), evidence(criteria[1], false, 'who or what can exert one')], {
      diff_html: '<del>A force is a push or pull.</del><ins>One object exerts force on another.</ins>',
      feedback: 'Push or pull is right. Add that one object exerts it on another.',
    });
    const result = await evaluator.evaluateStudentTurn({ ...params, studentMessage: 'A force is a push or pull.' });
    assert.equal(result.is_correct, false);
    assert.equal(result.diff_html, null);
    assert.equal(result.complete_answer, params.lastQuestionRubric.model_answer);
    assert.match(result.feedback, /Push or pull is right/);
  });

  test(`${name}: a keyword cannot override an explicit scientific contradiction`, async () => {
    const rubric = { criteria: [{ id: 'part', description: 'Name the structure regulating light entry.', required: true }], model_answer: 'The iris adjusts pupil size.' };
    const question = 'Which part of the eye controls the amount of light entering it?';
    model([evidence(rubric.criteria[0], true, 'Which part of the eye controls the amount of light entering it')], {
      contradictions: ['Student says the iris carries nerve signals to the brain.'],
    });
    const result = await evaluator.evaluateStudentTurn({ ...params, lastQuestionText: question, lastQuestionRubric: rubric, studentMessage: 'The iris carries nerve signals to the brain.' });
    assert.equal(result.is_correct, false);
    assert.equal(result.score_percent, 0);
  });

  test(`${name}: correction preserves a long actual wrong span without slicing deletion`, () => {
    const wrong = 'A force is something that belongs inside a ball and gets used up while the ball is moving.';
    const diff = evaluator.safeDiff(`<del>${wrong}</del><ins>A force is a push or pull.</ins>`, wrong);
    assert.equal(diff, `<del>${wrong}</del><ins>A force is a push or pull.</ins>`);
    assert.equal(evaluator.safeDiff('<del>invented words</del><ins>push</ins>', wrong), null);
  });

  test(`${name}: HTML remains escaped once and complete_answer stays plain text`, async () => {
    const raw = "The book's downward push is greater.";
    const rubric = { criteria: [{ id: 'size', description: 'Identify equal contact forces in the specified interaction.', required: true }], model_answer: "The table's upward push is equal in size to the book's downward push." };
    const question = "What size is the table's upward push compared to the book's downward push?";
    model([evidence(rubric.criteria[0], false, question)], {
      contradictions: ['The student states unequal forces.'],
      diff_html: '<del>greater</del><ins>equal in size to the book&amp;#39;s downward push</ins>',
      complete_answer: rubric.model_answer,
    });
    const result = await evaluator.evaluateStudentTurn({ ...params, lastQuestionText: question, lastQuestionRubric: rubric, studentMessage: raw });
    assert.equal(result.is_correct, false);
    assert.match(result.diff_html, /book&#039;s/);
    assert.doesNotMatch(result.diff_html, /&amp;#(?:0?39);/);
    assert.equal(result.complete_answer, rubric.model_answer);
  });
}
