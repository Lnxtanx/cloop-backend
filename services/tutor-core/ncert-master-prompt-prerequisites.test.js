const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeOptions, enforce } = require('./validate');
const { initialState, advance, questionTypeFor, instructionFor } = require('./state');
const { extractTextbookElements } = require('../../ai/agents/socratic-tutor/context/context-builder');
const { detectParagraphTag } = require('../../scripts/map-and-seed-textbook-content');
const { getSubjectRuleBlock, guidanceFor, buildTutorPrompt } = require('./tutor-generator');
const dialogueGenerator = require('../../ai/agents/socratic-tutor/generators/dialogue-generator');

test('1. Shuffle MCQ options: normalizes and shuffles without losing correct option', () => {
  const options = ['Alpha', 'Beta', 'Gamma', 'Delta'];
  const normalized = normalizeOptions(options, 'Gamma', true);
  assert.equal(normalized.length, 4);
  assert.ok(normalized.some(o => o.text === 'Gamma'));

  // Test enforce with shuffleOptions
  const mockTutorOutput = {
    messages: [
      { message: 'Which gas is needed for burning?', message_type: 'text', options: ['Oxygen', 'Nitrogen', 'Helium', 'Argon'] }
    ],
    lastQuestionRubric: {
      criteria: [{ id: 'gas', description: 'Oxygen', required: true }],
      model_answer: 'Oxygen',
      correct_option_text: 'Oxygen'
    }
  };

  const context = {
    phase: 'CHECK',
    questionType: 'mcq',
    shuffleOptions: true,
  };

  const enforced = enforce(mockTutorOutput, context);
  assert.equal(enforced.messages[0].options.length, 4);
  assert.ok(enforced.messages[0].options.some(o => o.text === 'Oxygen'));
  assert.equal(enforced.lastQuestionRubric.correct_option_text, 'Oxygen');
});

test('2. Reasoning MCQ in ROUNDUP: state machine transitions from recall to reasoning MCQ', () => {
  const s0 = {
    ...initialState(2),
    phase: 'ROUNDUP',
    roundupIndex: 0,
    recallThisGoal: 0,
    includeReasoningMcq: true,
  };

  // Turn 0: initial recall turn
  assert.equal(questionTypeFor('ROUNDUP', s0), 'open');
  assert.equal(instructionFor(s0), 'roundup_recall');

  // After 1 correct recall attempt on this goal
  const s1 = advance(s0, { intent: 'ANSWER', correct: true });

  assert.equal(s1.phase, 'ROUNDUP');
  assert.equal(s1.recallThisGoal, 1);
  assert.equal(questionTypeFor('ROUNDUP', s1), 'mcq');
  assert.equal(instructionFor(s1), 'roundup_reasoning_mcq');

  // After reasoning MCQ passes, advance to next goal recall
  const s2 = advance(s1, { intent: 'ANSWER', correct: true });

  assert.equal(s2.phase, 'ROUNDUP');
  assert.equal(s2.roundupIndex, 1);
  assert.equal(s2.recallThisGoal, 0);
  assert.equal(questionTypeFor('ROUNDUP', s2), 'open');
  assert.equal(instructionFor(s2), 'roundup_recall');
});

test('3. Textbook parser extracts question bank, activities, and section numbers', () => {
  const textbookSample = `
Section 2.1 Introduction to Forces
A force is a push or pull acting on an object.

Activity 2.1 Exploring Forces
Take a rubber ball and press it on a flat table. What do you observe?
Does the shape change?

Questions
1. Give two examples of contact forces.
2. Why does a rolling ball eventually stop?

What you have learnt
- A force can change the state of motion of an object.
- Force can also change the shape of an object.

A step further
Explore how maglev trains use magnetic forces to float above tracks.
`;

  const elements = extractTextbookElements(textbookSample);
  assert.ok(elements.passages.length > 0);
  assert.ok(elements.activities.length > 0);
  assert.ok(elements.question_bank.length > 0);
  assert.ok(elements.chapter_summary);
  assert.ok(elements.step_further);
  assert.ok(elements.section_numbers.includes('2.1') || elements.section_numbers.includes('Section 2.1') || elements.section_numbers.some(s => s.includes('2.1')));
});

