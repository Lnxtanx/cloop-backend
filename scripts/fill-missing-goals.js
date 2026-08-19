/**
 * Fill Missing Goals for Topics in Database
 * 
 * Finds all global topics that have 0 or insufficient goals and generates them.
 * 
 * Usage:
 *   node scripts/fill-missing-goals.js
 */

require('dotenv').config();
const prisma = require('../lib/prisma');
const { generateTopicGoals } = require('../services/ai/curriculum');
const pLimitModule = require('p-limit');
const pLimit = pLimitModule.default || pLimitModule;

async function fillMissingGoals() {
	console.log('\n======================================================');
	console.log('🎯 Scanning for Topics with Missing Goals...');
	console.log('======================================================\n');

	try {
		// Find all topics where goals count < 4
		const allTopics = await prisma.global_topics.findMany({
			include: {
				goals: {
					select: { id: true }
				},
				chapter: {
					include: {
						subject: true
					}
				}
			},
			orderBy: [
				{ subject_id: 'asc' },
				{ chapter_id: 'asc' },
				{ order: 'asc' }
			]
		});

		const topicsNeedingGoals = allTopics.filter(t => t.goals.length < 4);

		console.log(`📊 Total Topics in Database: ${allTopics.length}`);
		console.log(`⚠️ Topics Needing Goals:      ${topicsNeedingGoals.length}\n`);

		if (topicsNeedingGoals.length === 0) {
			console.log('✅ All topics in the database already have complete learning goals!\n');
			return;
		}

		const limit = pLimit(2);
		let completedCount = 0;
		let failedCount = 0;

		const promises = topicsNeedingGoals.map((topic, index) => {
			return limit(async () => {
				const subjectName = topic.chapter?.subject?.name || 'Unknown';
				const grade = topic.chapter?.subject?.grade || '';
				const board = topic.chapter?.subject?.board || '';
				const label = `[${index + 1}/${topicsNeedingGoals.length}] ${board} ${grade} ${subjectName} > ${topic.title}`;

				try {
					console.log(`⏳ Generating goals for: ${label}`);
					const goalsData = await generateTopicGoals(topic.title, topic.content);
					const goals = goalsData.goals || [];

					for (let i = 0; i < goals.length; i++) {
						const g = goals[i];
						await prisma.global_topic_goals.create({
							data: {
								topic_id: topic.id,
								title: `Goal ${i + 1}: ${g.title}`,
								description: g.description,
								order: i + 1
							}
						});
					}

					console.log(`  ✓ Created ${goals.length} goals for: ${topic.title}`);
					completedCount++;
					await new Promise(r => setTimeout(r, 1000));
				} catch (err) {
					console.error(`  ❌ Failed for ${topic.title}:`, err.message);
					failedCount++;
				}
			});
		});

		await Promise.all(promises);

		// Update global_curriculum_status records to completed where all topics now have goals
		const subjects = await prisma.global_subjects.findMany({
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

		for (const sub of subjects) {
			const allSubjectTopics = sub.chapters.flatMap(c => c.topics);
			const isComplete = allSubjectTopics.length > 0 && allSubjectTopics.every(t => t.goals.length >= 4);

			if (isComplete) {
				await prisma.global_curriculum_status.upsert({
					where: {
						board_grade_subject_name: {
							board: sub.board,
							grade: sub.grade,
							subject_name: sub.name
						}
					},
					update: {
						status: 'completed',
						chapters_generated: true,
						topics_generated: true,
						goals_generated: true,
						global_subject_id: sub.id,
						generation_completed_at: new Date()
					},
					create: {
						board: sub.board,
						grade: sub.grade,
						subject_name: sub.name,
						status: 'completed',
						chapters_generated: true,
						topics_generated: true,
						goals_generated: true,
						global_subject_id: sub.id,
						generation_completed_at: new Date()
					}
				});
			}
		}

		console.log('\n======================================================');
		console.log('🎉 GOALS FILL SUMMARY');
		console.log('======================================================');
		console.log(`✅ Completed Topics: ${completedCount}`);
		console.log(`❌ Failed Topics:    ${failedCount}`);
		console.log('======================================================\n');

	} catch (error) {
		console.error('Fatal error in fillMissingGoals:', error.message);
	} finally {
		await prisma.$disconnect();
	}
}

fillMissingGoals();
