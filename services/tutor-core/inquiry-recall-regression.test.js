const test = require('node:test');
const assert = require('node:assert/strict');

const question = 'Explain in your own words what an observation is, what an inference is, and give one example of each?';
const observation = 'An observation is information gathered directly through suitable senses or instruments.';
const inference = 'An inference is an explanation or conclusion based on observations and prior knowledge.';
const objectiveOnly = {
  phase: 'ROUNDUP', questionType: 'open', response_mode: 'check',
  currentGoalTitle: 'Distinguish observations and inferences',
  currentGoalDescription: 'Students will distinguish observations and inferences and give examples.',
  topicTitle: 'Introduction to Scientific Inquiry', academicNotes: null,
};
const fullRubric = {
  criteria: [
    { id: 'observation', description: observation, required: true },
    { id: 'inference', description: inference, required: true },
    { id: 'observation_example', description: 'Gives an example of directly observed information.', required: true },
    { id: 'inference_example', description: 'Gives an evidence-based interpretation of that information.', required: true },
  ],
  model_answer: `${observation} ${inference} Seeing wet ground is an observation; concluding it may have rained is an inference.`,
};

for (const filename of ['./validate', '../../ai/agents/socratic-tutor/formatters/bubble-formatter']) {
  const V = require(filename);
  test(`${filename}: exact inquiry source asks for three components, not one source sentence`, () => {
    const out = V.buildFocusedFallback({ ...objectiveOnly,
      currentGoalTitle: 'Identify core components of scientific inquiry',
      currentGoalDescription: 'Scientific inquiry includes observation, curiosity and questioning.',
    });
    assert.equal(out.messages[0].message, 'Name all 3 components of scientific inquiry?');
    assert.equal(out.lastQuestionRubric.criteria.length, 3);
    assert.ok(out.lastQuestionRubric.criteria.every(criterion => criterion.required));
    assert.deepEqual(out.lastQuestionRubric.criteria.map(criterion => criterion.description), [
      'Scientific inquiry includes observation.',
      'Scientific inquiry includes curiosity.',
      'Scientific inquiry includes questioning.',
    ]);
    assert.doesNotMatch(out.messages[0].message, /State the 1 key facts/);
  });

  test(`${filename}: curiosity recall asks about the sourced causal relationship`, () => {
    const out = V.buildFocusedFallback({ ...objectiveOnly, currentGoalTitle: 'Role of curiosity and questioning',
      currentGoalDescription: 'Curiosity sparks questions that begin scientific investigations.' });
    assert.equal(out.messages[0].message, 'What does curiosity spark?');
    assert.equal(out.lastQuestionRubric.criteria.length, 1);
    assert.doesNotMatch(out.messages[0].message, /key facts|learned about|role of/i);
  });

  test(`${filename}: an unscoped factual fragment cannot become a vague objective-heading question`, () => {
    const out = V.buildFocusedFallback({ ...objectiveOnly, currentGoalTitle: 'Role of curiosity and questioning',
      currentGoalDescription: 'Curiosity, questioning and observation.' });
    assert.equal(out.fallbackQuestionType, 'none');
    assert.equal(out.lastQuestionRubric, null);
    assert.equal(out.fallbackReason, 'recall_scope_unavailable');
  });

  test(`${filename}: a valid generated final recall survives an objective-only stored goal`, () => {
    assert.equal(V.wordCount(question), 19);
    const out = V.enforce({ messages: [{ message: 'You recalled the previous topic correctly.' }, { message: question }],
      lastQuestionRubric: fullRubric }, objectiveOnly);
    assert.equal(out.questionType, 'open');
    assert.equal(out.messages.at(-1).message, question);
    assert.equal(out.lastQuestionRubric.criteria.length, 4);
    assert.equal(out.questionReplaced, false);
    assert.notEqual(out.taskRepair, true);
    assert.equal(out.messages.length, 1, 'Fresh recall does not leak the answer before assessment');
    assert.equal(out.questionRecord.questionText, question);
  });

  test(`${filename}: complete source-backed generated recall is retained instead of replaced`, () => {
    const source = `${observation}; ${inference}`;
    const out = V.enforce({ messages: [{ message: question }], lastQuestionRubric: fullRubric }, {
      ...objectiveOnly, currentGoalDescription: source,
    });
    assert.equal(out.messages.at(-1).message, question);
    assert.equal(out.lastQuestionRubric.criteria.length, 4);
    assert.equal(out.questionReplaced, false);
  });

  test(`${filename}: a narrower definition task cannot drop a known inference requirement`, () => {
    const source = `${observation}; ${inference}`;
    const out = V.enforce({ messages: [{ message: 'What is an observation?' }],
      lastQuestionRubric: { criteria: [{ id: 'observation', description: observation, required: true }], model_answer: observation } },
    { ...objectiveOnly, currentGoalDescription: source });
    assert.equal(out.messages.at(-1).message, 'Define observation and inference?');
    assert.equal(out.lastQuestionRubric.criteria.length, 2);
    assert.match(out.lastQuestionRubric.model_answer, /inference/);
    assert.equal(out.questionReplaced, true);
  });

  test(`${filename}: a neutral evaluator outage retry remains unassisted`, () => {
    const out = V.enforce({ messages: [{ message: observation }, { message: question }], lastQuestionRubric: fullRubric },
    { ...objectiveOnly, sameAssessment: true, lastQuestionText: question, lastQuestionRubric: fullRubric,
      stateInstruction: 'reask_shorter', evaluatorResult: { intent: 'ANSWER', is_correct: null, evaluation_status: 'unavailable' } });
    assert.equal(out.questionAssisted, false);
    assert.equal(out.questionRecord.assisted, false);
    assert.equal(out.messages.length, 1, 'A neutral retry cannot leak a hint through its feedback bubble');
    assert.equal(out.messages[0].message, question);
    assert.equal(out.lastQuestionRubric.criteria.length, 4);
  });

  test(`${filename}: actual hint/correction on a recall retry is marked assisted`, () => {
    const out = V.enforce({ messages: [{ message: observation }, { message: question }], lastQuestionRubric: fullRubric },
    { ...objectiveOnly, sameAssessment: true, lastQuestionText: question, lastQuestionRubric: fullRubric,
      stateInstruction: 'correct_and_reask', evaluatorResult: { intent: 'ANSWER', is_correct: false } });
    assert.equal(out.questionAssisted, true);
    assert.equal(out.questionRecord.assisted, true);
    assert.equal(out.messages.length, 2);
    assert.equal(out.lastQuestionRubric.criteria.length, 4);
  });

  test(`${filename}: a complete model answer cannot conceal a narrower private rubric`, () => {
    const out = V.enforce({ messages: [{ message: 'Define observation and inference?' }],
      lastQuestionRubric: { criteria: [{ id: 'observation', description: observation, required: true }], model_answer: `${observation} ${inference}` } },
    { ...objectiveOnly, currentGoalDescription: `${observation}; ${inference}` });
    assert.equal(out.lastQuestionRubric.criteria.length, 2);
    assert.equal(out.questionReplaced, true);
  });

  test(`${filename}: a recall retry cannot silently drop a prior explicitly requested example`, () => {
    const out = V.enforce({ messages: [{ message: 'What is an observation?' }],
      lastQuestionRubric: { criteria: [{ id: 'observation', description: observation, required: true }], model_answer: observation } },
    { ...objectiveOnly, sameAssessment: true, questionAssisted: true, lastQuestionText: question, lastQuestionRubric: fullRubric });
    assert.equal(out.lastQuestionRubric.criteria.length, 4);
    assert.equal(out.messages.at(-1).message, question);
    assert.equal(out.questionAssisted, true);
  });
}

