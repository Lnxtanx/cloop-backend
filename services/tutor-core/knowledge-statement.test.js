/**
 * global_topic_goals.knowledge_statement: the facts a goal teaches.
 *
 * Goal descriptions are mostly learning objectives ("Students will..."). The
 * validator rightly refuses to treat an objective as a fact, so before this
 * column existed, objective-only goals left ROUNDUP with no fallback question
 * and recaps with nothing to list. These tests pin the knowledge statement as
 * the first source everywhere facts are read, in both validator copies and
 * both prompt builders, because production runs the agent's copies.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

for (const specifier of ['../ai/deepseek-client', '../../ai/providers']) {
  const filename = require.resolve(specifier);
  require.cache[filename] = { id: filename, filename, loaded: true, exports: {
    invokeModel: async () => { throw new Error('No provider calls in unit tests'); }, extractJson: JSON.parse,
  } };
}

const { buildAcademicNotes, prepareAcademicGoals } = require('./academic-notes');

const OBSERVATION = 'An observation is information gathered directly through the senses or instruments';
const INFERENCE = 'an inference is a conclusion based on observations and prior knowledge.';
const goal = {
  title: 'Differentiate between observations and inferences',
  description: 'Students will differentiate between observations and inferences using everyday examples.',
  knowledge_statement: `${OBSERVATION}; ${INFERENCE}`,
  knowledge_verified: false,
};

test('notes are built from the knowledge statement, not the objective', () => {
  const notes = buildAcademicNotes(goal, '');
  assert.ok(notes.exam_points.some(p => p.startsWith('An observation is information')));
  assert.ok(!notes.exam_points.some(p => /Students will/.test(p)), 'the objective is not an exam point');
  assert.equal(notes.knowledge_statement, goal.knowledge_statement);
  assert.equal(notes.knowledge_verified, false, 'an unreviewed statement stays marked unreviewed');
});

test('without a statement, notes fall back to the description exactly as before', () => {
  const { knowledge_statement, knowledge_verified, ...plain } = goal;
  const notes = buildAcademicNotes(plain, '');
  assert.equal(notes.knowledge_statement, null);
  assert.equal(notes.knowledge_verified, null);
  assert.deepEqual(notes.exam_points, [plain.description]);
});

test('adding or correcting a statement invalidates saved notes', () => {
  const { knowledge_statement, ...before } = goal;
  const a = prepareAcademicGoals([before], '').fingerprint;
  const b = prepareAcademicGoals([goal], '').fingerprint;
  const c = prepareAcademicGoals([{ ...goal, knowledge_statement: `${OBSERVATION}.` }], '').fingerprint;
  assert.notEqual(a, b);
  assert.notEqual(b, c);
});

for (const filename of ['./validate', '../../ai/agents/socratic-tutor/formatters/bubble-formatter']) {
  const V = require(filename);
  const roundup = { phase: 'ROUNDUP', questionType: 'open', response_mode: 'check', stateInstruction: 'roundup_recall',
    topicTitle: 'Introduction to Scientific Inquiry', currentGoalTitle: goal.title,
    currentGoalDescription: goal.description, sameAssessment: false };

  test(`${filename}: an objective-only goal yields facts once it has a statement`, () => {
    assert.deepEqual(V.sourceFactsFor({ currentGoalDescription: goal.description }), []);
    assert.equal(V.sourceFactsFor({ currentGoalDescription: goal.description,
      currentGoalKnowledge: goal.knowledge_statement }).length, 2);
    assert.equal(V.sourceFactsFor({ currentGoalDescription: goal.description,
      academicNotes: { knowledge_statement: goal.knowledge_statement } }).length, 2,
      'the statement also arrives through the academic notes');
  });

  test(`${filename}: the curated statement outranks a factual-looking description`, () => {
    const facts = V.sourceFactsFor({ currentGoalDescription: 'Inference is guessing.',
      currentGoalKnowledge: goal.knowledge_statement });
    assert.ok(!facts.includes('Inference is guessing.'));
    assert.ok(facts.some(f => f.startsWith('An observation is information')));
  });

  test(`${filename}: recap reads every goal's statement, not only the current goal's`, () => {
    const topic = V.topicFactsFor({ goals: [
      { title: 'Components', description: 'Students will identify components.', knowledge_statement: 'Scientific inquiry includes curiosity, questioning and observation.' },
      { title: 'Curiosity', description: 'Students will explain curiosity.', knowledge_statement: 'Curiosity sparks questions that begin scientific investigations.' },
      goal,
    ] });
    assert.deepEqual(topic.map(g => g.facts.length), [1, 1, 2]);
  });

  test(`${filename}: the fallback recall question is built from the statement`, () => {
    const out = V.buildFocusedFallback({ ...roundup, academicNotes: { knowledge_statement: goal.knowledge_statement } });
    assert.equal(out.messages[0].message, 'Define observation and inference?');
    assert.equal(out.lastQuestionRubric.criteria.length, 2);
    assert.notEqual(out.fallbackQuestionType, 'none');
  });

  test(`${filename}: DeepSeek's own recall question survives when its rubric copies the statement`, () => {
    const question = 'Explain what an observation is and what an inference is, and give one example of each?';
    const out = V.enforce({ messages: [{ message: question }], lastQuestionRubric: { criteria: [
      { id: 'obs', description: `${OBSERVATION}.`, required: true },
      { id: 'inf', description: INFERENCE, required: true },
      { id: 'ex', description: 'Gives one example of each.', required: true },
    ], model_answer: goal.knowledge_statement } }, { ...roundup, academicNotes: { knowledge_statement: goal.knowledge_statement } });
    assert.equal(out.messages.at(-1).message, question);
    assert.equal(out.questionReplaced, false);
  });

  test(`${filename}: a recall rubric that drops a stated fact is replaced, not graded`, () => {
    const out = V.enforce({ messages: [{ message: 'What is an observation?' }], lastQuestionRubric: { criteria: [
      { id: 'obs', description: `${OBSERVATION}.`, required: true }], model_answer: OBSERVATION } },
    { ...roundup, academicNotes: { knowledge_statement: goal.knowledge_statement } });
    assert.equal(out.messages.at(-1).message, 'Define observation and inference?');
    assert.equal(out.lastQuestionRubric.criteria.length, 2);
  });
}

for (const filename of ['./tutor-generator', '../../ai/agents/socratic-tutor/generators/dialogue-generator']) {
  const G = require(filename);
  test(`${filename}: the statement reaches DeepSeek as key facts, with the copy-verbatim rule`, () => {
    const prompt = G.buildTutorPrompt({ topicTitle: 'Introduction to Scientific Inquiry', currentGoalTitle: goal.title,
      currentGoalDescription: goal.description, goals: [goal], phase: 'ROUNDUP', stateInstruction: 'roundup_recall',
      academicNotes: buildAcademicNotes(goal, ''), classLevel: 'Class 6 CBSE', evaluatorResult: {} });
    assert.match(prompt, /An observation is information gathered directly through the senses or instruments/);
    assert.match(prompt, /must copy each of those facts word for word/);
  });
}
