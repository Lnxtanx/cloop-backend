const test = require('node:test');
const assert = require('node:assert');
const { buildFallbackRevisionSheet } = require('./revision-generator');

test('fallback revision sheet contains all 4 academic sections', () => {
  const sheet = buildFallbackRevisionSheet({
    topicTitle: 'Nutrition in Plants',
    goals: [
      { title: 'Autotrophic Nutrition', description: 'How plants make their own food' },
      { title: 'Photosynthesis Mechanism', description: 'Light and dark reactions' }
    ],
    keyErrors: [
      { type: 'Conceptual', count: 1 }
    ]
  });

  assert.strictEqual(sheet.topic, 'Nutrition in Plants');
  assert.ok(Array.isArray(sheet.key_concepts), 'key_concepts must be an array');
  assert.ok(sheet.key_concepts.length >= 2, 'must have at least 2 key concepts');

  assert.ok(Array.isArray(sheet.definitions), 'definitions must be an array');
  assert.ok(sheet.definitions.length >= 2, 'must have definitions');
  assert.strictEqual(sheet.definitions[0].term, 'Autotrophic Nutrition');

  assert.ok(Array.isArray(sheet.quick_recall_tips), 'quick_recall_tips must be an array');
  assert.ok(sheet.quick_recall_tips.length >= 2, 'must have quick recall tips');

  assert.ok(typeof sheet.practice_next_time === 'string', 'practice_next_time must be a string');
  assert.ok(sheet.practice_next_time.length > 0);
});
