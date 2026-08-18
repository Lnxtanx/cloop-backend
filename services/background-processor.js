const prisma = require('../lib/prisma');
const { ensureGlobalCurriculum, generateMissingGlobalGoals } = require('./global-curriculum-pipeline');
const { processEngagementNotifications } = require('./engagement-notifications');
const pLimitModule = require('p-limit');
const pLimit = pLimitModule.default || pLimitModule;

let isProcessing = false;
let processingInterval = null;
const POLLING_INTERVAL = 30000; // Check every 30 seconds

const DEFAULT_MATRIX = [
	// 1. CBSE
	{ board: 'Central Board of Secondary Education', grade: 'Class 5', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Environmental Studies', 'Computer Science', 'Art & Craft'] },
	{ board: 'Central Board of Secondary Education', grade: 'Class 6', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Environmental Studies', 'Computer Science'] },
	{ board: 'Central Board of Secondary Education', grade: 'Class 7', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Environmental Studies', 'Computer Science'] },
	{ board: 'Central Board of Secondary Education', grade: 'Class 8', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Environmental Studies', 'Computer Science'] },
	{ board: 'Central Board of Secondary Education', grade: 'Class 9', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science'] },
	{ board: 'Central Board of Secondary Education', grade: 'Class 10', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science'] },

	// 2. ICSE
	{ board: 'Indian Certificate of Secondary Education', grade: 'Class 5', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science', 'Environmental Studies'] },
	{ board: 'Indian Certificate of Secondary Education', grade: 'Class 6', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science', 'Environmental Studies'] },
	{ board: 'Indian Certificate of Secondary Education', grade: 'Class 7', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science', 'Environmental Studies'] },
	{ board: 'Indian Certificate of Secondary Education', grade: 'Class 8', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science', 'Environmental Studies'] },
	{ board: 'Indian Certificate of Secondary Education', grade: 'Class 9', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science'] },
	{ board: 'Indian Certificate of Secondary Education', grade: 'Class 10', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science'] },

	// 3. IB (International Baccalaureate)
	{ board: 'International Baccalaureate', grade: 'Class 5', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science', 'Art & Craft'] },
	{ board: 'International Baccalaureate', grade: 'Class 6', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science', 'Environmental Studies'] },
	{ board: 'International Baccalaureate', grade: 'Class 7', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science', 'Environmental Studies'] },
	{ board: 'International Baccalaureate', grade: 'Class 8', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science', 'Environmental Studies'] },
	{ board: 'International Baccalaureate', grade: 'Class 9', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science'] },
	{ board: 'International Baccalaureate', grade: 'Class 10', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science'] },

	// 4. IGCSE (Cambridge Assessment)
	{ board: 'International General Certificate of Secondary Education', grade: 'Class 5', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science', 'Environmental Studies'] },
	{ board: 'International General Certificate of Secondary Education', grade: 'Class 6', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science', 'Environmental Studies'] },
	{ board: 'International General Certificate of Secondary Education', grade: 'Class 7', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science', 'Environmental Studies'] },
	{ board: 'International General Certificate of Secondary Education', grade: 'Class 8', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science', 'Environmental Studies'] },
	{ board: 'International General Certificate of Secondary Education', grade: 'Class 9', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science'] },
	{ board: 'International General Certificate of Secondary Education', grade: 'Class 10', subjects: ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science'] }
];

async function enqueueStandardCurriculumTasks() {
	try {
		for (const item of DEFAULT_MATRIX) {
			for (const subjectName of item.subjects) {
				const existing = await prisma.global_curriculum_status.findUnique({
					where: {
						board_grade_subject_name: {
							board: item.board,
							grade: item.grade,
							subject_name: subjectName
						}
					}
				});

				if (!existing) {
					await prisma.global_curriculum_status.create({
						data: {
							board: item.board,
							grade: item.grade,
							subject_name: subjectName,
							status: 'pending'
						}
					});
				} else if (existing.status === 'in_progress') {
					// Check if stale (older than 5 minutes)
					const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
					if (existing.updated_at && new Date(existing.updated_at) < fiveMinAgo) {
						await prisma.global_curriculum_status.update({
							where: { id: existing.id },
							data: { status: 'pending' }
						});
					}
				}
			}
		}
	} catch (err) {
		console.error('Error enqueuing standard curriculum tasks:', err.message);
	}
}

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

  // Ensure all standard curriculum tasks are enqueued
  await enqueueStandardCurriculumTasks();

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
      orderBy: [
        { id: 'asc' }
      ]
    });

    if (pendingTasks.length === 0) {
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


