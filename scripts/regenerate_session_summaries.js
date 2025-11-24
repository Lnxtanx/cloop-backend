const prisma = require('../lib/prisma');
const { calculateSessionMetrics, generateSessionSummaryMessage } = require('../services/topic_chat_metrics');

async function main() {
  console.log('Scanning for legacy session summary messages...');

  // Find admin_chat messages that look like old-format session summaries
  const candidates = await prisma.admin_chat.findMany({
    where: {
      OR: [
        { message_type: 'session_summary' },
        { message: { contains: '📊 Common Mistakes' } },
        { message: { contains: 'Areas to Improve' } }
      ]
    },
    select: {
      id: true,
      user_id: true,
      message: true,
      diff_html: true,
      created_at: true
    }
  });

  console.log(`Found ${candidates.length} candidate messages`);

  for (const msg of candidates) {
    try {
      console.log(`\nProcessing admin_chat id=${msg.id} user=${msg.user_id}`);

      // Try to extract session_metrics from diff_html (stored JSON) to find goal IDs
      let goalIds = [];
      if (msg.diff_html) {
        try {
          const parsed = JSON.parse(msg.diff_html);
          if (parsed && parsed.goal_performance && Array.isArray(parsed.goal_performance)) {
            goalIds = parsed.goal_performance.map(g => g.goal_id).filter(Boolean);
          }
        } catch (e) {
          // Not JSON, ignore
        }
      }

      // If still no goalIds, try linked chat_goal_progress entries
      if (goalIds.length === 0) {
        const links = await prisma.chat_goal_progress.findMany({ where: { chat_id: msg.id }, select: { goal_id: true } });
        goalIds = links.map(l => l.goal_id);
      }

      if (goalIds.length === 0) {
        console.log('  No linked goals found; skipping');
        continue;
      }

      // Find the topic containing these goals (take first goal's topic)
      const topicGoal = await prisma.topic_goals.findFirst({ where: { id: goalIds[0] }, select: { topic_id: true } });
      if (!topicGoal) {
        console.log('  No topic found for goals; skipping');
        continue;
      }

      const topicId = topicGoal.topic_id;

      // Fetch all goals for this topic with progress for this user
      const topicGoals = await prisma.topic_goals.findMany({
        where: { topic_id: topicId },
        orderBy: { order: 'asc' },
        include: {
          chat_goal_progress: {
            where: { user_id: msg.user_id },
            orderBy: { updated_at: 'desc' },
            take: 1
          }
        }
      });

      // Calculate fresh metrics
      const metrics = await calculateSessionMetrics(msg.user_id, topicId, topicGoals);

      // Build new formatted summary
      const formatted = generateSessionSummaryMessage('Topic', metrics);

      // Update admin_chat: message, message_type, diff_html (store metrics)
      await prisma.admin_chat.update({
        where: { id: msg.id },
        data: {
          message: formatted,
          message_type: 'session_summary',
          diff_html: JSON.stringify(metrics)
        }
      });

      console.log('  Updated admin_chat with new formatted summary');
    } catch (e) {
      console.error('  Failed to update message:', e.message);
    }
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
