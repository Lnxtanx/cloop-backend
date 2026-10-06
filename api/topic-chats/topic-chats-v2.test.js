const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { initialState } = require('../../services/tutor-core/state');
const { buildReport } = require('../../services/tutor-core/summary');

// Load the real route/collector with local stubs, without changing require.cache
// or contacting Prisma, model providers, or media services.
function loadWithStubs(filename, stubs) {
  const absolute = path.resolve(__dirname, filename);
  const localRequire = createRequire(absolute);
  const module = { exports: {} };
  const quiet = { log() {}, warn() {}, error() {} };
  new Function('require', 'module', 'exports', 'console', fs.readFileSync(absolute, 'utf8'))(
    (name) => Object.hasOwn(stubs, name) ? stubs[name] : localRequire(name), module, module.exports, quiet
  );
  return module.exports;
}

const GOALS = [
  { id: 11, title: 'Start and stop motion', description: 'Force can start or stop motion.', order: 1 },
  { id: 12, title: 'Change direction', description: 'Force can change direction.', order: 2 },
  { id: 13, title: 'Change shape', description: 'Force can change shape.', order: 3 }
];

function slot(overrides = {}) {
  return { outcome: 'correct', assessed: true, completed: true, assisted: false, first_correct: true, attempts: [], ...overrides };
}

function teachingState() {
  const state = initialState(GOALS.length);
  state.phase = 'ROUNDUP';
  state.goalIndex = GOALS.length - 1;
  state.lastQuestionText = 'How can a force start or stop motion?';
  state.lastQuestionRubric = { model_answer: 'PRIVATE ANSWER', criteria: [{ id: 'motion', description: 'Start or stop motion', required: true }] };
  state.perGoal = GOALS.map(() => ({ correct: 2, total: 2, errors: [], assessments: { DIALOGUE: slot(), CHECK: slot() } }));
  return state;
}

function pipelineResult(nextState, overrides = {}) {
  const verdict = { intent: 'ANSWER', is_correct: true, score_percent: 100, error_type: null,
    feedback: 'You identified the required effect.', reasoning: 'PRIVATE REASONING', complete_answer: null };
  return {
    nextState,
    evaluatorResult: verdict,
    gradedThisTurn: true,
    answeredPhase: 'ROUNDUP',
    messages: [{ message: 'How can force change direction?', message_type: 'text', lastQuestionRubric: { model_answer: 'PRIVATE ANSWER' } }],
    userCorrection: { diff_html: null, complete_answer: null, emoji: '😊', feedback: { is_correct: true, score_percent: 100 } },
    attachments: [], mermaid_diagram: null, all_goals_completed: true,
    masteryReport: null, revisionSheet: null,
    ...overrides
  };
}

function fixture(previousState, result) {
  const calls = {};
  const saved = new Map();
  let counter = 100;
  const record = (name, args) => (calls[name] ||= []).push(args);
  const select = (row, fields) => fields ? Object.fromEntries(Object.keys(fields).filter((k) => fields[k]).map((k) => [k, row[k] ?? null])) : row;
  const prisma = {
    global_topics: { findUnique: async () => ({ id: 1, title: 'Effects of force', content: 'Force changes motion or shape.',
      chapter: { id: 5, subject_id: 6, title: 'Exploring forces', subject: { id: 6, name: 'Science' } } }) },
    global_topic_goals: { findMany: async () => GOALS.map((goal) => ({ ...goal, chat_goal_progress: [{ id: goal.id + 30, is_completed: true, score_percent: 99 }] })) },
    admin_chat: {
      findMany: async () => [
        { id: 91, sender: 'ai', message: previousState?.lastQuestionText || 'What changes?', options: [] },
        { id: 90, sender: 'ai', message: 'Which effect?', options: ['Earlier choice one', 'Earlier choice two'] }
      ],
      create: async (args) => {
        record('admin_chat.create', args);
        const row = { id: counter++, created_at: new Date(), ...args.data };
        saved.set(row.id, row);
        return select(row, args.select);
      },
      update: async (args) => {
        record('admin_chat.update', args);
        const row = { ...saved.get(args.where.id), ...args.data };
        saved.set(row.id, row);
        return select(row, args.select);
      }
    },
    chat_process: {
      findFirst: async () => ({ feedback: { session_state: previousState } }),
      create: async (args) => { record('chat_process.create', args); return { id: counter++ }; }
    },
    users: { findUnique: async () => ({ grade_level: 'VI', board: 'CBSE' }), update: async (args) => record('users.update', args) }
  };
  for (const table of ['chat_goal_progress', 'user_topic_reports', 'user_topic_progress', 'study_sessions', 'learning_turns']) {
    prisma[table] = {};
    for (const method of ['create', 'updateMany', 'upsert']) {
      prisma[table][method] = async (args) => { record(`${table}.${method}`, args); return { id: counter++ }; };
    }
  }
  const analytics = {};
  for (const name of ['recordTurnLog', 'recordErrorIfWrong', 'updateDailyStudyStats', 'endChatSession', 'updateCurriculumSummary']) {
    analytics[name] = async (...args) => { record(name, args); return 80; };
  }
  const { handleTopicChatMessageV2 } = loadWithStubs('./topic-chats-v2.js', {
    '../../lib/prisma': prisma,
    '../../services/tutor-core/orchestrator': { processTutorTurn: async (args) => { record('processTutorTurn', args); return result; } },
    '../../services/media-search': { searchYouTube: async (...args) => { record('searchYouTube', args); return [{ title: 'Video', url: 'https://example.com/video' }]; } },
    '../../services/tutor-core/diagram-cache': { getCachedDiagram: (...args) => { record('getCachedDiagram', args); return { code: 'graph TD; A-->B', title: 'Diagram' }; } },
    '../../services/analytics/topic-data-collector': analytics
  });
  return {
    calls,
    async send(message = '2') {
      const response = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await handleTopicChatMessageV2({ user: { user_id: 7 }, params: { topicId: '1' }, body: { message } }, response);
      assert.equal(response.statusCode, 201, response.body?.error);
      return response.body;
    }
  };
}

