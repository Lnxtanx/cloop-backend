const test = require('node:test');
const assert = require('node:assert/strict');

const modelPath = require.resolve('../ai/deepseek-client');
let response;
let failure;
let lastPrompt;
require.cache[modelPath] = {
  id: modelPath, filename: modelPath, loaded: true,
  exports: {
    invokeModel: async (prompt) => { lastPrompt = prompt; if (failure) throw failure; return response; },
    extractJson: JSON.parse
  }
};
const { generateTutorResponse, buildTutorPrompt, guidanceFor } = require('./tutor-generator');

const rubric = { criteria: [{ id: 'direction', description: 'Force can change direction', required: true }], model_answer: 'Force can change direction' };
const params = {
  topicTitle: 'Effects of force', currentGoalTitle: 'Change of shape',
  currentGoalDescription: 'A force can change shape; stretching, compressing and bending are shape changes',
  previousGoalTitle: 'Change of direction', previousGoalDescription: 'A force can change direction',
  lastQuestionText: 'What does hitting a moving ball sideways change?', lastQuestionRubric: rubric,
  phase: 'DIALOGUE', questionType: 'open', stateInstruction: 'open_goal_dialogue',
  studentMessage: 'friction', evaluatorResult: { intent: 'ANSWER', is_correct: false, complete_answer: 'Force can change direction' },
  sameAssessment: false
};

function reset() { failure = null; response = ''; }

test('generated question retains its private grading rubric', async () => {
  reset();
  response = JSON.stringify({ messages: [{ message: 'What happens when a sponge is squeezed?', message_type: 'text' }], lastQuestionRubric: { criteria: [{ id: 'shape', description: 'Its shape changes', required: true }], model_answer: 'Its shape changes' } });
  const out = await generateTutorResponse(params);
  assert.strictEqual(out.lastQuestionRubric.model_answer, 'Its shape changes');
  assert.ok(lastPrompt.includes('"is_correct":false'));
  assert.ok(lastPrompt.includes('"previous_goal":{"title":"Change of direction"'));
  assert.ok(lastPrompt.includes('"next_goal":{"title":"Change of shape"'));
  assert.ok(lastPrompt.includes('NEVER say "Exactly right"'));
});

test('roundup requires complete uncoached recall and separate factual criteria', () => {
  const prompt = buildTutorPrompt({ ...params, phase: 'ROUNDUP', stateInstruction: 'roundup_recall' });
  assert.ok(prompt.includes('ALL distinct required core facts'));
  assert.ok(prompt.includes('do not leak the current recall answer'));
  assert.ok(prompt.includes('A one-word answer to one component does not satisfy a multi-part rubric'));
  assert.ok(prompt.includes('If same_assessment is false, assistance directives apply only to the prior answer'));
  assert.ok(!prompt.includes('start bubble 1 with a clear, concise validation'));
});

test('an initial turn has neutral evaluation instead of an invented answer verdict', () => {
  const prompt = buildTutorPrompt({ ...params, evaluatorResult: undefined, studentMessage: '' });
  assert.ok(prompt.includes('"intent":"NONE","is_correct":null'));
});

test('a failed new question generates grounded recall rather than a dummy MCQ', async () => {
  reset(); failure = new Error('model unavailable');
  const out = await generateTutorResponse({ ...params, phase: 'CHECK', questionType: 'mcq', stateInstruction: 'assess_with_mcq' });
  assert.strictEqual(out.fallbackQuestionType, 'open');
  assert.ok(out.messages.at(-1).message.includes('Change of shape'));
  assert.strictEqual(out.messages.at(-1).options, undefined);
  assert.strictEqual(out.lastQuestionRubric.criteria.length, 2);
  assert.ok(!JSON.stringify(out).includes('Correct concept principle'));
});

test('failed retry repeats the actual pending assessment and explains its stored answer first', async () => {
  reset(); failure = new Error('model unavailable');
  const out = await generateTutorResponse({ ...params, sameAssessment: true, stateInstruction: 'hint_then_easier' });
  assert.strictEqual(out.messages[0].message, 'Force can change direction');
  assert.strictEqual(out.messages.at(-1).message, params.lastQuestionText);
  assert.deepStrictEqual(out.lastQuestionRubric, rubric);
});

test('failed new roundup does not leak a definition before asking recall', async () => {
  reset(); failure = new Error('model unavailable');
  const out = await generateTutorResponse({ ...params, phase: 'ROUNDUP', stateInstruction: 'hint_then_easier', sameAssessment: false });
  assert.strictEqual(out.messages.length, 1);
  assert.ok(out.messages[0].message.includes('Change of shape'));
});

test('failed roundup retry teaches first while retaining the complete pending question', async () => {
  reset(); failure = new Error('model unavailable');
  const out = await generateTutorResponse({ ...params, phase: 'ROUNDUP', stateInstruction: 'hint_then_easier', sameAssessment: true });
  assert.strictEqual(out.messages.length, 2);
  assert.strictEqual(out.messages[0].message, 'Force can change direction');
  assert.strictEqual(out.messages.at(-1).message, params.lastQuestionText);
  assert.deepStrictEqual(out.lastQuestionRubric, rubric);
});

test('missing rubric is treated as a generation failure', async () => {
  reset(); response = JSON.stringify({ messages: [{ message: 'What happens to the ball?' }] });
  const out = await generateTutorResponse(params);
  assert.strictEqual(out.fallbackQuestionType, 'open');
  assert.strictEqual(out.lastQuestionRubric.model_answer, params.currentGoalDescription);
});

