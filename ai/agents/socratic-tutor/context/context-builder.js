/**
 * Socratic Tutor Agent — Teaching Context Builder
 *
 * Centralizes and enriches all pedagogical, domain, and temporal context
 * passed to DeepSeek-V4-Pro on every turn:
 * 1. Academic Grounding (Guaranteed non-empty definitions, mechanisms, formulas, SI units)
 * 2. Misconceptions & Traps (From AKG and past student errors)
 * 3. Everyday Analogies Catalog (Familiar real-world Indian context)
 * 4. Scenario Continuity (Locks physical objects & actors across turns)
 * 5. Temporal Pacing & Question Deduplication (Prevents repetition)
 * 6. Phase-Specific Pedagogical Guidelines (Theory breakdown vs Socratic dialogue)
 */

const { buildAcademicNotes } = require('../../../../services/tutor-core/academic-notes');
const { getMisconceptionsForTopic } = require('../tools/memory-tool');

// Default domain-specific analogy catalog
const DOMAIN_ANALOGIES = {
  friction: [
    'A football rolling on grass stops because grass blades push against the ball surface.',
    'Bicycle brake pads pressing against the metallic rim to stop the rotating wheel.',
    'Rubbing hands together on a cold morning generating heat due to surface resistance.'
  ],
  gravity: [
    'A ripe mango falling straight down to the ground from a tree branch.',
    'Throwing a cricket ball up into the air and watching it slow down, stop, and fall back.'
  ],
  inertia: [
    'Passengers jerking forward when a bus driver suddenly hits the brakes.',
    'Dust flying off a carpet when struck with a wooden stick.'
  ],
  pressure: [
    'A sharp needle puncturing a balloon easily while a blunt finger cannot.',
    'Wide straps on a school bag distributing weight to prevent shoulder strain.'
  ],
  optics: [
    'Looking through a clear magnifying glass to focus sunlight on paper.',
    'The eye lens flexing to shift focus from a distant blackboard to a nearby textbook.'
  ],
  circuits: [
    'Water flowing through a pipe powered by a pump, analogous to electric current powered by a battery.',
    'A switch acting like a tap that opens or breaks the path of current.'
  ],
  chemistry: [
    'Iron nails rusting when left exposed to humid monsoon air.',
    'Baking soda reacting vigorously with lemon juice producing carbon dioxide bubbles.'
  ]
};

const DOMAIN_ANALOGY_RULES = [
  { pattern: /\b(frict|contact force|drag|resistance)\b/i, analogies: DOMAIN_ANALOGIES.friction },
  { pattern: /\b(gravit|falling|weight|free fall)\b/i, analogies: DOMAIN_ANALOGIES.gravity },
  { pattern: /\b(inerti|first law|momentum)\b/i, analogies: DOMAIN_ANALOGIES.inertia },
  { pattern: /\b(pressur|thrust|pascal)\b/i, analogies: DOMAIN_ANALOGIES.pressure },
  { pattern: /\b(optic|light|lens|mirror|reflect|refract)\b/i, analogies: DOMAIN_ANALOGIES.optics },
  { pattern: /\b(circuit|current|electr|voltage|resistor)\b/i, analogies: DOMAIN_ANALOGIES.circuits },
  { pattern: /\b(chem|react|acid|base|rust|combust)\b/i, analogies: DOMAIN_ANALOGIES.chemistry }
];

/**
 * Match topic or goal to familiar everyday analogies
 */
function resolveAnalogies(topicTitle = '', goalTitle = '') {
  const combined = `${topicTitle} ${goalTitle}`;
  for (const rule of DOMAIN_ANALOGY_RULES) {
    if (rule.pattern.test(combined)) return rule.analogies;
  }
  // Generic mechanical / physical fallback analogies
  return [
    'Observing a moving cycle or ball and seeing what causes it to start, speed up, or stop.',
    'Applying a push or pull on everyday classroom objects like doors, desks, or books.'
  ];
}

/**
 * Ensure definition and mechanism are NEVER empty, even if topic content is short
 */
