require('dotenv').config();
const { processTutorTurn } = require('../services/tutor-core/orchestrator');

const FORCE_TOPIC = {
  id: 201,
  title: 'Force and Pressure - Contact and Non-Contact Forces',
  content: 'A contact force is a force that requires physical contact between two objects, such as muscular force and friction. A non-contact force acts at a distance without physical contact, such as gravitational force, electrostatic force, and magnetic force.'
};

const FORCE_GOALS = [
  {
    id: 1,
    title: 'Contact Forces',
    description: 'Contact forces require physical touch between interacting objects; examples include muscular force and friction.'
  },
  {
    id: 2,
    title: 'Non-Contact Forces',
    description: 'Non-contact forces act across a distance without physical touch; examples include gravity, magnetic, and electrostatic forces.'
  }
];

async function runScenario(scenarioName, topic, goals, studentTurns, validations = {}) {
  console.log(`\n================================================================================`);
  console.log(`🧪 TEST SCENARIO: ${scenarioName}`);
  console.log(`================================================================================`);

  let state = null;
  const history = [];

  for (let i = 0; i < studentTurns.length; i++) {
    const studentMsg = studentTurns[i];
    console.log(`\n--- [Turn ${i + 1}] Student: "${studentMsg || '<Starts Session>'}" ---`);

    const result = await processTutorTurn({
      studentMessage: studentMsg,
      topic,
      goals,
      chatHistory: history,
      currentState: state,
      userProfile: { grade_level: 8, board: 'CBSE' }
    });

    state = result.nextState;

    console.log(`Evaluator: intent=${result.intent}, is_correct=${result.evaluatorResult?.is_correct}, error_type=${result.evaluatorResult?.error_type}`);
    console.log(`State: phase=${state.phase}, directive=${result.stateInstruction}`);

    if (result.userCorrection) {
      console.log(`Visual Correction Box:`, JSON.stringify(result.userCorrection));
      // Check sentence truncation in diff_html
      if (result.userCorrection.diff_html) {
        const insMatch = result.userCorrection.diff_html.match(/<ins>(.*?)<\/ins>/);
        if (insMatch) {
          const insText = insMatch[1];
          const hasDanglingConjunction = /\b(and|or|but|because|with|the)$/i.test(insText.trim().replace(/[.!?]+$/, ''));
          console.log(`  Diff check -> Ends with dangling conjunction: ${hasDanglingConjunction ? '❌ YES (BUG)' : '✅ NO (CLEAN)'}`);
        }
      }
    }

    console.log(`Tutor (${result.messages.length} bubbles):`);
    result.messages.forEach((msg, idx) => {
      console.log(`  Bubble ${idx + 1}: ${msg.message}`);
      if (msg.options) {
        console.log(`    [MCQ Options]:`, msg.options.map(o => o.text).join(' | '));
      }
      history.push({ sender: 'ai', message: msg.message, options: msg.options });
    });

    if (studentMsg) {
      history.push({ sender: 'user', message: studentMsg });
    }

    // Run custom step validation if provided
    if (validations[i + 1]) {
      validations[i + 1](result, state);
    }
  }
}

async function runAllTests() {
  console.log("🚀 STARTING EXTENSIVE MULTI-SCENARIO TUTOR TESTING");

  // ─────────────────────────────────────────────────────────────────────────────
  // SCENARIO 1: Binary Choice & Sentence Truncation Test (The Football Problem)
  // ─────────────────────────────────────────────────────────────────────────────
  await runScenario(
    "Binary Answer Grading & Clean Sentence Diffs (Physics Class 8)",
    FORCE_TOPIC,
    FORCE_GOALS,
    [
      "", // Turn 1: Opening
      "Contact", // Turn 2: Binary direct answer to contact force
      "Gravity is contact force because earth touches us directly", // Turn 3: Conceptual error
      "i dont get it" // Turn 4: Help request
    ],
    {
      2: (result) => {
        console.log(`  Assert: Direct answer "Contact" evaluated as correct? ${result.evaluatorResult?.is_correct === true ? '✅ PASS' : '❌ FAIL'}`);
      },
      3: (result) => {
        console.log(`  Assert: Wrong answer got correction box? ${result.userCorrection ? '✅ PASS' : '❌ FAIL'}`);
      },
      4: (result) => {
        console.log(`  Assert: "i dont get it" evaluated as HELP? ${result.intent === 'HELP' ? '✅ PASS' : '❌ FAIL'}`);
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // SCENARIO 2: Repetition Immunity & Multi-Turn Persistence
  // ─────────────────────────────────────────────────────────────────────────────
  await runScenario(
    "Repetition Immunity & Everyday Analogy Retrying",
    FORCE_TOPIC,
    FORCE_GOALS,
    [
      "", // Turn 1: Opening
      "dont know", // Turn 2: IDK
      "you already asked this question", // Turn 3: Direct repetition complaint
      "Muscular force is contact and magnetic force is non-contact" // Turn 4: Clear correct answer
    ],
    {
      2: (result) => {
        console.log(`  Assert: "dont know" intent is IDK? ${result.intent === 'IDK' ? '✅ PASS' : '❌ FAIL'}`);
      },
      3: (result) => {
        console.log(`  Assert: Repetition complaint intent is HELP? ${result.intent === 'HELP' ? '✅ PASS' : '❌ FAIL'}`);
        console.log(`  Assert: is_correct is not penalized (null)? ${result.evaluatorResult?.is_correct === null ? '✅ PASS' : '❌ FAIL'}`);
      },
      4: (result) => {
        console.log(`  Assert: Final comprehensive answer correct? ${result.evaluatorResult?.is_correct === true ? '✅ PASS' : '❌ FAIL'}`);
      }
    }
  );

  console.log("\n================================================================================");
  console.log("🏁 ALL SCENARIOS COMPLETED");
  console.log("================================================================================");
}

runAllTests().catch(err => {
  console.error("Scenario test error:", err);
  process.exit(1);
});