test('early wrap language does not celebrate full completion or confirmed mastery', async () => {
  reset(); failure = new Error('model unavailable');
  const reportBrief = { overall_mastery_percent: 40, ended_reason: 'turn_limit', session_completed: false, recall_completed: false };
  const out = await generateTutorResponse({ ...params, phase: 'WRAP', stateInstruction: 'wrap_with_report', reportBrief });
  assert.strictEqual(out.lastQuestionRubric, null);
  assert.ok(!/great job|finished|completed|mastery/i.test(out.messages[0].message));
  const guidance = guidanceFor('wrap_with_report', reportBrief);
  assert.ok(guidance.includes('40%'));
  assert.ok(guidance.includes('Do not claim all goals achieved'));
});

test('fallback teaching searches stored facts when the preferred answer exceeds the bubble limit', async () => {
  reset(); failure = new Error('model unavailable');
  const longAnswer = 'A force applied to a moving object can change several properties of that object depending on the size and direction of the force acting upon it.';
  const out = await generateTutorResponse({ ...params, sameAssessment: true, stateInstruction: 'hint_then_easier',
    evaluatorResult: { ...params.evaluatorResult, complete_answer: longAnswer },
    lastQuestionRubric: { ...rubric, model_answer: longAnswer },
    previousGoalDescription: 'A force can change direction; a sideways push can turn a moving ball' });
  assert.strictEqual(out.messages[0].message, 'A force can change direction');
  assert.strictEqual(out.messages.at(-1).message, params.lastQuestionText);
});

test('prompt contains no unfilled template interpolation placeholders', () => {
  const prompt = buildTutorPrompt(params);
  assert.ok(!/\$\{[^}]+\}/.test(prompt), 'Prompt should not contain raw ${...} template placeholders');
});

test('prompt contains no test-prep, JEE, NEET, or final-test language', () => {
  const prompt = buildTutorPrompt(params);
  assert.ok(!/\b(JEE|NEET|mock[- ]?test|final[- ]?test|test your mastery)\b/i.test(prompt));
});

test('history filters card rows like Concept Diagram, YouTube Video, and Revision Sheet', () => {
  const historyWithCards = [
    { sender: 'user', message: 'Hello' },
    { sender: 'ai', message: 'Concept Diagram', message_type: 'mermaid_diagram' },
    { sender: 'ai', message: 'YouTube Video', message_type: 'youtube_video' },
    { sender: 'ai', message: 'Revision Sheet', message_type: 'revision_sheet' },
    { sender: 'ai', message: 'What is force?' },
  ];
  const prompt = buildTutorPrompt({ ...params, recentHistory: historyWithCards });
  assert.ok(!prompt.includes('"Concept Diagram"'));
  assert.ok(!prompt.includes('"YouTube Video"'));
  assert.ok(!prompt.includes('"Revision Sheet"'));
  assert.ok(prompt.includes('"What is force?"'));
});

test('history retains up to 7 real conversation turns instead of capping at 4', () => {
  const longHistory = Array.from({ length: 10 }, (_, i) => ({
    sender: i % 2 === 0 ? 'user' : 'ai',
    message: `Message turn ${i + 1}`
  }));
  const prompt = buildTutorPrompt({ ...params, recentHistory: longHistory });
  assert.ok(prompt.includes('Message turn 4'));
  assert.ok(prompt.includes('Message turn 10'));
  assert.ok(!prompt.includes('Message turn 3'));
});

test('asked questions are extracted and listed in turnData to prevent repetition', () => {
  const history = [
    { sender: 'ai', message: 'What happens when a sponge is compressed?' },
    { sender: 'user', message: 'It changes shape' },
    { sender: 'ai', message: 'Can you give another example of shape change?' },
    { sender: 'user', message: 'Stretching rubber' },
  ];
  const prompt = buildTutorPrompt({ ...params, recentHistory: history, lastQuestionText: 'Can you give another example of shape change?' });
  assert.ok(prompt.includes('"asked_questions":'));
  assert.ok(prompt.includes('What happens when a sponge is compressed?'));
  assert.ok(prompt.includes('Can you give another example of shape change?'));
});

test('prompt enforces strict rule never to repeat a question', () => {
  const prompt = buildTutorPrompt(params);
  assert.ok(prompt.includes('NEVER REPEAT A QUESTION'));
  assert.ok(prompt.includes('Never repeat a question you have already asked'));
});

test('session goal map tracks progress with covered, current, and upcoming statuses', () => {
  const goals = [
    { id: 1, title: 'Push and pull' },
    { id: 2, title: 'Change of direction' },
    { id: 3, title: 'Change of shape' },
  ];
  const prompt = buildTutorPrompt({ ...params, goals, goalIndex: 2 });
  assert.ok(prompt.includes('goal 3 of 3'));
  assert.ok(prompt.includes('"status":"covered"'));
  assert.ok(prompt.includes('"status":"current"'));
});

test('goal map describes what the current phase is for', () => {
  const prompt = buildTutorPrompt({ ...params, phase: 'DIALOGUE' });
  assert.ok(prompt.includes('"phase_purpose":'));
  assert.ok(prompt.includes('guide the student to write answers') || prompt.includes('teach'));
});

test('when AKG is absent, fallback boundaries restrict tutor to current goal and class level', () => {
  const prompt = buildTutorPrompt({ ...params, akgContext: null });
  assert.ok(prompt.includes('academic_boundaries'));
  assert.ok(prompt.includes('Stay strictly within the current goal'));
  assert.ok(prompt.includes('Class 10'));
});