function ensureAcademicGrounding(goal, topicTitle = '', topicContent = '') {
  let notes = null;
  try {
    notes = buildAcademicNotes(goal, topicContent);
  } catch (_) {
    notes = null;
  }

  const title = goal?.title || topicTitle || 'Scientific Concept';
  const desc = goal?.description || '';

  // 1. Guaranteed scientific definition
  let definition = notes?.definition?.trim() || '';
  const isStubDefinition = !definition || definition.length < 20 || definition === desc;
  if (isStubDefinition) {
    if (/\b(frict)\b/i.test(title)) {
      definition = 'Frictional force is the opposing force that comes into play when two surfaces in contact move or tend to move with respect to each other.';
    } else if (/\b(gravit)\b/i.test(title)) {
      definition = 'Gravitational force is the universal attractive force exerted by any mass on any other mass.';
    } else if (/\b(magnetic)\b/i.test(title)) {
      definition = 'Magnetic force is the attraction or repulsion that arises between magnetic poles or moving electric charges.';
    } else if (/\b(electrostatic)\b/i.test(title)) {
      definition = 'Electrostatic force is the attractive or repulsive force exerted by an electrically charged object on another object.';
    } else if (/\b(pressure)\b/i.test(title)) {
      definition = 'Pressure is the physical force exerted perpendicular per unit surface area of an object.';
    } else if (/\b(inertia)\b/i.test(title)) {
      definition = 'Inertia is the natural tendency of an object to resist any change in its state of rest or uniform motion.';
    } else if (desc.length > 25) {
      definition = `${title} is defined as ${desc.split(/[.;]/)[0].toLowerCase()}.`;
    } else {
      definition = `${title} is a fundamental scientific principle in ${topicTitle || 'science'} describing this phenomenon.`;
    }
  }

  // 2. Guaranteed physical mechanism (how/why it works)
  let mechanism = notes?.mechanism?.trim() || '';
  if (!mechanism || mechanism.length < 15) {
    if (/\b(friction|contact)\b/i.test(title)) {
      mechanism = 'Occurs because microscopic irregularities on touching surfaces interlock, resisting relative motion.';
    } else if (/\b(non-contact|gravity|gravitation|magnetic)\b/i.test(title)) {
      mechanism = 'Acts across empty space through a force field without requiring physical contact between the objects.';
    } else if (/\b(inertia|first law)\b/i.test(title)) {
      mechanism = 'Mass inherently resists any change in its velocity unless compelled by an unbalanced external force.';
    } else if (/\b(pressure)\b/i.test(title)) {
      mechanism = 'Force exerted perpendicular per unit area; smaller surface area produces significantly higher pressure.';
    } else {
      mechanism = desc.length > 25
        ? `Operates through the core principles of ${title}, explaining cause and effect in the system.`
        : 'Governed by underlying physical interactions between the entities in this scenario.';
    }
  }

  // 3. Formula and SI units
  const formulas = Array.isArray(notes?.formulas) && notes.formulas.length ? notes.formulas : [];
  let siUnit = 'None';
  if (/\b(force|friction|weight|thrust)\b/i.test(title)) siUnit = 'Newton (N)';
  else if (/\b(pressure)\b/i.test(title)) siUnit = 'Pascal (Pa) or N/m²';
  else if (/\b(energy|work)\b/i.test(title)) siUnit = 'Joule (J)';
  else if (/\b(speed|velocity)\b/i.test(title)) siUnit = 'm/s';
  else if (/\b(acceleration)\b/i.test(title)) siUnit = 'm/s²';
  else if (/\b(mass)\b/i.test(title)) siUnit = 'Kilogram (kg)';

  // 4. Key exam points (guaranteed at least 2 complete academic statements)
  let examPoints = Array.isArray(notes?.exam_points) && notes.exam_points.length >= 2 && notes.exam_points.every(p => p.length >= 15)
    ? notes.exam_points
    : [definition, mechanism];

  return {
    definition,
    mechanism,
    formulas,
    si_unit: siUnit,
    exam_points: examPoints,
    exam_keywords: notes?.exam_keywords || [],
    common_mistake: notes?.common_mistake || '',
  };
}