test('written numeric answers keep their text and ROUNDUP links follow the recall pointer', async () => {
  const previous = teachingState();
  const next = teachingState();
  next.roundupIndex = 1;
  next.perGoal[0].assessments.ROUNDUP = slot();
  next.perGoal[0].correct = next.perGoal[0].total = 3;
  const f = fixture(previous, pipelineResult(next));
  const response = await f.send('2');
  assert.equal(f.calls.processTutorTurn[0].studentMessage, '2');
  assert.equal(response.userMessage.message, '2');
  const links = f.calls['chat_goal_progress.create'].map((args) => args.data);
  assert.equal(links[0].goal_id, GOALS[0].id, 'student answered the first recall goal');
  assert.equal(links[1].goal_id, GOALS[1].id, 'new question belongs to the second recall goal');
  assert.equal(f.calls.recordTurnLog[0][1].goalId, GOALS[0].id);
  assert.equal(f.calls['learning_turns.create'][0].data.goal_id, GOALS[0].id);
  assert.equal(response.goals[0].is_completed, true);
  assert.equal(response.goals[1].is_completed, false);
  assert.equal(response.all_goals_completed, false);
});

test('feedback retains its explanation but does not expose scores, private rubrics, or reasoning before wrap', async () => {
  const state = teachingState();
  const f = fixture(state, pipelineResult(state));
  const response = await f.send();
  assert.equal(response.feedback.explanation, 'You identified the required effect.');
  assert.equal(Object.hasOwn(response.feedback, 'score_percent'), false);
  assert.equal(Object.hasOwn(response.userCorrection.feedback, 'score_percent'), false);
  for (const goal of response.goals) assert.equal(Object.hasOwn(goal.chat_goal_progress[0], 'score_percent'), false);
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE|lastQuestionRubric|model_answer|reasoning/);
  assert.equal(f.calls['learning_turns.create'][0].data.feedback_text, response.feedback.explanation);
  assert.equal(f.calls['learning_turns.create'][0].data.score_percent, 100, 'internal analytics retains the evaluated score');
  assert.equal(f.calls['chat_process.create'][0].data.feedback.user_correction.feedback.explanation, response.feedback.explanation);
});

test('ROUNDUP never fetches or returns teaching media even when a request or attachment slips through', async () => {
  const state = teachingState();
  state.stuckStreak = 1;
  const f = fixture(state, pipelineResult(state, {
    attachments: ['video', 'diagram'], mermaid_diagram: { code: 'graph TD; A-->B' }
  }));
  const response = await f.send('Show a video and diagram');
  assert.equal(f.calls.searchYouTube, undefined);
  assert.equal(f.calls.getCachedDiagram, undefined);
  assert.equal(response.mermaid_diagram, null);
  assert.deepEqual(response.youtube_results, []);
  assert.ok(response.aiMessages.every((message) => !['mermaid_diagram', 'youtube_video'].includes(message.message_type)));
});

