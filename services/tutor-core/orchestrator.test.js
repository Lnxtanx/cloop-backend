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
