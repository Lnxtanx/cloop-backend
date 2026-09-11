const prisma = require('../lib/prisma');
const { processEngagementNotifications } = require('./engagement-notifications');
const { cleanupStaleSessions } = require('./analytics/activity-tracker');

let processingInterval = null;
let staleSessionInterval = null;

/**
 * Background Processor for Notifications & Scheduled Jobs
 * (Curriculum generation has been decoupled and runs exclusively via CLI script)
 */
async function startContinuousProcessing() {
  console.log('\n🔄 Initializing Background Service Worker...');

  try {
    await prisma.$connect();
    console.log('✓ Database connection established for background worker');
  } catch (error) {
    console.error('❌ Failed to connect to database in background worker:', error);
    throw error;
  }

  // Engagement Notification Loop (Check every 1 hour)
  const ENGAGEMENT_INTERVAL = 60 * 60 * 1000; // 1 hour
  processingInterval = setInterval(() => {
    processEngagementNotifications();
  }, ENGAGEMENT_INTERVAL);

  // Stale Activity Session Cleanup (every 2 minutes)
  const STALE_SESSION_INTERVAL = 2 * 60 * 1000; // 2 minutes
  staleSessionInterval = setInterval(() => {
    cleanupStaleSessions();
  }, STALE_SESSION_INTERVAL);

  // Run on start for demo/scheduling purposes
  setTimeout(() => {
    processEngagementNotifications();
  }, 10000); // Wait 10s after startup

  console.log('✓ Background Service Worker running (Notifications, Engagement & Session Cleanup)\n');
}

/**
 * Stop the background service worker
 */
async function stopContinuousProcessing() {
  if (processingInterval) {
    clearInterval(processingInterval);
    processingInterval = null;
  }
  if (staleSessionInterval) {
    clearInterval(staleSessionInterval);
    staleSessionInterval = null;
  }
  console.log('\n⏹️  Background worker stopped');

  if (prisma) {
    try {
      await prisma.$disconnect();
      console.log('✓ Database connection closed\n');
    } catch (error) {
      console.error('❌ Error disconnecting from database:', error);
    }
  }
}

function getProcessorStatus() {
  return {
    isRunning: processingInterval !== null
  };
}

module.exports = {
  startContinuousProcessing,
  stopContinuousProcessing,
  getProcessorStatus
};
