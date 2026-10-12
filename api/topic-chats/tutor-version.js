/** One selector for startup, written turns, and option selections. */
function useTutorCoreV2(req = {}, env = process.env) {
  const flag = String(env.ENABLE_TUTOR_CORE_V2 ?? '').trim().toLowerCase();
  const header = String(req.headers?.['x-tutor-version'] ?? '').trim().toLowerCase();
  const version = String(req.query?.v ?? '').trim().toLowerCase();
  return !['false', '0', 'off', 'no', 'v1'].includes(flag) &&
    !['v1', '1'].includes(header) && !['v1', '1'].includes(version);
}

const CORE_PHASES = ['PROBE', 'THEORY', 'OBJECTIVES', 'DIALOGUE', 'CHECK', 'ROUNDUP', 'WRAP', 'DONE'];

function storedCoreState(process) {
  const state = process?.feedback?.session_state;
  return state && typeof state === 'object' && CORE_PHASES.includes(state.phase) ? state : null;
}

/** A persisted engine owns its question until the topic's chat is explicitly reset. */
async function loadTutorSession(prisma, userId, topicId, goalIds = null) {
  const ids = goalIds || (await prisma.global_topic_goals.findMany({
    where: { topic_id: Number(topicId) }, select: { id: true }
  })).map(goal => goal.id);
  if (!ids.length) return { engine: null, state: null };
  const adminChatWhere = { user_id: userId, chat_goal_progress: { some: { goal_id: { in: ids } } } };
  // Filter in PostgreSQL rather than scanning chat history. A newer legacy row
  // without session_state must not erase an already saved test/question contract.
  const coreProcess = await prisma.chat_process.findFirst({
    where: { admin_chat: adminChatWhere,
      OR: CORE_PHASES.map(phase => ({ feedback: { path: ['session_state', 'phase'], equals: phase } })) },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }], select: { id: true, feedback: true }
  });
  const state = storedCoreState(coreProcess);
  if (state) {
    const latestProcess = await prisma.chat_process.findFirst({ where: { admin_chat: adminChatWhere },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }], select: { id: true, feedback: true } });
    let mixedQuestion = false;
    if (!['WRAP', 'DONE'].includes(state.phase) && state.lastQuestionText) {
      // Old legacy /option calls saved a new question without a process row.
      // Detect that visible question too, using one row rather than history scans.
      const [latestQuestion] = await prisma.admin_chat.findMany({
        where: { ...adminChatWhere, sender: 'ai', message_type: 'text', message: { contains: '?' } },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 1, select: { id: true, message: true }
      });
      const pendingText = String(state.lastQuestionText).replace(/\s+/gu, ' ').trim();
      const visibleText = String(latestQuestion?.message || '').replace(/\s+/gu, ' ').trim();
      const matchesPending = pendingText === visibleText || pendingText.endsWith(` ${visibleText}`);
      mixedQuestion = !!visibleText && !matchesPending &&
        (state.lastQuestionChatId == null || Number(latestQuestion.id) > Number(state.lastQuestionChatId));
    }
    return { engine: 'core', state,
      mixed: (!!latestProcess && !storedCoreState(latestProcess)) || mixedQuestion };
  }
  // Legacy greetings have no chat_process yet. One linked message is enough to
  // keep their next answer on the same engine; no historical score is rewritten.
  const existingMessages = await prisma.admin_chat.findMany({
    where: adminChatWhere, take: 1, select: { id: true }
  });
  return { engine: existingMessages.length ? 'legacy' : null, state: null };
}

function selectedTutorCore(req, session, env = process.env) {
  return session?.engine ? session.engine === 'core' : useTutorCoreV2(req, env);
}

const MIXED_SESSION_ERROR = 'This session needs a fresh start. Start a new session to continue with matching questions and feedback.';

module.exports = { useTutorCoreV2, loadTutorSession, selectedTutorCore, storedCoreState, MIXED_SESSION_ERROR };
