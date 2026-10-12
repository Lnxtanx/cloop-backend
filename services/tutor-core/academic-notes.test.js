const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAcademicNotes, prepareAcademicGoals } = require('./academic-notes');

test('exam notes preserve source definition and oxygen-transport mechanism', () => {
  const goal = { title: 'Carbon monoxide health effects', description: 'Carbon monoxide is a poisonous gas' };
  const source = 'Carbon monoxide forms during incomplete combustion. Carbon monoxide binds to haemoglobin and reduces oxygen transport in blood. Acid rain damages plants.';
  const notes = buildAcademicNotes(goal, source);
  assert.equal(notes.definition, goal.description);
  assert.match(notes.model_answer, /binds to haemoglobin and reduces oxygen transport/);
  assert.ok(notes.exam_keywords.includes('haemoglobin'));
  assert.ok(!notes.exam_points.includes('Acid rain damages plants.'));
});

test('notes never add a guessed textbook mechanism to thin source material', () => {
  const notes = buildAcademicNotes({ title: 'Clean fuels', description: 'Natural gas emits less CO2 than coal' }, '');
  assert.equal(notes.model_answer, 'Natural gas emits less CO2 than coal');
  assert.equal(notes.common_mistake, 'Natural gas emits less CO2 than coal');
  assert.ok(!/zero|air filter/.test(notes.model_answer));
});

test('full definitions and formulas survive the conversational word limit', () => {
  const description = 'Average speed is the total distance travelled divided by the total time taken for the whole journey; v = d/t, distance in metres, time in seconds, speed in m/s';
  const { notes, goals } = prepareAcademicGoals([{ title: 'Average speed', description }], '');
  assert.equal(notes[0].definition, description.split(';')[0]);
  assert.match(notes[0].formulas[0], /m\/s/);
  assert.equal(goals[0].description, notes[0].model_answer);
});

test('unchanged source and original goals reuse complete notes with their content fingerprint', () => {
  const goals = [{ title: 'Variables', description: 'The independent variable is deliberately changed', order: 1 }];
  const source = 'The independent variable is changed in an experiment.';
  const first = prepareAcademicGoals(goals, source);
  const second = prepareAcademicGoals(goals, source, first.notes, first.fingerprint);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.strictEqual(second.notes, first.notes);
  const reorderedProperties = [{ order: 1, description: goals[0].description, title: goals[0].title }];
  assert.equal(prepareAcademicGoals(reorderedProperties, source).fingerprint, first.fingerprint);
});

test('a changed syllabus rebuilds same-count cached notes from current source', () => {
  const goals = [{ title: 'Dependent and controlled variables', description: 'The independent variable is deliberately changed' }];
  const old = prepareAcademicGoals(goals, 'The dependent variable is the measured outcome.');
  const updated = prepareAcademicGoals(goals,
    'The dependent variable is a measurable outcome, such as plant height; Controlled variables are kept constant for a fair test.',
    old.notes, old.fingerprint);
  assert.notEqual(updated.fingerprint, old.fingerprint);
  assert.notStrictEqual(updated.notes, old.notes);
  assert.match(updated.notes[0].model_answer, /measurable outcome, such as plant height/);
  assert.match(updated.notes[0].model_answer, /Controlled variables are kept constant/);
  assert.ok(!updated.notes[0].exam_points.includes('The dependent variable is the measured outcome.'));
});

test('changed goal facts invalidate same-count cached notes without changing historical notes', () => {
  const original = [{ title: 'Variables', description: 'The dependent variable is the plant' }];
  const old = prepareAcademicGoals(original, '');
  const oldSnapshot = JSON.stringify(old.notes);
  const updated = prepareAcademicGoals([{ ...original[0], description: 'The dependent variable is measured plant growth' }],
    '', old.notes, old.fingerprint);
  assert.notEqual(updated.fingerprint, old.fingerprint);
  assert.equal(updated.notes[0].model_answer, 'The dependent variable is measured plant growth');
  assert.equal(JSON.stringify(old.notes), oldSnapshot);
});

test('legacy unkeyed notes are rebuilt even when their count matches current goals', () => {
  const goals = [{ title: 'Variables', description: 'The independent variable is deliberately changed' }];
  const old = prepareAcademicGoals(goals, '');
  old.notes[0].model_answer = 'Stale cached definition';
  const updated = prepareAcademicGoals(goals, '', old.notes);
  assert.notStrictEqual(updated.notes, old.notes);
  assert.equal(updated.notes[0].model_answer, goals[0].description);
});

test('matching fingerprint does not reuse incomplete or corrupted notes', () => {
  const goals = [{ title: 'Variables', description: 'The independent variable is deliberately changed' }];
  const original = prepareAcademicGoals(goals, '');
  for (const invalid of [[], [{ ...original.notes[0], exam_points: [] }],
    [{ ...original.notes[0], model_answer: 'The independent variable is the' }],
    [{ ...original.notes[0], definition: null }]]) {
    const updated = prepareAcademicGoals(goals, '', invalid, original.fingerprint);
    assert.notStrictEqual(updated.notes, invalid);
    assert.deepEqual(updated.notes, original.notes);
  }
});

test('fire-control notes retain the supplied mechanism, class and exam terms', () => {
  const notes = buildAcademicNotes({ title: 'Water extinguisher', description:
    'A water extinguisher cools burning material below its ignition temperature; Water suits Class A ordinary solid fires such as wood and paper' });
  assert.match(notes.mechanism, /cools.*ignition temperature/);
  assert.ok(notes.exam_keywords.includes('ignition temperature'));
  assert.ok(notes.exam_keywords.includes('Class A'));
  const unclassified = buildAcademicNotes({ title: 'Cooling with water', description: 'Water absorbs heat from burning wood and paper' });
  assert.ok(!unclassified.exam_keywords.includes('Class A'));
  assert.ok(!unclassified.model_answer.includes('Class A'));
});

test('experiment notes retain all source-taught academic variable names without adding absent terms', () => {
  const description = 'The independent variable is deliberately changed; The dependent variable is the measured outcome; Controlled variables are relevant conditions kept constant for a fair test';
  const notes = buildAcademicNotes({ title: 'Variable roles in a fair test', description });
  assert.deepEqual(notes.exam_keywords, ['independent variable', 'dependent variable', 'Controlled variables', 'fair test']);
  assert.equal(notes.model_answer, description);
  const unnamed = buildAcademicNotes({ title: 'Comparing plants', description: 'Plants can grow to different heights.' });
  assert.ok(!unnamed.exam_keywords.some(term => /variable/i.test(term)));
  assert.deepEqual(unnamed.formulas, []);
});