test('off-topic termination closes sessions without marking untouched recalls or the topic completed', async () => {
  const previous = teachingState();
  const next = { ...teachingState(), phase: 'WRAP', endedReason: 'off_topic' };
  const report = buildReport(next, GOALS);
  const f = fixture(previous, pipelineResult(next, {
    evaluatorResult: { intent: 'OFF_TOPIC', is_correct: null, score_percent: null }, gradedThisTurn: false,
    userCorrection: null, masteryReport: report,
    revisionSheet: { topic: 'Effects of force', key_concepts: ['Force can change motion or shape.'] }
  }));
  const response = await f.send('Who made you?');
  assert.equal(response.all_goals_completed, false);
  assert.equal(response.session_completed, false);
  assert.equal(response.mastery_confirmed, false);
  assert.equal(f.calls['user_topic_progress.upsert'][0].update.is_completed, false);
  assert.equal(f.calls['user_topic_progress.upsert'][0].update.completion_percent, 0);
  assert.ok(f.calls['chat_goal_progress.updateMany'].every((args) => args.data.is_completed === false));
  assert.equal(f.calls['study_sessions.updateMany'].length, 1);
  assert.equal(f.calls.endChatSession.length, 1);
  assert.equal(f.calls['learning_turns.create'], undefined);
  assert.equal(response.aiMessages.find((message) => message.session_summary).session_summary.ended_reason, 'off_topic');
  assert.equal(response.aiMessages.find((message) => message.session_summary).session_summary.recall_completed, false);
});

test('finished skipped recall ends the learning sequence without completing goals or claiming mastery', async () => {
  const previous = teachingState();
  const next = { ...teachingState(), phase: 'WRAP', endedReason: 'complete' };
  for (const goal of next.perGoal) goal.assessments.ROUNDUP = slot({ assessed: false, outcome: 'skipped', assisted: true });
  const report = buildReport(next, GOALS);
  const f = fixture(previous, pipelineResult(next, { masteryReport: report, gradedThisTurn: false, userCorrection: null }));
  const response = await f.send('pass');
  assert.equal(response.all_goals_completed, false);
  assert.equal(response.session_completed, true);
  assert.equal(response.session_closed, true);
  assert.equal(response.mastery_confirmed, false);
  assert.equal(f.calls['user_topic_progress.upsert'][0].update.is_completed, false);
  assert.equal(f.calls['user_topic_progress.upsert'][0].update.completion_percent, 0);
  assert.ok(response.goals.every((goal) => goal.is_completed === false));
  assert.equal(response.aiMessages.find((message) => message.session_summary).session_summary.assessments_skipped, 3);
});

test('DONE reuses closing artifacts without saving duplicate summary or revision cards', async () => {
  const previous = { ...teachingState(), phase: 'WRAP', endedReason: 'complete' };
  for (const goal of previous.perGoal) {
    goal.assessments.ROUNDUP = slot();
    goal.correct = goal.total = 3;
  }
  const report = buildReport(previous, GOALS);
  const revision = { topic: 'Effects of force', key_concepts: ['Force changes motion or shape.'] };
  previous.wrapArtifacts = { masteryReport: report, revisionSheet: revision };
  const next = { ...previous, phase: 'DONE' };
  const f = fixture(previous, pipelineResult(next, {
    masteryReport: report, revisionSheet: revision, userCorrection: null, gradedThisTurn: false,
    evaluatorResult: { intent: 'ACK', is_correct: null, score_percent: null }
  }));
  const response = await f.send('Thanks');
  assert.equal(response.session_completed, true);
  assert.equal(response.session_closed, true);
  assert.equal(response.all_goals_completed, true);
  assert.equal(response.mastery_confirmed, true);
  assert.equal(response.masteryReport, report);
  assert.equal(response.revisionSheet, revision);
  assert.ok(f.calls['admin_chat.create'].every((args) => !['session_summary', 'revision_sheet'].includes(args.data.message_type)));
  assert.equal(f.calls['user_topic_reports.upsert'], undefined);
  assert.equal(f.calls.endChatSession, undefined);
});

test('unavailable evaluations and unscored answers do not create learning_turns or negative correction emojis', async () => {
  for (const overrides of [
    { evaluatorResult: { intent: 'ANSWER', is_correct: null, score_percent: null }, userCorrection: null },
    { gradedThisTurn: false }
  ]) {
    const state = teachingState();
    const f = fixture(state, pipelineResult(state, overrides));
    const response = await f.send('My answer');
    assert.equal(f.calls['learning_turns.create'], undefined);
    if (overrides.evaluatorResult) assert.equal(response.userMessage.emoji, null);
  }
});

