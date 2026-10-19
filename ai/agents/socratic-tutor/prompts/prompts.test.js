const test = require('node:test');
const assert = require('node:assert/strict');

const prompts = require('./index');

test('PR1: System and Persona prompts export non-empty guidelines', () => {
  assert.ok(prompts.system.MASTER_PERSONA_PROMPT.includes('Socratic'));
  assert.ok(prompts.system.MASTER_PERSONA.TARGET_AUDIENCE.includes('Class 10'));
  assert.ok(prompts.system.SAFETY_AND_GROUNDING_PROMPT.includes('ANTI-JAILBREAK'));
});

test('PR2: Evaluation prompt builds valid JSON schema instructions', () => {
  const prompt = prompts.evaluation.buildRubricEvaluationPrompt();
  assert.ok(prompt.includes('You are Cloop\'s academic evaluator'));
  assert.ok(prompt.includes('criterion_results'));
  assert.ok(prompt.includes('contradictions'));
});

test('PR3: Intent classification prompt interpolates student text', () => {
  const prompt = prompts.evaluation.buildIntentClassificationPrompt('i am not sure', { lastQuestionText: 'What is accommodation?' });
  assert.ok(prompt.includes('i am not sure'));
  assert.ok(prompt.includes('What is accommodation?'));
  assert.ok(prompt.includes('"ANSWER|IDK|HELP|MOVE_ON'));
});

test('PR4: Concept breakdown prompt specifies 3-4 micro-bubble structure', () => {
  const prompt = prompts.teaching.buildConceptBreakdownPrompt({
    topicTitle: 'Human Eye',
    currentGoalTitle: 'Power of Accommodation',
    currentGoalDescription: 'Adjustment of focal length',
  });
  assert.ok(prompt.includes('Power of Accommodation'));
  assert.ok(prompt.includes('BUBBLE 1'));
  assert.ok(prompt.includes('BUBBLE 2'));
  assert.ok(prompt.includes('BUBBLE 3'));
  assert.ok(prompt.includes('BUBBLE 4'));
});

test('PR5: Dialogue prompts build valid templates for Probe, Inquiry, MCQ, and Curiosity', () => {
  const probe = prompts.dialogue.buildProbePrompt({ topicTitle: 'Electricity' });
  assert.ok(probe.includes('Electricity'));
  assert.ok(probe.includes('PROBE OBJECTIVE'));

  const inquiry = prompts.dialogue.buildSocraticInquiryPrompt({
    topicTitle: 'Optics',
    currentGoalTitle: 'Refraction',
    currentGoalDescription: 'Bending of light',
  });
  assert.ok(inquiry.includes('Refraction'));

  const mcq = prompts.dialogue.buildMcqCheckPrompt({
    topicTitle: 'Optics',
    currentGoalTitle: 'Refraction',
    currentGoalDescription: 'Bending of light',
  });
  assert.ok(mcq.includes('distractor'));

  const curiosity = prompts.dialogue.buildCuriosityBranchPrompt({
    studentMessage: 'Why does a straw look bent in water?',
    currentGoalTitle: 'Refraction',
    currentGoalDescription: 'Bending of light',
  });
  assert.ok(curiosity.includes('Why does a straw look bent in water?'));
  assert.ok(curiosity.includes('BUBBLE 1'));
  assert.ok(curiosity.includes('BUBBLE 2'));
});

test('PR6: Synthesis prompts build revision sheet and wrap templates without unearned praise', () => {
  const rev = prompts.synthesis.buildRevisionSheetPrompt({
    topicTitle: 'Force and Pressure',
    goalsText: '1. Force: Push or pull',
    coverageText: 'Force: assessed',
    errorsText: 'No recorded errors',
    classLevel: '10',
    endedReason: 'complete',
  });
  assert.ok(rev.includes('Force and Pressure'));
  assert.ok(rev.includes('strictly under 200 words'));

  const wrap = prompts.synthesis.buildSessionWrapPrompt({
    reportBrief: { overall_mastery_percent: 85, session_completed: true, recall_completed: true, mastery_confirmed: true },
  });
  assert.ok(wrap.includes('85%'));
});
