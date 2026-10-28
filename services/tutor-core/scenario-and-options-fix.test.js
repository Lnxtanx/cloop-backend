const test = require('node:test');
const assert = require('node:assert/strict');

for (const path of ['./validate', '../../ai/agents/socratic-tutor/formatters/bubble-formatter']) {
  const V = require(path);

  test(`${path}: conversational feedback in bubble 1 does not trigger false scenario conflict with new question`, () => {
    const feedback = "Right — that force changed the autorickshaw's direction.";
    const newQuestion = "A fielder stops a rolling ball with his hands. What change in motion does his force cause?";
    const checkRubric = {
      criteria: [{ id: 'stop', description: 'Force brings ball to rest', required: true }],
      model_answer: 'The force stops the rolling ball and brings it to rest.'
    };

    assert.ok(V.isFeedbackBubble(feedback));
    assert.strictEqual(V.validateScenarioConsistency(feedback, newQuestion, checkRubric), true);

    const out = V.enforce({
      messages: [
        { message: feedback, message_type: 'text' },
        { message: newQuestion, message_type: 'text' }
      ],
      lastQuestionRubric: checkRubric
    }, { phase: 'DIALOGUE', currentGoalTitle: 'Effects of force', currentGoalDescription: 'Force can stop motion' });

    assert.strictEqual(out.questionReplaced, false);
    assert.strictEqual(out.messages.length, 2);
    assert.strictEqual(out.messages[0].message, feedback);
    assert.strictEqual(out.messages[1].message, newQuestion);
  });

  test(`${path}: teacher feedback with bicycle brakes does not conflict with ball question`, () => {
    const feedback = "Your brake answer was right: force decreases a moving bicycle's speed until it stops.";
    const newQuestion = "A bat strikes a rolling ball sideways. How does its motion change?";
    const checkRubric = {
      criteria: [{ id: 'direction', description: 'Direction of motion changes', required: true }],
      model_answer: 'The sideways force changes the direction of the ball.'
    };

    assert.ok(V.isFeedbackBubble(feedback));
    assert.strictEqual(V.validateScenarioConsistency(feedback, newQuestion, checkRubric), true);

    const out = V.enforce({
      messages: [
        { message: feedback, message_type: 'text' },
        { message: newQuestion, message_type: 'text' }
      ],
      lastQuestionRubric: checkRubric
    }, { phase: 'DIALOGUE', currentGoalTitle: 'Effects of force', currentGoalDescription: 'Force changes direction' });

    assert.strictEqual(out.questionReplaced, false);
  });

  test(`${path}: normalizeOptions matches correct_option_text even with trailing punctuation or whitespace`, () => {
    const optionsWithPeriod = [
      { text: "It changes the direction of the ball's motion.", value: "It changes the direction of the ball's motion." },
      { text: "It only changes the shape of the ball.", value: "It only changes the shape of the ball." }
    ];
    const correctOptionWithoutPeriod = "It changes the direction of the ball's motion";

    const normalized = V.normalizeOptions(optionsWithPeriod, correctOptionWithoutPeriod);
    assert.ok(normalized);
    assert.strictEqual(normalized.length, 2);
  });

  test(`${path}: MCQ check with trailing period is preserved by enforce() without repair fallback`, () => {
    const options = [
      { text: "It changes the direction of the ball's motion.", value: "It changes the direction of the ball's motion." },
      { text: "It only changes the shape of the ball.", value: "It only changes the shape of the ball." }
    ];
    const raw = {
      messages: [
        { message: "You turn the handle of an autorickshaw to change direction.", message_type: 'text' },
        {
          message: "A cricket bat strikes a moving ball sideways. Which effect of force is this?",
          message_type: 'text',
          options
        }
      ],
      lastQuestionRubric: {
        criteria: [{ id: 'dir', description: 'Changes direction of ball', required: true }],
        model_answer: "It changes the direction of the ball's motion",
        correct_option_text: "It changes the direction of the ball's motion"
      }
    };

    const out = V.enforce(raw, {
      phase: 'CHECK',
      questionType: 'mcq',
      currentGoalTitle: 'Effects of force',
      currentGoalDescription: 'Force can change direction of motion'
    });

    assert.strictEqual(out.questionReplaced, false);
    assert.strictEqual(out.questionType, 'mcq');
    assert.ok(out.messages.at(-1).options);
    assert.strictEqual(out.messages.at(-1).options.length, 2);
  });

  test(`${path}: questions up to 30 words are preserved without replacement`, () => {
    const natural25Words = "When a fielder on the boundary line catches a speeding cricket ball with both hands, what specific effect does the force have on the ball?";
    assert.strictEqual(V.wordCount(natural25Words), 25);
    const rubric = {
      criteria: [{ id: 'stop', description: 'Stops moving ball', required: true }],
      model_answer: 'Stops the ball and brings it to rest'
    };

    const out = V.enforce({
      messages: [{ message: natural25Words, message_type: 'text' }],
      lastQuestionRubric: rubric
    }, {
      phase: 'DIALOGUE',
      currentGoalTitle: 'Effects of force',
      currentGoalDescription: 'A force can stop a moving object'
    });

    assert.strictEqual(out.questionReplaced, false);
    assert.strictEqual(out.messages.at(-1).message, natural25Words);
  });
}
