/**
 * Clean Global Curriculum Tables Script
 * 
 * Safely wipes only the global curriculum tables and user enrollments/progress:
 * - global_topic_goals
 * - global_topics
 * - global_chapters
 * - global_subjects
 * - global_curriculum_status
 * - user_subject_enrollment
 * - user_chapter_progress
 * - user_topic_progress
 * 
 * PRESERVED (Untouched):
 * - users
 * - english_* (english_subjects, english_chapters, etc.)
 * - standard_* / practice_*
 * - boards, languages, grade_levels
 * 
 * Usage:
 *   node scripts/clean-global-curriculum.js
 */

require('dotenv').config();
const { Client } = require('pg');

async function cleanGlobalCurriculum() {
	const client = new Client({
		connectionString: process.env.DATABASE_URL
	});

	try {
		await client.connect();
		console.log('\n======================================================');
		console.log('Connected to PostgreSQL database.');
		console.log('Wiping global curriculum tables & enrollments...');
		console.log('======================================================\n');

		await client.query(`
			TRUNCATE TABLE 
				global_topic_goals,
				global_topics,
				global_chapters,
				global_subjects,
				global_curriculum_status,
				user_subject_enrollment,
				user_chapter_progress,
				user_topic_progress
			CASCADE;
		`);

		console.log('✅ Successfully cleaned all global curriculum data.');
		console.log('🔒 Users and English learning modules preserved completely untouched.\n');
	} catch (err) {
		console.error('❌ Error during cleanup:', err.message);
	} finally {
		await client.end();
	}
}

cleanGlobalCurriculum();
