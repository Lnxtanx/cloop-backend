/**
 * Unified Prompt Catalog for Socratic Tutor Agent
 * Centralized, versioned prompt definitions for all sub-agents.
 */

// System & Persona
const { MASTER_PERSONA, MASTER_PERSONA_PROMPT } = require('./system/master-persona');
const { SAFETY_AND_GROUNDING_PROMPT } = require('./system/safety-and-grounding');

// Evaluation
const { buildRubricEvaluationPrompt } = require('./evaluation/rubric-evaluation-prompt');
const { buildIntentClassificationPrompt } = require('./evaluation/intent-classification-prompt');

// Teaching & Explanation
const { buildConceptBreakdownPrompt } = require('./teaching/concept-breakdown-prompt');
const { buildHintScaffoldingPrompt } = require('./teaching/hint-scaffolding-prompt');
const { buildChoiceOfferingPrompt } = require('./teaching/choice-offering-prompt');

// Dialogue & Inquiry
const { buildProbePrompt } = require('./dialogue/probe-prompt');
const { buildSocraticInquiryPrompt } = require('./dialogue/socratic-inquiry-prompt');
const { buildMcqCheckPrompt } = require('./dialogue/mcq-check-prompt');
const { buildRoundupRecallPrompt } = require('./dialogue/roundup-recall-prompt');
const { buildCuriosityBranchPrompt } = require('./dialogue/curiosity-branch-prompt');

// Synthesis & Revision
const { buildRevisionSheetPrompt } = require('./synthesis/revision-sheet-prompt');
const { buildSessionWrapPrompt } = require('./synthesis/session-wrap-prompt');

module.exports = {
  system: {
    MASTER_PERSONA,
    MASTER_PERSONA_PROMPT,
    SAFETY_AND_GROUNDING_PROMPT,
  },
  evaluation: {
    buildRubricEvaluationPrompt,
    buildIntentClassificationPrompt,
  },
  teaching: {
    buildConceptBreakdownPrompt,
    buildHintScaffoldingPrompt,
    buildChoiceOfferingPrompt,
  },
  dialogue: {
    buildProbePrompt,
    buildSocraticInquiryPrompt,
    buildMcqCheckPrompt,
    buildRoundupRecallPrompt,
    buildCuriosityBranchPrompt,
  },
  synthesis: {
    buildRevisionSheetPrompt,
    buildSessionWrapPrompt,
  },
};
