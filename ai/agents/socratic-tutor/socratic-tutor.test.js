const test = require('node:test');
const assert = require('node:assert/strict');

const {
  processTurn,
  initialState,
  detectRequestKind,
  detectFastIntent,
  findLastQuestion,
  closingMessage,
} = require('./index');

test('A1: Socratic Tutor initializes state properly', () => {
  const state = initialState(3);
  assert.equal(state.phase, 'PROBE');
  assert.equal(state.stuckStreak, 0);
  assert.equal(state.response_mode, 'check');
  assert.equal(state.perGoal.length, 3);
  assert.equal(state.totalTurns, 0);
});

test('A2: Fast intent detection accurately identifies user intent signals', () => {
  assert.equal(detectFastIntent("i don't know"), 'IDK');
  assert.equal(detectFastIntent('idk'), 'IDK');
  assert.equal(detectFastIntent('have no idea'), 'IDK');
  assert.equal(detectFastIntent('help me please'), 'HELP');
  assert.equal(detectFastIntent('give a hint'), 'HELP');
  assert.equal(detectFastIntent('move on to next question'), 'MOVE_ON');
  assert.equal(detectFastIntent('can you clarify the question?'), 'CLARIFICATION');
  assert.equal(detectFastIntent('the lens changes shape'), null); // candidate answer
});

test('A3: Request kind detection identifies learning choices', () => {
  assert.equal(detectRequestKind('explain the answer'), 'explain_answer');
  assert.equal(detectRequestKind('just tell me the answer'), 'explain_answer');
  assert.equal(detectRequestKind('let me try again'), 'try_again');
  assert.equal(detectRequestKind('one more chance'), 'try_again');
  assert.equal(detectRequestKind('skip this question'), 'move_on');

  // When awaiting choice
  assert.equal(detectRequestKind('1', { awaiting_learning_choice: true }), 'explain_answer');
  assert.equal(detectRequestKind('2', { awaiting_learning_choice: true }), 'try_again');
});

test('A4: findLastQuestion extracts terminal question from chat history', () => {
  const history = [
    { sender: 'user', message: 'Hello' },
    { sender: 'ai', message: "Welcome to today's topic on Human Eye!" },
    { sender: 'ai', message: 'What part of the eye changes focal length?' },
  ];
  const question = findLastQuestion(history, null);
  assert.equal(question, 'What part of the eye changes focal length?');
});

test('A5: Initial turn starts the Socratic probe session without evaluation', async () => {
  const topic = { id: 1, title: 'Power of Accommodation', content: 'The lens adjusts focal length using ciliary muscles.' };
  const goals = [
    { id: 101, title: 'Accommodation Definition', description: 'The ability of the eye lens to adjust its focal length.' },
  ];

  const result = await processTurn({
    studentMessage: '',
    topic,
    goals,
    chatHistory: [],
    currentState: null,
    userId: 1,
  });

  assert.ok(result);
  assert.equal(result.answeredPhase, 'PROBE');
  assert.equal(result.gradedThisTurn, false);
  assert.ok(Array.isArray(result.messages));
  assert.ok(result.messages.length > 0);
  assert.ok(result.nextState);
  assert.equal(result.nextState.phase, 'PROBE');
});

test('A6: Socratic Tutor handles student IDK gracefully without infinite loop', async () => {
  const topic = { id: 1, title: 'Power of Accommodation', content: 'The lens adjusts focal length using ciliary muscles.' };
  const goals = [
    { id: 101, title: 'Accommodation Definition', description: 'The ability of the eye lens to adjust its focal length.' },
  ];

  const state = initialState(1);
  state.phase = 'DIALOGUE';
  state.lastQuestionText = 'How does the eye adjust focal length?';

  const result = await processTurn({
    studentMessage: "i don't know",
    topic,
    goals,
    chatHistory: [{ sender: 'ai', message: state.lastQuestionText }],
    currentState: state,
    userId: 1,
  });

  assert.ok(result);
  assert.equal(result.intent, 'IDK');
  // State should not crash, and should provide scaffolding
  assert.ok(result.messages.length >= 1);
  assert.ok(result.nextState.unsuccessful_responses >= 1 || result.nextState.learning_support);
});
