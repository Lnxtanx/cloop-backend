const express = require('express')
const router = express.Router()
const prisma = require('../../lib/prisma')
const { authenticateToken } = require('../../middleware/auth')

// POST /api/profile/push-token
router.post('/push-token', authenticateToken, async (req, res) => {
    try {
        const { expoPushToken } = req.body
        const userId = req.user.user_id

        if (!expoPushToken) {
            return res.status(400).json({ error: 'Push token is required' })
        }

        // Update user with push token
        const updatedUser = await prisma.users.update({
            where: { user_id: userId },
            data: { expo_push_token: expoPushToken },
            select: {
                user_id: true,
                email: true,
                expo_push_token: true
            }
        })

        console.log(`✅ Push token updated for user ${userId}:`, expoPushToken)

        res.json({
            message: 'Push token saved successfully',
            user: updatedUser
        })
    } catch (error) {
        console.error('❌ Error saving push token:', error)
        res.status(500).json({ error: 'Failed to save push token' })
    }
})

module.exports = router
