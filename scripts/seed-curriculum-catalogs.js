/**
 * Seed Curriculum Catalogs: Boards, Subjects, and Grades (Class 5 to 10)
 * 
 * Usage:
 *   node scripts/seed-curriculum-catalogs.js
 */

require('dotenv').config();
const { Client } = require('pg');

async function seedCurriculumCatalogs() {
	const client = new Client({
		connectionString: process.env.DATABASE_URL
	});

	try {
		await client.connect();
		console.log('\n======================================================');
		console.log('Connected to PostgreSQL database.');
		console.log('Seeding Boards, Subjects, and Grade Levels (Class 5 to 10)...');
		console.log('======================================================\n');

		// 1. Seed Grade Levels (Class 5 to Class 10)
		console.log('📚 Seeding Grade Levels (Class 5 to Class 10)...');
		const grades = [
			'Class 5',
			'Class 6',
			'Class 7',
			'Class 8',
			'Class 9',
			'Class 10'
		];

		for (const gradeName of grades) {
			const res = await client.query('SELECT id FROM grade_levels WHERE name = $1', [gradeName]);
			if (res.rows.length === 0) {
				await client.query('INSERT INTO grade_levels (name) VALUES ($1)', [gradeName]);
				console.log(`   ✓ Added grade: ${gradeName}`);
			} else {
				console.log(`   - Grade exists: ${gradeName}`);
			}
		}

		// 2. Seed Boards (National, State, and International)
		console.log('\n🏫 Seeding Boards...');
		const boards = [
			{
				code: 'CBSE',
				name: 'Central Board of Secondary Education (CBSE)',
				country: 'India',
				description: 'National education board under the Government of India'
			},
			{
				code: 'ICSE',
				name: 'Indian Certificate of Secondary Education (ICSE)',
				country: 'India',
				description: 'Council for the Indian School Certificate Examinations board'
			},
			{
				code: 'KA_STATE',
				name: 'Karnataka State Board (KSEAB)',
				country: 'India',
				description: 'Karnataka School Examination and Assessment Board'
			},
			{
				code: 'MH_STATE',
				name: 'Maharashtra State Board (MSBSHSE)',
				country: 'India',
				description: 'Maharashtra State Board of Secondary and Higher Secondary Education'
			},
			{
				code: 'STATE',
				name: 'Other State Board',
				country: 'India',
				description: 'Education board administered by individual states in India'
			},
			{
				code: 'IB',
				name: 'International Baccalaureate (IB)',
				country: 'Global',
				description: 'Internationally recognized education board based in Geneva, Switzerland'
			},
			{
				code: 'IGCSE',
				name: 'Cambridge Assessment (IGCSE)',
				country: 'Global',
				description: 'International curriculum offered by Cambridge Assessment'
			}
		];

		for (const board of boards) {
			const res = await client.query('SELECT id FROM boards WHERE code = $1', [board.code]);
			if (res.rows.length === 0) {
				await client.query(
					'INSERT INTO boards (code, name, country, description, created_at) VALUES ($1, $2, $3, $4, NOW())',
					[board.code, board.name, board.country, board.description]
				);
				console.log(`   ✓ Added board: ${board.name} (${board.code})`);
			} else {
				await client.query(
					'UPDATE boards SET name = $1, description = $2 WHERE code = $3',
					[board.name, board.description, board.code]
				);
				console.log(`   ✓ Updated board: ${board.name} (${board.code})`);
			}
		}

		// 3. Seed Subjects (Core and Regional Languages)
		console.log('\n📖 Seeding Subjects...');
		const subjects = [
			{ code: 'MATH', name: 'Mathematics', category: 'Academic' },
			{ code: 'SCI', name: 'Science', category: 'Academic' },
			{ code: 'SOC', name: 'Social Studies', category: 'Academic' },
			{ code: 'ENG', name: 'English', category: 'Language' },
			{ code: 'HIN', name: 'Hindi', category: 'Language' },
			{ code: 'KAN', name: 'Kannada', category: 'Language' },
			{ code: 'MAR', name: 'Marathi', category: 'Language' },
			{ code: 'SAN', name: 'Sanskrit', category: 'Language' },
			{ code: 'TAM', name: 'Tamil', category: 'Language' },
			{ code: 'TEL', name: 'Telugu', category: 'Language' },
			{ code: 'CMP', name: 'Computer Science', category: 'Technology' },
			{ code: 'EVS', name: 'Environmental Studies', category: 'Academic' },
			{ code: 'ART', name: 'Art & Craft', category: 'Creative' }
		];

		for (const sub of subjects) {
			const res = await client.query('SELECT id FROM subjects WHERE code = $1', [sub.code]);
			if (res.rows.length === 0) {
				await client.query(
					'INSERT INTO subjects (code, name, category) VALUES ($1, $2, $3)',
					[sub.code, sub.name, sub.category]
				);
				console.log(`   ✓ Added subject: ${sub.name} (${sub.code})`);
			} else {
				await client.query(
					'UPDATE subjects SET name = $1, category = $2 WHERE code = $3',
					[sub.name, sub.category, sub.code]
				);
				console.log(`   - Subject exists/updated: ${sub.name} (${sub.code})`);
			}
		}

		console.log('\n✅ Successfully seeded all curriculum catalogs (Boards, Subjects, Grades 5-10)!\n');
	} catch (err) {
		console.error('❌ Error seeding curriculum catalogs:', err.message);
	} finally {
		await client.end();
	}
}

seedCurriculumCatalogs();
