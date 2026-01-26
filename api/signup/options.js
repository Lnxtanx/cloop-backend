const express = require('express')
const router = express.Router()

const prisma = require('../../lib/prisma')

// GET /api/signup/options
// Returns all the options needed for signup form: grades, boards, subjects, languages
router.get('/', async (req, res) => {
	try {
		// Fetch all options in parallel (use models defined in schema.prisma)
		const [grades, boards, subjects, languages] = await Promise.all([
			prisma.grade_levels.findMany({}), // Fetch all grades without DB sort, we will sort in JS
			prisma.boards.findMany({
				orderBy: { name: 'asc' }
			}),
			prisma.subjects.findMany({
				orderBy: { name: 'asc' }
			}),
			prisma.languages.findMany({
				orderBy: { name: 'asc' }
			})
		])

		// Custom sort for grades (e.g. "Grade 10" should come after "Grade 9", not "Grade 1")
		grades.sort((a, b) => {
			const getNum = (str) => {
				const match = str.match(/\d+/);
				return match ? parseInt(match[0], 10) : 0;
			};
			const numA = getNum(a.name);
			const numB = getNum(b.name);

			if (numA !== numB) return numA - numB;
			return a.name.localeCompare(b.name);
		});

		return res.status(200).json({
			// Return only grade names as an array of strings. Frontend expects only the name now.
			grades: grades.map(grade => grade.name),
			boards: boards.map(board => ({
				id: board.id,
				code: board.code,
				name: board.name,
				description: board.description
			})),
			subjects: subjects.map(subject => ({
				id: subject.id,
				code: subject.code,
				name: subject.name,
				category: subject.category
			})),
			languages: languages.map(language => ({
				id: language.id,
				code: language.code,
				name: language.name,
				native_name: language.native_name,
				is_active: !!language.is_active
			}))
		})
	} catch (err) {
		console.error('Error fetching signup options:', err)
		return res.status(500).json({ error: 'Server error while fetching signup options' })
	}
})

module.exports = router

