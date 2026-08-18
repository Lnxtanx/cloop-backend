const prisma = require('../lib/prisma');
const { ensureGlobalCurriculum, generateMissingGlobalGoals } = require('./global-curriculum-pipeline');
const { processEngagementNotifications } = require('./engagement-notifications');
const pLimitModule = require('p-limit');
const pLimit = pLimitModule.default || pLimitModule;

let isProcessing = false;
let processingInterval = null;
const POLLING_INTERVAL = 30000; // Check every 30 seconds

/**
 * Continuously check and process pending global curriculum generation
 */
async function startContinuousProcessing() {
  console.log('\n🔄 Starting continuous global curriculum processor...');
  console.log(`⏰ Polling interval: ${POLLING_INTERVAL / 1000} seconds\n`);

  // Initialize and connect Prisma
  try {
    await prisma.$connect();
    console.log('✓ Database connection established');
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
  const ENGAGEMENT_INTERVAL = 60 * 60 * 1000; // 1 hour
  setInterval(() => {
    processEngagementNotifications();
  }, ENGAGEMENT_INTERVAL);

  // Run on start for demo purposes
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
 * Process all pending global curriculum generation tasks
 */
async function processPendingTasks() {
  if (isProcessing) {
    console.log('⏳ Processing already in progress, skipping this cycle...');
    return;
  }

  try {
    isProcessing = true;

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const pendingTasks = await prisma.global_curriculum_status.findMany({
      where: {
        OR: [
          { status: 'pending' },
          { status: 'failed', updated_at: { lt: fiveMinutesAgo } }
        ]
      },
      orderBy: {
        created_at: 'asc'
      }
    });

    if (pendingTasks.length === 0) {
      console.log('📋 No pending global curriculum tasks');
      console.log('🔍 [background-processor] Checking for global topics without goals...');

      const missingGoalsResult = await generateMissingGlobalGoals();

      if (missingGoalsResult && missingGoalsResult.generated > 0) {
        console.log(`✅ Generated goals for ${missingGoalsResult.generated} global topics\n`);
      } else {
        console.log('✅ All global topics have goals\n');
      }

      return;
    }

    console.log(`\n📚 Found ${pendingTasks.length} pending global curriculum task(s) to process`);
    console.log('═'.repeat(60));

    const limit = pLimit(3);

    const taskPromises = pendingTasks.map((task) => {
      return limit(async () => {
        try {
          console.log(`\n🚀 [Worker] Processing Global Curriculum: ${task.board} | ${task.grade} | ${task.subject_name}`);

          const result = await ensureGlobalCurriculum(
            task.board,
            task.grade,
            task.subject_name
          );

          if (result && result.globalSubject) {
            console.log(`✅ [Worker] Successfully completed global curriculum: ${task.board} ${task.grade} ${task.subject_name} (ID: ${result.globalSubject.id})`);
          }

          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
          console.error(`\n❌ [Worker] Failed Global Curriculum: ${task.board} ${task.grade} ${task.subject_name}`);
          console.error(`   Error: ${error.message}`);
        }
      });
    });

    await Promise.all(taskPromises);

    console.log('\n' + '═'.repeat(60));
    console.log('✅ Global processing cycle completed');
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


