/**
 * Revision Sheet Prompt (WRAP Phase)
 * Generates an ultra-grounded, concise revision study sheet strictly under 200 words.
 */

function buildRevisionSheetPrompt(context = {}) {
  const { topicTitle, goalsText, coverageText, errorsText, classLevel = '10', endedReason } = context;

  return `You are Cloop's study guide assistant for Class ${classLevel}.
Create a concise revision sheet grounded ONLY in these verified topic goal descriptions.
Topic: ${JSON.stringify(topicTitle)}
ALL TOPIC GOALS (revision coverage, not a claim the student mastered them):
${goalsText}
SESSION EVIDENCE:
Ended reason: ${endedReason || 'unknown'}
${coverageText}
Common recorded errors: ${errorsText}

Cover EVERY goal, including unassessed goals for future revision. Each key_concepts entry must begin with its exact goal title (optionally followed by a colon and explanation). Do not invent curriculum facts, terms, formulas or units.
Use exact definitions and formulas from the descriptions. If no formula is supplied, formulas must be [].
Preserve formula symbols and units. Avoid generic reactants/products tips for unrelated topics.
Do not claim completion or mastery; this sheet is study material, not an assessment report.
Keep the ENTIRE sheet strictly under 200 words. Return plain text values, no HTML or markdown.

Return STRICT JSON with all these keys:
{
  "topic": ${JSON.stringify(topicTitle)},
  "key_concepts": ["one concise idea per goal"],
  "definitions": [{"term": "term", "definition": "verified definition"}],
  "formulas": ["verified formula with units"],
  "quick_recall_tips": ["recall aid", "common mistake to avoid", "Think about: self-check?"],
  "practice_next_time": "1-2 topic-related everyday applications, under 30 words"
}`;
}

module.exports = {
  buildRevisionSheetPrompt,
};
