/**
 * Teacher review of knowledge statements, shared by Node and the review page.
 *
 * The review page opens either a review queue written by
 * scripts/draft-knowledge-statements.js or an import file such as
 * data/knowledge-statements/scientific-inquiry.json. The teacher approves,
 * edits or skips each statement, and the page exports an import file with
 * "verified": true holding only the approved statements.
 *
 * This file has no dependencies so the page can embed it unchanged.
 * checkStatement mirrors validateStatement in knowledge-statements.js;
 * knowledge-review.test.js keeps the two in agreement.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KnowledgeReview = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const MAX_SENTENCES = 3;
  const MAX_CHARS = 600;
  const MAX_SOURCE_CHARS = 200;
  const PLACEHOLDER = /^(?:(?:brief|short|basic)\s+)?(?:note|stub|placeholder|tbd|todo|description|summary)[.!?]*$/i;
  const SUMMARY = /^(?:(?:this|the)\s+(?:topic|chapter|lesson|unit|section)\s+(?:introduces|covers|explains|explores|discusses|focuses|describes|highlights|traces|investigates|teaches)|students?\s+(?:learn|explore|discover|study)\b)/i;
  const OBJECTIVE = /^(?:students?\s+(?:will|should|can)|learners?\s+(?:will|should)|learning\s+(?:goal|objective)|(?:identify|describe|explain|define|demonstrate|analy[sz]e|understand|label|draw|list|name|recall|compare|give\s+examples?)(?:\s|:)|examples?(?:\s+such as|\s*:)|for example\b|e\.g\.)/i;

  function sentencesOf(text) {
    return String(text || '').split(/;|\n+|(?<=[.!?])\s+(?=[A-Z])/).map(s => s.trim()).filter(Boolean);
  }

  function clean(text) {
    return String(text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')
      .replace(/^[\s,;:.—-]+/, '').replace(/\s+([,.?!])/g, '$1').trim();
  }

  /** Problems with a statement, or [] when the tutor can use every sentence of it. */
  function checkStatement(text) {
    const statement = String(text || '').trim();
    if (!statement) return ['the statement is empty'];
    const problems = [];
    if (statement.length > MAX_CHARS) problems.push(`it is longer than ${MAX_CHARS} characters`);
    const parts = sentencesOf(statement);
    if (parts.length > MAX_SENTENCES) problems.push(`it has ${parts.length} sentences; keep it to ${MAX_SENTENCES}`);
    for (const part of parts) {
      const sentence = clean(part);
      if (!sentence || PLACEHOLDER.test(sentence) || SUMMARY.test(sentence) || OBJECTIVE.test(sentence)) {
        problems.push(`"${part}" reads like an objective or a lesson summary, not a fact`);
      }
    }
    return problems;
  }

  /**
   * The goals a reviewer sees, one row per statement, whichever file was opened.
   * key is stable for a file, so saved progress lines up when it is reopened.
   */
  function reviewItems(file) {
    const items = [];
    (file && Array.isArray(file.topics) ? file.topics : []).forEach((topic, t) => {
      (Array.isArray(topic.goals) ? topic.goals : []).forEach((goal, g) => {
        items.push({ key: `${t}:${g}`, t, g,
          topic_title: topic.topic_title || '', board: topic.board || '', grade: topic.grade || '',
          subject: topic.subject || '', chapter_title: topic.chapter_title || '',
          copies: Array.isArray(topic.copies) ? topic.copies.length : null,
          goal_title: goal.goal_title || (goal.goal_title_includes || []).join(' + ') || (goal.goal_id ? `goal ${goal.goal_id}` : ''),
          goal_description: goal.goal_description || '',
          draft: String(goal.knowledge_statement || ''),
          draft_problems: Array.isArray(goal.draft_problems) ? goal.draft_problems : [] });
      });
    });
    return items;
  }

  /**
   * Build the import file from a teacher's decisions.
   * decisions: { [key]: { status: 'approved' | 'skipped', statement } }
   * Returns { spec, errors, approved }; spec is null when there are errors.
   */
  function buildVerifiedImport(file, decisions, { teacher, reference, date } = {}) {
    const errors = [];
    const who = String(teacher || '').trim();
    const book = String(reference || '').trim();
    if (!who) errors.push('Enter the reviewing teacher\'s name.');
    if (!book) errors.push('Enter the textbook (and edition or chapter) the statements were checked against.');
    const source = `Teacher-checked by ${who} against ${book}, ${date || new Date().toISOString().slice(0, 10)}`;
    if (source.length > MAX_SOURCE_CHARS) errors.push(`Shorten the name or textbook: together they must fit in ${MAX_SOURCE_CHARS} characters.`);

    const topics = [];
    let approved = 0;
    (file && Array.isArray(file.topics) ? file.topics : []).forEach((topic, t) => {
      const kept = [];
      (topic.goals || []).forEach((goal, g) => {
        const decision = decisions[`${t}:${g}`];
        if (!decision || decision.status !== 'approved') return;
        const statement = String(decision.statement || '').trim();
        for (const problem of checkStatement(statement)) errors.push(`${topic.topic_title} / ${goal.goal_title || g + 1}: ${problem}`);
        kept.push({ g, goal, statement });
      });
      if (!kept.length) return;
      approved += kept.length;
      if (Array.isArray(topic.copies)) {
        // A review queue: one entry per forked copy, pinned by topic and goal id.
        for (const copy of topic.copies) {
          topics.push({ topic_title: topic.topic_title, topic_id: copy.topic_id, subject_id: copy.subject_id,
            goals: kept.map(({ g, statement }) => ({ goal_id: copy.goal_ids[g], knowledge_statement: statement })) });
        }
      } else {
        // An import file: keep its own topic and goal matching.
        const { goals: _goals, ...match } = topic;
        topics.push({ ...match, goals: kept.map(({ goal, statement }) => {
          const { knowledge_statement: _old, draft_problems: _p, goal_description: _d, ...goalMatch } = goal;
          return { ...goalMatch, knowledge_statement: statement };
        }) });
      }
    });
    if (!approved) errors.push('Approve at least one statement.');
    return { spec: errors.length ? null : { source, verified: true, topics }, errors, approved };
  }

  return { checkStatement, reviewItems, buildVerifiedImport, MAX_SOURCE_CHARS };
}));