/**
 * Extract and normalize misconceptions from AKG and memory tool
 */
function resolveMisconceptions(akgContext, topicTitle = '') {
  const misconceptions = [];

  // 1. From AKG context
  if (akgContext?.common_misconceptions && Array.isArray(akgContext.common_misconceptions)) {
    for (const m of akgContext.common_misconceptions) {
      if (m && typeof m === 'object' && (m.misconception || m.trap)) {
        misconceptions.push({
          trap: m.misconception || m.trap,
          scientific_truth: m.correction_angle || m.correction || m.fact || 'Opposite scientific principle holds true.'
        });
      }
    }
  }

  // 2. Domain-specific standard traps if AKG has none
  if (misconceptions.length === 0) {
    if (/\b(friction|contact)\b/i.test(topicTitle)) {
      misconceptions.push({
        trap: 'Believing friction acts in the direction of motion.',
        scientific_truth: 'Friction always opposes the relative motion between two surfaces in contact.'
      });
      misconceptions.push({
        trap: 'Believing smooth surfaces have zero friction.',
        scientific_truth: 'Even polished surfaces have microscopic irregularities that cause friction.'
      });
    } else if (/\b(third law|action|reaction)\b/i.test(topicTitle)) {
      misconceptions.push({
        trap: 'Thinking action and reaction forces cancel each other out.',
        scientific_truth: 'Action and reaction act on DIFFERENT objects, so they never cancel each other.'
      });
    } else if (/\b(mass|weight)\b/i.test(topicTitle)) {
      misconceptions.push({
        trap: 'Confusing mass and weight as identical quantities.',
        scientific_truth: 'Mass is the quantity of matter (kg, constant), while weight is the gravitational pull on mass (N, varies with gravity).'
      });
    }
  }

  return misconceptions;
}

/**
 * Extract deduplicated list of questions asked in recent turns
 */
function extractAskedQuestions(history = [], lastQuestionText = '') {
  const asked = [];
  const CARD_TITLES = new Set(['YouTube Video', 'Concept Diagram', 'Revision Sheet']);

  if (Array.isArray(history)) {
    for (const m of history) {
      if (!m) continue;
      const isAi = m.sender === 'ai' || m.sender === 'Tutor' || m.speaker === 'Tutor';
      if (!isAi) continue;
      const text = String(m.message || m.text || '').trim();
      if (CARD_TITLES.has(text)) continue;
      if (/[?？]/.test(text) && !asked.includes(text)) {
        asked.push(text);
      }
    }
  }

  const pending = String(lastQuestionText || '').trim();
  if (pending && /[?？]/.test(pending) && !asked.includes(pending)) {
    asked.push(pending);
  }
  return asked;
}

/**
 * Filter recent chat turns cleanly (keeping dialogue, stripping card artifacts)
 */
function filterRecentHistory(history = [], maxTurns = 8) {
  if (!Array.isArray(history)) return [];
  const CARD_TYPES = new Set(['mermaid_diagram', 'youtube_video', 'revision_sheet', 'session_summary']);

  return history
    .filter(m => {
      if (!m) return false;
      const text = String(m.message || m.text || '').trim();
      if (!text) return false;
      if (m.message_type && CARD_TYPES.has(m.message_type)) return false;
      return true;
    })
    .slice(-maxTurns)
    .map(m => ({
      speaker: m.sender === 'user' || m.speaker === 'Student' ? 'Student' : 'Tutor',
      text: m.message || m.text || '',
      ...(m.options && Array.isArray(m.options) && m.options.length ? { options: m.options } : {})
    }));
}

/**
 * Resolve active scenario continuity to prevent entity hopping
 */
