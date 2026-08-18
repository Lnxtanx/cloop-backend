const express = require('express')
const router = express.Router()
const { authenticateToken } = require('../../middleware/auth')

const prisma = require('../../lib/prisma')

// GET /api/chapters/:subjectId
// Fetch all global chapters for a specific subject and calculate user progress
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
		const parsedSubjectId = parseInt(subjectId)

		// Check enrollment or global subject existence
		let subjectInfo = null
		const enrollment = await prisma.user_subject_enrollment.findFirst({
			where: {
				user_id: user_id,
				subject_id: parsedSubjectId
			},
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

		if (enrollment) {
			subjectInfo = enrollment.subject
		} else {
			// Check if global subject exists directly
			const globalSubject = await prisma.global_subjects.findUnique({
				where: { id: parsedSubjectId },
				select: {
					id: true,
					name: true,
					code: true,
					category: true
				}
			})

			if (!globalSubject) {
				return res.status(404).json({ error: 'Subject not found' })
			}

			subjectInfo = globalSubject

			// Auto-enroll user if not yet enrolled
			await prisma.user_subject_enrollment.upsert({
				where: {
					user_id_subject_id: {
						user_id: user_id,
						subject_id: parsedSubjectId
					}
				},
				update: {},
				create: {
					user_id: user_id,
					subject_id: parsedSubjectId
				}
			}).catch(() => {})
		}

		// Fetch global chapters and user's topic progress
		const chapters = await prisma.global_chapters.findMany({
			where: {
				subject_id: parsedSubjectId
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
				topics: {
					select: {
						id: true,
						user_progress: {
							where: { user_id: user_id },
							select: {
								is_completed: true,
								completion_percent: true
							}
						}
					}
				}
			}
		})

		// Calculate progress dynamically
		const chaptersWithProgress = chapters.map(chapter => {
			const topics = chapter.topics || []
			const total_topics = topics.length
			let completed_topics = 0
			let sumPercent = 0

			for (const t of topics) {
				const prog = t.user_progress?.[0]
				if (prog?.is_completed) {
					completed_topics++
				}
				sumPercent += Number(prog?.completion_percent || 0)
			}

			let completion_percent = 0
			if (total_topics > 0) {
				completion_percent = Number((sumPercent / total_topics).toFixed(2))
			}

			return {
				id: chapter.id,
				title: chapter.title,
				content: chapter.content,
				created_at: chapter.created_at,
				total_topics,
				completed_topics,
				completion_percent,
				subject_id: chapter.subject_id,
				user_id: user_id
			}
		})

		return res.status(200).json({
			subject: subjectInfo,
			chapters: chaptersWithProgress
		})
	} catch (err) {
		console.error('Error fetching chapters:', err)
		return res.status(500).json({ error: 'Server error while fetching chapters' })
	}
})

module.exports = router


