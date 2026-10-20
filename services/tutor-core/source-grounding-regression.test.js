const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureAcademicGrounding, buildTeachingContext } = require('../../ai/agents/socratic-tutor/context/context-builder');
const V = require('./validate');

test('source definition equal to description is retained instead of manufactured from its title', () => {
  const fact = 'A force is a push or a pull acting on an object.';
  const notes = ensureAcademicGrounding({ title: 'Define force', description: fact }, 'What Is a Force?', '', 'Science');
  assert.equal(notes.definition, fact);
  assert.deepEqual(notes.exam_points, [fact]);
  assert.equal(notes.mechanism, '');
  assert.equal(notes.si_unit, 'None');
  assert.equal(notes.grounding_status, 'source_backed');
});

test('objective-only content has no invented definition, mechanism, unit or false academic evidence', () => {
  const notes = ensureAcademicGrounding({ title: 'Define force', description: 'Students will define force as a push or pull acting on an object in their own words.' }, 'What Is a Force?', '', 'Science');
  assert.equal(notes.definition, '');
  assert.equal(notes.mechanism, '');
  assert.equal(notes.si_unit, 'None');
  assert.deepEqual(notes.exam_points, []);
  assert.deepEqual(notes.formulas, []);
  assert.equal(notes.grounding_status, 'missing_factual_source');
  const out = V.buildFocusedFallback({ currentGoalTitle: 'Define force',
    currentGoalDescription: 'Students will define force as a push or pull acting on an object in their own words.', academicNotes: notes });
  assert.equal(out.taskRepair, true);
  assert.equal(out.lastQuestionRubric, null);
});

test('factual topic content fills an objective-only goal with sourced facts', () => {
  const facts = 'A force is a push or pull acting on an object. Force arises because two objects interact through a push or pull.';
  const notes = ensureAcademicGrounding({ title: 'Define force', description: 'Students will define force as a push or pull.' }, 'What Is a Force?', facts, 'Science');
  assert.equal(notes.definition, 'A force is a push or pull acting on an object.');
  assert.equal(notes.mechanism, 'Force arises because two objects interact through a push or pull.');
  assert.deepEqual(notes.exam_points, ['A force is a push or pull acting on an object.', 'Force arises because two objects interact through a push or pull.']);
});

test('formula and unit are included only when supplied by the source', () => {
  const source = 'Speed is distance travelled per unit time; formula v = d/t; speed is measured in m/s';
  const notes = ensureAcademicGrounding({ title: 'Definition of speed', description: source }, 'Speed', '', 'Science');
  assert.deepEqual(notes.formulas, ['formula v = d/t']);
  assert.equal(notes.si_unit, 'speed is measured in m/s');
  assert.equal(ensureAcademicGrounding({ title: 'Speed', description: '' }).si_unit, 'None');
});

test('production context exposes missing grounding without filling an academic-looking placeholder', () => {
  const context = buildTeachingContext({ topic: { title: 'What Is a Force?', content: '' },
    goals: [{ title: 'Define force', description: 'Students will define force in their own words.' }],
    state: { phase: 'DIALOGUE' }, userProfile: { grade_level: 8 } });
  assert.equal(context.academic_grounding.grounding_status, 'missing_factual_source');
  assert.equal(context.academic_grounding.scientific_definition, '');
  assert.equal(context.academic_grounding.scientific_mechanism, '');
  assert.deepEqual(context.academic_grounding.exam_points, []);
  assert.doesNotMatch(JSON.stringify(context.academic_grounding), /is defined as students|Operates through the core principles|core academic principle/);
});
