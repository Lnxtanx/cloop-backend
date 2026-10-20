/**
 * Socratic Tutor Agent — Teaching Context Builder
 *
 * Centralizes and enriches all pedagogical, domain, and temporal context
 * passed to DeepSeek-V4-Pro on every turn:
 * 1. Academic Grounding (Source-backed definitions, mechanisms, formulas, and units when available)
 * 2. Multi-Subject Support (Mathematics, Science, Social Sciences, Languages, Humanities)
 * 3. Multi-Board Curriculum Support (CBSE, ICSE, State Boards, Cambridge, IB)
 * 4. Misconceptions & Traps (From AKG and past student errors)
 * 5. Everyday Analogies Catalog (Familiar real-world Indian and everyday contexts)
 * 6. Scenario Continuity (Locks objects, numbers, and actors across turns)
 * 7. Temporal Pacing & Question Deduplication (Prevents repetition)
 * 8. Phase-Specific Pedagogical Guidelines (Theory breakdown vs Socratic dialogue)
 */

const { buildAcademicNotes } = require('../../../../services/tutor-core/academic-notes');
const { factualSourceParts } = require('../../../../services/tutor-core/validate');
const { getMisconceptionsForTopic } = require('../tools/memory-tool');

// Comprehensive domain-specific analogy catalog
const DOMAIN_ANALOGIES = {
  // --- Physics ---
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
  ],

  // --- Mathematics ---
  math_fractions: [
    'Cutting a circular pizza or cake into equal slices to share among friends.',
    'Sharing a chocolate bar with 8 equal squares among 4 classmates.'
  ],
  math_algebra: [
    'A balance scale where an unknown wrapped gift on one side must balance known weights on the other.',
    'Thinking of a mystery gift box whose contents we find by undoing each wrapper one step at a time.'
  ],
  math_geometry: [
    'Looking at hexagonal honeycombs or triangular trusses supporting a long railway bridge.',
    'Floor tiles fitted together perfectly on a room floor with no gaps or overlaps.'
  ],
  math_ratio_percent: [
    'Mixing concentrated squash juice with water in a 1 to 4 cup proportion for the right sweetness.',
    'Checking a discount tag of 20% off at a clothes store during a festival sale.'
  ],
  math_probability: [
    'Flipping a coin before a cricket match to decide who bats first.',
    'Rolling a six-sided dice in a board game like Ludo or snakes and ladders.'
  ],

  // --- Biology / Life Sciences ---
  bio_cell: [
    'A bustling walled city where the nucleus is city hall and mitochondria are the power stations.',
    'A modern school building where different rooms (library, kitchen, offices) carry out dedicated tasks.'
  ],
  bio_photosynthesis: [
    'Solar panels on a rooftop absorbing sunlight to generate electricity, like chlorophyll making food.',
    'A plant chef in a green kitchen using sunlight as the stove, air, and water as ingredients.'
  ],
  bio_human_systems: [
    'A vehicle burning fuel in an engine to get energy to move, like cells using glucose and oxygen.',
    'A water filtration plant purifying river water before sending it through city pipes, like kidneys.'
  ],

  // --- Social Sciences & Humanities ---
  social_civics: [
    'A classroom voting to choose the class monitor where every single student gets one equal vote.',
    'The rules of a cricket match agreed upon by all players before the game starts.'
  ],
  social_geography: [
    'A blueprint of a house or smartphone map showing roads, elevation contours, and landmarks.',
    'Spongy agricultural soil soaking up rainwater during heavy monsoon downpours.'
  ],
  social_history: [
    'A line of toppling dominoes where an initial event triggers a chain reaction of consequences across decades.',
    'Family photo albums showing how daily lifestyle and technology evolved across generations.'
  ],

  // --- Languages & English ---
  lang_grammar: [
    'Building blocks where nouns are the solid bricks, verbs make them move, and adjectives paint them in vivid colors.',
    'Traffic signals on a road directing cars smoothly, just like punctuation marks guide reading tone.'
  ]
};