// Importing each provider seam with a stub ensures no paid request is made.
for (const specifier of ['../ai/deepseek-client', '../../ai/providers']) {
  const filename = require.resolve(specifier);
  require.cache[filename] = { id: filename, filename, loaded: true, exports: {
    invokeModel: async () => { throw new Error('No provider calls in prompt test'); }, extractJson: JSON.parse,
  } };
}

for (const filename of ['./tutor-generator', '../../ai/agents/socratic-tutor/generators/dialogue-generator']) {
  const G = require(filename);
  test(`${filename}: inquiry prompt distinguishes evidence from guesses and requires suitable observations`, () => {
    const prompt = G.buildTutorPrompt({ ...objectiveOnly, topicContent: `${observation} ${inference}`,
      stateInstruction: 'roundup_recall', goals: [{ title: objectiveOnly.currentGoalTitle, description: objectiveOnly.currentGoalDescription }],
      classLevel: 'Class 6 CBSE', evaluatorResult: {} });
    assert.match(prompt, /inference is an explanation or conclusion based on observations and prior knowledge/i);
    assert.match(prompt, /not an unsupported guess/i);
    assert.match(prompt, /Do not require all five senses/);
    assert.match(prompt, /Touch cannot establish a below-zero temperature/);
    assert.match(prompt, /Being on the ground alone does not establish rest/);
    assert.match(prompt, /ball's name does not establish its colour/);
    assert.match(prompt, /Never count source sentences as answer parts/);
  });
}
