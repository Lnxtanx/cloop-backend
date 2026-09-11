/**
 * Delete specific users from the database.
 * 
 * Usage:
 *   node scripts/delete-users.js          # Dry run (shows what would be deleted)
 *   node scripts/delete-users.js --confirm # Actually deletes
 */

const prisma = require('../lib/prisma');

// User IDs to delete
const USER_IDS_TO_DELETE = [
  // Range 69–84
  69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84,
  // Individual IDs
  90, 91, 92, 96, 97, 99, 100, 104, 105, 107, 108, 111, 114, 124
];

async function main() {
  const isConfirmed = process.argv.includes('--confirm');

  console.log('==============================================');
  console.log('  USER DELETION SCRIPT');
  console.log('==============================================');
  console.log(`  Mode: ${isConfirmed ? '🔴 LIVE DELETE' : '🟡 DRY RUN'}`);
  console.log(`  Target IDs: ${USER_IDS_TO_DELETE.join(', ')}`);
  console.log(`  Total IDs: ${USER_IDS_TO_DELETE.length}`);
  console.log('----------------------------------------------\n');

  // 1. Check which users actually exist
  const existingUsers = await prisma.users.findMany({
    where: { user_id: { in: USER_IDS_TO_DELETE } },
    select: { user_id: true, name: true, email: true, created_at: true }
  });

  console.log(`Found ${existingUsers.length} users out of ${USER_IDS_TO_DELETE.length} requested:\n`);

  if (existingUsers.length === 0) {
    console.log('  No matching users found. Nothing to delete.');
    return;
  }

  for (const user of existingUsers) {
    console.log(`  ID: ${user.user_id} | ${user.name} | ${user.email} | Created: ${user.created_at?.toISOString().split('T')[0] || 'N/A'}`);
  }

  const existingIds = existingUsers.map(u => u.user_id);
  const missingIds = USER_IDS_TO_DELETE.filter(id => !existingIds.includes(id));
  if (missingIds.length > 0) {
    console.log(`\n  IDs not found (already deleted or never existed): ${missingIds.join(', ')}`);
  }

  // 2. Count related records that will be cascade-deleted
  console.log('\n--- Related records that will be cascade-deleted ---\n');

  const relatedCounts = await Promise.all([
    prisma.admin_chat.count({ where: { user_id: { in: existingIds } } }),
    prisma.learning_turns.count({ where: { user_id: { in: existingIds } } }),
    prisma.chat_goal_progress.count({ where: { user_id: { in: existingIds } } }),
    prisma.normal_user_chat.count({ where: { user_id: { in: existingIds } } }),
    prisma.normal_chat_sessions.count({ where: { user_id: { in: existingIds } } }),
    prisma.study_sessions.count({ where: { user_id: { in: existingIds } } }),
    prisma.user_topic_progress.count({ where: { user_id: { in: existingIds } } }),
    prisma.user_chapter_progress.count({ where: { user_id: { in: existingIds } } }),
    prisma.user_subject_enrollment.count({ where: { user_id: { in: existingIds } } }),
    prisma.user_topic_reports.count({ where: { user_id: { in: existingIds } } }),
    prisma.saved_topics.count({ where: { user_id: { in: existingIds } } }),
    prisma.notifications.count({ where: { user_id: { in: existingIds } } }),
    prisma.feedback.count({ where: { user_id: { in: existingIds } } }),
    prisma.practice_tests.count({ where: { user_id: { in: existingIds } } }),
    prisma.ai_token_logs.count({ where: { user_id: { in: existingIds } } }),
    prisma.ai_user_daily_token_usage.count({ where: { user_id: { in: existingIds } } }),
    prisma.user_english_progress.count({ where: { user_id: { in: existingIds } } }),
    prisma.web_search_logs.count({ where: { user_id: { in: existingIds } } }),
    prisma.assessment_sessions.count({ where: { user_id: { in: existingIds } } }),
    prisma.voice_sessions.count({ where: { user_id: { in: existingIds } } }),
  ]);

  const labels = [
    'admin_chat', 'learning_turns', 'chat_goal_progress', 'normal_user_chat',
    'normal_chat_sessions', 'study_sessions', 'user_topic_progress',
    'user_chapter_progress', 'user_subject_enrollment', 'user_topic_reports',
    'saved_topics', 'notifications', 'feedback', 'practice_tests',
    'ai_token_logs', 'ai_user_daily_token_usage', 'user_english_progress',
    'web_search_logs', 'assessment_sessions', 'voice_sessions'
  ];

  let totalRelated = 0;
  for (let i = 0; i < labels.length; i++) {
    if (relatedCounts[i] > 0) {
      console.log(`  ${labels[i]}: ${relatedCounts[i]} records`);
      totalRelated += relatedCounts[i];
    }
  }
  console.log(`\n  TOTAL related records: ${totalRelated}`);

  // 3. Delete or show summary
  if (!isConfirmed) {
    console.log('\n⚠️  DRY RUN — No records were deleted.');
    console.log('    To actually delete, run:');
    console.log('    node scripts/delete-users.js --confirm\n');
    return;
  }

  console.log('\n🔴 DELETING users...\n');

  // Prisma's onDelete: Cascade handles related records automatically
  const result = await prisma.users.deleteMany({
    where: { user_id: { in: existingIds } }
  });

  console.log(`✅ Deleted ${result.count} users and all related data.\n`);
}

main()
  .catch(err => {
    console.error('❌ Script failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