test('4. Paragraph tag detection for chapter summary, step further, activity, question bank', () => {
  assert.equal(detectParagraphTag('What you have learnt: Force changes motion.'), '[CHAPTER_SUMMARY]');
  assert.equal(detectParagraphTag('Summary of the chapter concepts.'), '[CHAPTER_SUMMARY]');
  assert.equal(detectParagraphTag('A step further: Discover how rockets launch.'), '[A_STEP_FURTHER]');
  assert.equal(detectParagraphTag('Activity 5.3: Measuring friction on different surfaces.'), '[ACTIVITY: 5.3]');
  assert.equal(detectParagraphTag('Questions and Exercises: 1. Explain inertia.'), '[QUESTION_BANK]');
});

test('5. Subject rule blocks for Science, Mathematics, Social Science, and English', () => {
  const scienceRules = getSubjectRuleBlock('Science');
  assert.ok(scienceRules.includes('[Science]'));
  assert.ok(scienceRules.includes('predict-observe-explain'));

  const mathRules = getSubjectRuleBlock('Mathematics');
  assert.ok(mathRules.includes('[Mathematics]'));
  assert.ok(mathRules.includes("use the book's method and notation") || mathRules.includes('method and notation'));

  const sstRules = getSubjectRuleBlock('Social Science');
  assert.ok(sstRules.includes('[Social Science]'));
  assert.ok(sstRules.includes('maps, timelines and case examples'));

  const engRules = getSubjectRuleBlock('English');
  assert.ok(engRules.includes('[English]'));
  assert.ok(engRules.includes("chapter's text: story, poem or play") || engRules.includes('story, poem or play'));
});

test('6. Revision pointers with section and activity numbers in wrap directive', () => {
  const directive = guidanceFor('wrap_with_report', { overall_mastery_percent: 85, session_completed: true, recall_completed: true }, ['Section 3.2', 'Activity 3.1']);
  assert.ok(directive.includes('Section 3.2'));
  assert.ok(directive.includes('Activity 3.1'));
});

test('7. Master tutor prompt matches the boss\'s specification in both generators', () => {
  const sampleParams = {
    topicTitle: 'Chemical Reactions and Equations',
    currentGoalTitle: 'Balance chemical equations',
    currentGoalDescription: 'State the law of conservation of mass and balance simple equations.',
    classLevel: 'Class 10 CBSE',
    phase: 'DIALOGUE',
    stateInstruction: 'open_goal_dialogue',
    questionType: 'open',
    subjectName: 'Science',
    bookTitle: 'Science Class X NCERT',
  };

  const corePrompt = buildTutorPrompt(sampleParams);
  assert.ok(corePrompt.includes('You are Cloop, a warm and calm tutor for Class 10 CBSE students in India.'));
  assert.ok(corePrompt.includes('Reply in simple English only, even when the student writes in Hindi or Hinglish: understand them, answer in English.'));
  assert.ok(corePrompt.includes('WHO DECIDES WHAT'));
  assert.ok(corePrompt.includes('YOUR SOURCES'));
  assert.ok(corePrompt.includes('1. textbook.passages: the book\'s own words for this topic.'));
  assert.ok(corePrompt.includes('2. next_goal.prepared_lesson: the teaching target'));
  assert.ok(corePrompt.includes('3. textbook.question_bank: the book\'s in-text questions and exercises.'));
  assert.ok(corePrompt.includes('HOW EACH PHASE WORKS'));
  assert.ok(corePrompt.includes('QUESTION FORMATS (for reasoning questions)'));
  assert.ok(corePrompt.includes('FEEDBACK (use previous_evaluation; never contradict its verdict)'));
  assert.ok(corePrompt.includes('WHEN THE STUDENT STRUGGLES'));
  assert.ok(corePrompt.includes('TONE'));
  assert.ok(corePrompt.includes('SAFETY AND SENSITIVE TOPICS'));
  assert.ok(corePrompt.includes('LANGUAGE AND FORMAT'));
  assert.ok(corePrompt.includes('SUBJECT RULES: Science'));

  const dialoguePrompt = dialogueGenerator.buildTutorPrompt(sampleParams);
  assert.ok(dialoguePrompt.includes('You are Cloop, a warm and calm tutor for Class 10 CBSE students in India.'));
  assert.ok(dialoguePrompt.includes('Reply in simple English only, even when the student writes in Hindi or Hinglish: understand them, answer in English.'));
  assert.ok(dialoguePrompt.includes('WHO DECIDES WHAT'));
  assert.ok(dialoguePrompt.includes('YOUR SOURCES'));
  assert.ok(dialoguePrompt.includes('HOW EACH PHASE WORKS'));
  assert.ok(dialoguePrompt.includes('QUESTION FORMATS (for reasoning questions)'));
  assert.ok(dialoguePrompt.includes('SUBJECT RULES:'));
  assert.ok(dialoguePrompt.includes('[Science]'));
});