function resolveScenarioContinuity(lastQuestionRecord, studentMessage = '', academicNotes = null) {
  if (lastQuestionRecord?.scenario && typeof lastQuestionRecord.scenario === 'object') {
    return {
      actor: lastQuestionRecord.scenario.actor || null,
      object: lastQuestionRecord.scenario.object || null,
      action: lastQuestionRecord.scenario.action || null,
      summary: lastQuestionRecord.scenario.summary || null,
    };
  }

  // Look for prominent physical entities in recent context
  const text = `${studentMessage} ${academicNotes?.definition || ''}`.toLowerCase();
  if (/\b(ball|football|cricket)\b/.test(text)) {
    return { object: 'ball', setting: 'grass ground', action: 'rolling and slowing down' };
  }
  if (/\b(box|block|crate)\b/.test(text)) {
    return { object: 'wooden box', setting: 'horizontal rough floor', action: 'being pushed' };
  }
  if (/\b(cycle|bicycle|car)\b/.test(text)) {
    return { object: 'bicycle', setting: 'road', action: 'applying brakes' };
  }

  return null;
}

/**
 * Grade-Level Pedagogical Calibration
 * Differentiates vocabulary, cognitive depth, and formula depth per class (Class 6 vs 8 vs 10)
 */
function resolveGradePedagogy(gradeLevel = 8) {
  const gradeNum = parseInt(String(gradeLevel).replace(/\D/g, ''), 10) || 8;
  if (gradeNum <= 6) {
    return {
      grade: 6,
      audience: 'Class 6 Students (Ages 11-12)',
      cognitive_depth: 'Pure observational science and concrete everyday physical experience (push/pull, hot/cold, shadows, plant/animal parts).',
      vocabulary_policy: 'Extremely simple, friendly words. Short sentences. NO abstract scientific jargon without immediate concrete demonstration.',
      formula_policy: 'ZERO mathematical or algebraic formulas. Do not mention equations or abstract constants.',
      analogy_focus: 'Playground, classroom, toys, kitchen, sports (balls, swings, water, doors).'
    };
  }
  if (gradeNum === 7) {
    return {
      grade: 7,
      audience: 'Class 7 Students (Ages 12-13)',
      cognitive_depth: 'Descriptive scientific mechanisms and elementary processes (heat conduction/convection, simple speed, acids/bases, respiration).',
      vocabulary_policy: 'Clear introductory scientific terms, explained immediately in plain conversational words.',
      formula_policy: 'Simple arithmetic relationships only (e.g. speed = distance / time).',
      analogy_focus: 'Everyday household observations, cooking, cycling, weather, breathing.'
    };
  }
  if (gradeNum === 8) {
    return {
      grade: 8,
      audience: 'Class 8 Students (Ages 13-14)',
      cognitive_depth: 'Fundamental scientific principles, qualitative physical laws, cause-and-effect reasoning (Force & Pressure, Friction, Sound).',
      vocabulary_policy: 'Standard foundational scientific terms and clear NCERT definitions.',
      formula_policy: 'Elementary formulas with basic SI units (Newton, Pascal) explained through proportionality (smaller area = higher pressure).',
      analogy_focus: 'Cricket ball, bicycle brakes, school bag straps, balloons, needles, rough vs smooth roads.'
    };
  }
  if (gradeNum === 9) {
    return {
      grade: 9,
      audience: 'Class 9 Students (Ages 14-15)',
      cognitive_depth: 'Formal scientific laws, vector principles (Newton\'s 3 laws with separate action-reaction bodies), gravitation, work-energy theorem.',
      vocabulary_policy: 'Precise academic terminology and rigorous conceptual definitions.',
      formula_policy: 'Formal mathematical laws (F=ma, g=9.8 m/s², W=F*s) with dimensional units.',
      analogy_focus: 'Vehicles, falling objects, springs, sports mechanics, chemical mixtures.'
    };
  }
  // Class 10+
  return {
    grade: 10,
    audience: 'Class 10 Students (Ages 15-16)',
    cognitive_depth: 'Board-exam academic rigor. Quantitative reasoning, multi-step mechanisms, ray optics diagrams, electrical circuits, biochemical pathways.',
    vocabulary_policy: 'NCERT board-standard scientific keywords and exam-grade phrasing.',
    formula_policy: 'Formal formulas (1/f = 1/v - 1/u, V=IR, P=VI, balanced chemical equations) with derived SI units.',
    analogy_focus: 'Camera lenses, human eye ciliary flexing, vehicle headlights, domestic wiring, chemical reactions.'
  };
}

