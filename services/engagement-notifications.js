const prisma = require('../lib/prisma');
const { createNotification } = require('./notifications');

// Configuration
const NOTIFICATIONS_PER_DAY = 10;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = DAY_IN_MS / NOTIFICATIONS_PER_DAY; // ~2.4 hours
const COOL_DOWN_MS = 2 * 60 * 60 * 1000; // Minimum 2 hours between notifications

// Templates
const GENERAL_MESSAGES = [
    "Learning is a journey. Take a step today!",
    "Small daily improvements lead to stunning long-term results.",
    "Your brain is like a muscle. Train it today! 🧠",
    "Don't wish for it. Work for it. Start a session now!",
    "Consistency is key. 15 minutes today makes a difference.",
    "You're doing great! Keep the momentum going.",
    "A little progress each day adds up to big results.",
    "Knowledge is power. Empower yourself today!",
    "Success is the sum of small efforts, repeated day in and day out.",
    "Unlock your potential with a quick study session!"
];

const INCOMPLETE_MESSAGES = [
    "Finish what you started! '{{topic}}' is waiting.",
    "You're almost there with '{{topic}}'. Complete it today! 🏁",
    "Don't leave '{{topic}}' hanging. Wrap it up now.",
    "A quick sprint to finish '{{topic}}'? You got this!"
];

const SAVED_TOPIC_MESSAGES = [
    "Time to revise! '{{topic}}' is in your saved list.",
    " revisiting '{{topic}}' now will boost your retention.",
    "Don't forget about '{{topic}}'. Take a quick look.",
    "Saved for later? Later is now! Open '{{topic}}'."
];

const SCORE_MESSAGES = [
    "New Report Available! 📊 Check your recent performance in {{topic}}.",
    "Aim higher! Your score in {{topic}} can still improve.",
    "Performance Alert: You scored {{score}}% in {{topic}}. beat it today!",
    "Mastery takes time. Review {{topic}} to boost your score."
];

/**
 * Get a random message from an array
 */
const getRandomMessage = (messages) => {
    return messages[Math.floor(Math.random() * messages.length)];
};

/**
 * Generate a personalized engagement notification
 */
async function processEngagementNotifications() {
    console.log('\n📣 Checking engagement notifications...');

    try {
        const users = await prisma.users.findMany({
            where: {
                expo_push_token: { not: null } // Only notify users with push tokens
            },
            select: {
                user_id: true,
                name: true,
                subjects: true,
                grade_level: true
            }
        });

        console.log(`Found ${users.length} users with push tokens.`);

        let sentCount = 0;

        for (const user of users) {
            try {
                // 1. Check last engagement notification time
                const lastNotification = await prisma.notifications.findFirst({
                    where: {
                        user_id: user.user_id,
                        type: { in: ['engagement', 'motivation', 'study_reminder', 'metrics_alert'] }
                    },
                    orderBy: { created_at: 'desc' }
                });

                // 2. Rate limiting check
                if (lastNotification) {
                    const timeSinceLast = Date.now() - new Date(lastNotification.created_at).getTime();
                    if (timeSinceLast < COOL_DOWN_MS) {
                        // Skipping: Too soon
                        continue;
                    }
                }

                // 3. Determine Message Strategy (Priority Waterfall)
                let title = "Time to Learn!";
                let message = getRandomMessage(GENERAL_MESSAGES);
                let type = 'motivation';
                let matchedStrategy = false;

                // Strategy A: Incomplete Topics (High)
                // Find a topic that is started (completion > 0) but not completed
                if (!matchedStrategy) {
                    const incompleteTopic = await prisma.topics.findFirst({
                        where: {
                            user_id: user.user_id,
                            is_completed: false,
                            completion_percent: { gt: 0 }
                        },
                        // topics table has title directly
                        orderBy: { id: 'desc' }
                    });

                    if (incompleteTopic) {
                        title = "Complete Your Session ⏳";
                        message = getRandomMessage(INCOMPLETE_MESSAGES).replace('{{topic}}', incompleteTopic.title);
                        type = 'study_reminder';
                        matchedStrategy = true;
                    }
                }

                // Strategy B: Low Performance / New Reports (Medium)
                if (!matchedStrategy) {
                    const recentReport = await prisma.user_topic_reports.findFirst({
                        where: {
                            user_id: user.user_id,
                        },
                        include: { topics: true },
                        orderBy: { updated_at: 'desc' }
                    });

                    // If report is recent (last 24h) and low score, OR just random chance to remind
                    if (recentReport) {
                        const isLowScore = recentReport.score_percent < 60;
                        // 50% chance to trigger this if low score, 20% otherwise
                        const shouldNotify = isLowScore ? Math.random() > 0.5 : Math.random() > 0.8;

                        if (shouldNotify) {
                            title = isLowScore ? "Boost Your Score! 📈" : "Metrics Update 📊";
                            message = getRandomMessage(SCORE_MESSAGES)
                                .replace('{{topic}}', recentReport.topics.title)
                                .replace('{{score}}', recentReport.score_percent);
                            type = 'metrics_alert';
                            matchedStrategy = true;
                        }
                    }
                }

                // Strategy C: Saved Topics (Medium-Low)
                if (!matchedStrategy) {
                    const savedTopic = await prisma.saved_topics.findFirst({
                        where: { user_id: user.user_id },
                        include: { topics: true }
                    });

                    if (savedTopic && Math.random() > 0.5) {
                        title = "Review Saved Topic 🔖";
                        message = getRandomMessage(SAVED_TOPIC_MESSAGES).replace('{{topic}}', savedTopic.topics.title);
                        type = 'study_reminder';
                        matchedStrategy = true;
                    }
                }

                // Strategy D: Subject Nudge (Fallback 1)
                if (!matchedStrategy && user.subjects && user.subjects.length > 0) {
                    // Find a random subject to nudge about
                    const randomSubjectCode = user.subjects[Math.floor(Math.random() * user.subjects.length)];
                    const subject = await prisma.subjects.findUnique({ where: { code: randomSubjectCode } });

                    if (subject && Math.random() > 0.3) {
                        title = `Let's Study ${subject.name} 📚`;
                        message = `Hey ${user.name}, ready to dive back into ${subject.name}? A quick session can help you stay ahead!`;
                        type = 'study_reminder';
                        matchedStrategy = true;
                    }
                }

                // Fallback: General Motivation (if nothing else matched)

                // 4. Send Notification
                console.log(`Sending engagement notification to User ${user.user_id}: ${title} [Type: ${type}]`);
                // Add emoji to title based on type (optional logic could go here)

                await createNotification(
                    user.user_id,
                    title,
                    message,
                    type
                );
                sentCount++;

                // Small delay to avoid thundering herd on push server
                await new Promise(resolve => setTimeout(resolve, 500));

            } catch (err) {
                console.error(`Error processing engagement for user ${user.user_id}:`, err);
            }
        }

        console.log(`Engagement check complete. Sent ${sentCount} notifications.\n`);

    } catch (error) {
        console.error('Error in processEngagementNotifications:', error);
    }
}

module.exports = {
    processEngagementNotifications
};
