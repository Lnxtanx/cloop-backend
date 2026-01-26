const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const notificationService = require('../../services/notifications');

// Get all notifications for the user
router.get('/', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.user_id;
        const notifications = await notificationService.getUserNotifications(userId);
        res.json(notifications);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

// Mark a notification as read
router.post('/:id/read', authenticateToken, async (req, res) => {
    try {
        const notificationId = req.params.id;
        await notificationService.markNotificationAsRead(notificationId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to mark notification as read' });
    }
});

// Get unread count
router.get('/unread-count', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.user_id;
        const count = await notificationService.getUnreadCount(userId);
        res.json({ count });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch unread count' });
    }
});

// Delete a notification
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const notificationId = req.params.id;
        await notificationService.deleteNotification(notificationId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete notification' });
    }
});

// Mark all notifications as read
router.post('/read-all', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.user_id;
        await notificationService.markAllAsRead(userId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to mark all notifications as read' });
    }
});

module.exports = router;
