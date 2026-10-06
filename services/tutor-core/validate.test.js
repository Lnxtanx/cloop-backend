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

test('replaces an overlong sentence with a whole focused question rather than a chopped fragment', () => {
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
  assert.strictEqual(res.messages.at(-1).message, 'Can you name another element?');
  assert.ok(!res.messages.some(m => m.message.includes('other atoms')), 'A chopped sentence tail survived');
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
    lastQuestionRubric: { criteria: [{ id: 'composition', description: 'Water contains hydrogen and oxygen', required: true }], model_answer: 'Hydrogen and oxygen', correct_option_text: 'Hydrogen and oxygen' },
    messages: [
      {
        message: 'What is water made of?',
        message_type: 'text',
        options: opts
      }
    ]
  };
  const out = V.enforce(raw, { phase: 'CHECK', questionType: 'mcq' });
  assert.deepStrictEqual(out.messages[0].options, opts.map(o => ({ text: o.text, value: o.text })), 'Option values must be real answer texts');
});

const goalContext = {
  currentGoalTitle: 'Effects of force',
  currentGoalDescription: 'Force can start or stop motion; force can change speed; force can change direction; force can change shape',
  phase: 'ROUNDUP', questionType: 'open'
};
const rubric = {
  criteria: [{ id: 'effect', description: 'Force can change shape', required: true }],
  model_answer: 'A force can change shape'
};

test('strict bubble limit is 19 words and preserves whole short questions', () => {
  const question = 'Which effect of force makes a rolling ball stop when a goalkeeper catches it carefully with both hands today during practice?';
  assert.strictEqual(V.wordCount(question), 21);
  const out = V.enforce({ messages: [{ message: question }], lastQuestionRubric: rubric }, goalContext);
  assert.ok(out.questionReplaced);
  assert.strictEqual(out.messages.at(-1).message, 'Explain "Effects of force": definition, key facts, and any formula with units?');
  assert.ok(out.messages.every(m => V.wordCount(m.message) < 20));
  assert.strictEqual(out.lastQuestionRubric.criteria.length, 4);
});

test('does not accept imperative text as a terminal question', () => {
  assert.strictEqual(V.endsWithQuestion('Explain this mechanism.'), false);
});

test('both correction tags are required', () => {
  assert.strictEqual(V.sanitizeDiffHtml('<del>wrong</del>', 'wrong'), null);
  assert.strictEqual(V.sanitizeDiffHtml('<ins>right</ins>', 'wrong'), null);
});

test('rebuilds correction HTML with escaped student and model text', () => {
  const diff = '<del onclick="alert(1)"><img src=x onerror=alert(1)></del><ins style="color:red"><script>alert(2)</script>force</ins>';
  const out = V.sanitizeDiffHtml(diff);
  assert.ok(out.startsWith('<del>&lt;img'));
  assert.ok(out.includes('<ins>&lt;script&gt;'));
  assert.ok(!/<(?:script|img)\b/i.test(out));
  assert.ok(!/<(?:del|ins)\s/i.test(out));
});

test('removes false praise for wrong and unassessed answers while preserving science prose', () => {
  for (const phrase of ['Exactly right!', 'Correct!', 'That is correct.', 'Well done!']) {
    assert.ok(V.reconcileTone(`${phrase} Try again.`, false).startsWith('Not quite!'));
    assert.ok(!V.reconcileTone(`${phrase} Try again.`, null).includes(phrase));
  }
  assert.strictEqual(V.reconcileTone('A force can turn the ball right.', false), 'A force can turn the ball right.');
});

test('options are absent in every phase except CHECK, including WRAP and DONE', () => {
  for (const phase of ['PROBE', 'THEORY', 'OBJECTIVES', 'DIALOGUE', 'ROUNDUP', 'WRAP', 'DONE']) {
    const out = V.enforce({ messages: [{ message: 'What changes?', options: [{ text: 'Shape', value: 'Shape' }, { text: 'Colour', value: 'Colour' }] }], lastQuestionRubric: rubric }, { ...goalContext, phase });
    assert.ok(out.messages.every(m => !m.options), phase);
    if (phase === 'WRAP' || phase === 'DONE') assert.strictEqual(out.lastQuestionRubric, null);
  }
});

