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

		// Dynamic board-specific subject filtering
		const boardIdParam = req.query.board_id ? parseInt(req.query.board_id) : null;
		let filteredSubjects = subjects;

		if (boardIdParam) {
			const selectedBoard = boards.find(b => b.id === boardIdParam);
			if (selectedBoard) {
				const code = selectedBoard.code?.toUpperCase() || '';
				const name = selectedBoard.name?.toLowerCase() || '';

				if (code === 'KA_STATE' || name.includes('karnataka')) {
					const allowed = ['Mathematics', 'Science', 'Social Studies', 'Kannada', 'English', 'Hindi', 'Computer Science', 'Environmental Studies', 'Art & Craft'];
					filteredSubjects = subjects.filter(s => allowed.includes(s.name));
				} else if (code === 'MH_STATE' || name.includes('maharashtra')) {
					const allowed = ['Mathematics', 'Science', 'Social Studies', 'Marathi', 'English', 'Hindi', 'Computer Science', 'Environmental Studies', 'Art & Craft'];
					filteredSubjects = subjects.filter(s => allowed.includes(s.name));
				} else if (code === 'CBSE' || name.includes('cbse') || name.includes('central board')) {
					const allowed = ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Sanskrit', 'Computer Science', 'Environmental Studies', 'Art & Craft'];
					filteredSubjects = subjects.filter(s => allowed.includes(s.name));
				} else if (code === 'ICSE' || name.includes('icse') || name.includes('indian certificate')) {
					const allowed = ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science', 'Environmental Studies', 'Art & Craft'];
					filteredSubjects = subjects.filter(s => allowed.includes(s.name));
				}
			}
		}

		return res.status(200).json({
			// Return only grade names as an array of strings.
			grades: grades.map(grade => grade.name),
			boards: boards.map(board => ({
				id: board.id,
				code: board.code,
				name: board.name,
				description: board.description
			})),
			subjects: filteredSubjects.map(subject => ({
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

