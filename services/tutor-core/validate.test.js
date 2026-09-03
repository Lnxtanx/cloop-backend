const test = require('node:test');
const assert = require('node:assert');
const V = require('./validate');

test('purges blank and whitespace-only bubbles', () => {
  const raw = {
    messages: [
      { message: '   ', message_type: 'text' },
      { message: '\n\t  ', message_type: 'text' },
      { message: 'What is carbon?', message_type: 'text' }
    ]
  };
  const res = V.enforce(raw, { phase: 'TEACH' });
  assert.strictEqual(res.messages.length, 1);
  assert.strictEqual(res.messages[0].message, 'What is carbon?');
});

test('splits bubbles exceeding 20 words into micro-bubbles', () => {
  const longText = 'Carbon is an extraordinary chemical element with atomic number six because it can form four strong covalent bonds with other atoms.';
  const raw = {
    messages: [
      { message: longText, message_type: 'text' }
    ]
  };
  const res = V.enforce(raw, { phase: 'TEACH', fallbackQuestion: 'Can you name another element?' });

  for (const msg of res.messages) {
    const wc = V.wordCount(msg.message);
    assert.ok(wc <= V.MAX_WORDS_PER_BUBBLE, `Bubble exceeded 20 words (${wc} words): "${msg.message}"`);
  }
  assert.ok(res.messages.length >= 2, 'Expected long text to be split into at least 2 bubbles');
});

test('guarantees terminal question when model forgot', () => {
  const raw = {
    messages: [
      { message: 'Carbon shares electrons.', message_type: 'text' }
    ]
  };
  const res = V.enforce(raw, { phase: 'TEACH', fallbackQuestion: 'How many electrons does it share?' });
  const last = res.messages[res.messages.length - 1];
  assert.ok(V.endsWithQuestion(last.message), `Last bubble did not end with question: "${last.message}"`);
});

test('reconciles tone by stripping unearned praise on incorrect answers', () => {
  const raw = {
    messages: [
      { message: 'Great job! But carbon cannot form ionic bonds.', message_type: 'text' },
      { message: 'Why do you think that is?', message_type: 'text' }
    ]
  };
  const res = V.enforce(raw, { isCorrect: false, phase: 'TEACH' });
  assert.ok(!res.messages[0].message.toLowerCase().startsWith('great job'), 'Praise was not stripped on wrong answer');
});

test('caps bubble count to maxAllowedBubbles', () => {
  const raw = {
    messages: [
      { message: 'One.', message_type: 'text' },
      { message: 'Two.', message_type: 'text' },
      { message: 'Three.', message_type: 'text' },
      { message: 'Four?', message_type: 'text' },
      { message: 'Five?', message_type: 'text' }
    ]
  };
  const res = V.enforce(raw, { isCorrect: true, phase: 'TEACH' });
  assert.ok(res.messages.length <= 3, `Expected <= 3 bubbles for normal turn, got ${res.messages.length}`);
});

test('sanitizes bloated diff_html', () => {
  const giantIns = '<del>wrong</del><ins>This is a super ridiculously long explanation that the model wrote instead of a clean short diff tag.</ins>';
  const res = V.sanitizeDiffHtml(giantIns, 'wrong');
  assert.ok(res.includes('<del>wrong</del>'), 'Missing del tag');
  const insWords = V.wordCount(res.match(/<ins>(.*?)<\/ins>/)[1]);
  assert.ok(insWords <= 15, `insWords exceeded 15 words: ${insWords}`);
});
