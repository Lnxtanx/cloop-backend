/**
 * Student-facing wording from the Scientific Inquiry replay.
 *
 * Each case is a sentence a real student saw, or would have seen: a fallback
 * question that dropped its preposition, a topic summary graded as if it were
 * a fact, and an internal repair note shown in the chat. Both validator copies
 * are checked, because production runs the agent's copy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

for (const filename of ['./validate', '../../ai/agents/socratic-tutor/formatters/bubble-formatter']) {
  const V = require(filename);
  const objectiveOnly = {
    phase: 'ROUNDUP', questionType: 'open', response_mode: 'check',
    topicTitle: 'Introduction to Scientific Inquiry', academicNotes: null,
  };

  test(`${filename}: a verb's preposition stays in the fallback question`, () => {
    const out = V.buildFocusedFallback({ ...objectiveOnly,
      currentGoalTitle: 'Identify the core components of scientific inquiry',
      currentGoalDescription: 'Scientific inquiry starts with curiosity and careful observation.' });
    assert.equal(out.messages[0].message, 'What does scientific inquiry start with?');
    assert.doesNotMatch(out.messages[0].message, /\bstart\?$/, 'never "What does scientific inquiry start?"');
  });

  test(`${filename}: a sentence describing the lesson is not a fact to grade against`, () => {
    for (const blurb of [
      'This topic introduces scientific inquiry: observing with the senses and asking questions.',
      'The chapter covers the water cycle and its stages.',
      'Students learn how curiosity begins an investigation.',
    ]) {
      assert.deepEqual(V.factualSourceParts(blurb), [], blurb);
    }
    assert.deepEqual(V.factualSourceParts('An inference is a conclusion drawn from observations.'),
      ['An inference is a conclusion drawn from observations.'], 'real facts are still accepted');
  });

  test(`${filename}: a question the tutor cannot build is never graded against the topic summary`, () => {
    const out = V.buildFocusedFallback({ ...objectiveOnly,
      currentGoalTitle: 'Differentiate between observations and inferences',
      currentGoalDescription: 'Students will differentiate between observations and inferences.',
      topicContent: 'This topic introduces scientific inquiry: observing with the senses and drawing inferences.' });
    assert.equal(out.lastQuestionRubric, null, 'no rubric built from a lesson summary');
  });

  test(`${filename}: the repair message speaks to the student, not about the system`, () => {
    const out = V.buildFocusedFallback({ ...objectiveOnly, currentGoalTitle: 'Observations',
      currentGoalDescription: 'Students will explain observations.' });
    const text = out.messages.map(m => m.message).join(' ');
    assert.doesNotMatch(text, /lesson wording|check a suitable/i);
    assert.equal(text, 'Let me find a clearer way to ask this.');
  });
}