test('a graded wrong answer keeps false verdict and useful feedback without a score badge', async () => {
  const state = teachingState();
  const f = fixture(state, pipelineResult(state, {
    evaluatorResult: { intent: 'ANSWER', is_correct: false, score_percent: 50, error_type: 'Incomplete', feedback: 'Direction is still missing.' },
    userCorrection: { emoji: '😊', complete_answer: 'Force changes motion and shape.', diff_html: '<del>stretch</del><ins>direction</ins>', feedback: { error_type: 'Incomplete', score_percent: 50 } }
  }));
  const response = await f.send('stretch, speed, shape');
  assert.equal(response.userCorrection.emoji, '😅');
  assert.equal(response.feedback.is_correct, false);
  assert.equal(response.feedback.explanation, 'Direction is still missing.');
  assert.equal(f.calls['learning_turns.create'][0].data.is_correct, false);
  assert.equal(Object.hasOwn(response.feedback, 'score_percent'), false);
});

test('assisted correct evidence is not mislabeled as an incorrect answer in progress', async () => {
  const state = teachingState();
  state.perGoal[0] = { correct: 1, total: 2, errors: [], assessments: {
    DIALOGUE: slot({ outcome: 'assisted', assisted: true }), CHECK: slot()
  } };
  const f = fixture(state, pipelineResult(state));
  const response = await f.send();
  assert.equal(response.goals[0].chat_goal_progress[0].num_correct, 1);
  assert.equal(response.goals[0].chat_goal_progress[0].num_incorrect, 0);
  assert.equal(f.calls['chat_goal_progress.create'][0].data.num_incorrect, 0);
});

test('daily analytics excludes unknown and unscored evidence', async () => {
  const calls = [];
  const collector = loadWithStubs('../../services/analytics/topic-data-collector.js', {
    '../../lib/prisma': { user_daily_stats: { upsert: async (args) => calls.push(args) } }
  });
  for (const [gradedThisTurn, is_correct] of [[true, null], [false, true], [true, true]]) {
    await collector.updateDailyStudyStats(7, { gradedThisTurn, evaluatorResult: { intent: 'ANSWER', is_correct } }, 1);
  }
  assert.deepEqual(calls.map((args) => args.create.questions_answered), [0, 0, 1]);
  assert.deepEqual(calls.map((args) => args.create.questions_correct), [0, 0, 1]);
});

test('analytics closes an early session without incrementing topics_completed', async () => {
  const calls = {};
  const collector = loadWithStubs('../../services/analytics/topic-data-collector.js', {
    '../../lib/prisma': {
      topic_chat_sessions: {
        findFirst: async () => ({ id: 44, started_at: new Date(), goals_total: GOALS.length }),
        update: async (args) => { calls.session = args; }
      },
      user_daily_stats: { upsert: async (args) => { calls.daily = args; } }
    }
  });
  const state = { ...teachingState(), phase: 'WRAP', endedReason: 'turn_limit' };
  await collector.endChatSession(7, 1, { nextState: state, masteryReport: buildReport(state, GOALS) });
  assert.equal(calls.session.data.goals_completed, 0);
  assert.equal(calls.daily.create.topics_completed, 0);
  assert.equal(calls.daily.update.topics_completed, undefined);
});

test('analytics does not count a finished skipped recall sequence as a completed topic', async () => {
  let daily;
  const collector = loadWithStubs('../../services/analytics/topic-data-collector.js', {
    '../../lib/prisma': {
      topic_chat_sessions: {
        findFirst: async () => ({ id: 44, started_at: new Date(), goals_total: GOALS.length }), update: async () => {}
      },
      user_daily_stats: { upsert: async (args) => { daily = args; } }
    }
  });
  const state = { ...teachingState(), phase: 'WRAP', endedReason: 'complete' };
  for (const goal of state.perGoal) goal.assessments.ROUNDUP = slot({ assessed: false, outcome: 'skipped' });
  const report = buildReport(state, GOALS);
  assert.equal(report.session_completed, true);
  await collector.endChatSession(7, 1, { nextState: state, masteryReport: report });
  assert.equal(daily.create.topics_completed, 0);
  assert.equal(daily.update.topics_completed, undefined);
});
