const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const prisma = require('../../lib/prisma');
const { JWT_SECRET } = require('../../middleware/auth');

// Master showcase account containing the completed 61-turn tutor conversation
const DEMO_MASTER_EMAIL = 'GUEST-52233';

/**
 * POST /api/demo/session
 * 
 * By default, serves the master demo showcase session from GUEST-52233,
 * providing the full conversation history, concept animation, feedback cards,
 * definitions, formulas, and completed session summary.
 * 
 * If { fresh: true } is sent, creates a new isolated guest account for fresh chatting.
 */
router.post('/session', async (req, res) => {
	try {
		const isFreshRequested = Boolean(req.body?.fresh);

		// 1. Unless explicit fresh reset is requested, serve the master showcase account GUEST-52233
		if (!isFreshRequested) {
			try {
				const masterUser = await prisma.users.findFirst({
					where: { email: { equals: DEMO_MASTER_EMAIL, mode: 'insensitive' } },
					select: {
						user_id: true,
						name: true,
						email: true,
						created_at: true,
					}
				});

				if (masterUser) {
					console.log(`[Demo] Serving showcase chat from master account ${masterUser.email} (User ID ${masterUser.user_id})`);

					const tokenPayload = {
						user_id: masterUser.user_id,
						email: masterUser.email,
						name: masterUser.name,
						is_demo: true,
					};
					const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '30d' });

					return res.status(200).json({
						success: true,
						token,
						user: {
							id: String(masterUser.user_id),
							user_id: masterUser.user_id,
							name: masterUser.name,
							email: masterUser.email,
							is_demo: true,
						},
						guestId: masterUser.email,
						demoTopic: {
							topicId: 3474,
							topicTitle: 'Concept 1: What Is a Force: Push and Pull',
							chapterTitle: 'Chapter 5: Exploring Forces',
							subjectName: 'Science',
						}
					});
				} else {
					console.warn(`[Demo] Master account ${DEMO_MASTER_EMAIL} not found, provisioning fresh demo session.`);
				}
			} catch (findErr) {
				console.error(`[Demo] Error querying master account ${DEMO_MASTER_EMAIL}:`, findErr.message);
			}
		}

		// 2. Fresh session creation (or fallback)
		const randomSuffix = Math.floor(100000 + Math.random() * 900000);
		const guestId = `DEMO-${randomSuffix}`;
		const studentName = req.body?.name || `Demo Guest ${randomSuffix.toString().slice(-4)}`;

		console.log(`[Demo] Creating fresh isolated demo session for ${guestId}...`);

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
	res.status(200).json({
		status: 'ok',
		service: 'demo-launcher',
		targetTopicId: 3474,
		masterAccount: DEMO_MASTER_EMAIL
	});
});

module.exports = router;
