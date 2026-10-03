/**
 * AI Avatar API routes
 *
 * A live, speaking Tavus PAL the student talks to. Voice only -- no whiteboard,
 * no tools. Free tier: 20 conversation minutes per month, 1 concurrent stream.
 *
 * Endpoints (all require JWT):
 *   GET  /api/avatar/config            availability, faces, languages, budget
 *   GET  /api/avatar/usage             minutes used / remaining
 *   POST /api/avatar/session           create a Tavus conversation
 *   POST /api/avatar/session/end       end it and charge the budget
 *   GET  /api/avatar/sessions          this user's avatar history
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const prisma = require('../../lib/prisma');
const tavus = require('../../services/avatar/tavus-client');
const budget = require('../../services/avatar/budget');
const {
  INDIAN_LANGUAGES,
  FEMALE_FACES,
  DEFAULT_FACE_ID,
  DEFAULT_LANGUAGES,
  sanitizeLanguages,
  sanitizeFaceId,
  sanitizeText,
} = require('../../services/avatar/catalog');

const TRACK_KEY = 'avatar_tutor';

function isEnabled() {
  return String(process.env.AVATAR_ENABLED || '').toLowerCase() === 'true';
}

/**
 * authenticateToken sets `req.user` (the JWT payload), not `req.userId`.
 * The claim name has varied across sign-in paths, so accept every shape the
 * rest of the codebase uses and fall back to rejecting.
 */
function resolveUserId(req) {
  const id = req.user?.user_id ?? req.user?.userId ?? req.user?.id;
  return Number.isFinite(Number(id)) ? Number(id) : null;
}

/** Guard for handlers that write to the database. */
function requireUserId(req, res) {
  const userId = resolveUserId(req);
  if (userId === null) {
    res.status(401).json({ error: 'Token is missing a user id' });
    return null;
  }
  return userId;
}

/** Wraps an async handler so a rejected promise reaches the error middleware. */
const wrap = (handler) => (req, res, next) => handler(req, res).catch(next);

router.use(authenticateToken);

router.get(
  '/config',
  wrap(async (req, res) => {
    const configured = tavus.isConfigured();
    const enabled = isEnabled();

    res.json({
      enabled,
      configured,
      available: enabled && configured,
      reason: !enabled
        ? 'The AI avatar is not switched on yet.'
        : !configured
          ? 'The AI avatar is missing its Tavus credentials on the server.'
          : null,
      faces: FEMALE_FACES,
      languages: INDIAN_LANGUAGES,
      defaultFaceId: DEFAULT_FACE_ID,
      defaultLanguages: DEFAULT_LANGUAGES,
      maxCallSeconds: tavus.getMaxCallSeconds(),
      usage: budget.usageFor(resolveUserId(req)),
    });
  }),
);

router.get(
  '/usage',
  wrap(async (req, res) => {
    res.json(budget.usageFor(resolveUserId(req)));
  }),
);

router.post(
  '/session',
  wrap(async (req, res) => {
    if (!isEnabled()) {
      return res.status(503).json({ error: 'The AI avatar is not switched on yet.' });
    }

    if (!tavus.isConfigured()) {
      return res
        .status(503)
        .json({ error: 'The AI avatar is missing its Tavus credentials on the server.' });
    }

const userId = requireUserId(req, res);
    if (userId === null) return;

    const testMode = Boolean(req.body && req.body.testMode);

    const verdict = budget.check(userId, { testMode });
    if (!verdict.allowed) {
      return res.status(402).json({ error: verdict.reason, usage: verdict.usage });
    }

    const languages = sanitizeLanguages(req.body && req.body.languages);
    const faceId = sanitizeFaceId(req.body && req.body.faceId) || DEFAULT_FACE_ID;
    const greeting = sanitizeText(req.body && req.body.greeting, 300);
    const context = sanitizeText(req.body && req.body.context, 2000);

    const conversation = await tavus.createConversation({
      faceId,
      languages: languages || DEFAULT_LANGUAGES,
      greeting,
      context,
      testMode,
});

    if (!testMode) {
      // Log to voice_sessions, which already has the columns we need, so avatar
      // sessions show up in the existing dashboards with no migration.
      // Safe to close by status later: the free tier allows only one concurrent
      // conversation, so a user can have at most one ACTIVE row.
      try {
        await prisma.voice_sessions.create({
          data: {
            user_id: userId,
            track_key: TRACK_KEY,
            session_mode: 'avatar',
            status: 'ACTIVE',
            tutor_name: 'Cloop AI Avatar',
            duration_seconds: 0,
            started_at: new Date(),
          },
        });
      } catch (err) {
        // Never block the call because analytics failed.
        console.error('[avatar] failed to log session start:', err.message);
      }
    }

    res.json({
      conversationId: conversation.conversation_id,
      conversationUrl: conversation.conversation_url,
      status: conversation.status,
      testMode,
      usage: budget.usageFor(userId),
    });
  }),
);

router.post(
  '/session/end',
  wrap(async (req, res) => {
    const conversationId = sanitizeText(req.body && req.body.conversationId, 64);
    const elapsedSeconds = Number(req.body && req.body.elapsedSeconds) || 0;

    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required' });
    }

const userId = requireUserId(req, res);
    if (userId === null) return;

    // Charge first so the budget is enforced even if Tavus is unreachable.
    const usage = budget.charge(conversationId, userId, elapsedSeconds);

    try {
      await tavus.endConversation(conversationId);
    } catch (err) {
      // 404 means Tavus already cleaned it up, which is the state we wanted.
      if (err.status !== 404) {
        console.error(`[avatar] failed to end ${conversationId}:`, err.message);
      }
    }

    try {
      await prisma.voice_sessions.updateMany({
        where: {
          user_id: userId,
          track_key: TRACK_KEY,
          status: 'ACTIVE',
        },
        data: {
          status: 'COMPLETED',
          duration_seconds: Math.round(elapsedSeconds),
          completed_at: new Date(),
        },
      });
    } catch (err) {
      console.error('[avatar] failed to close session row:', err.message);
    }

    res.json({ ok: true, usage });
  }),
);

router.get(
  '/sessions',
wrap(async (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === null) return;

    const limit = Math.min(Number(req.query.limit) || 20, 50);

    const rows = await prisma.voice_sessions.findMany({
      where: { user_id: userId, track_key: TRACK_KEY },
      orderBy: { created_at: 'desc' },
      take: limit,
      select: {
        id: true,
        status: true,
        duration_seconds: true,
        started_at: true,
        completed_at: true,
        created_at: true,
      },
    });

    res.json({ sessions: rows });
  }),
);

module.exports = router;
