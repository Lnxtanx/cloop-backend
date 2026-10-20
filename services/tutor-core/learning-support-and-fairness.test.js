const test = require('node:test');
const assert = require('node:assert/strict');

const clientPath = require.resolve('../ai/deepseek-client');
let mockModelOutput = null;
let mockModelError = null;
require.cache[clientPath] = {
  id: clientPath, filename: clientPath, loaded: true,
  exports: {
    invokeModel: async (system, messages, options) => {
      if (mockModelError) throw mockModelError;
      if (mockModelOutput) return typeof mockModelOutput === 'string' ? mockModelOutput : JSON.stringify(mockModelOutput);
      const parsedMsg = JSON.parse(messages?.[0]?.content || '{}');
      const ans = String(parsedMsg.student_answer || '').toLowerCase();
      const isCorrect = ans.includes('pupil') || ans.includes('iris');
      return JSON.stringify({
        intent: 'ANSWER',
        criterion_results: [{ id: 'part', satisfied: isCorrect, evidence: ans }],
        contradictions: [],
        error_type: isCorrect ? null : 'Conceptual',
        complete_answer: 'Pupil and iris regulate light.',
        feedback: isCorrect ? 'Correct.' : 'Incorrect.',
        diff_html: null
      });
    },
    extractJson: text => JSON.parse(text),
  },
};

const {
  advance,
  initialState,
  instructionFor,
  CHOICE_QUESTION,
  learningPointIdFor
} = require('./state');
const {
  evaluateStudentTurn,
  detectRequestKind,
  validateQuestionRubricAlignment
} = require('./evaluator');
const {
  enforce,
  cleanConceptHeading,
  cleanObjectiveText,
  createQuestionRecord
} = require('./validate');
const { buildFallbackRevisionSheet } = require('./revision-generator');
const { buildReport } = require('./summary');

test('T1: Server-owned 2-attempt policy transitions to teach on fail 1 and offer_choice on fail 2', () => {
  const s0 = initialState(3);
  s0.phase = 'DIALOGUE';

  // 1st incorrect answer: enters teach mode
  const s1 = advance(s0, { intent: 'ANSWER', correct: false });
  assert.equal(s1.response_mode, 'teach', 'First fail should set response_mode to teach');
  assert.equal(instructionFor(s1), 'correct_and_reask');
  const lp1 = s1.learning_support[s1.active_learning_point_id];
  assert.equal(lp1.attempt_count, 1);
  assert.equal(lp1.awaiting_choice, false);

  // 2nd incorrect answer on same learning point: offers choice deterministically
  const s2 = advance(s1, { intent: 'ANSWER', correct: false });
  assert.equal(s2.response_mode, 'offer_choice', 'Second fail should set response_mode to offer_choice');
  assert.equal(instructionFor(s2), 'offer_choice');
  const lp2 = s2.learning_support[s2.active_learning_point_id];
  assert.equal(lp2.attempt_count, 2);
  assert.equal(lp2.awaiting_choice, true);

  // Instruction text verifies CHOICE_QUESTION
  assert.equal(CHOICE_QUESTION, 'Would you like me to explain the answer, or would you like another try?');
});

test('T2: Deterministic choice handling for try_again and explain_answer', () => {
  const s0 = initialState(2);
  s0.phase = 'DIALOGUE';
  const s1 = advance(s0, { intent: 'ANSWER', correct: false });
  const s2 = advance(s1, { intent: 'ANSWER', correct: false });
  assert.equal(s2.response_mode, 'offer_choice');

  // Choice: try_again -> preserves struggle history and gives a fresh retry
  const sTryAgain = advance(s2, { requestKind: 'try_again' });
  assert.equal(sTryAgain.response_mode, 'check');
  assert.equal(instructionFor(sTryAgain), 'reteach_new_angle');
  const lpTry = sTryAgain.learning_support[sTryAgain.active_learning_point_id];
  assert.equal(lpTry.awaiting_choice, false);
  assert.equal(lpTry.attempt_count, 2, 'attempt history survives another try');

  // Choice: explain_answer -> reveals answer and advances to next question/goal
  const sExplain = advance(s2, { requestKind: 'explain_answer' });
  assert.equal(sExplain.response_mode, 'explain');
  const lpExp = sExplain.learning_support[s2.active_learning_point_id];
  assert.equal(lpExp.awaiting_choice, false);
  assert.equal(sExplain.active_learning_point_id, s2.active_learning_point_id);
  assert.equal(sExplain.phase, 'DIALOGUE');
  assert.equal(sExplain.pendingAdvanceAfterExplanation, true);
});

