/**
 * Audit Curriculum Database Status
 * 
 * Inspects all curriculum tables (global_subjects, global_chapters, global_topics, global_topic_goals, global_curriculum_status)
 * and displays an accurate summary of what has been generated and what is pending.
 * 
 * Usage:
 *   node scripts/audit-curriculum-status.js
 */

require('dotenv').config();
const prisma = require('../lib/prisma');

async function auditCurriculum() {
	console.log('\n================================================================================');
	console.log('📊 CLOOP GLOBAL CURRICULUM DATABASE AUDIT');
	console.log('================================================================================\n');

	try {
		// 1. Fetch all global subjects with chapters, topics, and goals counts
		const subjects = await prisma.global_subjects.findMany({
			orderBy: [
				{ board: 'asc' },
				{ grade: 'asc' },
				{ name: 'asc' }
			],
			include: {
				chapters: {
					include: {
						topics: {
							include: {
								goals: {
									select: { id: true }
								}
							}
						}
					}
				}
			}
		});

		// 2. Fetch all status records from global_curriculum_status
		const statusRecords = await prisma.global_curriculum_status.findMany({
			orderBy: [
				{ board: 'asc' },
				{ grade: 'asc' },
				{ subject_name: 'asc' }
			]
		});

		const statusMap = new Map();
		for (const st of statusRecords) {
			const key = `${st.board}::${st.grade}::${st.subject_name}`.toLowerCase();
			statusMap.set(key, st);
		}

		// 3. Group by Board & Grade
		const grouped = {};
		let totalChapters = 0;
		let totalTopics = 0;
		let totalGoals = 0;

		for (const sub of subjects) {
			const boardKey = sub.board || 'Unknown Board';
			const gradeKey = sub.grade || 'Unknown Grade';

			if (!grouped[boardKey]) grouped[boardKey] = {};
			if (!grouped[boardKey][gradeKey]) grouped[boardKey][gradeKey] = [];

			const chapterCount = sub.chapters.length;
			let topicCount = 0;
			let goalCount = 0;

			for (const chap of sub.chapters) {
				topicCount += chap.topics.length;
				for (const top of chap.topics) {
					goalCount += top.goals.length;
				}
			}

			totalChapters += chapterCount;
			totalTopics += topicCount;
			totalGoals += goalCount;

			const statusKey = `${sub.board}::${sub.grade}::${sub.name}`.toLowerCase();
			const statusObj = statusMap.get(statusKey);
			const status = statusObj ? statusObj.status : (chapterCount > 0 && topicCount > 0 ? 'completed' : 'unknown');

			grouped[boardKey][gradeKey].push({
				id: sub.id,
				name: sub.name,
				category: sub.category,
				chapters: chapterCount,
				topics: topicCount,
				goals: goalCount,
				status: status
			});
		}

		// 4. Print Report Grouped by Board and Grade
		for (const [boardName, grades] of Object.entries(grouped)) {
			console.log(`\n🏫 BOARD: ${boardName}`);
			console.log('═'.repeat(80));

			for (const [gradeName, subjectList] of Object.entries(grades)) {
				console.log(`\n  📚 ${gradeName}:`);
				console.log('  ' + '-'.repeat(76));
				console.log(`  ${'Subject Name'.padEnd(26)} | ${'Status'.padEnd(12)} | ${'Chapters'.padEnd(10)} | ${'Topics'.padEnd(8)} | ${'Goals'.padEnd(8)}`);
				console.log('  ' + '-'.repeat(76));

				for (const s of subjectList) {
					let statusIcon = '✅ COMPLETED';
					if (s.status === 'in_progress') statusIcon = '🔄 IN_PROGRESS';
					else if (s.status === 'pending') statusIcon = '⏳ PENDING';
					else if (s.status === 'failed') statusIcon = '❌ FAILED';
					else if (s.chapters === 0) statusIcon = '⚠️ NO DATA';

					console.log(
						`  ${s.name.padEnd(26)} | ${statusIcon.padEnd(12)} | ${String(s.chapters).padStart(8)}   | ${String(s.topics).padStart(6)} | ${String(s.goals).padStart(6)}`
					);
				}
			}
		}

		// 5. Grand Summary
		console.log('\n================================================================================');
		console.log('📈 GRAND TOTALS ACROSS DATABASE');
		console.log('================================================================================');
		console.log(`📚 Total Global Subjects: ${subjects.length}`);
		console.log(`📖 Total Chapters:        ${totalChapters}`);
		console.log(`📝 Total Topics:          ${totalTopics}`);
		console.log(`🎯 Total Learning Goals:  ${totalGoals}`);
		console.log('================================================================================\n');

	} catch (error) {
		console.error('❌ Error auditing curriculum database:', error.message);
	} finally {
		await prisma.$disconnect();
	}
}

auditCurriculum();
