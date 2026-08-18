/**
 * Clean legacy orphan progress rows before applying new global foreign keys.
 * 
 * Usage:
 *   node scripts/clean-orphan-progress.js
 */

require('dotenv').config();
const { Client } = require('pg');

async function clean() {
	const client = new Client({
		connectionString: process.env.DATABASE_URL
	});

	try {
		await client.connect();
		console.log('Connected to database.');

		console.log('Truncating orphan progress tables that reference old per-user IDs...');
		await client.query(`
			TRUNCATE TABLE 
				chat_goal_progress, 
				user_topic_reports, 
				saved_topics, 
				study_sessions, 
				learning_turns,
				user_chapter_progress,
				user_topic_progress,
				user_subject_enrollment
			CASCADE;
		`);

		console.log('✅ Successfully cleaned orphaned test progress records.');
		console.log('You can now run: npx prisma@6 db push');
	} catch (err) {
		console.error('❌ Error during cleanup:', err.message);
	} finally {
		await client.end();
	}
}

clean();
