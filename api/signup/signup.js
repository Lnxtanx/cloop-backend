const express = require('express')
const bcrypt = require('bcryptjs')
const CurriculumAutoTrigger = require('../../services/curriculum-auto-trigger')

const router = express.Router()

const prisma = require('../../lib/prisma')

// POST /api/signup/
// body: { name, guestId?, grade_level?, board?, subjects?, preferred_language?, study_goal? }
// For demo: Guest ID is auto-generated if not provided, email/phone not required
router.post('/', async (req, res) => {
	const { name, guestId, grade_level, board, subjects, preferred_language, study_goal } = req.body
	
	// Generate Guest ID if not provided
	const finalGuestId = guestId || `GUEST-${Math.floor(10000 + Math.random() * 90000)}`;
	
	if (!name) {
		return res.status(400).json({ error: 'name is required' })
	}

	try {
		// Look up the actual database records to get their names/codes
		let boardName = null
		let languageName = null
		// Validate grade level exists before creating user
		let gradeRecord = null;
		if (grade_level) {
			// grade_level is expected to be the grade name now (e.g., "Grade 6")
			// Use findFirst because `name` is not necessarily a unique field in the schema.
			gradeRecord = await prisma.grade_levels.findFirst({ 
				where: { name: grade_level }
			});
			if (!gradeRecord) {
				return res.status(400).json({ error: 'Invalid grade level' });
			}
		}
		
		if (board) {
			const parsedBoardId = parseInt(board);
			if (!isNaN(parsedBoardId)) {
				const boardRecord = await prisma.boards.findUnique({ 
					where: { id: parsedBoardId }
				});
				if (boardRecord) {
					boardName = boardRecord.name;
				}
			} else {
				boardName = board;
			}
		}
		
		if (preferred_language) {
			const parsedLangId = parseInt(preferred_language);
			if (!isNaN(parsedLangId)) {
				// Numeric ID — look up by id
				const languageRecord = await prisma.languages.findUnique({ 
					where: { id: parsedLangId }
				});
				if (languageRecord) {
					languageName = languageRecord.name;
				}
			} else {
				// String name (e.g. "English") — use directly
				languageName = preferred_language;
			}
		}

		// Create the user (store Guest ID in email field)
		const user = await prisma.users.create({
			data: {
			name,
			email: finalGuestId, // Store Guest ID in email field
			phone: null, // No phone required for demo
			// Store the grade name as the user's grade_level (per frontend change)
			grade_level: gradeRecord ? gradeRecord.name : null,
			board: boardName,
			subjects: [], // Keep empty array since we'll use user_subjects table
			preferred_language: languageName,
			study_goal,
			},
			select: {
				user_id: true,
				name: true,
				email: true,
				created_at: true,
				num_chats: true,
				num_lessons: true,
			}
		})

		// Create user_subjects entries if subjects were selected
		let subjectCodes = [];
		if (subjects && Array.isArray(subjects) && subjects.length > 0) {
			const validNumericSubjectIds = subjects
				.map(id => parseInt(id))
				.filter(id => !isNaN(id));

			if (validNumericSubjectIds.length > 0) {
				const userSubjectsData = validNumericSubjectIds.map(subjectId => ({
					user_id: user.user_id,
					subject_id: subjectId
				}));
				
				await prisma.user_subjects.createMany({
					data: userSubjectsData,
					skipDuplicates: true
				});

				// Get subject codes for the users.subjects array
				const subjectRecords = await prisma.subjects.findMany({
					where: {
						id: { in: validNumericSubjectIds }
					},
					select: { code: true }
				});
				subjectCodes = subjectRecords.map(s => s.code).filter(Boolean);
			} else {
				// Non-numeric subject names passed directly, e.g. ["English"]
				subjectCodes = subjects.filter(s => typeof s === 'string' && isNaN(parseInt(s)));
			}

			// Update user with subject codes
			if (subjectCodes.length > 0) {
				await prisma.users.update({
					where: { user_id: user.user_id },
					data: { subjects: subjectCodes }
				});
			}
		}

		// End subjects block

		// Auto-trigger curriculum generation setup for new user unless skipped (e.g. for English app)
		if (!req.body.skipCurriculumGeneration && !req.body.isEnglishApp) {
			try {
				await CurriculumAutoTrigger.handleUserSignup(user.user_id);
				console.log(`✓ Content generation setup completed for user ${user.user_id}`);
			} catch (error) {
				console.error('Auto-trigger curriculum generation setup after signup failed:', error);
				// Don't fail signup if content generation setup fails
			}
		} else {
			console.log(`ℹ Curriculum generation skipped for user ${user.user_id} (English App/Custom focus)`);
		}

		return res.status(201).json({ 
			user,
			guestId: finalGuestId, // Return the Guest ID to frontend
		})

	} catch (err) {
		// handle unique email error from Prisma
		if (err && err.code === 'P2002') {
			return res.status(409).json({ error: 'Email already in use' })
		}
		console.error(err)
		return res.status(500).json({ error: 'Server error' })
	}
})

module.exports = router

