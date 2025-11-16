const prisma = require('../lib/prisma');

/**
 * Store user's Expo push token
 */
async function saveExpoPushToken(userId, expoPushToken) {
  try {
    await prisma.users.update({
      where: { user_id: userId },
      data: { 
        expo_push_token: expoPushToken 
      }
    });
    
    console.log(`✓ Saved Expo push token for user ${userId}`);
    return { success: true };
  } catch (error) {
    console.error('Error saving Expo push token:', error);
    throw error;
  }
}

/**
 * Send push notification using Expo Push API
 */
async function sendPushNotification(expoPushToken, title, body, data = {}) {
  try {
    const message = {
      to: expoPushToken,
      sound: 'default',
      title: title,
      body: body,
      data: data,
      priority: 'high',
      channelId: 'content-generation',
    };

    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    const result = await response.json();
    
    if (result.data && result.data.status === 'ok') {
      console.log(`✓ Push notification sent: ${title}`);
      return { success: true, result };
    } else {
      console.error('Push notification failed:', result);
      return { success: false, error: result };
    }
  } catch (error) {
    console.error('Error sending push notification:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Send notification to user about content generation
 */
async function notifyContentGenerationStatus(userId, status, subject, details = {}) {
  try {
    const user = await prisma.users.findUnique({
      where: { user_id: userId },
      select: { expo_push_token: true, name: true }
    });

    if (!user || !user.expo_push_token) {
      console.log(`No push token for user ${userId}, skipping notification`);
      return { success: false, reason: 'No push token' };
    }

    let title = '';
    let body = '';
    let data = {
      type: 'content_generation',
      userId,
      subject,
      status,
      ...details
    };

    switch (status) {
      case 'started':
        title = '🚀 Content Generation Started';
        body = `Creating curriculum for ${subject}. This may take a few minutes...`;
        break;
      
      case 'chapters_complete':
        title = '📚 Chapters Ready!';
        body = `${details.count} chapters created for ${subject}. Generating topics now...`;
        break;
      
      case 'topics_complete':
        title = '📖 Topics Generated!';
        body = `${details.count} topics ready for ${subject}. Creating learning goals...`;
        break;
      
      case 'goals_complete':
        title = '🎯 Goals Created!';
        body = `${details.count} learning goals set for ${subject}.`;
        break;
      
      case 'completed':
        title = '✅ All Set!';
        body = `${subject} curriculum is ready! Start learning now.`;
        break;
      
      case 'failed':
        title = '⚠️ Generation Failed';
        body = `There was an issue creating ${subject}. We'll retry automatically.`;
        break;
      
      default:
        title = '📚 Content Update';
        body = `Status update for ${subject}`;
    }

    return await sendPushNotification(user.expo_push_token, title, body, data);
  } catch (error) {
    console.error('Error notifying user:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Send batch notifications to multiple users
 */
async function sendBatchNotifications(notifications) {
  try {
    const messages = notifications.map(notif => ({
      to: notif.expoPushToken,
      sound: 'default',
      title: notif.title,
      body: notif.body,
      data: notif.data || {},
      priority: 'high',
      channelId: 'content-generation',
    }));

    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    const result = await response.json();
    console.log(`✓ Sent ${messages.length} batch notifications`);
    return { success: true, result };
  } catch (error) {
    console.error('Error sending batch notifications:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  saveExpoPushToken,
  sendPushNotification,
  notifyContentGenerationStatus,
  sendBatchNotifications,
};
