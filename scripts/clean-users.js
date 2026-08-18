/**
 * Clean All Users and Associated User Data
 * 
 * Safely removes all user accounts and their associated progress, chats, and logs:
 * - users
 * - user_subject_enrollment
 * - user_chapter_progress
 * - user_topic_progress
 * - admin_chat, chat_process, chat_goal_progress
 * - learning_turns
 * - normal_user_chat, normal_chat_sessions
 * - notifications, feedback
 * - practice_tests, practice_test_chapters, practice_questions
 * - saved_topics, user_topic_reports, study_sessions
 * - user_english_progress
 * - ai_token_logs, ai_user_daily_token_usage, web_search_logs
 * 
 * PRESERVED (Untouched Content Catalogs):
 * - global_subjects, global_chapters, global_topics, global_topic_goals
 * - english_subjects, english_chapters, english_topics, english_topic_goals
 * - standard_exams, standard_subjects, standard_chapters
 * - boards, languages, grade_levels
 * 
 * Usage:
 *   node scripts/clean-users.js
 */

require('dotenv').config();
const { Client } = require('pg');

async function cleanUsers() {
	const client = new Client({
		connectionString: process.env.DATABASE_URL
	});

	try {
		await client.connect();
		console.log('\n======================================================');
		console.log('Connected to PostgreSQL database.');
		console.log('Wiping all users and user-specific test data...');
		console.log('======================================================\n');

		// Truncate users table with CASCADE to automatically wipe all dependent user data
		await client.query(`
			TRUNCATE TABLE 
				users,
				admin_chat,
				chat_process,
				chat_goal_progress,
				learning_turns,
				normal_user_chat,
				normal_chat_sessions,
				notifications,
				feedback,
				practice_tests,
				practice_test_chapters,
				saved_topics,
				user_topic_reports,
				study_sessions,
				user_subject_enrollment,
				user_chapter_progress,
				user_topic_progress,
				user_english_progress,
				ai_token_logs,
				ai_user_daily_token_usage,
				web_search_logs
			CASCADE;
		`);

		console.log('✅ Successfully deleted all users and user test records.');
		console.log('🔒 Curriculum catalogs (Global, English, Standard, Boards) preserved intact.\n');
	} catch (err) {
		console.error('❌ Error during cleanup:', err.message);
	} finally {
		await client.end();
	}
}

cleanUsers();
