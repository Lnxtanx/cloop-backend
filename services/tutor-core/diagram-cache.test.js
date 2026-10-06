const test = require('node:test');
const assert = require('node:assert/strict');
const { getCachedDiagram } = require('./diagram-cache');

test('a concept diagram uses the specific stored curriculum instead of generic chapter claims', () => {
  const diagram = getCachedDiagram('Exploring Forces', 'Changes in shape', {
    description: 'A force can change shape; stretching, compressing, and bending change shape'
  });
  assert.match(diagram.code, /stretching, compressing, and bending/);
  assert.ok(!/Scientific Mechanism|Mastery Outcome|Ionic|accelerat/i.test(diagram.code));
});

test('a revised goal does not keep an obsolete cached diagram', () => {
  const first = getCachedDiagram('Motion', 'Speed', { description: 'Speed = distance / time' });
  const second = getCachedDiagram('Motion', 'Speed', { description: 'Speed = distance / time; SI unit metre per second (m/s)' });
  assert.notEqual(first.code, second.code);
  assert.match(second.code, /m\/s/);
});