const DOMAIN_ANALOGY_RULES = [
  // Mathematics
  { pattern: /\b(fractions?|ratios?|proportions?|numerators?|denominators?)\b/i, analogies: DOMAIN_ANALOGIES.math_fractions },
  { pattern: /\b(algebra|equations?|variables?|linear equations?|polynomials?|solve for x)\b/i, analogies: DOMAIN_ANALOGIES.math_algebra },
  { pattern: /\b(geometr\w*|triangles?|quadrilaterals?|polygons?|circles?|angles?|perimeters?|areas?|mensuration|volumes?)\b/i, analogies: DOMAIN_ANALOGIES.math_geometry },
  { pattern: /\b(percents?|percentages?|profits?|loss(es)?|discounts?|interests?)\b/i, analogies: DOMAIN_ANALOGIES.math_ratio_percent },
  { pattern: /\b(probabilit\w*|dice|coins?|outcomes?|statistics?|means?|medians?|modes?)\b/i, analogies: DOMAIN_ANALOGIES.math_probability },

  // Biology
  { pattern: /\b(cells?|organelles?|nucleus|mitochondria|tissues?|membranes?)\b/i, analogies: DOMAIN_ANALOGIES.bio_cell },
  { pattern: /\b(photosynthe\w*|chlorophyll|stomata|plant foods?)\b/i, analogies: DOMAIN_ANALOGIES.bio_photosynthesis },
  { pattern: /\b(respirat\w*|digest\w*|circulat\w*|hearts?|blood|kidneys?|excret\w*)\b/i, analogies: DOMAIN_ANALOGIES.bio_human_systems },

  // Social Sciences
  { pattern: /\b(democra\w*|constitut\w*|parliaments?|judiciar\w*|citizens?|votes?|elections?|rights?|governments?)\b/i, analogies: DOMAIN_ANALOGIES.social_civics },
  { pattern: /\b(maps?|latitudes?|longitudes?|monsoons?|climates?|soils?|rivers?|plateaus?|resources?)\b/i, analogies: DOMAIN_ANALOGIES.social_geography },
  { pattern: /\b(revolutions?|dynast\w*|empires?|wars?|coloni\w*|freedom struggles?|history|civilizations?)\b/i, analogies: DOMAIN_ANALOGIES.social_history },

  // English & Languages
  { pattern: /\b(nouns?|verbs?|adjectives?|tenses?|grammar|prepositions?|pronouns?|sentences?|adverbs?)\b/i, analogies: DOMAIN_ANALOGIES.lang_grammar },

  // Physics & Chemistry
  { pattern: /\b(frict\w*|contact forces?|drag|resistances?)\b/i, analogies: DOMAIN_ANALOGIES.friction },
  { pattern: /\b(gravit\w*|falling|weights?|free falls?)\b/i, analogies: DOMAIN_ANALOGIES.gravity },
  { pattern: /\b(inerti\w*|first laws?|momentums?)\b/i, analogies: DOMAIN_ANALOGIES.inertia },
  { pattern: /\b(pressur\w*|thrusts?|pascals?)\b/i, analogies: DOMAIN_ANALOGIES.pressure },
  { pattern: /\b(optic\w*|lights?|lens(es)?|mirrors?|reflect\w*|refract\w*)\b/i, analogies: DOMAIN_ANALOGIES.optics },
  { pattern: /\b(circuits?|currents?|electr\w*|voltages?|resistors?)\b/i, analogies: DOMAIN_ANALOGIES.circuits },
  { pattern: /\b(chem\w*|react\w*|acids?|bases?|rust|combust\w*|salts?|compounds?)\b/i, analogies: DOMAIN_ANALOGIES.chemistry }
];

/**
 * Match topic or goal to familiar everyday analogies across subjects
 */