test('duplicate, dummy, missing-key and single-option MCQs become grounded written questions', () => {
  const optionsCases = [
    [{ text: 'Shape' }, { text: 'Shape' }],
    [{ text: 'Correct concept principle' }, { text: 'Opposite effect occurs' }],
    [{ text: 'Speed' }, { text: 'Colour' }],
    [{ text: 'Shape' }]
  ];
  for (const options of optionsCases) {
    const out = V.enforce({ messages: [{ message: 'What changes when a sponge is squeezed?', options }], lastQuestionRubric: { ...rubric, correct_option_text: 'Shape' } }, { ...goalContext, phase: 'CHECK', questionType: 'mcq' });
    assert.strictEqual(out.questionType, 'open');
    assert.strictEqual(out.messages.at(-1).options, undefined);
    assert.strictEqual(out.lastQuestionRubric.criteria.length, 4);
  }
});

test('fallback repeats a real pending question only for the same assessment', () => {
  const pending = { ...goalContext, sameAssessment: true, lastQuestionText: 'What can a force change?', lastQuestionRubric: rubric };
  const retry = V.buildFocusedFallback(pending);
  assert.strictEqual(retry.messages[0].message, pending.lastQuestionText);
  assert.deepStrictEqual(retry.lastQuestionRubric, rubric);
  const next = V.buildFocusedFallback({ ...pending, sameAssessment: false });
  assert.notStrictEqual(next.messages[0].message, pending.lastQuestionText);
  assert.strictEqual(next.lastQuestionRubric.criteria.length, 4);
});

test('blank and malformed output rebuilds a private rubric from all goal facts', () => {
  for (const raw of [null, { messages: [] }, { messages: [{ message: '   ' }] }, { messages: [{ message: 'What is shape?' }] }]) {
    const out = V.enforce(raw, goalContext);
    assert.strictEqual(out.lastQuestionRubric.criteria.length, 4);
    assert.ok(out.lastQuestionRubric.criteria.every(c => c.required));
    assert.strictEqual(out.questionType, 'open');
  }
});

test('a retry cannot replace a complete rubric with one easy criterion', () => {
  const fullRubric = V.buildFocusedFallback(goalContext).lastQuestionRubric;
  const out = V.enforce({ messages: [{ message: 'Can force change speed?' }], lastQuestionRubric: rubric }, {
    ...goalContext, sameAssessment: true, lastQuestionRubric: fullRubric
  });
  assert.deepStrictEqual(out.lastQuestionRubric, fullRubric);
});

test('new roundup rubrics require the complete goal even if a model supplies one component', () => {
  const out = V.enforce({ messages: [{ message: 'What are the effects of force?' }], lastQuestionRubric: rubric }, goalContext);
  assert.strictEqual(out.lastQuestionRubric.criteria.length, 4);
  assert.strictEqual(out.lastQuestionRubric.model_answer, goalContext.currentGoalDescription);
});

test('full recall requires core facts without memorizing every illustrative example', () => {
  const out = V.buildFocusedFallback({ currentGoalTitle: 'Shape changes', currentGoalDescription: 'A force can change shape by stretching or compressing; examples such as rubber bands and sponges' });
  assert.strictEqual(out.lastQuestionRubric.criteria.length, 1);
  assert.ok(out.lastQuestionRubric.criteria[0].description.includes('stretching or compressing'));
});

test('new roundup replaces narrower generated questions and removes answer leakage', () => {
  const out = V.enforce({ messages: [{ message: 'A force can change speed and shape.' }, { message: 'Can force change shape?' }], lastQuestionRubric: rubric }, goalContext);
  assert.strictEqual(out.messages.length, 1);
  assert.strictEqual(out.messages[0].message, V.buildFocusedFallback(goalContext).messages[0].message);
  assert.strictEqual(out.lastQuestionRubric.criteria.length, 4);
});

