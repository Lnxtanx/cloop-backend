const test = require('node:test');
const assert = require('node:assert');
const { findLastQuestion } = require('./orchestrator');
const { resolveOptionAnswer } = require('./evaluator');

test('findLastQuestion retrieves question from state', () => {
  const state = { lastQuestionText: 'What is a covalent bond?' };
  assert.strictEqual(findLastQuestion([], state), 'What is a covalent bond?');
});

test('findLastQuestion retrieves question from chat history when state is empty', () => {
  const history = [
    { sender: 'user', message: 'Hello' },
    { sender: 'ai', message: 'Welcome! Can you tell me what carbon is?' }
  ];
  assert.strictEqual(findLastQuestion(history, null), 'Welcome! Can you tell me what carbon is?');
});

test('findLastQuestion returns default fallback when no question found', () => {
  const history = [
    { sender: 'user', message: 'Hello' }
  ];
  assert.strictEqual(findLastQuestion(history, {}), 'What do you understand about this concept?');
});

test('resolveOptionAnswer resolves letter A to option text', () => {
  const options = [
    { text: 'Salt and water', value: 'A' },
    { text: 'Acid and base', value: 'B' }
  ];
  const res = resolveOptionAnswer('A', options);
  assert.strictEqual(res.isOption, true);
  assert.strictEqual(res.resolvedText, 'Salt and water');
});

test('resolveOptionAnswer resolves Option B to option text', () => {
  const options = [
    { text: 'Salt and water', value: 'A' },
    { text: 'Acid and base', value: 'B' }
  ];
  const res = resolveOptionAnswer('Option b', options);
  assert.strictEqual(res.isOption, true);
  assert.strictEqual(res.resolvedText, 'Acid and base');
});

test('resolveOptionAnswer leaves normal written answer untouched', () => {
  const options = [
    { text: 'Salt and water', value: 'A' }
  ];
  const res = resolveOptionAnswer('The reaction produces bubbles of gas', options);
  assert.strictEqual(res.isOption, false);
  assert.strictEqual(res.resolvedText, 'The reaction produces bubbles of gas');
});

test('resolveOptionAnswer resolves exact option text match', () => {
  const options = [
    { text: 'Fatter', value: 'A' },
    { text: 'Thinner', value: 'B' }
  ];
  const res = resolveOptionAnswer('Fatter', options);
  assert.strictEqual(res.isOption, true);
  assert.strictEqual(res.resolvedText, 'Fatter');
});

test('resolveOptionAnswer resolves digit 1 or 2 to option text', () => {
  const options = [
    { text: 'Fatter', value: 'Fatter' },
    { text: 'Thinner', value: 'Thinner' }
  ];
  const res = resolveOptionAnswer('2', options);
  assert.strictEqual(res.isOption, true);
  assert.strictEqual(res.resolvedText, 'Thinner');
});

test('resolveOptionAnswer resolves plain string options', () => {
  const options = ['Fatter', 'Thinner'];
  const resA = resolveOptionAnswer('A', options);
  assert.strictEqual(resA.isOption, true);
  assert.strictEqual(resA.resolvedText, 'Fatter');

  const resText = resolveOptionAnswer('thinner', options);
  assert.strictEqual(resText.isOption, true);
  assert.strictEqual(resText.resolvedText, 'Thinner');
});

const { findLastQuestionOptions } = require('./orchestrator');

test('findLastQuestionOptions retrieves options from state first', () => {
  const state = { lastQuestionOptions: [{ text: 'Opt 1', value: 'A' }] };
  const history = [{ sender: 'ai', options: [{ text: 'Old Opt', value: 'Old' }] }];
  assert.deepStrictEqual(findLastQuestionOptions(history, state), [{ text: 'Opt 1', value: 'A' }]);
});

test('findLastQuestionOptions falls back to chat history if state has no options', () => {
  const history = [
    { sender: 'ai', message: 'Question?', options: [{ text: 'Fatter', value: 'Fatter' }] }
  ];
  assert.deepStrictEqual(findLastQuestionOptions(history, null), [{ text: 'Fatter', value: 'Fatter' }]);
});