test('T3: Control actions pre-evaluated without scoring or user correction card', async () => {
  // detectRequestKind directly
  assert.equal(detectRequestKind('explain the answer'), 'explain_answer');
  assert.equal(detectRequestKind('tell me the answer'), 'explain_answer');
  assert.equal(detectRequestKind('another try'), 'try_again');
  assert.equal(detectRequestKind('let me try again'), 'try_again');
  assert.equal(detectRequestKind('move on'), 'move_on');
  assert.equal(detectRequestKind('what do you mean by goal 1'), 'clarify_term');
  assert.equal(detectRequestKind('explain the question'), 'clarify_task');

  // When awaiting choice, option 1 and 2 work cleanly
  assert.equal(detectRequestKind('1', { awaiting_learning_choice: true }), 'explain_answer');
  assert.equal(detectRequestKind('option 1', { awaiting_learning_choice: true }), 'explain_answer');
  assert.equal(detectRequestKind('2', { awaiting_learning_choice: true }), 'try_again');
  assert.equal(detectRequestKind('option 2', { awaiting_learning_choice: true }), 'try_again');

  // evaluateStudentTurn intercepts control actions
  const result = await evaluateStudentTurn({
    studentMessage: 'tell me the answer',
    lastQuestionText: 'Which part of the human eye controls the amount of light?',
    topicTitle: 'Structure of the Human Eye'
  });
  assert.equal(result.evaluation_status, 'not_applicable');
  assert.equal(result.is_correct, null);
  assert.equal(result.userCorrection, null);
  assert.equal(result.request_kind, 'explain_answer');
});

test('T4: Evaluator accepts pupil and iris interchangeably for light entering the eye', async () => {
  const eyeLightRubric = {
    criteria: [
      { id: 'part', description: 'Name pupil or iris as regulating the light entering the eye', required: true }
    ],
    model_answer: 'The pupil (regulated by the iris) controls and regulates the amount of light entering the eye.'
  };

  // Naming "pupil" should be accepted
  const resPupil = await evaluateStudentTurn({
    studentMessage: 'pupil',
    lastQuestionText: 'Which part of the eye regulates the amount of light entering it?',
    lastQuestionRubric: eyeLightRubric,
    topicTitle: 'Structure of the Human Eye'
  });
  assert.equal(resPupil.is_correct, true, 'pupil must be accepted for light regulation');

  // Naming "iris" should also be accepted
  const resIris = await evaluateStudentTurn({
    studentMessage: 'iris',
    lastQuestionText: 'Which part of the eye controls how much light enters?',
    lastQuestionRubric: eyeLightRubric,
    topicTitle: 'Structure of the Human Eye'
  });
  assert.equal(resIris.is_correct, true, 'iris must be accepted for light control');
});

test('T5: Evaluator de-requires hidden accommodation criteria on general image formation questions', () => {
  const mismatchedRubric = {
    criteria: [
      { id: 'refraction', description: 'Light is refracted by the cornea and lens onto the retina.', required: true },
      { id: 'accommodation', description: 'Ciliary muscles adjust the focal length of the eye lens (accommodation).', required: true }
    ],
    model_answer: 'Light is focused on the retina to form an inverted image.'
  };

  const check = validateQuestionRubricAlignment(
    'How is an image formed inside the human eye?',
    mismatchedRubric
  );
  assert.equal(check.aligned, true);
  // Accommodation criterion is de-required
  const accomCrit = mismatchedRubric.criteria.find(c => c.id === 'accommodation');
  assert.equal(accomCrit.required, false, 'Unasked accommodation requirement should be de-required');
});

test('T6: Sanitization of concept headings strips action verbs and prevents ??', () => {
  assert.equal(
    cleanConceptHeading('Topic 3: Identify the two or more objects', 'Forces'),
    'two or more objects'
  );
  assert.equal(
    cleanConceptHeading('Identify the parts of the human eye', 'Human Eye'),
    'parts of the human eye'
  );
  assert.equal(
    cleanConceptHeading('Describe the image formation in eye?', 'Human Eye'),
    'image formation in eye'
  );
  assert.equal(
    cleanConceptHeading('Goal 2: State Newton’s First Law', 'Forces'),
    'Newton’s First Law'
  );
  assert.ok(!cleanConceptHeading('What is inertia??', 'Forces').includes('??'));
});

