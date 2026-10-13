require('dotenv').config();
const { evaluateStudentTurn } = require('../services/tutor-core/evaluator');

async function testBinaryDirectQuestion() {
  console.log("================================================================================");
  console.log("🎯 TESTING DIRECT BINARY QUESTION EVALUATION WITH LIVE MODEL");
  console.log("================================================================================\n");

  const question = "Think of kicking a football with your foot — is that a contact force or a non-contact force?";
  const rubric = {
    criteria: [
      { id: "type", description: "State that it is a contact force", required: true }
    ],
    model_answer: "Kicking a football is a contact force because the foot touches the ball."
  };

  const studentAnswers = [
    "Contact",
    "contact force",
    "it is contact",
    "Non-contact"
  ];

  for (const answer of studentAnswers) {
    console.log(`\nEvaluating student answer: "${answer}"`);
    const result = await evaluateStudentTurn({
      studentMessage: answer,
      lastQuestionText: question,
      lastQuestionRubric: rubric,
      phase: "DIALOGUE",
      topicTitle: "Force and Pressure",
      currentGoal: { title: "Contact Forces", description: "Forces that require physical touch." },
      classLevel: "Class 8 CBSE"
    });

    console.log(`  Intent: ${result.intent}`);
    console.log(`  is_correct: ${result.is_correct} (expected: ${answer.toLowerCase().includes('contact') && !answer.toLowerCase().includes('non') ? 'true' : 'false'})`);
    console.log(`  Score: ${result.score_percent}%`);
    console.log(`  Feedback: ${result.feedback}`);
    if (result.diff_html) console.log(`  Diff HTML: ${result.diff_html}`);
  }

  console.log("\n================================================================================");
  console.log("🏁 DIRECT BINARY QUESTION TEST FINISHED");
  console.log("================================================================================");
}

testBinaryDirectQuestion().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
