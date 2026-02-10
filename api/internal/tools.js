const express = require('express')
const router = express.Router()
const { executeTool } = require('../../services/ai-tools')
const jwt = require('jsonwebtoken')

// Middleware to verify internal or admin access
// For now, we reuse the standard JWT verification since the Python service passes the user's token
const verifyToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1]
    if (!token) return res.status(401).json({ error: 'No token provided' })

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET)
        req.user = decoded
        next()
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' })
    }
}

router.post('/execute', verifyToken, async (req, res) => {
    try {
        const { tool_name, args } = req.body
        const userId = req.user.user_id

        console.log(`[Internal API] Executing tool ${tool_name} for user ${userId}`)

        const result = await executeTool(userId, tool_name, args)
        res.json(result)

    } catch (error) {
        console.error('[Internal API] Tool execution error:', error)
        res.status(500).json({ error: error.message })
    }
})

module.exports = router