test('roundup retry may teach but preserves the original full question and rubric', () => {
  const original = V.buildFocusedFallback(goalContext);
  const out = V.enforce({ messages: [{ message: 'Force can start or stop motion and change speed, direction, or shape.' }, { message: 'Does force change shape?' }], lastQuestionRubric: rubric }, {
    ...goalContext, sameAssessment: true, lastQuestionText: original.messages[0].message, lastQuestionRubric: original.lastQuestionRubric
  });
  assert.strictEqual(out.messages.length, 2);
  assert.strictEqual(out.messages.at(-1).message, original.messages[0].message);
  assert.deepStrictEqual(out.lastQuestionRubric, original.lastQuestionRubric);
});

test('a whole terminal question survives splitting preceding prose', () => {
  const out = V.enforce({ messages: [{ message: 'A moving object may change speed, direction, or both when an external unbalanced force acts on it. What can force change?' }], lastQuestionRubric: rubric }, { phase: 'DIALOGUE', currentGoalTitle: 'Effects of force', currentGoalDescription: 'A force can change motion or shape' });
  assert.strictEqual(out.messages.at(-1).message, 'What can force change?');
  assert.strictEqual(out.questionReplaced, false);
});

test('a decimal inside an overlong question cannot make its tail appear to be a whole question', () => {
  const out = V.enforce({ messages: [{ message: 'Which effect of force explains why a slowly moving toy car on the table accelerates when we push it with 0.5 newtons?' }], lastQuestionRubric: rubric }, { phase: 'DIALOGUE', currentGoalTitle: 'Effects of force', currentGoalDescription: 'A force can change speed' });
  assert.strictEqual(out.questionReplaced, true);
  assert.ok(!out.messages.at(-1).message.startsWith('5 newtons'));
  assert.strictEqual(out.lastQuestionRubric.model_answer, 'A force can change speed');
});

test('DIALOGUE retries preserve the complete pending question as well as its rubric', () => {
  const full = V.buildFocusedFallback(goalContext);
  const question = 'What distinct effects can a force have on a body?';
  const out = V.enforce({ messages: [{ message: 'Force can start motion, stop it, or change speed, direction, or shape.' }, { message: 'Can force change shape?' }], lastQuestionRubric: rubric }, {
    ...goalContext, phase: 'DIALOGUE', sameAssessment: true, lastQuestionText: question, lastQuestionRubric: full.lastQuestionRubric
  });
  assert.strictEqual(out.messages.length, 2);
  assert.strictEqual(out.messages.at(-1).message, question);
  assert.deepStrictEqual(out.lastQuestionRubric, full.lastQuestionRubric);
});

test('CHECK retries restore the original question, actual choices and private key', () => {
  const options = [{ text: 'Shape', value: 'Shape' }, { text: 'Colour', value: 'Colour' }];
  const pendingRubric = { ...rubric, correct_option_text: 'Shape' };
  const out = V.enforce({ messages: [{ message: 'Think about the sponge’s shape.' }, { message: 'Can force change speed?', options: [{ text: 'Yes', value: 'Yes' }, { text: 'No', value: 'No' }] }],
    lastQuestionRubric: { criteria: [{ id: 'yes', description: 'Yes', required: true }], model_answer: 'Yes', correct_option_text: 'Yes' } }, {
    ...goalContext, phase: 'CHECK', questionType: 'mcq', sameAssessment: true,
    lastQuestionText: 'What changes when you squeeze a sponge?', lastQuestionOptions: options, lastQuestionRubric: pendingRubric
  });
  assert.strictEqual(out.messages.at(-1).message, 'What changes when you squeeze a sponge?');
  assert.deepStrictEqual(out.messages.at(-1).options, options);
  assert.deepStrictEqual(out.lastQuestionRubric, pendingRubric);
  assert.strictEqual(out.questionType, 'mcq');
});
