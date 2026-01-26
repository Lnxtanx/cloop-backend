const prisma = require('../lib/prisma');

const createNotification = async (userId, title, message, type = 'info') => {
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

  // 1. Save to Database
  await createNotification(userId, title, message, type);

  // 2. Send Push Notification (if user has token)
  try {
    const user = await prisma.users.findUnique({
      where: { user_id: parseInt(userId) },
      select: { push_token: true }
    });

    if (user?.push_token && Expo.isExpoPushToken(user.push_token)) {
      await expo.sendPushNotificationsAsync([{
        to: user.push_token,
        sound: 'default',
        title: title,
        body: message,
        data: { subjectName, status, ...data },
      }]);
    }
  } catch (error) {
    console.error('Error sending push notification:', error);
    // Don't fail the pipeline just because push failed
  }
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
