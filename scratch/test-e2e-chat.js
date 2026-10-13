require('dotenv').config();
const { processTutorTurn } = require('../services/tutor-core/orchestrator');

const TOPIC = {
  id: 101,
  title: 'Saturated and Unsaturated Carbon Compounds',
  content: 'Carbon can form single, double, or triple covalent bonds. Saturated compounds have only single carbon-carbon bonds (alkanes). Unsaturated compounds have double (alkenes) or triple bonds (alkynes) between carbon atoms.'
};

const GOALS = [
  {
    id: 1,
    title: 'Single vs Multiple Bonds',
    description: 'Saturated compounds contain only single C-C bonds; unsaturated compounds contain double or triple C-C bonds.'
  },
  {
    id: 2,
    title: 'Alkanes, Alkenes, and Alkynes',
    description: 'Alkanes have general formula CnH2n+2 with single bonds; alkenes have CnH2n with double bonds; alkynes have CnH2n-2 with triple bonds.'
  }
];

const STUDENT_TURNS = [
  "", // Turn 1: Initial greeting / opening
  "dont know", // Turn 2: Student doesn't know
  "explain me that", // Turn 3: Student asks for explanation
  "you already asked this", // Turn 4: Repetition check / complaint
  "saturated has single bonds and unsaturated has double or triple bonds" // Turn 5: Student answers
];

async function runEndToEndChat() {
  console.log("================================================================================");
  console.log("🚀 STARTING END-TO-END TUTOR CHAT TEST WITH LIVE DEEPSEEK MODEL");
  console.log("Topic:", TOPIC.title);
  console.log("================================================================================\n");

  let state = null;
  const history = [];

  for (let i = 0; i < STUDENT_TURNS.length; i++) {
    const studentMsg = STUDENT_TURNS[i];
    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`[TURN ${i + 1}] Student: ${studentMsg ? `"${studentMsg}"` : '<Starts Session>'}`);
    console.log(`--------------------------------------------------------------------------------`);

    const result = await processTutorTurn({
      studentMessage: studentMsg,
      topic: TOPIC,
      goals: GOALS,
      chatHistory: history,
      currentState: state,
      userProfile: { grade_level: 10, board: 'CBSE' }
    });

    state = result.nextState;

    console.log(`Evaluator Intent: ${result.intent}`);
    console.log(`Evaluator is_correct: ${result.evaluatorResult?.is_correct}`);
    console.log(`State Instruction: ${result.stateInstruction}`);
    console.log(`Phase: ${state.phase} (Goal ${state.goalIndex + 1})`);

    if (result.userCorrection) {
      console.log(`Visual Correction Box:`, JSON.stringify(result.userCorrection));
    }

    console.log(`\nTutor Response (${result.messages.length} bubbles):`);
    result.messages.forEach((msg, idx) => {
      console.log(`  Bubble ${idx + 1}: ${msg.message}`);
      if (msg.options) {
        console.log(`    Options:`, msg.options.map(o => o.text).join(' | '));
      }
      history.push({ sender: 'ai', message: msg.message, options: msg.options });
    });

    if (studentMsg) {
      history.push({ sender: 'user', message: studentMsg });
    }
  }

  console.log("\n================================================================================");
  console.log("🏁 END-TO-END CHAT TEST COMPLETE");
  console.log("================================================================================");
}

runEndToEndChat().catch(err => {
  console.error("End-to-End Chat Error:", err);
  process.exit(1);
});
