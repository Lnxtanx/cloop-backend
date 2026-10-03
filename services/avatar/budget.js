/**
 * Avatar minute budget.
 *
 * Tavus free tier gives us 20 conversation minutes per month and 1 concurrent
 * stream, shared by every student. Without a guard one user can burn the whole
 * month in four calls, so we enforce two ceilings:
 *
 *   global   -- total minutes across all users this calendar month
 *   perUser  -- minutes a single user may spend per rolling day
 *
 * State lives in memory (single backend instance) and is flushed to disk so a
 * restart or deploy does not hand everyone a fresh budget.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', '.data');
const LEDGER_PATH = path.join(DATA_DIR, 'avatar-usage.json');

const DEFAULT_MONTHLY_BUDGET_MINUTES = 20;
const DEFAULT_PER_USER_DAILY_SECONDS = 5 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getMonthlyBudgetSeconds() {
  return num(process.env.TAVUS_MONTHLY_MINUTE_BUDGET, DEFAULT_MONTHLY_BUDGET_MINUTES) * 60;
}

function getPerUserDailySeconds() {
  return num(process.env.AVATAR_PER_USER_DAILY_SECONDS, DEFAULT_PER_USER_DAILY_SECONDS);
}

/** Minutes are bucketed by IST so "this month" matches the student's month. */
function currentMonthKey(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date(now));
}

function dayKey(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
}

function emptyState(now = Date.now()) {
  return {
    month: currentMonthKey(now),
    secondsUsed: 0,
    users: {},
    conversations: {},
  };
}

let state = null;
let flushTimer = null;

function load() {
  if (state) return state;

  let loaded = null;
  try {
    const raw = fs
      .readFileSync(LEDGER_PATH, 'utf8')
      // A UTF-8 BOM makes JSON.parse throw, which would silently reset usage to
      // zero and defeat the guard entirely. Strip it.
      .replace(/^\uFEFF/, '');
    loaded = JSON.parse(raw);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error(
        `[avatar-budget] ${LEDGER_PATH} unreadable (${err.message}). Budget restarts at zero.`,
      );
    }
    loaded = null;
  }

  const now = Date.now();
  if (
    !loaded ||
    loaded.month !== currentMonthKey(now) ||
    typeof loaded.secondsUsed !== 'number'
  ) {
    loaded = emptyState(now);
  }

  if (typeof loaded.users !== 'object' || loaded.users === null) loaded.users = {};
  if (typeof loaded.conversations !== 'object' || loaded.conversations === null) {
    loaded.conversations = {};
  }

  state = loaded;
  return state;
}

function flush() {
  if (!state) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LEDGER_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error(`[avatar-budget] failed to persist ledger: ${err.message}`);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 2000);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function userEntry(db, userId, now = Date.now()) {
  const key = String(userId);
  const today = dayKey(now);

  if (!db.users[key] || db.users[key].day !== today) {
    db.users[key] = { day: today, secondsUsed: 0 };
  }
  return db.users[key];
}

function usageFor(userId) {
  const db = load();
  const monthly = getMonthlyBudgetSeconds();
  const perUserDaily = getPerUserDailySeconds();
  const user = db.users[String(userId)];

  const userToday = db.users[String(userId)];
  const userSecondsUsed =
    userToday && userToday.day === dayKey() ? userToday.secondsUsed : 0;

  return {
    month: db.month,
    secondsUsed: db.secondsUsed,
    secondsBudget: monthly,
    remainingSeconds: Math.max(0, monthly - db.secondsUsed),
    perUserSecondsUsed: userSecondsUsed,
    perUserSecondsBudget: perUserDaily,
    perUserRemainingSeconds: Math.max(0, perUserDaily - userSecondsUsed),
    sessionCount: Object.keys(db.conversations).length,
  };
}

/**
 * Decide whether this user may start a real conversation.
 * Returns { allowed, reason, usage }.
 */
function check(userId, { testMode = false } = {}) {
  const usage = usageFor(userId);

  if (!testMode) {
    if (usage.remainingSeconds <= 0) {
      return {
        allowed: false,
        reason: `The monthly avatar budget is used up (${Math.round(
          usage.secondsUsed / 60,
        )} of ${Math.round(usage.secondsBudget / 60)} minutes). It resets next month.`,
        usage,
      };
    }

    if (usage.perUserRemainingSeconds <= 0) {
      return {
        allowed: false,
        reason: `You have used your ${Math.round(
          usage.perUserSecondsBudget / 60,
        )}-minute avatar allowance for today. Try again tomorrow.`,
        usage,
      };
    }
  }

  return { allowed: true, reason: null, usage };
}

/**
 * Record time against a conversation. Called when a session ends.
 * Idempotent per conversation -- a retried end request is charged once.
 */
function charge(conversationId, userId, seconds) {
  const db = load();
  const amount = Math.max(0, Math.round(Number(seconds) || 0));

  if (!conversationId || !db.conversations[conversationId]) {
    db.secondsUsed += amount;

    if (userId !== undefined && userId !== null) {
      const entry = userEntry(db, userId);
      entry.secondsUsed += amount;
    }

    db.conversations[conversationId] = {
      userId: userId ?? null,
      seconds: amount,
      at: new Date().toISOString(),
    };

    // Keep the map from growing without bound.
    const keys = Object.keys(db.conversations);
    if (keys.length > 500) {
      for (const key of keys.slice(0, keys.length - 500)) {
        delete db.conversations[key];
      }
    }

    scheduleFlush();
  }

  return usageFor(userId);
}

function reset() {
  state = emptyState();
  flush();
  return usageFor(undefined);
}

module.exports = {
  check,
  charge,
  usageFor,
  reset,
  getMonthlyBudgetSeconds,
  getPerUserDailySeconds,
  currentMonthKey,
  dayKey,
};