/**
 * Build Phase-Specific Pedagogical Guidelines
 */
function getPhaseGuidance(phase, stateInstruction, reportBrief) {
  switch (phase) {
    case 'PROBE':
      return {
        phase_purpose: 'Discover intuitive prior knowledge before formal teaching begins.',
        bubble_structure: '1-2 bubbles (under 20 words each). Bubble 1: Welcome & topic anchor. Bubble 2: Open everyday curiosity question.',
        rules: 'Unscored. NO options. Do NOT reveal definitions or formulas yet.'
      };

    case 'THEORY':
      return {
        phase_purpose: 'Explicit concept breakdown. Teach the core science before any assessment question.',
        bubble_structure: '3-4 micro-bubbles (under 25 words each):\n• Bubble 1: Precise scientific definition.\n• Bubble 2: Physical mechanism & everyday Indian analogy.\n• Bubble 3: Concrete observation or everyday application.\n• Bubble 4: Focused check question to begin dialogue.',
        rules: 'Teach one concept completely. Each bubble must have 25 words or fewer. Do not cram everything into one bubble.'
      };

    case 'DIALOGUE':
      return {
        phase_purpose: 'Interactive Socratic inquiry. Guide the student to articulate scientific answers.',
        bubble_structure: '1-2 bubbles (under 20 words each). Brief acknowledgment + focused question.',
        rules: 'If student struggles: Attempt 1 = targeted hint; Attempt 2 = different angle / starter; Attempt 3 = reveal model answer & advance.'
      };

    case 'CHECK':
      return {
        phase_purpose: 'Objective verification of understanding.',
        bubble_structure: '1 bubble containing 1 Multiple Choice Question with 2-4 distinct plausible options.',
        rules: 'Exactly one correct option. Distractors must target known student misconceptions.'
      };

    case 'ROUNDUP':
      return {
        phase_purpose: 'Exam-readiness recall of all goals taught, without hints.',
        bubble_structure: '1 focused written recall question asking the student to state the definition or formula in their own words.',
        rules: 'Scored recall. Confirms retention before the final revision sheet is issued.'
      };

    case 'WRAP':
      return {
        phase_purpose: 'Session conclusion and synthesis.',
        bubble_structure: 'Warm closing acknowledgment with server score. Emits revision sheet.',
        rules: 'No further questions. No unearned flattery.'
      };

    default:
      return {
        phase_purpose: 'Teach and clarify the current topic.',
        bubble_structure: '1-2 concise bubbles (under 20 words each).',
        rules: 'Keep explanations grounded in the supplied syllabus.'
      };
  }
}

/**
 * Main Entry Point: Build the complete, enriched teaching context
 *
 * @param {Object} params
 * @returns {Object} Complete structured teaching context
 */
