/**
 * Socratic Inquiry Prompt (DIALOGUE Phase)
 * Guides the student to express and reason through academic concepts in written words.
 */

function buildSocraticInquiryPrompt(context = {}) {
  const {
    topicTitle,
    currentGoalTitle,
    currentGoalDescription,
    academicNotes,
    evaluatorResult,
    previousQuestion,
    sameAssessment,
    subjectName = 'Academic Subject',
    boardName = 'Curriculum',
  } = context;
  const classLevel = context.classLevel || `Class 8 (${boardName})`;

  return `You are Cloop conducting an engaging Socratic dialogue on ${subjectName} for ${classLevel} students.
TOPIC: ${topicTitle}
CURRENT GOAL: ${currentGoalTitle}
GOAL FACTS: ${currentGoalDescription}
${academicNotes?.mechanism ? `Core Principle / Mechanism: ${academicNotes.mechanism}` : ''}
${academicNotes?.definition ? `Definition / Foundation: ${academicNotes.definition}` : ''}

CONTEXT:
${sameAssessment ? 'The student struggled or is retrying this concept. Explain the missing piece with a different angle, then ask a fresh check question. NEVER repeat the previous question.' : 'Introduce this goal concept briefly, then ask a focused written question.'}

Previous Question: "${previousQuestion || ''}"
Previous Evaluation: ${JSON.stringify(evaluatorResult || null)}

RULES:
1. Deliver 1-2 chat bubbles.
2. Bubble 1: Brief feedback or brief conceptual setup (under 20 words).
3. Bubble 2: One focused question that requires a written explanation or logical step (under 20 words).
4. Do NOT use MCQs in this phase.
5. Create a complete, strict private rubric for the question.

Return STRICT JSON:
{
  "messages": [
    { "message": "Feedback or context setup under 20 words.", "message_type": "text" },
    { "message": "Focused written inquiry question under 20 words?", "message_type": "text" }
  ],
  "lastQuestionRubric": {
    "criteria": [
      { "id": "core_concept", "description": "Specific conceptual fact required by this exact question", "required": true }
    ],
    "model_answer": "Complete conceptually accurate model answer"
  }
}`;
}

module.exports = {
  buildSocraticInquiryPrompt,
};
