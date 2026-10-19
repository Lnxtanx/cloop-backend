const test = require('node:test');
const assert = require('node:assert/strict');
const { recordInspectorTurn, getInspectorTurns, clearInspectorTurns } = require('./inspector-store');

test('INS1: inspector-store records and retrieves turn payloads', async () => {
  const sampleTopicId = 9999;
  clearInspectorTurns(sampleTopicId);

  const sampleTurn = {
    turn_id: 'turn_test_1',
    timestamp: new Date().toISOString(),
    topic: { id: sampleTopicId, title: 'Laws of Motion' },
    user: { id: 42, grade_level: '9', board: 'CBSE' },
    student_turn: {
      message: 'A book stays at rest until pushed',
      intent: 'ANSWER',
      answered_phase: 'THEORY',
      evaluator_result: { is_correct: true, score_percent: 100 }
    },
    generator_input: {
      phase: 'DIALOGUE',
      goal_index: 0,
      directive: 'continue_dialogue',
      system_prompt: 'You are Cloop tutor...',
      academic_boundaries: 'Stay within Class 9 syllabus',
    },
    generator_output: {
      reasoning_content: 'Student identified inertia of rest correctly.',
      raw_response: { messages: [{ message: 'Exactly! That is inertia.', message_type: 'text' }] },
      validated_bubbles: [{ message: 'Exactly! That is inertia.', message_type: 'text' }],
      next_rubric: { criteria: [{ id: 'fact_1', description: 'Requires net external force', required: true }] },
      telemetry: { promptTokens: 300, completionTokens: 50, cachedPromptTokens: 250 },
      duration_ms: 450,
    },
    state_transition: {
      phase_before: 'THEORY',
      phase_after: 'DIALOGUE',
    }
  };

  await recordInspectorTurn(sampleTurn);

  const turns = getInspectorTurns({ topicId: sampleTopicId });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turn_id, 'turn_test_1');
  assert.equal(turns[0].topic.title, 'Laws of Motion');
  assert.equal(turns[0].student_turn.intent, 'ANSWER');
  assert.equal(turns[0].generator_output.telemetry.cachedPromptTokens, 250);

  // Clear
  clearInspectorTurns(sampleTopicId);
  const cleared = getInspectorTurns({ topicId: sampleTopicId });
  assert.equal(cleared.length, 0);
});
