const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTeachingContext,
  ensureAcademicGrounding,
  resolveAnalogies,
  resolveMisconceptions,
  resolveScenarioContinuity,
  getPhaseGuidance
} = require('./context-builder');

test('CB1: Guaranteed academic grounding generates non-empty definition, mechanism, and SI units even for short stubs', () => {
  const shortGoal = { title: 'Frictional Force', description: 'Brief note' };
  const grounding = ensureAcademicGrounding(shortGoal, 'Forces in Nature', '');

  assert.ok(grounding.definition.length > 10, 'Definition must be non-empty');
  assert.ok(grounding.mechanism.length > 10, 'Mechanism must be non-empty');
  assert.equal(grounding.si_unit, 'Newton (N)', 'SI unit for force must be Newton');
  assert.ok(Array.isArray(grounding.exam_points) && grounding.exam_points.length >= 2, 'Exam points must be populated');
});

test('CB2: Analogies resolver injects familiar everyday Indian examples', () => {
  const frictionAnalogies = resolveAnalogies('Contact Forces', 'Frictional resistance');
  assert.ok(frictionAnalogies.length >= 2);
  assert.ok(frictionAnalogies.some(a => a.toLowerCase().includes('ball') || a.toLowerCase().includes('bicycle')));

  const gravityAnalogies = resolveAnalogies('Gravitation', 'Falling objects');
  assert.ok(gravityAnalogies.some(a => a.toLowerCase().includes('cricket') || a.toLowerCase().includes('mango')));
});

test('CB3: Misconceptions resolver extracts AKG traps and falls back to domain-specific scientific truths', () => {
  const akgContext = {
    common_misconceptions: [
      { misconception: 'Heavier objects fall faster in vacuum', correction_angle: 'All objects accelerate at g regardless of mass' }
    ]
  };
  const resolved = resolveMisconceptions(akgContext, 'Gravitation');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].trap, 'Heavier objects fall faster in vacuum');

  // Fallback test
  const fallback = resolveMisconceptions(null, 'Contact and Non-Contact Forces');
  assert.ok(fallback.length >= 2, 'Should provide standard domain misconceptions if AKG has none');
  assert.ok(fallback.some(m => m.trap.toLowerCase().includes('direction of motion')));
});

test('CB4: Scenario continuity locks physical objects across turns', () => {
  const lastQuestionRecord = {
    scenario: { object: 'wooden cart', actor: 'student', action: 'pulling horizontally' }
  };
  const scenario = resolveScenarioContinuity(lastQuestionRecord);
  assert.equal(scenario.object, 'wooden cart');
  assert.equal(scenario.action, 'pulling horizontally');
});

test('CB5: Pedagogical phase guidance customizes instructions and word counts per phase', () => {
  const probeGuidance = getPhaseGuidance('PROBE');
  assert.ok(probeGuidance.bubble_structure.includes('under 20 words'));

  const theoryGuidance = getPhaseGuidance('THEORY');
  assert.ok(theoryGuidance.bubble_structure.includes('under 25 words'), 'Theory phase bubbles must be under 25 words each');
  assert.ok(theoryGuidance.bubble_structure.includes('3-4 micro-bubbles'));

  const checkGuidance = getPhaseGuidance('CHECK');
  assert.ok(checkGuidance.bubble_structure.includes('Multiple Choice Question'));
});

test('CB6: Full buildTeachingContext produces structured, complete payload ready for DeepSeek', () => {
  const context = buildTeachingContext({
    topic: { title: 'Contact Forces', content: 'Friction and muscular forces.' },
    goals: [
      { id: 1, title: 'Define Friction', description: 'Resistance to sliding.' },
      { id: 2, title: 'Muscular Force', description: 'Force by muscles.' }
    ],
    goalIndex: 0,
    chatHistory: [
      { sender: 'ai', message: 'What happens when a ball rolls on grass?' },
      { sender: 'user', message: 'It slows down because of grass' }
    ],
    state: { phase: 'THEORY', lastQuestionText: 'What happens when a ball rolls on grass?' },
    studentMessage: 'It slows down because of grass',
    userProfile: { grade_level: '8', board: 'CBSE' },
  });

  assert.equal(context.academic_grounding.topic_title, 'Contact Forces');
  assert.equal(context.academic_grounding.class_level, 'Class 8 CBSE');
  assert.ok(context.academic_grounding.scientific_definition.length > 10);
  assert.ok(context.academic_grounding.everyday_analogies.length >= 2);
  assert.ok(context.academic_grounding.known_misconceptions.length >= 1);
  assert.equal(context.temporal_state.phase, 'THEORY');
  assert.equal(context.temporal_state.lesson_progress.current_step, 'Goal 1 of 2');
  assert.equal(context.academic_grounding.grade_pedagogy.grade, 8);
});

