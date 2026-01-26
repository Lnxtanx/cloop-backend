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
                        type: { in: ['engagement', 'motivation', 'study_reminder'] }
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

                // 3. Determine Message Strategy
                let title = "Time to Learn!";
                let message = getRandomMessage(GENERAL_MESSAGES);
                let type = 'motivation';

                // Strategy A: Low Performance (Priority)
                const lowPerformanceTopic = await prisma.user_topic_reports.findFirst({
                    where: {
                        user_id: user.user_id,
                        score_percent: { lt: 60 }
                    },
                    include: { topics: true },
                    orderBy: { updated_at: 'desc' } // Most recent failure
                });

                if (lowPerformanceTopic) {
                    title = "Boost Your Score! 📈";
                    message = `Hey ${user.name}, your score in ${lowPerformanceTopic.topics.title} was a bit low. Why not retry and master it?`;
                    type = 'study_reminder';
                }
                // Strategy B: Incomplete Subject (Secondary)
                else if (user.subjects && user.subjects.length > 0) {
                    // Find a random subject to nudge about
                    const randomSubjectCode = user.subjects[Math.floor(Math.random() * user.subjects.length)];
                    const subject = await prisma.subjects.findUnique({ where: { code: randomSubjectCode } });

                    if (subject) {
                        title = `Let's Study ${subject.name} 📚`;
                        message = `Hey ${user.name}, ready to dive back into ${subject.name}? A quick session can help you stay ahead!`;
                        type = 'study_reminder';
                    }
                }

                // 4. Send Notification
                console.log(`Sending engagement notification to User ${user.user_id}: ${title}`);
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
