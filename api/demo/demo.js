const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const prisma = require('../../lib/prisma');
const { JWT_SECRET } = require('../../middleware/auth');

/**
 * POST /api/demo/session
 * 
 * Auto-creates a unique, independent demo learner account with zero friction.
 * Returns a JWT token and pre-configured metadata for the demo showcase:
 * Topic 3474 ("Concept 1: What Is a Force: Push and Pull", Class 8 Science).
 */
router.post('/session', async (req, res) => {
	try {
		// Generate an isolated, random demo guest ID
		const randomSuffix = Math.floor(100000 + Math.random() * 900000);
		const guestId = `DEMO-${randomSuffix}`;
		const studentName = req.body?.name || `Demo Guest ${randomSuffix.toString().slice(-4)}`;

		console.log(`[Demo] Creating fresh demo session for ${guestId}...`);

		// Create user record in Postgres with Grade 8 Science pre-assigned
		const user = await prisma.users.create({
			data: {
				name: studentName,
				email: guestId, // Guest ID is stored in email field across Cloop
				phone: null,
				grade_level: 'Grade 8',
				board: 'CBSE',
				subjects: ['Science'],
				preferred_language: 'English',
				study_goal: 'Explore Force and Motion',
			},
			select: {
				user_id: true,
				name: true,
				email: true,
				created_at: true,
			}
		});

		// Enroll user in global Science subject if available (non-blocking)
		try {
			const scienceSubject = await prisma.global_subjects.findFirst({
				where: {
					OR: [
						{ name: { equals: 'Science', mode: 'insensitive' } },
						{ code: { equals: 'SCI', mode: 'insensitive' } }
					]
				}
			});

			if (scienceSubject) {
				await prisma.user_subject_enrollment.create({
					data: {
						user_id: user.user_id,
						subject_id: scienceSubject.id
					}
				}).catch(() => {});
			}
		} catch (enrollErr) {
			console.warn('[Demo] Subject enrollment skipped:', enrollErr.message);
		}

		// Generate standard JWT token valid for 7 days
		const tokenPayload = {
			user_id: user.user_id,
			email: user.email,
			name: user.name,
			is_demo: true,
		};
		const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

		console.log(`[Demo] Fresh session created successfully: User ID ${user.user_id} (${guestId})`);

		return res.status(201).json({
			success: true,
			token,
			user: {
				id: String(user.user_id),
				user_id: user.user_id,
				name: user.name,
				email: user.email,
				is_demo: true,
			},
			guestId,
			demoTopic: {
				topicId: 3474,
				topicTitle: 'Concept 1: What Is a Force: Push and Pull',
				chapterTitle: 'Chapter 5: Exploring Forces',
				subjectName: 'Science',
			}
		});
	} catch (error) {
		console.error('[Demo] Error creating demo session:', error);
		return res.status(500).json({
			error: 'Failed to initialize demo session. Please try again.',
			details: error.message
		});
	}
});

/**
 * GET /api/demo/health
 * Quick endpoint to verify demo service status
 */
router.get('/health', (req, res) => {
	res.status(200).json({ status: 'ok', service: 'demo-launcher', targetTopicId: 3474 });
});

module.exports = router;
