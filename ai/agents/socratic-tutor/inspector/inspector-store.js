/**
 * Socratic AI Turn Inspector Store
 *
 * Hybrid storage for turn payloads and context inspection:
 * 1. In-memory Ring Buffer (zero-latency, always available on Local & EC2)
 * 2. Database persistence via Prisma (when database connection is active)
 * 3. File-based fallback logger (logs/turns/topic_<id>.jsonl)
 */

const fs = require('fs');
const path = require('path');

// In-memory ring buffer: topicId -> array of turn payloads (max 200 turns per topic)
const turnRingBuffer = new Map();
const MAX_TURNS_PER_TOPIC = 200;

// Logs directory for disk persistence
const LOGS_DIR = path.join(__dirname, '../../../../logs/turns');

function ensureLogsDir() {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
  } catch (err) {
    // Non-fatal if read-only filesystem
  }
}

/**
 * Record an inspector turn
 *
 * @param {Object} turnPayload - The complete turn payload
 */
async function recordInspectorTurn(turnPayload) {
  if (!turnPayload || !turnPayload.topic?.id) return;

  const topicId = parseInt(turnPayload.topic.id, 10);
  if (isNaN(topicId)) return;

  // 1. In-memory buffer update
  if (!turnRingBuffer.has(topicId)) {
    turnRingBuffer.set(topicId, []);
  }
  const buffer = turnRingBuffer.get(topicId);
  buffer.push(turnPayload);
  if (buffer.length > MAX_TURNS_PER_TOPIC) {
    buffer.shift();
  }

  // 2. Disk persistence (append to JSONL file)
  try {
    ensureLogsDir();
    const filePath = path.join(LOGS_DIR, `topic_${topicId}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify(turnPayload) + '\n', 'utf8');
  } catch (fileErr) {
    // Non-fatal
  }

  // 3. Database persistence (non-blocking)
  try {
    const prisma = require('../../../../lib/prisma');
    if (prisma?.tutor_turn_logs?.create) {
      await prisma.tutor_turn_logs.create({
        data: {
          user_id: turnPayload.user?.id || 1,
          topic_id: topicId,
          intent: turnPayload.student_turn?.intent || 'ANSWER',
          is_correct: turnPayload.student_turn?.evaluator_result?.is_correct ?? null,
          score_percent: turnPayload.student_turn?.evaluator_result?.score_percent ?? null,
          error_type: turnPayload.student_turn?.evaluator_result?.error_type || null,
          diff_html: turnPayload.student_turn?.evaluator_result?.diff_html || null,
          complete_answer: turnPayload.student_turn?.evaluator_result?.complete_answer || null,
          suggested_action: turnPayload.student_turn?.evaluator_result?.suggested_action || null,
          evaluator_reasoning: turnPayload.student_turn?.evaluator_result?.reasoning || null,
          phase: turnPayload.generator_input?.phase || 'DIALOGUE',
          state_instruction: turnPayload.generator_input?.directive || null,
          question_type: turnPayload.generator_output?.question_type || null,
          goal_index: turnPayload.generator_input?.goal_index || 0,
          user_message: turnPayload.student_turn?.message || null,
          ai_response_preview: (turnPayload.generator_output?.validated_bubbles?.[0]?.message || '').substring(0, 500),
          ai_bubble_count: turnPayload.generator_output?.validated_bubbles?.length || 0,
        }
      }).catch(() => {});
    }
  } catch (_) {
    // Non-fatal if DB not configured
  }
}

/**
 * Retrieve inspector turns for a topic
 *
 * @param {Object} options - { topicId, userId, limit }
 * @returns {Array<Object>} List of turn payloads
 */
function getInspectorTurns(options = {}) {
  const topicId = parseInt(options.topicId, 10);
  if (isNaN(topicId)) return [];

  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 50, 1), 200);

  // First check in-memory ring buffer
  if (turnRingBuffer.has(topicId) && turnRingBuffer.get(topicId).length > 0) {
    const buffer = turnRingBuffer.get(topicId);
    let turns = [...buffer];
    if (options.userId) {
      const uid = parseInt(options.userId, 10);
      turns = turns.filter(t => t.user?.id === uid);
    }
    return turns.slice(-limit);
  }

  // Fallback to reading disk file if server restarted
  try {
    const filePath = path.join(LOGS_DIR, `topic_${topicId}.jsonl`);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      let turns = lines.map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);

      if (options.userId) {
        const uid = parseInt(options.userId, 10);
        turns = turns.filter(t => t.user?.id === uid);
      }
      return turns.slice(-limit);
    }
  } catch (readErr) {
    console.warn('[InspectorStore] Read error:', readErr.message);
  }

  return [];
}

/**
 * Clear turns for a topic
 */
function clearInspectorTurns(topicId) {
  const tid = parseInt(topicId, 10);
  if (!isNaN(tid)) {
    turnRingBuffer.delete(tid);
    try {
      const filePath = path.join(LOGS_DIR, `topic_${tid}.jsonl`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {}
  }
}

module.exports = {
  recordInspectorTurn,
  getInspectorTurns,
  clearInspectorTurns,
};