function resolveAnalogies(topicTitle = '', goalTitle = '') {
  const combined = `${topicTitle} ${goalTitle}`;
  for (const rule of DOMAIN_ANALOGY_RULES) {
    if (rule.pattern.test(combined)) return rule.analogies;
  }
  // Universal multi-subject fallback analogies
  return [
    'Relating abstract concepts to everyday relatable situations like shopping at a market, sharing food with friends, playing playground games, or classroom routines.',
    'Relating concepts to concrete physical actions like measuring, balancing, comparing, or sorting familiar objects.'
  ];
}

/**
 * Resolve subject name, board, and grade level dynamically
 */
function resolveSubjectAndBoard(topic = {}, userProfile = {}) {
  const rawSubject =
    topic?.chapter?.subject?.name ||
    topic?.subject?.name ||
    topic?.subject_name ||
    (typeof topic?.subject === 'string' ? topic.subject : null) ||
    '';

  let subjectName = rawSubject.trim();
  if (!subjectName) {
    const text = `${topic?.title || ''} ${topic?.content || ''}`.toLowerCase();
    if (/\b(fraction|triangle|algebra|geometry|polynomial|integer|equation|ratio|probability|calculus|quadrilateral|arithmetic|mensuration|trigonometry)\b/i.test(text)) {
      subjectName = 'Mathematics';
    } else if (/\b(history|mughal|revolution|empire|war|dynasty|civilization|freedom|colony|colonial)\b/i.test(text)) {
      subjectName = 'History';
    } else if (/\b(geography|climate|monsoon|plateau|soil|river|earthquake|map|globe|ocean|landform|resource)\b/i.test(text)) {
      subjectName = 'Geography';
    } else if (/\b(civics|democracy|constitution|parliament|judiciary|citizen|rights|government|law)\b/i.test(text)) {
      subjectName = 'Civics / Political Science';
    } else if (/\b(grammar|noun|verb|tense|adjective|preposition|pronoun|sentence|idiom|comprehension|essay|poem)\b/i.test(text)) {
      subjectName = 'English Language';
    } else if (/\b(cell|tissue|photosynthesis|digestion|respiration|plant|animal|organism|reproduction|ecosystem|bacteria)\b/i.test(text)) {
      subjectName = 'Biology';
    } else if (/\b(chemical|reaction|acid|base|salt|atom|molecule|element|compound|rust|metal|non-metal)\b/i.test(text)) {
      subjectName = 'Chemistry';
    } else if (/\b(force|friction|motion|gravity|pressure|light|sound|electricity|magnet|lens|energy|work)\b/i.test(text)) {
      subjectName = 'Physics';
    } else {
      subjectName = 'Academic Concept';
    }
  }

  const boardName =
    userProfile?.board ||
    topic?.chapter?.subject?.board ||
    topic?.board ||
    'CBSE';

  const gradeLevel =
    userProfile?.grade_level ||
    topic?.chapter?.subject?.grade ||
    '8';

  return { subjectName, boardName, gradeLevel };
}

