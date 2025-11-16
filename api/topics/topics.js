const express = require('express')
const router = express.Router()
const { authenticateToken } = require('../../middleware/auth')

const prisma = require('../../lib/prisma')

// GET /api/topics/:chapterId
// Fetch all topics for a specific chapter and user
router.get('/:chapterId', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id
	const { chapterId } = req.params

	// For production, always require authenticated user
	if (!user_id) {
		return res.status(401).json({ error: 'Authentication required - please login' })
	}

	if (!chapterId || isNaN(parseInt(chapterId))) {
		return res.status(400).json({ error: 'Valid chapter ID is required' })
	}

	try {
		// First verify that the user has access to this chapter
		const chapter = await prisma.chapters.findFirst({
			where: {
				id: parseInt(chapterId),
				user_id: user_id
			},
			include: {
				subjects: {
					select: {
						id: true,
						name: true,
						code: true,
						category: true
					}
				}
			}
		})

		if (!chapter) {
			return res.status(403).json({ error: 'Chapter not found or user does not have access' })
		}

		// Fetch topics for this chapter and user
		const topics = await prisma.topics.findMany({
			where: {
				chapter_id: parseInt(chapterId),
				user_id: user_id
			},
			orderBy: {
				created_at: 'asc'
			},
			select: {
				id: true,
				title: true,
				content: true,
				created_at: true,
				is_completed: true,
				completion_percent: true,
				subject_id: true,
				chapter_id: true,
				user_id: true,
				time_spent_seconds: true
			}
		})

		return res.status(200).json({
			chapter: {
				id: chapter.id,
				title: chapter.title,
				content: chapter.content,
				created_at: chapter.created_at,
				total_topics: chapter.total_topics,
				completed_topics: chapter.completed_topics,
				completion_percent: chapter.completion_percent,
				subject: chapter.subjects
			},
			topics: topics
		})
	} catch (err) {
		console.error('Error fetching topics:', err)
		return res.status(500).json({ error: 'Server error while fetching topics' })
	}
})

module.exports = router