test('T7: Fallback revision sheet definitions sanitize syllabus imperatives', () => {
  const sheet = buildFallbackRevisionSheet({
    topicTitle: 'Human Eye and Colourful World',
    goals: [
      {
        title: 'Structure of the Eye',
        description: 'Label cornea, iris, pupil, lens, retina and optic nerve; explain their primary functions.'
      }
    ]
  });
  assert.equal(sheet.definitions.length, 1);
  const def = sheet.definitions[0].definition;
  assert.ok(!def.toLowerCase().startsWith('label'), `Definition should not start with 'Label': "${def}"`);
  assert.ok(def.toLowerCase().startsWith('cornea'), `Definition should start with 'Cornea': "${def}"`);
});

test('T8: Enforce response_mode preserves offer_choice and explanation without question replacement', () => {
  // offer_choice mode: guarantees CHOICE_QUESTION and options
  const choiceResult = enforce(
    { messages: [{ message: 'Your answer was close.' }] },
    { response_mode: 'offer_choice', phase: 'DIALOGUE' }
  );
  assert.equal(choiceResult.questionType, 'choice');
  assert.equal(choiceResult.lastQuestionRubric, null);
  const finalMsg = choiceResult.messages.at(-1);
  assert.equal(finalMsg.message, CHOICE_QUESTION);
  assert.equal(finalMsg.options.length, 2);
  assert.equal(finalMsg.options[0].text, 'Explain the answer');
  assert.equal(finalMsg.options[1].text, 'I want another try');

  // explain mode: returns explanation without fallback question replacement
  const explainResult = enforce(
    { messages: [{ message: 'The iris regulates pupil size to adjust light intensity.' }] },
    { response_mode: 'explain', phase: 'DIALOGUE' }
  );
  assert.equal(explainResult.questionType, 'none');
  assert.equal(explainResult.lastQuestionRubric, null);
  assert.equal(explainResult.questionReplaced, false);
});

test('T9: Summary report arithmetic reconciles: total = correct + incorrect + assisted', () => {
  const mockState = {
    phase: 'WRAP',
    endedReason: 'complete',
    perGoal: [
      {
        total: 7,
        correct: 4,
        assessments: {
          OPEN: { assessed: true, outcome: 'correct', first_correct: true },
          CHECK: { assessed: true, outcome: 'incorrect', first_correct: false },
          ROUNDUP: { assessed: true, outcome: 'correct', first_correct: true, completed: true }
        }
      },
      {
        total: 7,
        correct: 3,
        assessments: {
          OPEN: { assessed: true, outcome: 'incorrect', first_correct: true }, // assisted answer
          CHECK: { assessed: true, outcome: 'incorrect', first_correct: true }, // assisted answer
          ROUNDUP: { assessed: true, outcome: 'correct', first_correct: true, completed: true }
        }
      }
    ]
  };

  const report = buildReport(mockState, [
    { id: 1, title: 'Goal 1' },
    { id: 2, title: 'Goal 2' }
  ]);

  assert.ok(report.breakdown, 'report should have explicit breakdown object');
  const { total, correct, incorrect, assisted } = report.breakdown;
  assert.equal(total, 14);
  assert.equal(total, correct + incorrect + assisted, 'total must equal correct + incorrect + assisted');
});

test('T10: createQuestionRecord captures learning_point_id, explicit_requirements, and response_mode', () => {
  const record = createQuestionRecord({
    goalId: 'g1',
    learning_point_id: 'lp_eye_iris',
    questionText: 'Which part of the human eye controls the light?',
    rubric: {
      criteria: [
        { id: 'c1', description: 'Identify pupil or iris', required: true }
      ],
      model_answer: 'The pupil and iris regulate light.'
    },
    response_mode: 'check'
  });

  assert.equal(record.learning_point_id, 'lp_eye_iris');
  assert.deepEqual(record.explicit_requirements, ['Identify pupil or iris']);
  assert.equal(record.response_mode, 'check');
});