function buildTeachingContext(params) {
  const {
    topic,
    goals = [],
    goalIndex = 0,
    chatHistory = [],
    state = {},
    studentMessage = '',
    evaluatorResult = {},
    userProfile = {},
    akgContext = null,
    wantsVideo = false,
  } = params;

  const topicTitle = topic?.title || 'Science Topic';
  const topicContent = topic?.content || '';
  const totalGoals = Math.max(1, goals.length);
  const currentGoalIdx = Math.min(Math.max(0, goalIndex), totalGoals - 1);
  const currentGoal = goals[currentGoalIdx] || { title: topicTitle, description: topicContent };

  const classLevel = [
    userProfile.grade_level ? `Class ${userProfile.grade_level}` : 'Class 8',
    userProfile.board || 'CBSE'
  ].join(' ');

  const gradePedagogy = resolveGradePedagogy(userProfile.grade_level || 8);

  // 1. Guaranteed Academic Grounding
  const academicGrounding = ensureAcademicGrounding(currentGoal, topicTitle, topicContent);
  const analogies = resolveAnalogies(topicTitle, currentGoal.title);
  const misconceptions = resolveMisconceptions(akgContext, topicTitle);

  // 2. Syllabus Boundaries (AKG)
  const fallbackBoundary = `Stay strictly within ${classLevel} syllabus; never introduce advanced out-of-scope formulas or terminology.`;
  const boundarySnippet = akgContext?.tutor_context?.prompt_snippet || fallbackBoundary;

  // 3. Scenario & Entity Continuity
  const scenario = resolveScenarioContinuity(state.lastQuestionRecord, studentMessage, academicGrounding);

  // 4. Temporal & Question History
  const askedQuestions = extractAskedQuestions(chatHistory, state.lastQuestionText);
  const recentHistory = filterRecentHistory(chatHistory, 8);

  // 5. Phase-Specific Pedagogical Guidance
  const phase = state.phase || 'DIALOGUE';
  const stateInstruction = params.stateInstruction || state.lastInstruction || 'continue_dialogue';
  const phaseGuidance = getPhaseGuidance(phase, stateInstruction, params.reportBrief);

  // 6. Goal Progress Map
  const goalMap = goals.map((g, idx) => ({
    index: idx + 1,
    title: typeof g === 'string' ? g : (g?.title || `Goal ${idx + 1}`),
    status: idx < currentGoalIdx ? 'covered' : idx === currentGoalIdx ? 'current' : 'upcoming'
  }));

  return {
    academic_grounding: {
      topic_title: topicTitle,
      class_level: classLevel,
      current_goal: {
        index: currentGoalIdx + 1,
        total: totalGoals,
        title: currentGoal.title,
        description: currentGoal.description || '',
      },
      scientific_definition: academicGrounding.definition,
      scientific_mechanism: academicGrounding.mechanism,
      formulas: academicGrounding.formulas,
      si_unit: academicGrounding.si_unit,
      exam_points: academicGrounding.exam_points,
      exam_keywords: academicGrounding.exam_keywords,
      everyday_analogies: analogies,
      known_misconceptions: misconceptions,
      academic_boundaries: boundarySnippet,
      grade_pedagogy: gradePedagogy,
    },
    temporal_state: {
      phase,
      state_instruction: stateInstruction,
      pedagogical_guidance: phaseGuidance,
      active_scenario: scenario,
      asked_questions: askedQuestions,
      recent_history: recentHistory,
      lesson_progress: {
        current_step: `Goal ${currentGoalIdx + 1} of ${totalGoals}`,
        goals: goalMap,
      },
    },
    student_status: {
      latest_message: studentMessage,
      intent: evaluatorResult?.intent || 'NONE',
      evaluator_verdict: {
        is_correct: evaluatorResult?.is_correct ?? null,
        error_type: evaluatorResult?.error_type || null,
        feedback: evaluatorResult?.feedback || null,
        complete_answer: evaluatorResult?.complete_answer || null,
        satisfied_criteria: Array.isArray(evaluatorResult?.criterion_results)
          ? evaluatorResult.criterion_results.filter(c => c.satisfied).map(c => c.description)
          : [],
        missing_criteria: Array.isArray(evaluatorResult?.criterion_results)
          ? evaluatorResult.criterion_results.filter(c => c.required && !c.satisfied).map(c => c.description)
          : [],
      },
      response_mode: state.response_mode || 'check',
      consecutive_wrong: state.consecutiveWrong || 0,
      stuck_streak: state.stuckStreak || 0,
      wants_video: Boolean(wantsVideo),
    }
  };
}

module.exports = {
  buildTeachingContext,
  ensureAcademicGrounding,
  resolveAnalogies,
  resolveMisconceptions,
  resolveGradePedagogy,
  extractAskedQuestions,
  filterRecentHistory,
  resolveScenarioContinuity,
  getPhaseGuidance,
  DOMAIN_ANALOGIES,
};
