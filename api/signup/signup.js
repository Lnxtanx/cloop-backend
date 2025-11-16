const express = require('express')
const bcrypt = require('bcryptjs')
const CurriculumAutoTrigger = require('../../services/curriculum-auto-trigger')

const router = express.Router()

const prisma = require('../../lib/prisma')

// POST /api/signup/
// body: { name, email, phone?, grade_level?, board?, subjects?, preferred_language?, study_goal? }
// Now stores references to database table IDs and creates user_subjects entries
router.post('/', async (req, res) => {
	const { name, email, phone, grade_level, board, subjects, preferred_language, study_goal } = req.body
	if (!name || !email) {
		return res.status(400).json({ error: 'name and email are required' })
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
			const boardRecord = await prisma.boards.findUnique({ 
				where: { id: parseInt(board) }
			});
			if (!boardRecord) {
				return res.status(400).json({ error: 'Invalid board ID' });
			}
			boardName = boardRecord.name;
		}
		
		if (preferred_language) {
			const languageRecord = await prisma.languages.findUnique({ 
				where: { id: parseInt(preferred_language) }
			});
			if (!languageRecord) {
				return res.status(400).json({ error: 'Invalid language ID' });
			}
			languageName = languageRecord.name;
		}

		// Create the user
		const user = await prisma.users.create({
			data: {
			name,
			email,
			phone,
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
		if (subjects && subjects.length > 0) {
			const userSubjectsData = subjects.map(subjectId => ({
				user_id: user.user_id,
				subject_id: parseInt(subjectId)
			}))
			
			await prisma.user_subjects.createMany({
				data: userSubjectsData,
				skipDuplicates: true
			})

			// Get subject codes for the users.subjects array
			const subjectRecords = await prisma.subjects.findMany({
				where: {
					id: { in: subjects.map(id => parseInt(id)) }
				},
				select: { code: true }
			});
			subjectCodes = subjectRecords.map(s => s.code).filter(Boolean);

			// Update user with subject codes
			if (subjectCodes.length > 0) {
				await prisma.users.update({
					where: { user_id: user.user_id },
					data: { subjects: subjectCodes }
				});
			}
		}

		// End subjects block

		// Auto-trigger curriculum generation setup for new user
		// Call this regardless of whether subjects were provided in the request.
		// The trigger function itself will validate the user's profile and
		// skip creating statuses if grade/board/subjects are missing.
		try {
			await CurriculumAutoTrigger.handleUserSignup(user.user_id);
			console.log(`✓ Content generation setup completed for user ${user.user_id}`);
		} catch (error) {
			console.error('Auto-trigger curriculum generation setup after signup failed:', error);
			// Don't fail signup if content generation setup fails
		}

		return res.status(201).json({ user })

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

