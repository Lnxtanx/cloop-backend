const express = require('express')
const router = express.Router()
const { authenticateToken } = require('../../middleware/auth')

const prisma = require('../../lib/prisma')

// GET /api/topics/search
// Search global topics with filters and user progress
router.get('/search', authenticateToken, async (req, res) => {
	let user_id = parseInt(req.user?.user_id)
	const { q, subjectId, chapterId, status, limit } = req.query

	if (!user_id) {
		return res.status(401).json({ error: 'Authentication required' })
	}

	try {
		const whereClause = {}

		// Text search
		if (q && q.trim().length > 0) {
			whereClause.OR = [
				{ title: { contains: q.trim(), mode: 'insensitive' } },
				{ content: { contains: q.trim(), mode: 'insensitive' } }
			]
		}

		// Filters
		if (subjectId && !isNaN(parseInt(subjectId))) {
			whereClause.subject_id = parseInt(subjectId)
		}

		if (chapterId && !isNaN(parseInt(chapterId))) {
			whereClause.chapter_id = parseInt(chapterId)
		}

		const resultLimit = limit ? parseInt(limit) : 5

		const topics = await prisma.global_topics.findMany({
			where: whereClause,
			take: resultLimit,
			orderBy: { id: 'desc' },
			include: {
				chapter: {
					select: { title: true }
				},
				user_progress: {
					where: { user_id: user_id },
					select: {
						is_completed: true,
						completion_percent: true,
						time_spent_seconds: true
					}
				}
			}
		})

		const formattedTopics = topics.map(t => {
			const progress = t.user_progress?.[0] || {}
			return {
				id: t.id,
				title: t.title,
				content: t.content,
				subject_id: t.subject_id,
				chapter_id: t.chapter_id,
				order: t.order,
				is_completed: progress.is_completed || false,
				completion_percent: progress.completion_percent || 0,
				time_spent_seconds: progress.time_spent_seconds || 0,
				chapters: { title: t.chapter?.title }
			}
		})

		// Apply status filtering in-memory if needed
		let filtered = formattedTopics
		if (status) {
			if (status === 'completed') {
				filtered = formattedTopics.filter(t => t.is_completed)
			} else if (status === 'in_progress') {
				filtered = formattedTopics.filter(t => !t.is_completed && Number(t.completion_percent) > 0)
			} else if (status === 'not_started') {
				filtered = formattedTopics.filter(t => !t.is_completed && Number(t.completion_percent) === 0)
			}
		}

		return res.json(filtered)
	} catch (err) {
		console.error('Error searching topics:', err)
		return res.status(500).json({ error: 'Search failed' })
	}
})

// GET /api/topics/:chapterId
// Fetch all topics for a specific chapter with user progress
router.get('/:chapterId', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id
	const { chapterId } = req.params

	if (!user_id) {
		return res.status(401).json({ error: 'Authentication required - please login' })
	}

	if (!chapterId || isNaN(parseInt(chapterId))) {
		return res.status(400).json({ error: 'Valid chapter ID is required' })
	}

	try {
		const parsedChapterId = parseInt(chapterId)

		// Fetch the global chapter
		const chapter = await prisma.global_chapters.findUnique({
			where: { id: parsedChapterId },
			include: {
				subject: {
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
			return res.status(404).json({ error: 'Chapter not found' })
		}

		// Fetch all global topics for this chapter with user progress
		const topics = await prisma.global_topics.findMany({
			where: {
				chapter_id: parsedChapterId
			},
			orderBy: [
				{ order: 'asc' },
				{ id: 'asc' }
			],
			select: {
				id: true,
				title: true,
				content: true,
				order: true,
				created_at: true,
				subject_id: true,
				chapter_id: true,
				user_progress: {
					where: { user_id: user_id },
					select: {
						is_completed: true,
						completion_percent: true,
						time_spent_seconds: true
					}
				}
			}
		})

		let completed_topics = 0
		let sumPercent = 0

		const topicsWithProgress = topics.map(topic => {
			const progress = topic.user_progress?.[0] || {}
			const is_completed = progress.is_completed || false
			const completion_percent = progress.completion_percent ? Number(progress.completion_percent) : 0
			const time_spent_seconds = progress.time_spent_seconds || 0

			if (is_completed) completed_topics++
			sumPercent += completion_percent

			return {
				id: topic.id,
				title: topic.title,
				content: topic.content,
				created_at: topic.created_at,
				is_completed,
				completion_percent,
				subject_id: topic.subject_id,
				chapter_id: topic.chapter_id,
				user_id: user_id,
				time_spent_seconds
			}
		})

		const total_topics = topics.length
		const chapter_completion_percent = total_topics > 0 ? Number((sumPercent / total_topics).toFixed(2)) : 0

		return res.status(200).json({
			chapter: {
				id: chapter.id,
				title: chapter.title,
				content: chapter.content,
				created_at: chapter.created_at,
				total_topics,
				completed_topics,
				completion_percent: chapter_completion_percent,
				subject: chapter.subject
			},
			topics: topicsWithProgress
		})
	} catch (err) {
		console.error('Error fetching topics:', err)
		return res.status(500).json({ error: 'Server error while fetching topics' })
	}
})

module.exports = router


