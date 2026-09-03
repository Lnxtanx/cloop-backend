const test = require('node:test');
const assert = require('node:assert');
const { findLastQuestion } = require('./orchestrator');

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