/** Preserve the note contract, but never manufacture facts from a title/objective. */
function ensureAcademicGrounding(goal, topicTitle = '', topicContent = '', subjectName = '') {
  let notes = null;
  try { notes = buildAcademicNotes(goal || {}, topicContent); } catch (_) {}
  const examPoints = [...new Set((notes?.exam_points || []).flatMap(factualSourceParts))];
  const definition = examPoints.find(fact => /\b(?:is|are|defined as|means|refers to)\b|\s=\s/i.test(fact)) || '';
  const mechanism = examPoints.find(fact => /\b(?:because|binds?|reacts?|reduces?|causes?|converts?|traps?|formed|incomplete|absorbs?|lowers?|removes?|cools?|cooling|smothering)\b/i.test(fact)) || '';
  const formulas = (notes?.formulas || []).filter(formula => examPoints.includes(formula));
  const unitFact = examPoints.find(fact => /\b(?:SI units?|units? (?:of|is|are)|measured in)\b/i.test(fact));
  return {
    definition,
    mechanism,
    formulas,
    si_unit: unitFact || 'None',
    exam_points: examPoints,
    exam_keywords: notes?.exam_keywords || [],
    common_mistake: examPoints.includes(notes?.common_mistake) ? notes.common_mistake : '',
    grounding_status: examPoints.length ? 'source_backed' : 'missing_factual_source',
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
        const truth = m.correction_angle || m.correction || m.fact || 'Opposite principle holds true.';
        misconceptions.push({
          trap: m.misconception || m.trap,
          factual_truth: truth,
          scientific_truth: truth
        });
      }
    }
  }

  // 2. Domain-specific standard traps if AKG has none
  if (misconceptions.length === 0) {
    if (/\b(friction|contact)\b/i.test(topicTitle)) {
      misconceptions.push({
        trap: 'Believing friction acts in the direction of motion.',
        factual_truth: 'Friction always opposes the relative motion between two surfaces in contact.',
        scientific_truth: 'Friction always opposes the relative motion between two surfaces in contact.'
      });
      misconceptions.push({
        trap: 'Believing smooth surfaces have zero friction.',
        factual_truth: 'Even polished surfaces have microscopic irregularities that cause friction.',
        scientific_truth: 'Even polished surfaces have microscopic irregularities that cause friction.'
      });
    } else if (/\b(third law|action|reaction)\b/i.test(topicTitle)) {
      misconceptions.push({
        trap: 'Thinking action and reaction forces cancel each other out.',
        factual_truth: 'Action and reaction act on DIFFERENT objects, so they never cancel each other.',
        scientific_truth: 'Action and reaction act on DIFFERENT objects, so they never cancel each other.'
      });
    } else if (/\b(mass|weight)\b/i.test(topicTitle)) {
      misconceptions.push({
        trap: 'Confusing mass and weight as identical quantities.',
        factual_truth: 'Mass is the quantity of matter (kg, constant), while weight is the gravitational pull on mass (N, varies with gravity).',
        scientific_truth: 'Mass is the quantity of matter (kg, constant), while weight is the gravitational pull on mass (N, varies with gravity).'
      });
    } else if (/\b(fraction|ratio)\b/i.test(topicTitle)) {
      misconceptions.push({
        trap: 'Adding numerators and denominators straight across (e.g. 1/2 + 1/3 = 2/5).',
        factual_truth: 'Fractions require a common denominator before numerators can be combined.',
        scientific_truth: 'Fractions require a common denominator before numerators can be combined.'
      });
    } else if (/\b(equation|algebra)\b/i.test(topicTitle)) {
      misconceptions.push({
        trap: 'Applying an operation to only one side of the equals sign.',
        factual_truth: 'Equations maintain balance only when the exact same operation is applied to both sides.',
        scientific_truth: 'Equations maintain balance only when the exact same operation is applied to both sides.'
      });
    } else if (/\b(respiration|breathing)\b/i.test(topicTitle)) {
      misconceptions.push({
        trap: 'Thinking breathing and cellular respiration are the same thing.',
        factual_truth: 'Breathing is the physical gas exchange in lungs, while cellular respiration is biochemical energy release inside cells.',
        scientific_truth: 'Breathing is the physical gas exchange in lungs, while cellular respiration is biochemical energy release inside cells.'
      });
    } else if (/\b(photosynthesis)\b/i.test(topicTitle)) {
      misconceptions.push({
        trap: 'Thinking plants photosynthesize during the day and never respire.',
        factual_truth: 'Plants perform cellular respiration continuously day and night, but perform photosynthesis only in the presence of light.',
        scientific_truth: 'Plants perform cellular respiration continuously day and night, but perform photosynthesis only in the presence of light.'
      });
    } else if (/\b(democracy|constitution|parliament|judiciary)\b/i.test(topicTitle)) {
      misconceptions.push({
        trap: 'Thinking democracy simply means majority rule without protections for minorities or rule of law.',
        factual_truth: 'A constitutional democracy guarantees fundamental rights, equal protection, and institutional checks and balances.',
        scientific_truth: 'A constitutional democracy guarantees fundamental rights, equal protection, and institutional checks and balances.'
      });
    } else {
      misconceptions.push({
        trap: 'Memorizing terminology without understanding the underlying cause-and-effect or reasoning.',
        factual_truth: 'True understanding comes from connecting the definition to practical observations and logical reasoning.',
        scientific_truth: 'True understanding comes from connecting the definition to practical observations and logical reasoning.'
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

  // Look for prominent entities in recent context
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
  if (/\b(pizza|cake|chocolate)\b/.test(text)) {
    return { object: 'pizza', setting: 'dining table', action: 'dividing into equal slices' };
  }
  if (/\b(scale|balance|weight)\b/.test(text)) {
    return { object: 'pan balance scale', setting: 'desk', action: 'balancing sides' };
  }

  return null;
}

/**
 * Grade-Level Pedagogical Calibration
 * Differentiates vocabulary, cognitive depth, and formula depth per class (Class 6 vs 8 vs 10)
 * and adapts to the active subject (Mathematics, Science, Social Science, Language).
 */
function resolveGradePedagogy(gradeLevel = 8, subjectName = '') {
  const gradeNum = parseInt(String(gradeLevel).replace(/\D/g, ''), 10) || 8;
  const isMath = /\b(math|algebra|geometr|arithmetic)\b/i.test(subjectName);
  const isSocial = /\b(social|history|geography|civics)\b/i.test(subjectName);
  const isLanguage = /\b(english|hindi|language|grammar)\b/i.test(subjectName);

  if (gradeNum <= 6) {
    return {
      grade: 6,
      audience: 'Class 6 Students (Ages 11-12)',
      cognitive_depth: isMath
        ? 'Concrete visual math (counting, pizza/bar fraction models, simple geometric shapes). No abstract algebra.'
        : isSocial
          ? 'Story-based historical narratives, visual map exploration, and basic community roles.'
          : 'Pure observational learning and concrete everyday physical experience (push/pull, hot/cold, shadows, plant/animal parts).',
      vocabulary_policy: 'Extremely simple, friendly words. Short sentences. NO abstract jargon without immediate concrete demonstration.',
      formula_policy: 'ZERO complex or abstract algebraic formulas. Keep mathematical reasoning intuitive.',
      analogy_focus: 'Playground, classroom, toys, kitchen, sharing food with friends, sports (balls, swings, water, doors).'
    };
  }
  if (gradeNum === 7) {
    return {
      grade: 7,
      audience: 'Class 7 Students (Ages 12-13)',
      cognitive_depth: isMath
        ? 'Introductory algebraic expressions, operations with fractions/decimals, basic ratios and proportions.'
        : isSocial
          ? 'Descriptive regional geography, medieval timelines, and introductory civic institutions.'
          : 'Descriptive mechanisms and elementary processes (heat conduction/convection, simple speed, acids/bases, respiration).',
      vocabulary_policy: 'Clear introductory academic terms, explained immediately in plain conversational words.',
      formula_policy: 'Simple arithmetic and elementary relations only (e.g. speed = distance / time, area = length * width).',
      analogy_focus: 'Everyday household observations, cooking, cycling, weather, shopping at local stores.'
    };
  }
  if (gradeNum === 8) {
    return {
      grade: 8,
      audience: 'Class 8 Students (Ages 13-14)',
      cognitive_depth: isMath
        ? 'Linear equations in one variable, percentages, basic mensuration, quadrilaterals, exponents.'
        : isSocial
          ? 'Constitution, fundamental rights, natural resources, colonial period in India.'
          : 'Fundamental scientific principles, qualitative physical laws, cause-and-effect reasoning (Force & Pressure, Friction, Sound).',
      vocabulary_policy: 'Standard foundational curriculum terms and clear syllabus definitions.',
      formula_policy: 'Elementary formulas with basic units (Newton, Pascal, cm², ratios) explained through proportionality.',
      analogy_focus: 'Cricket ball, bicycle brakes, school bag straps, pan balance scales, dividing snacks, balloons, needles.'
    };
  }
  if (gradeNum === 9) {
    return {
      grade: 9,
      audience: 'Class 9 Students (Ages 14-15)',
      cognitive_depth: isMath
        ? 'Coordinate geometry, polynomials, geometric proofs (Euclid/triangles), surface areas and volumes.'
        : isSocial
          ? 'French Revolution, Russian Revolution, democratic rights, physical features of India, drainage.'
          : 'Formal scientific laws, vector principles (Newton\'s 3 laws with separate action-reaction bodies), gravitation, cell structures.',
      vocabulary_policy: 'Precise academic terminology and rigorous conceptual definitions aligned with syllabus standards.',
      formula_policy: 'Formal mathematical relations and laws (F=ma, g=9.8 m/s², W=F*s, (a+b)²) with dimensional units.',
      analogy_focus: 'Vehicles, coordinate grids, architecture, sports mechanics, chemical mixtures, economic decisions.'
    };
  }
  // Class 10+
  return {
    grade: 10,
    audience: 'Class 10 Students (Ages 15-16)',
    cognitive_depth: isMath
      ? 'Board-exam quantitative rigor: Quadratic equations, trigonometry, arithmetic progressions, coordinate geometry, circles, statistics.'
      : isSocial
        ? 'Nationalism in India, resources and development, power sharing, federalism, globalization.'
        : 'Board-exam academic rigor. Quantitative reasoning, multi-step mechanisms, ray optics diagrams, electrical circuits, biochemical pathways.',
    vocabulary_policy: 'Board-standard curriculum keywords, precise phrasing, and exam-grade accuracy.',
    formula_policy: 'Formal formulas with derived units and algebraic steps.',
    analogy_focus: 'Camera lenses, vehicle headlights, domestic wiring, chemical reactions, banking interest, construction angles.'
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
        phase_purpose: 'Explicit concept breakdown. Teach the core concept before any assessment question.',
        bubble_structure: 'Up to 3 micro-bubbles (under 25 words each):\n• Bubble 1: Precise definition / core idea.\n• Bubble 2: Mechanism / logic with familiar everyday analogy.\n• Bubble 3: A focused check question, unless the student requested explanation only.',
        rules: 'Teach one concept completely. Each bubble must have 25 words or fewer. Do not cram everything into one bubble.'
      };

    case 'DIALOGUE':
      return {
        phase_purpose: 'Interactive Socratic inquiry. Guide the student to articulate answers.',
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

  const topicTitle = topic?.title || 'Academic Topic';
  const topicContent = topic?.content || '';
  const totalGoals = Math.max(1, goals.length);
  const currentGoalIdx = Math.min(Math.max(0, goalIndex), totalGoals - 1);
  const currentGoal = goals[currentGoalIdx] || { title: topicTitle, description: topicContent };

  const { subjectName, boardName, gradeLevel } = resolveSubjectAndBoard(topic, userProfile);

  const gradeStr = userProfile.grade_level ? `Class ${userProfile.grade_level}` : 'Class 8';
  const classLevel = `${gradeStr} ${boardName}`;

  const gradePedagogy = resolveGradePedagogy(gradeLevel, subjectName);

  // 1. Source-backed Academic Grounding
  const academicGrounding = ensureAcademicGrounding(currentGoal, topicTitle, topicContent, subjectName);
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
      subject_name: subjectName,
      board_name: boardName,
      grade_level: gradeLevel,
      class_level: classLevel,
      current_goal: {
        index: currentGoalIdx + 1,
        total: totalGoals,
        title: currentGoal.title,
        description: currentGoal.description || '',
      },
      grounding_status: academicGrounding.grounding_status,
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
  resolveSubjectAndBoard,
  extractAskedQuestions,
  filterRecentHistory,
  resolveScenarioContinuity,
  getPhaseGuidance,
  DOMAIN_ANALOGIES,
};
