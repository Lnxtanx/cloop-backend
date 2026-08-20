/**
 * Migrate Board Column Length to VARCHAR(100)
 * 
 * Usage:
 *   node scripts/migrate-board-column.js
 */

require('dotenv').config();
const { Client } = require('pg');

async function migrate() {
	console.log('\n======================================================');
	console.log('🔄 Migrating board column to VARCHAR(100)...');
	console.log('======================================================\n');

	const client = new Client({
		connectionString: process.env.DATABASE_URL
	});

	try {
		await client.connect();

		await client.query(`
			ALTER TABLE global_subjects ALTER COLUMN board TYPE VARCHAR(100);
			ALTER TABLE global_curriculum_status ALTER COLUMN board TYPE VARCHAR(100);
		`);

		console.log('✅ Successfully expanded board column to VARCHAR(100) on both tables!\n');
		console.log('======================================================\n');
	} catch (err) {
		console.error('❌ Migration failed:', err.message);
	} finally {
		await client.end();
	}
}

migrate();
