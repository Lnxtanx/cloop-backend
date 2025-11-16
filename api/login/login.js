const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')

const router = express.Router()

const prisma = require('../../lib/prisma')

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key'

// POST /api/login/  { emailOrPhone }
// New behavior: accept an email or phone and return the user if found (no password required)
router.post('/', async (req, res) => {
	console.log('Login request received:', req.body);
	
	const { emailOrPhone } = req.body
	if (!emailOrPhone) {
		console.log('Login error: emailOrPhone required');
		return res.status(400).json({ error: 'emailOrPhone required' });
	}

	try {
		console.log('Searching for user with:', emailOrPhone);
		
		// Try to find by email first, then by phone
		const user = await prisma.users.findFirst({
			where: {
				OR: [
					{ email: emailOrPhone },
					{ phone: emailOrPhone },
				],
			},
		})

		if (!user) {
			console.log('User not found for:', emailOrPhone);
			return res.status(401).json({ error: 'User not found' });
		}

		console.log('User found:', { user_id: user.user_id, email: user.email, name: user.name });

		const payload = {
			user_id: user.user_id,
			email: user.email,
			name: user.name,
		}

		// Always generate a token since JWT_SECRET is required
		const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' })
		console.log('Login successful, token generated');
		
		return res.json({ token, user: payload })
	} catch (err) {
		console.error('Login server error:', err)
		return res.status(500).json({ error: 'Server error' })
	}
})

// --- Simple user CRUD for account management -

// GET /api/login/users/:id
router.get('/users/:id', async (req, res) => {
	const id = Number(req.params.id)
	if (!id) return res.status(400).json({ error: 'invalid id' })

	try {
		const user = await prisma.users.findUnique({
			where: { user_id: id },
			select: {
				user_id: true,
				name: true,
				email: true,
				created_at: true,
				num_chats: true,
				num_lessons: true,
				grade_level: {
					select: {
						id: true,
						code: true,
						name: true
					}
				},
				board: {
					select: {
						id: true,
						code: true,
						name: true,
						country: true
					}
				},
				preferred_language: {
					select: {
						id: true,
						code: true,
						name: true,
						native_name: true
					}
				}
			}
		})

		if (!user) return res.status(404).json({ error: 'User not found' })
		return res.json({ user })
	} catch (err) {
		console.error(err)
		return res.status(500).json({ error: 'Server error' })
	}
})

// PUT /api/login/users/:id  body: fields to update (name, grade_level, board, subjects, preferred_language, study_goal)
router.put('/users/:id', async (req, res) => {
	const id = Number(req.params.id)
	if (!id) return res.status(400).json({ error: 'invalid id' })

	const { name, grade_level_id, board_id, subjects, language_id, study_goal, phone } = req.body

	try {
		const data = {}
		if (name) data.name = name
		if (grade_level_id !== undefined) data.grade_level_id = grade_level_id
		if (board_id !== undefined) data.board_id = board_id
		if (subjects !== undefined) data.subjects = subjects
		if (language_id !== undefined) data.language_id = language_id
		if (study_goal !== undefined) data.study_goal = study_goal
		if (phone !== undefined) data.phone = phone

		const updated = await prisma.users.update({
			where: { user_id: id },
			data,
			select: {
				user_id: true,
				name: true,
				email: true,
				grade_level: true,
				board: true,
				subjects: true,
				preferred_language: true,
				study_goal: true,
				created_at: true,
				num_chats: true,
				num_lessons: true,
			}
		})

		return res.json({ user: updated })
	} catch (err) {
		console.error(err)
		return res.status(500).json({ error: 'Server error' })
	}
})

// DELETE /api/login/users/:id
router.delete('/users/:id', async (req, res) => {
	const id = Number(req.params.id)
	if (!id) return res.status(400).json({ error: 'invalid id' })

	try {
		await prisma.users.delete({ where: { user_id: id } })
		return res.json({ ok: true })
	} catch (err) {
		console.error(err)
		return res.status(500).json({ error: 'Server error' })
	}
})

module.exports = router