test('CB7: Grade-level pedagogy differentiates Class 6 vs Class 8 vs Class 10 cognitive depth and formula policy', () => {
  const { resolveGradePedagogy } = require('./context-builder');
  const class6 = resolveGradePedagogy(6);
  assert.equal(class6.grade, 6);
  assert.ok(class6.formula_policy.includes('ZERO'));
  assert.ok(class6.cognitive_depth.includes('observational'));

  const class8 = resolveGradePedagogy(8);
  assert.equal(class8.grade, 8);
  assert.ok(class8.formula_policy.includes('Newton'));

  const class10 = resolveGradePedagogy(10);
  assert.equal(class10.grade, 10);
  assert.ok(class10.formula_policy.includes('Formal formulas'));
  assert.ok(class10.cognitive_depth.includes('Board-exam'));
});

test('CB8: Multi-subject grounding and analogies work for Mathematics, Biology, and Civics', () => {
  const { resolveSubjectAndBoard, resolveAnalogies, ensureAcademicGrounding } = require('./context-builder');

  // Math test
  const mathTopic = {
    title: 'Linear Equations in One Variable',
    chapter: { subject: { name: 'Mathematics', board: 'ICSE', grade: '9' } }
  };
  const resolvedMath = resolveSubjectAndBoard(mathTopic, { grade_level: '9', board: 'ICSE' });
  assert.equal(resolvedMath.subjectName, 'Mathematics');
  assert.equal(resolvedMath.boardName, 'ICSE');

  const mathAnalogies = resolveAnalogies('Linear Equations', 'Solving for x');
  assert.ok(mathAnalogies.some(a => a.toLowerCase().includes('balance') || a.toLowerCase().includes('box')));

  const mathGrounding = ensureAcademicGrounding({ title: 'Solving Linear Equations', description: 'Isolating the variable.' }, 'Linear Equations', '', 'Mathematics');
  assert.ok(mathGrounding.definition.includes('mathematical statement') || mathGrounding.definition.includes('Linear Equations'));
  assert.ok(mathGrounding.mechanism.includes('inverse') || mathGrounding.mechanism.includes('sides'));

  // Biology test
  const bioAnalogies = resolveAnalogies('Life Processes', 'Photosynthesis in plants');
  assert.ok(bioAnalogies.some(a => a.toLowerCase().includes('sunlight') || a.toLowerCase().includes('kitchen') || a.toLowerCase().includes('solar')));

  // Civics test
  const civicsAnalogies = resolveAnalogies('Democratic Politics', 'Constitutional Design');
  assert.ok(civicsAnalogies.some(a => a.toLowerCase().includes('voting') || a.toLowerCase().includes('cricket') || a.toLowerCase().includes('rules')));
});

test('CB9: Multi-board context builder produces correct class level for State Board and Cambridge', () => {
  const stateBoardContext = buildTeachingContext({
    topic: { title: 'Quadrilaterals', chapter: { subject: { name: 'Mathematics', board: 'Maharashtra State Board' } } },
    goals: [{ id: 1, title: 'Properties of Parallelogram', description: 'Opposite sides equal.' }],
    userProfile: { grade_level: '9', board: 'Maharashtra State Board' }
  });

  assert.equal(stateBoardContext.academic_grounding.board_name, 'Maharashtra State Board');
  assert.equal(stateBoardContext.academic_grounding.subject_name, 'Mathematics');
  assert.equal(stateBoardContext.academic_grounding.class_level, 'Class 9 Maharashtra State Board');
});

