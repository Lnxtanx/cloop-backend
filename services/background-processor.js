const prisma = require('../lib/prisma');
const { runContentGenerationPipeline, generateMissingGoals } = require('./content-pipeline');
const { notifyContentGenerationStatus } = require('./notifications');
const { processEngagementNotifications } = require('./engagement-notifications');

console.log('[background-processor] Prisma loaded:', typeof prisma, 'has contentGenerationStatus:', typeof prisma?.contentGenerationStatus);

let isProcessing = false;
let processingInterval = null;
const POLLING_INTERVAL = 30000; // Check every 30 seconds

/**
 * Continuously check and process pending content generation
 */
async function startContinuousProcessing() {
  console.log('\n🔄 Starting continuous content generation processor...');
  console.log(`⏰ Polling interval: ${POLLING_INTERVAL / 1000} seconds\n`);

  console.log('[startContinuousProcessing] Prisma before connect:', typeof prisma, 'has contentGenerationStatus:', typeof prisma?.contentGenerationStatus);

  // Initialize and connect Prisma
  try {
    await prisma.$connect();
    console.log('✓ Database connection established');
    console.log('[startContinuousProcessing] Prisma after connect:', typeof prisma, 'has contentGenerationStatus:', typeof prisma?.contentGenerationStatus);
  } catch (error) {
    console.error('❌ Failed to connect to database:', error);
    throw error;
  }

  // Run immediately on start
  await processPendingTasks();

  // Then set up interval for continuous checking
  processingInterval = setInterval(async () => {
    await processPendingTasks();
  }, POLLING_INTERVAL);

  // Engagement Notification Loop (Check every 1 hour)
  // We check frequently, but the internal logic handles the 2-hour cooldown per user
  const ENGAGEMENT_INTERVAL = 60 * 60 * 1000; // 1 hour
  setInterval(() => {
    processEngagementNotifications();
  }, ENGAGEMENT_INTERVAL);

  // Run on start for demo purposes (optional)
  setTimeout(() => {
    processEngagementNotifications();
  }, 10000); // Wait 10s after startup

  console.log('✓ Continuous processor started\n');
}

/**
 * Stop the continuous processing
 */
async function stopContinuousProcessing() {
  if (processingInterval) {
    clearInterval(processingInterval);
    processingInterval = null;
    console.log('\n⏹️  Continuous processor stopped');
  }

  // Disconnect Prisma client
  if (prisma) {
    try {
      await prisma.$disconnect();
      console.log('✓ Database connection closed\n');
    } catch (error) {
      console.error('❌ Error disconnecting from database:', error);
    }
  }
}

/**
 * Process all pending content generation tasks
 */
async function processPendingTasks() {
  // Prevent concurrent processing
  if (isProcessing) {
    console.log('⏳ Processing already in progress, skipping this cycle...');
    return;
  }

  try {
    isProcessing = true;

    // Find all pending or failed tasks
    const pendingTasks = await prisma.content_generation_status.findMany({
      where: {
        OR: [
          { status: 'pending' },
          { status: 'failed' }
        ]
      },
      include: {
        subjects: {
          select: {
            id: true,
            name: true,
            code: true
          }
        }
      },
      orderBy: {
        created_at: 'asc' // Process oldest first
      }
    });

    if (pendingTasks.length === 0) {
      // No pending tasks, check for missing goals
      console.log('📋 No pending content generation tasks');
      console.log('🔍 [background-processor] Checking for topics without goals...');

      const missingGoalsResult = await generateMissingGoals();

      if (missingGoalsResult.generated > 0) {
        console.log(`✅ Generated goals for ${missingGoalsResult.generated} topics\n`);
      } else {
        console.log('✅ All topics have goals\n');
      }

      return;
    }

    console.log(`\n📚 Found ${pendingTasks.length} pending task(s) to process`);
    console.log('═'.repeat(60));

    for (const task of pendingTasks) {
      try {
        // Check if user still exists and has complete profile
        const user = await prisma.users.findUnique({
          where: { user_id: task.user_id }
        });

        if (!user) {
          console.log(`❌ User ${task.user_id} not found, skipping...`);

          // Mark as failed
          await prisma.content_generation_status.update({
            where: { id: task.id },
            data: {
              status: 'failed',
              error_message: 'User not found',
              updated_at: new Date()
            }
          });
          continue;
        }

        if (!user.grade_level || !user.board) {
          console.log(`⚠️  User ${task.user_id} profile incomplete, skipping...`);
          continue;
        }

        console.log(`\n🚀 Processing: ${user.name} - ${task.subjects.name}`);
        console.log(`   Grade: ${user.grade_level}, Board: ${user.board}`);

        // Send start notification
        await notifyContentGenerationStatus(
          task.user_id,
          'started',
          task.subjects.name
        );

        // Run the content generation pipeline
        const result = await runContentGenerationPipeline(task.user_id, task.subject_id);

        if (result.success) {
          console.log(`✅ Successfully completed: ${task.subjects.name}`);
          console.log(`   Chapters: ${result.chaptersCount}, Topics: ${result.topicsCount || 0}`);

          // Send completion notification
          await notifyContentGenerationStatus(
            task.user_id,
            'completed',
            task.subjects.name,
            {
              chaptersCount: result.chaptersCount,
              topicsCount: result.topicsCount
            }
          );
        }

        // Add delay between tasks to avoid rate limiting
        console.log('⏸️  Waiting 3 seconds before next task...');
        await new Promise(resolve => setTimeout(resolve, 3000));

      } catch (error) {
        console.error(`\n❌ Failed: User ${task.user_id}, Subject ${task.subjects.name}`);
        console.error(`   Error: ${error.message}`);

        // Send failure notification
        await notifyContentGenerationStatus(
          task.user_id,
          'failed',
          task.subjects.name,
          { error: error.message }
        );

        // Mark as failed in database
        await prisma.content_generation_status.update({
          where: { id: task.id },
          data: {
            status: 'failed',
            error_message: error.message,
            updated_at: new Date()
          }
        });
      }
    }

    console.log('\n' + '═'.repeat(60));
    console.log('✅ Processing cycle completed');
    console.log(`⏰ Next check in ${POLLING_INTERVAL / 1000} seconds\n`);

  } catch (error) {
    console.error('❌ Error in processing cycle:', error);
  } finally {
    isProcessing = false;
  }
}

/**
 * Get current processor status
 */
function getProcessorStatus() {
  return {
    isRunning: processingInterval !== null,
    isProcessing: isProcessing,
    pollingInterval: POLLING_INTERVAL
  };
}

/**
 * Manually trigger a processing cycle
 */
async function triggerManualProcessing() {
  console.log('\n🔧 Manual processing triggered...\n');
  await processPendingTasks();
}

module.exports = {
  startContinuousProcessing,
  stopContinuousProcessing,
  processPendingTasks,
  getProcessorStatus,
  triggerManualProcessing,
};

