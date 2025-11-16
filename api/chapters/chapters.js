const express = require('express')
const router = express.Router()
const { authenticateToken } = require('../../middleware/auth')

const prisma = require('../../lib/prisma')

// GET /api/chapters/:subjectId
// Fetch all chapters for a specific subject and user
router.get('/:subjectId', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id
	const { subjectId } = req.params

	// For production, always require authenticated user
	if (!user_id) {
		return res.status(401).json({ error: 'Authentication required - please login' })
	}

	if (!subjectId || isNaN(parseInt(subjectId))) {
		return res.status(400).json({ error: 'Valid subject ID is required' })
	}

	try {
		// First verify that the user has access to this subject
		const userSubject = await prisma.user_subjects.findFirst({
			where: {
				user_id: user_id,
				subject_id: parseInt(subjectId)
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

		if (!userSubject) {
			return res.status(403).json({ error: 'User does not have access to this subject' })
		}

		// Fetch chapters for this subject and user
		const chapters = await prisma.chapters.findMany({
			where: {
				subject_id: parseInt(subjectId),
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
				total_topics: true,
				completed_topics: true,
				completion_percent: true,
				subject_id: true,
				user_id: true
			}
		})

		return res.status(200).json({
			subject: userSubject.subjects,
			chapters: chapters
		})
	} catch (err) {
		console.error('Error fetching chapters:', err)
		return res.status(500).json({ error: 'Server error while fetching chapters' })
	}
})

module.exports = router

