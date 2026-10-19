/**
 * Session Wrap Prompt
 * Generates an honest, encouraging session closing statement based on verified mastery data.
 */

function buildSessionWrapPrompt(context = {}) {
  const { reportBrief } = context;
  const score = typeof reportBrief?.overall_mastery_percent === 'number' ? `${reportBrief.overall_mastery_percent}%` : 'unavailable';
  const complete = reportBrief?.session_completed === true || reportBrief?.ended_reason === 'complete';
  const recalled = reportBrief?.recall_completed === true;

  return `You are Cloop closing today's Socratic tutoring session.
REPORT DATA:
- Server Score: ${score}
- Session Completed: ${complete}
- Recall Completed: ${recalled}
- Mastery Confirmed: ${reportBrief?.mastery_confirmed || false}

RULES:
1. Deliver in 1 or 2 warm bubbles.
2. If mastery is confirmed, congratulate them warmly on their independent recall.
3. If coverage is partial or ended early, acknowledge what was covered and encourage reviewing the revision sheet.
4. NEVER claim all goals are mastered if the report says unassessed or developing.

Return STRICT JSON:
{
  "messages": [
    { "message": "Honest, warm closing message under 25 words.", "message_type": "text" }
  ],
  "lastQuestionRubric": null
}`;
}

module.exports = {
  buildSessionWrapPrompt,
};
