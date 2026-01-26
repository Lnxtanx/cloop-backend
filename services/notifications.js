const prisma = require('../lib/prisma');

// Helper to send push notification
const sendPushNotification = async (userId, title, message, data = {}) => {
  try {
    const user = await prisma.users.findUnique({
      where: { user_id: parseInt(userId) },
      select: { expo_push_token: true }
    });

    const token = user?.expo_push_token;

    if (token && Expo.isExpoPushToken(token)) {
      console.log(`Sending push to user ${userId} with token ${token}`);
      await expo.sendPushNotificationsAsync([{
        to: token,
        sound: 'default',
        title: title,
        body: message,
        data: data,
        priority: 'high',
      }]);
    }
  } catch (error) {
    console.error('Error sending push notification:', error);
  }
};

const createNotification = async (userId, title, message, type = 'info', data = {}) => {
  try {
    const notification = await prisma.notifications.create({
      data: {
        user_id: parseInt(userId),
        title,
        message,
        type,
        is_read: false
      }
    });

    // Send push notification automatically
    await sendPushNotification(userId, title, message, { type, ...data });

    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    throw error;
  }
};

const getUserNotifications = async (userId) => {
  try {
    const notifications = await prisma.notifications.findMany({
      where: {
        user_id: parseInt(userId)
      },
      orderBy: {
        created_at: 'desc'
      }
    });
    return notifications;
  } catch (error) {
    console.error('Error fetching user notifications:', error);
    throw error;
  }
};

const markNotificationAsRead = async (notificationId) => {
  try {
    const notification = await prisma.notifications.update({
      where: {
        id: parseInt(notificationId)
      },
      data: {
        is_read: true
      }
    });
    return notification;
  } catch (error) {
    console.error('Error marking notification as read:', error);
    throw error;
  }
};

const markAllAsRead = async (userId) => {
  try {
    const result = await prisma.notifications.updateMany({
      where: {
        user_id: parseInt(userId),
        is_read: false
      },
      data: {
        is_read: true
      }
    });
    return result;
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    throw error;
  }
};
const deleteNotification = async (id) => {
  try {
    await prisma.notifications.delete({
      where: {
        id: parseInt(id)
      }
    });
    return { success: true };
  } catch (error) {
    console.error('Error deleting notification:', error);
    throw error;
  }
};

const getUnreadCount = async (userId) => {
  try {
    const count = await prisma.notifications.count({
      where: {
        user_id: parseInt(userId),
        is_read: false
      }
    });
    return count;
  } catch (error) {
    console.error('Error getting unread count:', error);
    throw error;
  }
};

const { Expo } = require('expo-server-sdk');
let expo = new Expo();

const notifyContentGenerationStatus = async (userId, status, subjectName, data = {}) => {
  let title = '';
  let message = '';
  let type = 'info';

  switch (status) {
    case 'started':
      title = 'Curriculum Generation Started';
      message = `We've started building your ${subjectName} curriculum. This usually takes 2-3 minutes.`;
      type = 'processing';
      break;
    case 'chapters_complete':
      title = 'Chapters Ready';
      message = `Chapters for ${subjectName} are ready! Now generating detailed topics...`;
      type = 'processing';
      break;
    case 'topics_complete':
      title = 'Topics Generated';
      message = `All topics for ${subjectName} are created. Finalizing learning goals...`;
      type = 'processing';
      break;
    case 'completed':
      title = 'Subject Ready!';
      message = `${subjectName} is fully ready with ${data.chaptersCount} chapters and ${data.topicsCount} topics. Start learning now!`;
      type = 'success';
      break;
    case 'failed':
      title = 'Generation Failed';
      message = `We encountered an issue generating ${subjectName}. We'll try again automatically.`;
      type = 'error';
      break;
    default:
      return;
  }

  // Save to Database AND Send Push (handled by createNotification now)
  await createNotification(userId, title, message, type, { subjectName, status, ...data });
};

module.exports = {
  createNotification,
  getUserNotifications,
  markNotificationAsRead,
  markAllAsRead,
  deleteNotification,
  getUnreadCount,
  notifyContentGenerationStatus
};
