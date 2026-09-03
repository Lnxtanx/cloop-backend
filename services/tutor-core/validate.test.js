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
  assert.ok(res.messages.length <= 2, `Expected <= 2 bubbles for turn, got ${res.messages.length}`);
});


test('sanitizes bloated diff_html', () => {
  const giantIns = '<del>wrong</del><ins>This is a super ridiculously long explanation that the model wrote instead of a clean short diff tag.</ins>';
  const res = V.sanitizeDiffHtml(giantIns, 'wrong');
  assert.ok(res.includes('<del>wrong</del>'), 'Missing del tag');
  const insWords = V.wordCount(res.match(/<ins>(.*?)<\/ins>/)[1]);
  assert.ok(insWords <= 15, `insWords exceeded 15 words: ${insWords}`);
});

test('strips pill narration so the question stands alone', () => {
  // A real production failure: the tutor spent the student's only bubble
  // sending them to a card instead of asking something they could answer.
  const cases = [
    ["Open the 'Remember This' card, then tell me: why does it rust?", 'why does it rust?'],
    ['Check the diagram below and then answer this. Which one?', 'Which one?'],
    ['Tap the card to see more. What happens next?', 'What happens next?'],
    ['Copy it down. Is iron or copper more reactive?', 'Is iron or copper more reactive?'],
  ];
  for (const [input, expected] of cases) {
    const out = V.enforce({ messages: [{ message: input }] }, { phase: 'TEACH', fallbackQuestion: 'Why?' });
    const joined = out.messages.map(m => m.message).join(' ');
    assert.strictEqual(joined, expected, `not stripped: ${input}`);
  }
});

test('leaves an ordinary question untouched', () => {
  const q = 'Why does iron rust faster in the monsoon?';
  const out = V.enforce({ messages: [{ message: q }] }, { phase: 'TEACH', fallbackQuestion: 'Why?' });
  assert.strictEqual(out.messages[0].message, q);
});

test('strips options when questionType is open', () => {
  const raw = {
    messages: [
      {
        message: 'What is water made of?',
        message_type: 'text',
        options: [{ text: 'Hydrogen and oxygen', value: 'A' }]
      }
    ]
  };
  const out = V.enforce(raw, { phase: 'DIALOGUE', questionType: 'open' });
  assert.strictEqual(out.messages[0].options, undefined, 'Options should be stripped on open turns');
});

test('preserves options when questionType is mcq', () => {
  const opts = [{ text: 'Hydrogen and oxygen', value: 'A' }, { text: 'Helium and neon', value: 'B' }];
  const raw = {
    messages: [
      {
        message: 'What is water made of?',
        message_type: 'text',
        options: opts
      }
    ]
  };
  const out = V.enforce(raw, { phase: 'CHECK', questionType: 'mcq' });
  assert.deepStrictEqual(out.messages[0].options, opts, 'Options should be preserved on MCQ turns');
});

