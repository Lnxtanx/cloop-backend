/**
 * Clean Empty Global Subjects
 * 
 * Removes any global_subjects shells that have 0 chapters and 0 topics.
 * 
 * Usage:
 *   node scripts/clean-empty-subjects.js
 */

require('dotenv').config();
const prisma = require('../lib/prisma');

async function cleanEmptySubjects() {
	console.log('\n======================================================');
	console.log('🧹 Cleaning empty global subject shells (0 chapters)...');
	console.log('======================================================\n');

	try {
		// Find all subjects that have no chapters
		const emptySubjects = await prisma.global_subjects.findMany({
			where: {
				chapters: {
					none: {}
				}
			}
		});

		console.log(`Found ${emptySubjects.length} empty subject shells:`);
		for (const sub of emptySubjects) {
			console.log(`  - [ID: ${sub.id}] ${sub.board} | ${sub.grade} | ${sub.name}`);
		}

		if (emptySubjects.length > 0) {
			const ids = emptySubjects.map(s => s.id);
			await prisma.global_subjects.deleteMany({
				where: {
					id: { in: ids }
				}
			});
			console.log(`\n✅ Successfully deleted ${emptySubjects.length} empty subject shells.`);
		} else {
			console.log('\n✅ No empty subject shells found.');
		}

		console.log('======================================================\n');
	} catch (error) {
		console.error('❌ Error cleaning empty subjects:', error.message);
	} finally {
		await prisma.$disconnect();
	}
}

cleanEmptySubjects();
