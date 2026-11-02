const test = require('node:test');
const assert = require('node:assert/strict');

// Prompt construction only. Provider calls must stay offline even when a
// developer has production credentials configured in their shell.
for (const name of ['../ai/deepseek-client', '../../ai/providers']) {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports: {
    invokeModel: async () => { throw new Error('No live calls in prompt preservation tests.'); },
    extractJson: JSON.parse,
  } };
}

const book = `Section 2.1 What is a force?
A force is a push or pull acting on an object.

Activity 2.1 Exploring Forces
Press a rubber ball on a table. What change do you observe?

Questions
1. Give two examples of a force.

What you have learnt
Force can change motion or shape.

A step further
Explore forces in a game.`;
const params = {
  topicTitle: 'What is a Force?', currentGoalTitle: 'Define force',
  currentGoalDescription: 'A force is a push or pull acting on an object.',
  topicTextbook: book, topicContent: 'An abbreviated legacy topic summary.',
  classLevel: 'Class 8 CBSE', subjectName: 'Science',
  phase: 'DIALOGUE', questionType: 'open', stateInstruction: 'hint_then_easier',
  studentMessage: 'Motion', evaluatorResult: { intent: 'ANSWER', is_correct: false },
};

const formats = [
  'NOT question:', 'Statements:', 'Situation:', 'Reason:', 'Consequence:',
  'Experiment:', 'Term in context:', 'Diagram:', 'Assertion-Reason', 'Case-based',
];
function inspect(prompt) {
  const data = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"topic":')));
  const schema = JSON.parse(prompt.split('\nSCHEMA:\n').at(-1));
  return { prompt, data, schema };
}

for (const [route, moduleName] of [
  ['local', './tutor-generator'],
  ['agent', '../../ai/agents/socratic-tutor/generators/dialogue-generator'],
]) {
  const { buildTutorPrompt } = require(moduleName);

  test(`${route}: preserves the Master NCERT prompt and all ten reasoning formats`, () => {
    const { prompt } = inspect(buildTutorPrompt(params));
    assert.match(prompt, /from the NCERT textbook/);
    assert.match(prompt, /QUESTION FORMATS \(for reasoning questions\)/);
    for (const format of formats) assert.ok(prompt.includes(format), format);
    assert.match(prompt, /Classes 9 and 10 only: Assertion-Reason/);
    assert.match(prompt, /SAFETY AND SENSITIVE TOPICS/);
  });

  test(`${route}: keeps structured passages, question bank, activities, summary and extras`, () => {
    const { data } = inspect(buildTutorPrompt(params));
    assert.equal(data.textbook_material, book, 'The real textbook wins over the short topic summary.');
    assert.ok(data.textbook.passages.length);
    assert.ok(data.textbook.question_bank.length);
    assert.ok(data.textbook.activities.length);
    assert.ok(data.textbook.summary);
    assert.ok(data.textbook.step_further);
    assert.ok(data.textbook.section_numbers.length);
  });

  test(`${route}: written first recall remains uncoached and complete; reasoning MCQ uses exact task criteria`, () => {
    const first = inspect(buildTutorPrompt({ ...params, phase: 'ROUNDUP', questionType: 'open', stateInstruction: 'roundup_recall' }));
    assert.match(first.prompt, /First ask the goal's prepared written recall question without hints/);
    assert.match(first.prompt, /ALL distinct required core facts explicitly requested/);
    assert.ok(!first.schema.messages.at(-1).options);
    const second = inspect(buildTutorPrompt({ ...params, phase: 'ROUNDUP', questionType: 'mcq', stateInstruction: 'roundup_reasoning_mcq' }));
    assert.match(second.prompt, /When the DIRECTIVE asks for the second reasoning question/);
    assert.ok(second.schema.messages.at(-1).options.length >= 2);
    assert.ok(second.schema.lastQuestionRubric.correct_option_text);
    assert.doesNotMatch(second.prompt, /For ROUNDUP: require ALL/);
    assert.doesNotMatch(second.prompt, /must copy each of those facts word for word/);
  });

  test(`${route}: first error gets a natural hint and support choices remain server controlled`, () => {
    const { prompt, schema } = inspect(buildTutorPrompt(params));
    assert.match(prompt, /On a first wrong answer.*natural Socratic hint/);
    assert.match(prompt, /unless the server explicitly selects offer_choice/);
    assert.ok(schema.lastQuestionRubric);
    assert.doesNotMatch(JSON.stringify(schema), /I want another try/);
    const choice = inspect(buildTutorPrompt({ ...params, response_mode: 'offer_choice', stateInstruction: 'offer_choice' }));
    assert.equal(choice.schema.lastQuestionRubric, null);
    assert.match(JSON.stringify(choice.schema), /I want another try/);
  });

  test(`${route}: definitions, exact rubrics, help and media safeguards upgrade without forced analogies`, () => {
    const { prompt, schema } = inspect(buildTutorPrompt(params));
    assert.match(prompt, /Give the readable textbook definition before asking/);
    assert.match(prompt, /any N complete valid examples suffice/);
    assert.match(prompt, /Current student requests for help, clarification, recap/);
    assert.match(prompt, /without repeatedly saying "NCERT says"/);
    assert.match(prompt, /Diagrams, concept maps and videos are selective aids/);
    assert.match(prompt, /Never turn a title, objective or source fragment/);
    assert.doesNotMatch(JSON.stringify(schema), /everyday analogy/);
  });

  test(`${route}: explicit explanation mode never forces a quiz or private rubric`, () => {
    const { prompt, schema } = inspect(buildTutorPrompt({ ...params, response_mode: 'explain', stateInstruction: 'explain_answer' }));
    assert.match(prompt, /Do not ask a check question, offer choices, or create a rubric/);
    assert.equal(schema.lastQuestionRubric, null);
    assert.doesNotMatch(JSON.stringify(schema), /Focused.*question|everyday analogy/);
  });
}
